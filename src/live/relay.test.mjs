import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  createLiveRelay,
  sanitizeLiveCommand,
  sanitizeLiveComment,
} from '../../server/live/relay.js';
import { runLiveCommand, connectLiveRelay } from './relayClient.js';
import { createLiveRequestQueue } from './requestQueue.js';
import { LIVE_CONFIG } from './config.js';
import { liveOverlayModel } from './overlay.js';

test('relay commands keep only known types and fields', () => {
  assert.deepEqual(sanitizeLiveCommand({ type: 'next', extra: 1 }), {
    type: 'next',
  });
  assert.deepEqual(
    sanitizeLiveCommand({ type: 'add', user: '@juan', place: 'París', x: 1 }),
    {
      type: 'add',
      user: '@juan',
      place: 'París',
    },
  );
  assert.equal(
    sanitizeLiveCommand({ type: 'add', user: 'a', place: '  ' }),
    null,
  );
  assert.deepEqual(sanitizeLiveCommand({ type: 'promote', id: 3 }), {
    type: 'promote',
    id: 3,
  });
  assert.equal(sanitizeLiveCommand({ type: 'remove', id: '3' }), null);
  assert.deepEqual(sanitizeLiveCommand({ type: 'toggleFlights', x: 1 }), {
    type: 'toggleFlights',
  });
  assert.equal(sanitizeLiveCommand({ type: 'eval' }), null);
  assert.equal(sanitizeLiveCommand({ type: 'constructor' }), null);
  assert.equal(sanitizeLiveCommand(null), null);
  assert.equal(
    sanitizeLiveCommand({ type: 'add', place: 'x'.repeat(500) }).place.length,
    200,
  );
  assert.deepEqual(sanitizeLiveComment({ user: 'ana', text: ' !ir Lima ' }), {
    type: 'submit',
    user: 'ana',
    text: '!ir Lima',
  });
  assert.equal(sanitizeLiveComment({ user: 'ana', text: '' }), null);
});

/** A relay on an ephemeral port, plus helpers to talk to it. */
async function serveRelay(t) {
  const relay = createLiveRelay({ keepaliveMs: 60_000, env: {} });
  const server = http.createServer((req, res) => relay.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/live`;
  const controllers = [];
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    relay.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  const post = (path, body, headers = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  /** Open an event stream and collect its events as they arrive. */
  const listen = async (role) => {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${base}/events?role=${role}`, {
      signal: controller.signal,
    });
    const events = [];
    const waiters = [];
    (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (!event) continue;
            events.push({ event, data: JSON.parse(data) });
            for (const waiter of waiters.splice(0)) waiter();
          }
        }
      } catch {
        // Aborted at the end of the test.
      }
    })();
    const next = async (event) => {
      for (;;) {
        const index = events.findIndex((e) => e.event === event);
        if (index >= 0) return events.splice(index, 1)[0].data;
        await new Promise((resolve) => waiters.push(resolve));
      }
    };
    return { response, events, next, close: () => controller.abort() };
  };
  return { relay, base, post, listen };
}

test('relay passes panel commands and chat comments to the map', async (t) => {
  const { post, listen } = await serveRelay(t);
  assert.equal((await post('/command', { type: 'next' })).status, 409);
  const panel = await listen('panel');
  assert.deepEqual(await panel.next('status'), {
    mapConnected: false,
    maps: 0,
    tiktok: null,
    chatPaused: false,
  });
  const map = await listen('map');
  assert.deepEqual(await panel.next('status'), {
    mapConnected: true,
    maps: 1,
    tiktok: null,
    chatPaused: false,
  });

  assert.equal(
    (await post('/command', { type: 'add', user: '', place: 'Lima' })).status,
    202,
  );
  assert.deepEqual(await map.next('command'), {
    type: 'add',
    user: '',
    place: 'Lima',
  });
  assert.equal(
    (await post('/comment', { user: 'ana', text: '!ale Okap' })).status,
    202,
  );
  assert.deepEqual(await map.next('command'), {
    type: 'submit',
    user: 'ana',
    text: '!ale Okap',
  });
  assert.equal((await post('/command', { type: 'rm -rf' })).status, 400);

  assert.equal(
    (await post('/state', { current: null, upcoming: [] })).status,
    200,
  );
  assert.deepEqual(await panel.next('state'), { current: null, upcoming: [] });
  // A panel that opens later receives the last state at once.
  const late = await listen('panel');
  await late.next('status');
  assert.deepEqual(await late.next('state'), { current: null, upcoming: [] });

  map.close();
  assert.deepEqual(await panel.next('status'), {
    mapConnected: false,
    maps: 0,
    tiktok: null,
    chatPaused: false,
  });
});

test('Pausar chat de TikTok drops chat requests but keeps the panel working', async (t) => {
  const { post, listen } = await serveRelay(t);
  const panel = await listen('panel');
  await panel.next('status');
  const map = await listen('map');
  await panel.next('status');

  const paused = await post('/command', { type: 'toggleChat' });
  assert.deepEqual(await paused.json(), { ok: true, chatPaused: true });
  assert.equal((await panel.next('status')).chatPaused, true);
  assert.equal(
    map.events.some((e) => e.event === 'command'),
    false,
  );

  // The bridge is answered (so it keeps running) but nothing reaches the map.
  const comment = await post('/comment', { user: '@juan', text: '!ir París' });
  assert.deepEqual(await comment.json(), { ok: true, ignored: 'chat-paused' });
  // The streamer's own requests still go through.
  await post('/command', { type: 'add', user: '@ana', place: 'Lima' });
  assert.deepEqual(await map.next('command'), {
    type: 'add',
    user: '@ana',
    place: 'Lima',
  });
  assert.equal(map.events.filter((e) => e.event === 'command').length, 0);

  await post('/command', { type: 'toggleChat' });
  assert.equal((await panel.next('status')).chatPaused, false);
  await post('/comment', { user: '@juan', text: '!ir París' });
  assert.deepEqual(await map.next('command'), {
    type: 'submit',
    user: '@juan',
    text: '!ir París',
  });
});

test('relay sends commands only to the newest map window', async (t) => {
  const { post, listen } = await serveRelay(t);
  const panel = await listen('panel');
  await panel.next('status');
  const first = await listen('map');
  await panel.next('status');
  const second = await listen('map');
  await panel.next('status');
  await post('/command', { type: 'skip' });
  assert.deepEqual(await second.next('command'), { type: 'skip' });
  assert.equal(first.events.filter((e) => e.event === 'command').length, 0);
  second.close();
  await panel.next('status');
  await post('/command', { type: 'pause' });
  assert.deepEqual(await first.next('command'), { type: 'pause' });
});

test('relay refuses requests that are not local', async (t) => {
  const { post, base } = await serveRelay(t);
  assert.equal(
    (
      await post(
        '/command',
        { type: 'next' },
        { Origin: 'https://evil.example' },
      )
    ).status,
    403,
  );
  const rebinding = await new Promise((resolve) => {
    const url = new URL(`${base}/command`);
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { Host: 'evil.example', 'Content-Type': 'application/json' },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.end(JSON.stringify({ type: 'next' }));
  });
  assert.equal(rebinding, 403);
  assert.equal(
    (await post('/command', { type: 'next' }, { 'X-Forwarded-For': '8.8.8.8' }))
      .status,
    403,
  );
});

test('map client runs each relayed command against the live API', async () => {
  const calls = [];
  const api = new Proxy(
    {},
    {
      get:
        (_, name) =>
        (...args) =>
          calls.push([name, ...args]),
    },
  );
  runLiveCommand(api, { type: 'add', user: '@juan', place: 'París' });
  runLiveCommand(api, { type: 'submit', user: 'ana', text: '!ir Lima' });
  runLiveCommand(api, { type: 'promote', id: 4 });
  runLiveCommand(api, { type: 'togglePause' });
  runLiveCommand(api, { type: 'unknown' });
  assert.deepEqual(calls, [
    [
      'submit',
      { user: '@juan', text: '!ir París' },
      { operator: true, source: 'panel' },
    ],
    ['submit', { user: 'ana', text: '!ir Lima' }, { source: 'chat' }],
    ['promote', 4],
    ['togglePause'],
  ]);
});

test('map client coalesces state posts and stops on close', async () => {
  const listeners = {};
  class FakeEventSource {
    constructor(url) {
      this.url = url;
    }
    addEventListener(type, fn) {
      listeners[type] = fn;
    }
    close() {
      this.closed = true;
    }
  }
  const posts = [];
  let release;
  const client = connectLiveRelay({
    api: {},
    getState: () => ({ n: posts.length }),
    EventSourceImpl: FakeEventSource,
    fetchImpl: (url, init) => {
      posts.push([url, JSON.parse(init.body)]);
      return new Promise((resolve) => (release = resolve));
    },
    publishEveryMs: 60_000,
  });
  client.publish();
  client.publish();
  client.publish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(posts.length, 1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(posts.length, 2);
  assert.equal(posts[0][0], '/api/live/state');
  client.close();
  release();
  client.publish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(posts.length, 2);
});

test('queue: operator requests skip the wait, show the streamer, and can be promoted', async () => {
  let time = 0;
  const queue = createLiveRequestQueue({
    now: () => time,
    resolvePlace: async (query) => ({
      lat: 1,
      lng: 2,
      label: query,
      types: ['locality'],
    }),
  });
  await queue.submit({ user: 'ana', text: '!ir Lima' });
  const wait = await queue.submit({ user: 'ana', text: '!ir Quito' });
  assert.equal(wait.reason, 'user-cooldown');
  assert.equal(wait.waitMs, LIVE_CONFIG.userCooldownSeconds * 1000);
  time += 18_000;
  assert.equal(
    (await queue.submit({ user: 'ana', text: '!ir Quito' })).waitMs,
    42_000,
  );

  // The streamer transcribes several viewers, and their own requests, at once.
  assert.equal(
    (
      await queue.submit(
        { user: '@juan', text: '!ir París' },
        { operator: true },
      )
    ).ok,
    true,
  );
  assert.equal(
    (
      await queue.submit(
        { user: '@juan', text: '!ir Roma' },
        { operator: true },
      )
    ).ok,
    true,
  );
  const own = await queue.submit(
    { user: '', text: '!ir Tokio' },
    { operator: true },
  );
  assert.equal(own.request.user, LIVE_CONFIG.operatorName);
  assert.equal(own.request.streamer, true);
  // Transcribing "@ana" does not start or reset ana's own chat wait.
  await queue.submit({ user: 'ana', text: '!ir Cusco' }, { operator: true });
  assert.equal(
    (await queue.submit({ user: 'ana', text: '!ir Quito' })).waitMs,
    42_000,
  );

  const order = () => queue.getState().upcoming.map((r) => r.place);
  assert.deepEqual(order(), ['París', 'Roma', 'Tokio', 'Cusco']);
  assert.equal(queue.promote(own.request.id), true);
  assert.deepEqual(order(), ['Tokio', 'París', 'Roma', 'Cusco']);
  assert.equal(queue.promote(999), false);

  const model = liveOverlayModel(queue.getState());
  assert.equal(model.upcoming[0].handle, 'Mr. Erold');
  assert.equal(model.upcoming[1].handle, '@juan');
});

test('Volar ahora: relayed as flyNow, and the overlay hides banner and waiting text', () => {
  assert.deepEqual(
    sanitizeLiveCommand({ type: 'flyNow', place: 'Jacmel', user: 'x' }),
    {
      type: 'flyNow',
      place: 'Jacmel',
    },
  );
  assert.equal(sanitizeLiveCommand({ type: 'flyNow', place: '' }), null);
  const calls = [];
  runLiveCommand(
    { flyNow: (place) => calls.push(place) },
    { type: 'flyNow', place: 'Jacmel' },
  );
  assert.deepEqual(calls, ['Jacmel']);
  const current = {
    id: 1,
    user: 'ana',
    place: 'Lima',
    types: ['locality'],
    country: 'Perú',
  };
  const upcoming = [
    {
      id: 2,
      user: 'beto',
      place: 'Quito',
      types: ['locality'],
      country: 'Ecuador',
    },
  ];
  const state = { current, upcoming, paused: true, remainingMs: 1000 };
  assert.equal(liveOverlayModel(state).mode, 'showing');
  const free = liveOverlayModel(state, { freeFlight: true });
  assert.equal(free.mode, 'free');
  assert.equal(free.upcoming.length, 1, 'the line stays visible');
  assert.equal(
    liveOverlayModel({ current: null, upcoming: [] }, { freeFlight: true })
      .mode,
    'free',
  );
});
