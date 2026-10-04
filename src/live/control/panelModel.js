/**
 * What the live control panel shows and how it reads the keyboard, kept free
 * of the DOM so it can be tested directly.
 */

/** Why a request was refused, in the streamer's words. */
const REASONS = Object.freeze({
  'not-found': 'no se encontró',
  'private-place': 'es una calle o dirección',
  'not-public-place': 'no es una ciudad ni lugar público',
  'has-numbers': 'tiene números (parece dirección o coordenadas)',
  'link-or-mention': 'tiene un enlace o una @mención',
  'too-long': 'el nombre es demasiado largo',
  empty: 'falta el nombre del lugar',
  'blocked-word': 'tiene una palabra bloqueada',
  'queue-full': 'la fila está llena',
  duplicate: 'ya está en la fila',
  failed: 'falló la búsqueda',
});

/** Where a request came from. */
const SOURCES = Object.freeze({
  chat: 'chat',
  panel: 'panel',
  'panel-fly': 'volar ahora',
  console: 'consola',
});

/** "rechazado: …" text for one refused request. */
export function rejectionText({ reason, waitMs } = {}) {
  if (reason === 'user-cooldown') {
    const seconds = Math.max(1, Math.ceil((Number(waitMs) || 0) / 1000));
    return `este usuario debe esperar ${seconds} s`;
  }
  return REASONS[reason] || String(reason || 'motivo desconocido');
}

export function sourceText(source) {
  return SOURCES[source] || String(source || '');
}

/**
 * A typed user name as a handle: "juan" and "@juan" both give "@juan"; an
 * empty field stays empty, so the request is shown as the streamer's own.
 */
export function normalizeUser(value) {
  const name = String(value ?? '')
    .trim()
    .replace(/^@+/, '')
    .replace(/\s+/g, '');
  return name ? `@${name}` : '';
}

/** The TikTok bridge line: `{ text, online }` from the relay's `tiktok`. */
export function tiktokStatus(tiktok) {
  if (!tiktok)
    return {
      text: 'TikTok: puente apagado (solo panel manual)',
      online: false,
    };
  const who = tiktok.username ? `@${tiktok.username}` : 'tu cuenta';
  return tiktok.connected
    ? { text: `TikTok: conectado al live de ${who}`, online: true }
    : { text: `TikTok: esperando que ${who} esté en vivo…`, online: false };
}

/** "0:14" for a number of milliseconds. */
export function formatClock(ms) {
  const total = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** "21:14" for a timestamp, in local time. */
export function formatTime(at) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** "Lima, Perú", or the place alone when the country is unknown. */
export function placeWithCountry({ place, country } = {}) {
  const text = String(place || '').trim();
  // "tapachula" as typed reads as "Tapachula", as on the banner.
  const name = text.charAt(0).toLocaleUpperCase() + text.slice(1);
  return country ? `${name}, ${country}` : name;
}

/**
 * Seconds left on screen now, from the map's last state. The map reports the
 * remaining time when it sent the state; while running, it keeps counting.
 */
export function remainingNow(state, now = Date.now()) {
  if (!state?.current) return 0;
  const remaining = Number(state.remainingMs) || 0;
  if (state.paused) return remaining;
  return Math.max(0, remaining - (now - (Number(state.at) || now)));
}

const SHORTCUTS = Object.freeze({
  n: 'next',
  s: 'skip',
  p: 'togglePause',
  e: 'extend',
  a: 'toggleFlights',
  c: 'toggleChat',
  k: 'toggleCockpit',
  t: 'cycleCardPosition',
});

/**
 * The command a key press means, or null. Letters act only outside text
 * fields, so typing "Nueva York" never skips a city, and never with Ctrl,
 * Alt or the Windows/Command key, so browser shortcuts keep working.
 */
export function shortcutFor(event) {
  if (!event || event.ctrlKey || event.altKey || event.metaKey) return null;
  if (event.repeat) return null;
  const target = event.target;
  const tag = String(target?.tagName || '').toLowerCase();
  if (
    ['input', 'textarea', 'select'].includes(tag) ||
    target?.isContentEditable
  )
    return null;
  return SHORTCUTS[String(event.key || '').toLowerCase()] || null;
}
