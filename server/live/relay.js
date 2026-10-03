/**
 * Live request relay at /api/live, for streaming with `?live=1`.
 *
 * The request line lives in the map window, which owns the geocoder and the
 * camera. This relay only carries messages between it and everything else:
 *
 * - GET  /api/live/events?role=map|panel  Server-Sent Events stream.
 *   The map receives `command` events; a panel receives `state` and
 *   `status` events (whether a map is connected).
 * - POST /api/live/command  `{ type, ... }` from the control panel.
 * - POST /api/live/comment  `{ user, text }` from a chat bridge.
 * - POST /api/live/state    the map's current state, passed on to panels.
 *
 * Commands go to the most recently connected map only, so a reloaded or
 * duplicated map window never runs a request twice. Every route accepts
 * local requests only, under the same rules as /mcp.
 */

import { isLocalMcpRequest } from '../mcp/plugin.js';

const MAX_BODY_BYTES = 64 * 1024;
const BODY_TIMEOUT_MS = 10 * 1000;
const KEEPALIVE_MS = 15 * 1000;
const MAX_TEXT = 200;

/** Commands a panel may send, and the fields each one carries. */
const COMMANDS = Object.freeze({
  add: ['user', 'place'],
  flyNow: ['place'],
  next: [],
  skip: [],
  extend: [],
  pause: [],
  resume: [],
  togglePause: [],
  remove: ['id'],
  promote: ['id'],
  clearLine: [],
  clear: [],
});

const text = (value) =>
  typeof value === 'string' ? value.slice(0, MAX_TEXT) : '';

/**
 * Reduce an incoming command to its known fields, or null when it is not one.
 * @param {unknown} body
 */
export function sanitizeLiveCommand(body) {
  const type = body?.type;
  if (typeof type !== 'string' || !Object.hasOwn(COMMANDS, type)) return null;
  const command = { type };
  for (const field of COMMANDS[type]) {
    if (field === 'id') {
      if (!Number.isSafeInteger(body.id)) return null;
      command.id = body.id;
    } else command[field] = text(body[field]);
  }
  if ('place' in command && !command.place.trim()) return null;
  return command;
}

/** A chat comment as a `submit` command, or null when it has no text. */
export function sanitizeLiveComment(body) {
  const comment = text(body?.text).trim();
  if (!comment) return null;
  return { type: 'submit', user: text(body?.user), text: comment };
}

/**
 * The relay as a plain Node request handler, so it runs under Vite's dev and
 * preview servers and under a bare `http.createServer` in tests.
 */
export function createLiveRelay({
  keepaliveMs = KEEPALIVE_MS,
  bodyTimeoutMs = BODY_TIMEOUT_MS,
  env = process.env,
} = {}) {
  const maps = [];
  const panels = new Set();
  let lastState = null;

  const send = (res, event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const currentMap = () => maps.at(-1) || null;
  // `maps` lets the panel warn when more than one map window is open: only
  // the newest one receives commands.
  const status = () => ({
    mapConnected: maps.length > 0,
    maps: maps.length,
  });
  const broadcastStatus = () => {
    for (const panel of panels) send(panel, 'status', status());
  };

  const json = (res, code, body) => {
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  };

  const openStream = (req, res, role) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const keepalive = setInterval(() => res.write(': ping\n\n'), keepaliveMs);
    if (role === 'map') {
      maps.push(res);
      broadcastStatus();
    } else {
      panels.add(res);
      send(res, 'status', status());
      if (lastState) send(res, 'state', lastState);
    }
    req.on('close', () => {
      clearInterval(keepalive);
      if (role === 'map') {
        const index = maps.indexOf(res);
        if (index >= 0) maps.splice(index, 1);
        if (!maps.length) lastState = null;
        broadcastStatus();
      } else panels.delete(res);
    });
  };

  const forward = (res, command) => {
    const map = currentMap();
    if (!map) return json(res, 409, { error: 'map-offline' });
    send(map, 'command', command);
    return json(res, 202, { ok: true });
  };

  async function handle(req, res, next) {
    const url = new URL(req.url || '/', 'http://local');
    const route = url.pathname.replace(/^\/api\/live/, '') || '/';
    if (
      !isLocalMcpRequest({
        remoteAddress: req.socket?.remoteAddress,
        localPort: req.socket?.localPort,
        host: req.headers.host || '',
        origin: req.headers.origin,
        headers: req.headers,
        env,
      })
    )
      return json(res, 403, { error: 'local-only' });

    if (route === '/events' && req.method === 'GET') {
      const role = url.searchParams.get('role');
      if (role !== 'map' && role !== 'panel')
        return json(res, 400, { error: 'bad-role' });
      return openStream(req, res, role);
    }
    if (req.method !== 'POST') {
      if (typeof next === 'function') return next();
      return json(res, 404, { error: 'not-found' });
    }
    let body;
    try {
      body = JSON.parse((await readBody(req, bodyTimeoutMs)).toString('utf8'));
    } catch (error) {
      return json(res, error?.status || 400, { error: 'bad-request' });
    }
    if (route === '/command') {
      const command = sanitizeLiveCommand(body);
      return command
        ? forward(res, command)
        : json(res, 400, { error: 'bad-command' });
    }
    if (route === '/comment') {
      const command = sanitizeLiveComment(body);
      return command
        ? forward(res, command)
        : json(res, 400, { error: 'bad-comment' });
    }
    if (route === '/state') {
      lastState = body && typeof body === 'object' ? body : null;
      for (const panel of panels) send(panel, 'state', lastState);
      return json(res, 200, { ok: true });
    }
    if (typeof next === 'function') return next();
    return json(res, 404, { error: 'not-found' });
  }

  return {
    handle,
    status,
    close() {
      for (const res of [...maps, ...panels]) res.end();
      maps.length = 0;
      panels.clear();
    },
  };
}

/** Where the control panel page lives; served at /live-control. */
export const LIVE_CONTROL_PAGE = '/src/live/control/index.html';

/** The page path a request for /live-control should be served from, or null. */
export function liveControlPagePath(url) {
  const [path, query] = String(url || '').split(/\?(.*)/s);
  if (path !== '/live-control' && path !== '/live-control/') return null;
  return query ? `${LIVE_CONTROL_PAGE}?${query}` : LIVE_CONTROL_PAGE;
}

/**
 * Vite plugin that mounts the relay at /api/live and the control panel page
 * at /live-control. The page is a development-server page: the production
 * build does not include it.
 */
export function liveRelayPlugin(options) {
  const install = (server) => {
    const relay = createLiveRelay(options);
    server.middlewares.use((req, res, next) => {
      const page = liveControlPagePath(req.url);
      if (page) req.url = page;
      next();
    });
    server.middlewares.use('/api/live', (req, res, next) => {
      // Connect strips the mount path; the handler expects the full path.
      req.url = `/api/live${req.url === '/' ? '' : req.url}`;
      relay.handle(req, res, next).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    server.httpServer?.on('close', () => relay.close());
  };
  return {
    name: 'live-relay',
    configureServer: install,
    configurePreviewServer: install,
  };
}

function readBody(req, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(
      () => reject(Object.assign(new Error('timeout'), { status: 408 })),
      timeoutMs,
    );
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        clearTimeout(timer);
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
