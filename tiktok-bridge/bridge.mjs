#!/usr/bin/env node
/**
 * Puente TikTok LIVE → Mr Erold Live.
 *
 * Lee el chat de tu live y envía a la app los comentarios que empiezan con
 * "!ir" o "!ale". Solo lee: no escribe en el chat ni usa tu contraseña.
 *
 *   node bridge.mjs mr.eroldoficial
 *
 * Variables opcionales:
 *   LIVE_RELAY      dirección de la app (por defecto http://localhost:4180)
 *   EULER_API_KEY   clave gratuita de eulerstream.com, si el servicio limita
 *
 * Usa la librería no oficial tiktok-live-connector (AGPL-3.0), que firma la
 * conexión con el servidor de Euler Stream. Si TikTok cambia algo puede
 * dejar de funcionar: el panel manual sigue sirviendo igual.
 */
import { LIVE_CONFIG } from '../src/live/config.js';
import { normalizeUsername, requestFromChat } from './comments.mjs';

const username = normalizeUsername(
  process.argv[2] || process.env.TIKTOK_USUARIO,
);
const relay = (process.env.LIVE_RELAY || 'http://localhost:4180').replace(
  /\/+$/,
  '',
);
const RETRY_OFFLINE_S = 30;
const RETRY_ERROR_S = 15;
const HEARTBEAT_S = 20;

if (!username) {
  console.error(
    'Falta tu usuario de TikTok. Ejemplo: node bridge.mjs mr.eroldoficial',
  );
  process.exit(1);
}

const time = () => new Date().toLocaleTimeString('es', { hour12: false });
const log = (message) => console.log(`[${time()}] ${message}`);

let connected = false;

/** Tell the app whether the bridge is connected, for the control panel. */
async function reportStatus() {
  try {
    await fetch(`${relay}/api/live/bridge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connected, username }),
    });
  } catch {
    // The app may not be open yet; the next heartbeat tries again.
  }
}

async function forward(request) {
  try {
    const response = await fetch(`${relay}/api/live/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (response.status === 409)
      log(`${request.user}: "${request.text}" — el mapa no está abierto`);
    else if (!response.ok)
      log(
        `${request.user}: "${request.text}" — la app respondió ${response.status}`,
      );
    else {
      const body = await response.json().catch(() => ({}));
      log(
        body?.ignored === 'chat-paused'
          ? `${request.user}: "${request.text}" — chat en pausa (ignorado)`
          : `${request.user}: "${request.text}" → enviado a la fila`,
      );
    }
  } catch {
    log(
      `${request.user}: "${request.text}" — no hay conexión con la app (¿está abierto el servidor?)`,
    );
  }
}

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function main() {
  let library;
  try {
    library = await import('tiktok-live-connector');
  } catch {
    console.error(
      'No encuentro la librería. En esta carpeta ejecuta: npm install',
    );
    process.exit(1);
  }
  const { TikTokLiveConnection, WebcastEvent, ControlEvent } = library;

  setInterval(reportStatus, HEARTBEAT_S * 1000);
  log(`Puente TikTok para @${username}. App: ${relay}`);

  for (;;) {
    const connection = new TikTokLiveConnection(username, {
      // Without this, the chat history sent on connect would queue old requests.
      processInitialData: false,
      ...(process.env.EULER_API_KEY
        ? { signApiKey: process.env.EULER_API_KEY }
        : {}),
    });
    const closed = new Promise((resolve) => {
      connection.on(ControlEvent.DISCONNECTED, resolve);
    });
    connection.on(WebcastEvent.CHAT, (data) => {
      const request = requestFromChat(data, LIVE_CONFIG.commands);
      if (request) forward(request);
    });
    // Errors while connecting are reported once, below; these are the ones
    // that arrive during the live.
    connection.on(ControlEvent.ERROR, (error) => {
      if (connected)
        log(`Aviso de TikTok: ${error?.info || error?.message || error}`);
    });

    try {
      await connection.connect();
      connected = true;
      await reportStatus();
      log(
        `Conectado al live de @${username}. Esperando comentarios con !ir o !ale…`,
      );
      await closed;
      log('Se cortó la conexión con TikTok.');
    } catch (error) {
      const offline = /offline|not live|isn't online|UserOffline/i.test(
        `${error?.name} ${error?.message}`,
      );
      log(
        offline
          ? `@${username} no está en vivo todavía.`
          : `No se pudo conectar: ${error?.message || error}`,
      );
    }
    // After a live connection drops, retry sooner than while waiting for
    // the live to start.
    const wasConnected = connected;
    connected = false;
    await reportStatus();
    try {
      connection.disconnect?.();
    } catch {
      // Already closed.
    }
    const wait = wasConnected ? RETRY_ERROR_S : RETRY_OFFLINE_S;
    log(`Reintento en ${wait} s…`);
    await sleep(wait);
  }
}

main();
