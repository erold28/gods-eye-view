import { LIVE_CONFIG } from './config.js';
import { foldText } from './text.js';

/** Fixed instruction lines, Spanish then Kreyòl. */
export const LIVE_INSTRUCTIONS = Object.freeze([
  'Escribe: !ir + tu ciudad',
  'Ekri: !ale + vil ou',
]);

/** Waiting-screen call to action, Spanish then Kreyòl. */
export const LIVE_IDLE_LINES = Object.freeze([
  '¡Pide tu ciudad!',
  'Mande vil ou!',
]);

export const LIVE_BRAND = 'Mr. Erold';

/** Small call to follow, under the instructions (clear of TikTok's header). */
export const LIVE_FOLLOW = 'Sígueme para más viajes 🌎';

const MAX_USER_CHARS = 20;
const MAX_PLACE_CHARS = 28;

const clip = (value, max) => {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** "@ana" for "ana" or "@ana"; a missing name stays as given. */
export function liveHandle(user) {
  const name = clip(String(user ?? '').replace(/^@+/, ''), MAX_USER_CHARS);
  return name.startsWith('(') ? name : `@${name}`;
}

/** Who asked: "@juan", or the streamer's own name without an "@". */
const requestHandle = (request) =>
  request.streamer
    ? clip(request.user, MAX_USER_CHARS)
    : liveHandle(request.user);

/**
 * The place exactly as the viewer wrote it, with a capital first letter.
 * Never the geocoder's name or an alias target ("مصر", "Deutschland"): those
 * are internal and often in a script the audience cannot read.
 */
function spokenPlace(request) {
  const text = clip(request.place, MAX_PLACE_CHARS);
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

/**
 * The Spanish country the request landed in, so a wrong match shows at a
 * glance ("Tokio, Papúa Nueva Guinea"). Empty for a country request, or when
 * the viewer already wrote the country.
 */
function countryOf(request) {
  const country = String(request.country || '').trim();
  if (!country || request.types?.includes('country')) return '';
  return foldText(country) === foldText(request.place) ? '' : country;
}

/**
 * What the overlay shows for one queue state. Kept free of the DOM so the
 * wording and limits are tested directly.
 */
export function liveOverlayModel(
  state,
  {
    config = LIVE_CONFIG,
    maxUpcoming = config.queueRowsShown,
    freeFlight = false,
  } = {},
) {
  const displayMs = config.displaySeconds * 1000;
  const current = state?.current || null;
  // Requests still being looked up may yet be refused: never on air.
  const upcoming = (state?.upcoming || []).filter(
    (request) => request.status !== 'pending',
  );
  return {
    // A free flight shows neither the banner nor the waiting message.
    mode: freeFlight ? 'free' : current ? 'showing' : 'idle',
    paused: Boolean(state?.paused),
    current: current
      ? {
          handle: requestHandle(current),
          place: spokenPlace(current),
          country: countryOf(current),
          progress:
            displayMs > 0
              ? Math.min(1, Math.max(0, 1 - state.remainingMs / displayMs))
              : 1,
        }
      : null,
    upcoming: upcoming.slice(0, maxUpcoming).map((request, index) => ({
      position: index + 1,
      handle: requestHandle(request),
      place: spokenPlace(request),
      country: countryOf(request),
    })),
    more: Math.max(0, upcoming.length - maxUpcoming),
  };
}

const el = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * The on-screen layer: brand, instructions, the request on screen (or the
 * waiting message) and the next requests, laid out in a 9:16 column. All
 * viewer text is set with textContent, never parsed as markup.
 */
export function createLiveOverlay({
  document = globalThis.document,
  parent = document.body,
  config = LIVE_CONFIG,
} = {}) {
  const root = el(document, 'div', 'gev-live');
  root.setAttribute('aria-live', 'polite');
  const column = el(document, 'div', 'gev-live__column');
  root.append(column);

  const brand = el(document, 'div', 'gev-live__brand', LIVE_BRAND);

  const instructions = el(document, 'div', 'gev-live__instructions');
  for (const line of LIVE_INSTRUCTIONS)
    instructions.append(el(document, 'div', 'gev-live__instruction', line));
  instructions.append(el(document, 'div', 'gev-live__follow', LIVE_FOLLOW));

  const banner = el(document, 'div', 'gev-live__banner');
  const who = el(document, 'div', 'gev-live__who');
  const handle = el(document, 'span', 'gev-live__handle');
  who.append(handle, document.createTextNode(' pidió:'));
  const place = el(document, 'div', 'gev-live__place');
  const placeName = el(document, 'span', 'gev-live__place-name');
  const placeCountry = el(document, 'span', 'gev-live__country');
  place.append(placeName, placeCountry);
  const bar = el(document, 'div', 'gev-live__bar');
  const fill = el(document, 'div', 'gev-live__bar-fill');
  bar.append(fill);
  const paused = el(document, 'div', 'gev-live__paused', 'PAUSA');
  banner.append(who, place, bar, paused);

  const idle = el(document, 'div', 'gev-live__idle');
  for (const line of LIVE_IDLE_LINES)
    idle.append(el(document, 'div', 'gev-live__idle-line', line));

  const queue = el(document, 'div', 'gev-live__queue');
  const queueTitle = el(
    document,
    'div',
    'gev-live__queue-title',
    'Próximas · Pwochen',
  );
  const queueList = el(document, 'ol', 'gev-live__queue-list');
  const queueMore = el(document, 'div', 'gev-live__queue-more');
  queue.append(queueTitle, queueList, queueMore);

  const stack = el(document, 'div', 'gev-live__stack');
  stack.append(banner, idle, queue);
  column.append(brand, instructions, stack);
  parent.append(root);

  return {
    element: root,
    render(state, { freeFlight = false } = {}) {
      const model = liveOverlayModel(state, { config, freeFlight });
      root.dataset.mode = model.mode;
      root.classList.toggle('is-paused', model.paused);
      banner.hidden = model.mode !== 'showing';
      idle.hidden = model.mode !== 'idle';
      if (model.current) {
        handle.textContent = model.current.handle;
        placeName.textContent = model.current.place;
        placeCountry.textContent = model.current.country
          ? `, ${model.current.country}`
          : '';
        fill.style.transform = `scaleX(${1 - model.current.progress})`;
      }
      paused.hidden = !model.paused;
      queue.hidden = model.upcoming.length === 0;
      queueList.replaceChildren(
        ...model.upcoming.map((item) => {
          const row = el(document, 'li', 'gev-live__queue-item');
          const placeCell = el(
            document,
            'span',
            'gev-live__queue-place',
            item.place,
          );
          if (item.country)
            placeCell.append(
              el(document, 'span', 'gev-live__country', `, ${item.country}`),
            );
          row.append(
            el(document, 'span', 'gev-live__queue-pos', String(item.position)),
            placeCell,
            el(document, 'span', 'gev-live__queue-user', item.handle),
          );
          return row;
        }),
      );
      queueMore.textContent = model.more ? `+${model.more} más` : '';
      queueMore.hidden = !model.more;
    },
    destroy() {
      root.remove();
    },
  };
}
