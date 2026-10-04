import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  normalizeUsername,
  requestFromChat,
} from '../../tiktok-bridge/comments.mjs';
import { createLiveRelay } from '../../server/live/relay.js';
import { tiktokStatus } from './control/panelModel.js';
import { LIVE_CONFIG } from './config.js';

const chat = (uniqueId, comment) => ({ user: { uniqueId }, comment });

test('bridge passes on only !ir and !ale requests, as @user + text', () => {
  const commands = LIVE_CONFIG.commands;
  assert.deepEqual(requestFromChat(chat('juan', '!ir París'), commands), {
    user: '@juan',
    text: '!ir París',
  });
  assert.deepEqual(
    requestFromChat(chat('jean509', '  !ALE   Okap '), commands),
    {
      user: '@jean509',
      text: '!ALE Okap',
    },
  );
  assert.equal(requestFromChat(chat('ana', 'hola desde Lima'), commands), null);
  assert.equal(requestFromChat(chat('ana', '!irParis'), commands), null);
  assert.equal(requestFromChat(chat('ana', ''), commands), null);
  assert.equal(requestFromChat(null, commands), null);
  assert.equal(
    requestFromChat(chat('ana', `!ir ${'x'.repeat(500)}`), commands).text
      .length,
    200,
  );
  assert.equal(requestFromChat({ comment: '!ir Lima' }, commands).user, '');
});

test('bridge accepts the username with @ or as a TikTok link', () => {
  assert.equal(normalizeUsername('@mr.eroldoficial'), 'mr.eroldoficial');
  assert.equal(normalizeUsername('mr.eroldoficial'), 'mr.eroldoficial');
  assert.equal(
    normalizeUsername('https://www.tiktok.com/@mr.eroldoficial/live'),
    'mr.eroldoficial',
  );
  assert.equal(normalizeUsername(''), '');
});

test('panel line for the bridge', () => {
  assert.deepEqual(tiktokStatus(null), {
    text: 'TikTok: puente apagado (solo panel manual)',
    online: false,
  });
  assert.deepEqual(
    tiktokStatus({ connected: true, username: 'mr.eroldoficial' }),
    {
      text: 'TikTok: conectado al live de @mr.eroldoficial',
      online: true,
    },
  );
  assert.equal(
    tiktokStatus({ connected: false, username: 'mr.eroldoficial' }).text,
    'TikTok: esperando que @mr.eroldoficial esté en vivo…',
  );
});

test('relay shows the bridge until it stops reporting', async (t) => {
  let time = 1_000_000;
  const relay = createLiveRelay({
    env: {},
    now: () => time,
    bridgeStaleMs: 60_000,
  });
  const server = http.createServer((req, res) => relay.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    relay.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/live`;
  assert.equal(relay.status().tiktok, null);
  const response = await fetch(`${base}/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connected: true, username: '@mr.eroldoficial' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(relay.status().tiktok, {
    connected: true,
    username: 'mr.eroldoficial',
  });
  time += 59_000;
  assert.equal(relay.status().tiktok.connected, true);
  time += 2_000;
  assert.equal(relay.status().tiktok, null, 'the bridge window was closed');
  // A comment from the bridge with no map open is refused, not lost silently.
  const comment = await fetch(`${base}/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: '@juan', text: '!ir París' }),
  });
  assert.equal(comment.status, 409);
});
