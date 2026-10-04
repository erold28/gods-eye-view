import { createLiveCamera } from './camera.js';
import { LIVE_CONFIG } from './config.js';
import { parseLiveComment } from './commands.js';
import { createCountryLookup } from './countryNames.js';
import { preferredLiveMap } from './mapPreference.js';
import { judgeLivePlace, preferCityOverState } from './placePolicy.js';
import { createLiveOverlay } from './overlay.js';
import { connectLiveRelay } from './relayClient.js';
import { createLiveRequestQueue } from './requestQueue.js';
import './overlay.css';

const TICK_MS = 250;
/** Pause after the line empties before the waiting spin starts. */
const IDLE_DELAY_MS = 4000;
/** The startup camera intro finishes before the first waiting spin. */
const STARTUP_IDLE_DELAY_MS = 9000;
/** The app restores its visual state while starting, so the clean view is re-applied. */
const CLEAN_VIEW_DELAYS_MS = Object.freeze([0, 2000, 8000]);
/**
 * When the live view checks its map: early checks only move to Google 3D once
 * it is ready; the later ones may fall back to Esri (see mapPreference.js).
 */
const MAP_CHECKS = Object.freeze([
  { delayMs: 0, final: false },
  { delayMs: 2000, final: false },
  { delayMs: 8000, final: true },
  { delayMs: 15000, final: true },
]);
/** Refused requests the control panel lists. */
const REJECTED_KEPT = 20;

/** Whether this page was opened for streaming with `?live=1`. */
export function isLiveMode(location = globalThis.location) {
  return new URLSearchParams(location?.search || '').get('live') === '1';
}

/**
 * Live mode for streaming: requests from comments fly the camera, with the
 * request overlay on top. Does nothing unless the page has `?live=1`.
 *
 * `run(name, args)` runs an app action (the same ones voice uses); the HUD
 * goes through it. Flights use the app's own landmark flight (camera.js), with
 * `ground` the app's ground-floor service so the eye never lands underground.
 * `mapStack` is the app's map controller: live mode always shows Google 3D
 * when it is available, whatever map the view link remembered.
 *
 * Requests arrive from the control panel or a chat bridge through the
 * /api/live relay (server/live/relay.js), or from the browser console:
 * `__gevLive.submit({ user: 'ana', text: '!ir París' })`.
 * @returns {() => void} cleanup
 */
export function installLiveMode({
  viewer,
  placeSearch,
  run,
  ground = null,
  mapStack = null,
  signal,
  document = globalThis.document,
  location = globalThis.location,
  config = LIVE_CONFIG,
}) {
  if (!isLiveMode(location)) return () => {};
  const lifetime = new AbortController();
  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  };

  const countries = createCountryLookup();
  const resolvePlace = async (query, options = {}) => {
    const signal = AbortSignal.any(
      [lifetime.signal, options.signal].filter(Boolean),
    );
    const geocode = async (text) =>
      (await placeSearch.geocode(text, { signal })).place;
    const first = await geocode(query);
    if (!first) return null;
    // "Puebla" answers as the state; ask again for the city of that name.
    const place = await preferCityOverState(first, geocode, config.camera);
    // The country only labels the overlay; a failed lookup never refuses.
    const country = await countries
      .countryAt(place.lat, place.lng)
      .catch(() => null);
    return { ...place, country: country?.name || null };
  };
  const queue = createLiveRequestQueue({ config, resolvePlace });
  const overlay = createLiveOverlay({ document, config });
  // Moving the map by hand pauses the line; Continuar (P) resumes the tour.
  const camera = createLiveCamera({
    viewer,
    ground,
    config,
    onTakeover: () => queue.pause(),
  });
  let idleTimer = null;
  /** Connected once the API exists, below; queue events publish through it. */
  let relay = null;
  /**
   * "Volar ahora (sin cartel)": the place the streamer flew to directly,
   * outside the line. The line stays paused, with no banner, until resumed.
   */
  let freeFlight = null;
  const render = (state = queue.getState()) =>
    overlay.render(state, { freeFlight: Boolean(freeFlight) });

  const stopOrbit = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    timers.delete(idleTimer);
    idleTimer = null;
    camera.stopIdle();
  };

  const startIdleOrbit = (delay = IDLE_DELAY_MS) => {
    stopOrbit();
    idleTimer = later(() => {
      idleTimer = null;
      const state = queue.getState();
      if (state.current || state.paused || viewer.isDestroyed?.()) return;
      camera.startIdle();
    }, delay);
  };

  const fly = (request) => {
    stopOrbit();
    try {
      camera.tour(request);
    } catch (error) {
      console.warn('[Live] Flight failed:', error);
    }
  };

  const unsubscribe = queue.subscribe(({ state, event }) => {
    // Any step of the line ends a free flight; resuming flies back to the
    // request that was on screen, since the camera was elsewhere.
    const leftFreeFlight =
      freeFlight !== null &&
      ['show', 'resumed', 'idle', 'cleared'].includes(event.type);
    if (leftFreeFlight) freeFlight = null;
    if (event.type === 'show') fly(event.request);
    else if (event.type === 'paused') stopOrbit();
    else if (leftFreeFlight && event.type === 'resumed' && state.current)
      fly(state.current);
    else if (event.type === 'resumed' && camera.userControl) camera.resume();
    else if (
      !state.current &&
      !state.paused &&
      ['idle', 'cleared', 'resumed'].includes(event.type)
    )
      startIdleOrbit();
    render(state);
    relay?.publish();
  });

  const cleanView = () => {
    Promise.resolve(run('set_hud', { visible: 'off' })).catch(() => {});
    const scope = document.getElementById('scope-toggle');
    if (
      scope &&
      (scope.classList.contains('active') ||
        scope.getAttribute('aria-pressed') === 'true')
    )
      scope.click();
  };
  for (const delay of CLEAN_VIEW_DELAYS_MS) later(cleanView, delay);

  // Switch only when needed, through the app's own map action, so an active
  // Google 3D is never reloaded and the view link follows the change.
  const checkMap = (final) => {
    let target = null;
    try {
      target = preferredLiveMap(mapStack?.getState?.(), { final });
    } catch {
      return;
    }
    if (target)
      Promise.resolve(run('set_map_stack', { stack: target })).catch(() => {});
  };
  if (mapStack)
    for (const { delayMs, final } of MAP_CHECKS)
      later(() => checkMap(final), delayMs);

  const tick = setInterval(() => {
    queue.update();
    render();
  }, TICK_MS);
  render();
  startIdleOrbit(STARTUP_IDLE_DELAY_MS);

  // Refused requests, newest first, so the control panel can say why.
  // Ordinary chat without a command is not a refusal and is not kept.
  const rejected = [];
  const reject = (entry, result) => {
    rejected.unshift({
      at: Date.now(),
      user: String(entry.user ?? ''),
      text: String(entry.text ?? ''),
      source: entry.source,
      reason: result.reason,
      ...(result.waitMs ? { waitMs: result.waitMs } : {}),
    });
    rejected.length = Math.min(rejected.length, REJECTED_KEPT);
    relay?.publish();
  };

  const submit = async (
    { user, text },
    { operator = false, source = 'console' } = {},
  ) => {
    const result = await queue.submit(
      { user, text },
      { signal: lifetime.signal, operator },
    );
    // Chat without a command, and requests the streamer removed while they
    // were being looked up, are not refusals.
    if (!result.ok && !['not-command', 'removed'].includes(result.reason))
      reject({ user, text, source }, result);
    return result;
  };

  /**
   * Volar ahora (sin cartel): fly straight to a place without a banner and
   * without joining the line. The line pauses and waits for Continuar (P).
   * The same rules as any request apply: aliases, no numbers or links, and
   * public places only.
   */
  const flyNow = async (place) => {
    const text = `!ir ${String(place ?? '').trim()}`;
    const entry = { user: '', text, source: 'panel-fly' };
    const parsed = parseLiveComment(text, config);
    if (!parsed.ok) {
      reject(entry, parsed);
      return parsed;
    }
    const resolved = await resolvePlace(parsed.query);
    const verdict = judgeLivePlace(resolved);
    if (!verdict.ok) {
      reject(entry, verdict);
      return verdict;
    }
    queue.pause();
    freeFlight = {
      place: parsed.place,
      country: resolved.country || null,
      lat: resolved.lat,
      lng: resolved.lng,
      types: [...(resolved.types || [])],
      viewport: resolved.viewport || null,
    };
    fly(freeFlight);
    render();
    relay?.publish();
    return { ok: true, place: { ...freeFlight } };
  };

  // Live aircraft, off by default (heavy on a laptop over a big city). The
  // app's own layer action shows and hides them.
  let flightsOn = false;
  // The app remembers its layers in the view link; live mode starts with the
  // aircraft off so the panel's "Aviones: NO" is true, even after Ctrl+R.
  const keepFlightsOff = () => {
    if (!flightsOn)
      Promise.resolve(
        run('set_layer_visibility', { layerId: 'flights', enabled: false }),
      ).catch(() => {});
  };
  for (const delay of CLEAN_VIEW_DELAYS_MS) later(keepFlightsOff, delay);
  const toggleFlights = async () => {
    const enabled = !flightsOn;
    await run('set_layer_visibility', { layerId: 'flights', enabled });
    flightsOn = enabled;
    relay?.publish();
    return { ok: true, flights: flightsOn };
  };

  const api = {
    submit,
    toggleFlights,
    flyNow,
    next: () => queue.next(),
    skip: () => queue.skip(),
    extend: () => queue.extend(),
    remove: (id) => queue.remove(id),
    promote: (id) => queue.promote(id),
    pause: () => queue.pause(),
    resume: () => queue.resume(),
    togglePause: () => queue.togglePause(),
    clearLine: () => queue.clearLine(),
    clear: () => queue.clear(),
    getState: () => queue.getState(),
  };
  window.__gevLive = api;

  relay = connectLiveRelay({
    api,
    getState: () => ({
      at: Date.now(),
      displayMs: config.displaySeconds * 1000,
      ...queue.getState(),
      flights: flightsOn,
      freeFlight: freeFlight
        ? { place: freeFlight.place, country: freeFlight.country }
        : null,
      rejected: rejected.map((entry) => ({ ...entry })),
    }),
  });

  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', cleanup);
    lifetime.abort();
    clearInterval(tick);
    for (const id of timers) clearTimeout(id);
    timers.clear();
    stopOrbit();
    camera.destroy();
    unsubscribe();
    relay.close();
    overlay.destroy();
    if (window.__gevLive === api) delete window.__gevLive;
  };
  signal?.addEventListener('abort', cleanup, { once: true });
  return cleanup;
}
