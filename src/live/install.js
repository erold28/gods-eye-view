import { getSelectedEntityContext } from '../data/contextStore.js';
import { createLiveCamera } from './camera.js';
import { LIVE_CONFIG } from './config.js';
import { parseBlockedWordsText, parseLiveComment } from './commands.js';
import { createCountryLookup } from './countryNames.js';
import { preferredLiveMap } from './mapPreference.js';
import {
  judgeLivePlace,
  preferCityOverState,
  preferSettlementInArea,
} from './placePolicy.js';
import { normalizePhotonFeature, photonSearchUrl } from '../keylessGeocoder.js';
import {
  CARD_POSITIONS,
  createLiveOverlay,
  flightCardModel,
} from './overlay.js';
import { connectLiveRelay } from './relayClient.js';
import { createLiveVoice } from './voiceControl.js';
import { createLandmarkLabels } from './landmarks.js';
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
/**
 * The streamer's own list of blocked words, at the project root. It stays on
 * their PC (excluded from git); palabras-bloqueadas.ejemplo.txt is the
 * template the launcher copies when the list is missing.
 */
const BLOCKED_WORDS_URL = '/palabras-bloqueadas.txt';
const BLOCKED_WORDS_RELOAD_MS = 60 * 1000;
/** Layers whose selected contact gets a flight card (live and military). */
const AIRCRAFT_LAYERS = Object.freeze(['flights', 'military']);
/** How long after letting an aircraft go its re-selection is ignored. */
const RELEASE_ECHO_MS = 3000;
/** Search radius for a city's famous places, by camera kind (framing.js). */
const LANDMARK_RADIUS_KM = Object.freeze({
  bigCity: 10,
  city: 6,
  town: 3,
  neighborhood: 3,
  other: 5,
});
/** Refused requests the control panel lists. */
const REJECTED_KEPT = 20;

/** Settlement kinds asked of the keyless geocoder (OpenStreetMap place=*). */
const SETTLEMENT_TAGS = Object.freeze([
  'place:city',
  'place:town',
  'place:village',
]);

/**
 * Towns and cities called `name`, best first, from the app's keyless
 * geocoder (Photon), asking for settlements only.
 */
async function findSettlements(name, signal) {
  const url = new URL(photonSearchUrl(name, { limit: 5 }));
  for (const tag of SETTLEMENT_TAGS) url.searchParams.append('osm_tag', tag);
  const response = await fetch(url, {
    signal: AbortSignal.any(
      [signal, AbortSignal.timeout(6000)].filter(Boolean),
    ),
  });
  if (!response.ok) return [];
  const body = await response.json();
  return (body?.features || []).map(normalizePhotonFeature).filter(Boolean);
}

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
  dataManager = null,
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
    // A municipality or state answer ("Tapachula", "Puebla") points at the
    // middle of its land: prefer the town of that name inside it, then, for
    // large states, a second lookup as "Name, Name, Country".
    const town = await preferSettlementInArea(first, (name) =>
      findSettlements(name, signal),
    );
    const place =
      town === first
        ? await preferCityOverState(first, geocode, config.camera)
        : town;
    // The country only labels the overlay; a failed lookup never refuses.
    const country = await countries
      .countryAt(place.lat, place.lng)
      .catch(() => null);
    return { ...place, country: country?.name || null };
  };
  // The config the line reads at each request: blocked words from config.js
  // plus palabras-bloqueadas.txt, re-read every minute so edits apply live.
  const liveConfig = { ...config, blockedWords: [...config.blockedWords] };
  const loadBlockedWords = async () => {
    try {
      const response = await fetch(BLOCKED_WORDS_URL, {
        cache: 'no-store',
        signal: lifetime.signal,
      });
      // A missing file can come back as the app's page: only plain text counts.
      const type = response.headers.get('content-type') || '';
      if (!response.ok || !type.includes('text/plain')) return;
      liveConfig.blockedWords = [
        ...config.blockedWords,
        ...parseBlockedWordsText(await response.text()),
      ];
    } catch {
      // Keep the last list; the file is optional.
    }
  };
  loadBlockedWords();
  const blockedWordsTimer = setInterval(
    loadBlockedWords,
    BLOCKED_WORDS_RELOAD_MS,
  );
  const queue = createLiveRequestQueue({ config: liveConfig, resolvePlace });
  const landmarks = createLandmarkLabels({ viewer });
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
  /**
   * The aircraft layer whose contact is selected ("flights" or "military"),
   * or null. Its card replaces the banner and reads the app's live record.
   */
  let selectedAircraftLayer = null;
  let cockpitOn = false;
  /** Where the flight card sits: top, middle or bottom (panel key T). */
  let cardPosition = 'top';
  const selectedFlight = () =>
    selectedAircraftLayer ? flightCardModel(getSelectedEntityContext()) : null;
  const render = (state = queue.getState()) =>
    // In the cockpit its own instruments show the flight: no card or banner
    // over the view ahead.
    overlay.render(state, {
      freeFlight: Boolean(freeFlight) || cockpitOn,
      flight: cockpitOn ? null : selectedFlight(),
      cardPosition,
    });

  /**
   * Leaving the cockpit re-selects its aircraft for a moment on the app's
   * side; selections right after a release are that echo, not the streamer.
   */
  let releasedAt = -Infinity;
  /** Let go of the aircraft: leave the cockpit and stop following it. */
  const releaseAircraft = () => {
    if (cockpitOn || selectedAircraftLayer) releasedAt = Date.now();
    if (cockpitOn) {
      cockpitOn = false;
      Promise.resolve(run('control_cockpit', { action: 'exit' }))
        .catch(() => {})
        .then(keepFlightsOff);
    }
    if (selectedAircraftLayer) {
      selectedAircraftLayer = null;
      Promise.resolve(run('stop_tracking', {}))
        .catch(() => {})
        .then(keepFlightsOff);
    }
  };

  // Selecting an aircraft (a click, voice or the cockpit) shows its card and
  // pauses the line; Continuar (P) lets it go and returns to the tour.
  const onAircraftSelected = (event) => {
    if (!AIRCRAFT_LAYERS.includes(event?.detail?.layerId)) return;
    if (Date.now() - releasedAt < RELEASE_ECHO_MS) {
      Promise.resolve(run('stop_tracking', {})).catch(() => {});
      return;
    }
    selectedAircraftLayer = event.detail.layerId;
    // The app follows the aircraft with the camera; the tour steps aside.
    camera.yieldControl();
    queue.pause();
    render();
    relay?.publish();
  };
  const onAircraftCleared = (event) => {
    if (event?.detail?.layerId !== selectedAircraftLayer) return;
    selectedAircraftLayer = null;
    render();
    relay?.publish();
  };
  window.addEventListener('gev:awareness-subject-selected', onAircraftSelected);
  window.addEventListener('gev:awareness-subject-cleared', onAircraftCleared);

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

  const fly = (request, { keepLandmarks = false } = {}) => {
    stopOrbit();
    try {
      const plan = camera.tour(request);
      // A city's famous places are looked up during the 10 s flight; a flight
      // to one of them keeps the list of the city around it.
      if (keepLandmarks) return;
      const radiusKm = LANDMARK_RADIUS_KM[plan?.kind];
      if (radiusKm)
        landmarks
          .load(request.lat, request.lng, radiusKm)
          .then(() => relay?.publish());
      else landmarks.clear();
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
    // Moving on (next city, or Continuar) lets go of a selected aircraft.
    if (['show', 'resumed'].includes(event.type)) releaseAircraft();
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
  /**
   * "Ir" in the panel's list of famous places: fly there like Volar ahora,
   * with the line paused; P returns to the city's tour.
   */
  const flyToLandmark = (id) => {
    const place = landmarks.find(String(id ?? ''));
    if (!place) return { ok: false, reason: 'not-found' };
    queue.pause();
    freeFlight = {
      place: place.name,
      country: queue.getState().current?.country || null,
      lat: place.lat,
      lng: place.lng,
      types: ['landmark'],
      viewport: null,
    };
    fly(freeFlight, { keepLandmarks: true });
    render();
    relay?.publish();
    return { ok: true, place: place.name };
  };

  const flyNow = async (place) => {
    const text = `!ir ${String(place ?? '').trim()}`;
    const entry = { user: '', text, source: 'panel-fly' };
    const parsed = parseLiveComment(text, liveConfig);
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
  // app's own layer action shows and hides them. `wantFlights` is the
  // streamer's choice; the panel shows whether the layer is really on, since
  // selecting an aircraft or entering the cockpit turns it on by itself.
  let wantFlights = false;
  const flightsVisible = () =>
    dataManager?.layers?.get?.('flights')?.enabled ?? wantFlights;
  // The app remembers its layers in the view link; live mode starts with the
  // aircraft off, even after Ctrl+R, and turns them off again after an
  // aircraft is let go if the streamer had them off.
  const keepFlightsOff = () => {
    if (!wantFlights && !selectedAircraftLayer && !cockpitOn)
      Promise.resolve(
        run('set_layer_visibility', { layerId: 'flights', enabled: false }),
      ).catch(() => {});
  };
  for (const delay of CLEAN_VIEW_DELAYS_MS) later(keepFlightsOff, delay);

  /**
   * Cabina: enter the cockpit of the selected aircraft (or the app's choice
   * among those in view), or leave it. The tour lets go of the camera and
   * the line pauses; Continuar (P) leaves the cockpit and resumes the tour.
   */
  const toggleCockpit = async () => {
    if (cockpitOn) {
      cockpitOn = false;
      await run('control_cockpit', { action: 'exit' });
      keepFlightsOff();
    } else {
      camera.yieldControl();
      queue.pause();
      const result = await run('control_cockpit', {
        action: 'enter',
        targetLayer: selectedAircraftLayer || 'flights',
      });
      cockpitOn = result?.ok !== false;
    }
    relay?.publish();
    return { ok: true, cockpit: cockpitOn };
  };

  // Voz (mantener para hablar) from the panel. Talking pauses the line and
  // hands the camera over, so the voice can fly it; P returns to the tour.
  const voice = createLiveVoice({
    onTalk: () => {
      camera.yieldControl();
      queue.pause();
    },
    onChange: () => relay?.publish(),
  });
  // The voice controller is ready once the app has started: MINI by default.
  later(() => voice.preferMini(), 1000);

  /** Tarjeta: move the flight card to the next position. */
  const cycleCardPosition = () => {
    const next =
      (CARD_POSITIONS.indexOf(cardPosition) + 1) % CARD_POSITIONS.length;
    cardPosition = CARD_POSITIONS[next];
    render();
    relay?.publish();
    return { ok: true, cardPosition };
  };

  const toggleFlights = async () => {
    const enabled = !flightsVisible();
    wantFlights = enabled;
    await run('set_layer_visibility', { layerId: 'flights', enabled });
    relay?.publish();
    return { ok: true, flights: flightsVisible() };
  };

  const api = {
    submit,
    toggleFlights,
    toggleCockpit,
    cycleCardPosition,
    flyToLandmark,
    toggleLandmarks: () => {
      landmarks.setVisible(!landmarks.visible);
      relay?.publish();
      return { ok: true, landmarks: landmarks.visible };
    },
    voicePress: () => voice.press(),
    voiceHold: () => voice.hold(),
    voiceRelease: () => voice.release(),
    voiceStop: () => voice.stop(),
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
      flights: flightsVisible(),
      cockpit: cockpitOn,
      cardPosition,
      voice: voice.state(),
      landmarks: { visible: landmarks.visible, list: landmarks.list },
      aircraft: selectedFlight(),
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
    clearInterval(blockedWordsTimer);
    voice.destroy();
    landmarks.clear();
    window.removeEventListener(
      'gev:awareness-subject-selected',
      onAircraftSelected,
    );
    window.removeEventListener(
      'gev:awareness-subject-cleared',
      onAircraftCleared,
    );
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
