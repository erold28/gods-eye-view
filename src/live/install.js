import * as Cesium from 'cesium';
import { OrbitController } from '../orbit.js';
import { LIVE_CONFIG } from './config.js';
import { createCountryLookup } from './countryNames.js';
import { liveFlightRangeM } from './framing.js';
import { createLiveOverlay } from './overlay.js';
import { createLiveRequestQueue } from './requestQueue.js';
import './overlay.css';

const TICK_MS = 250;
/** Waiting-mode spin, degrees per second: one turn every three minutes. */
const IDLE_ORBIT_DEG_PER_S = 2;
/** Pause after the line empties before the waiting spin starts. */
const IDLE_DELAY_MS = 4000;
/** The startup camera intro finishes before the first waiting spin. */
const STARTUP_IDLE_DELAY_MS = 9000;
/** The app restores its visual state while starting, so the clean view is re-applied. */
const CLEAN_VIEW_DELAYS_MS = Object.freeze([0, 2000, 8000]);

/** Whether this page was opened for streaming with `?live=1`. */
export function isLiveMode(location = globalThis.location) {
  return new URLSearchParams(location?.search || '').get('live') === '1';
}

/** The ground point at the centre of the screen, or null over empty space. */
function screenCenterTarget(viewer) {
  const { scene, camera } = viewer;
  const center = new Cesium.Cartesian2(
    scene.canvas.clientWidth / 2,
    scene.canvas.clientHeight / 2,
  );
  const ray = camera.getPickRay(center);
  return (
    (ray && scene.globe?.show && scene.globe.pick(ray, scene)) ||
    camera.pickEllipsoid(center) ||
    null
  );
}

/**
 * Live mode for streaming: requests from comments fly the camera, with the
 * request overlay on top. Does nothing unless the page has `?live=1`.
 *
 * `run(name, args)` runs an app action (the same ones voice uses), so flights
 * and the HUD go through the app's own camera and display rules.
 *
 * Until the comment route lands, requests can be sent from the browser
 * console: `__gevLive.submit({ user: 'ana', text: '!ir París' })`.
 * @returns {() => void} cleanup
 */
export function installLiveMode({
  viewer,
  placeSearch,
  run,
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
  const queue = createLiveRequestQueue({
    config,
    async resolvePlace(query, options = {}) {
      const outcome = await placeSearch.geocode(query, {
        signal: AbortSignal.any(
          [lifetime.signal, options.signal].filter(Boolean),
        ),
      });
      const place = outcome.place;
      if (!place) return null;
      // The country only labels the overlay; a failed lookup never refuses.
      const country = await countries
        .countryAt(place.lat, place.lng)
        .catch(() => null);
      return { ...place, country: country?.name || null };
    },
  });
  const overlay = createLiveOverlay({ document, config });
  const orbit = new OrbitController(viewer);
  let idleTimer = null;

  const stopOrbit = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    timers.delete(idleTimer);
    idleTimer = null;
    if (orbit.active) orbit.stop();
  };

  const startIdleOrbit = (delay = IDLE_DELAY_MS) => {
    stopOrbit();
    idleTimer = later(() => {
      idleTimer = null;
      const state = queue.getState();
      if (state.current || state.paused || viewer.isDestroyed?.()) return;
      const target = screenCenterTarget(viewer);
      if (!target) return;
      const radius = Cesium.Cartesian3.distance(
        viewer.camera.positionWC,
        target,
      );
      const pitch = Cesium.Math.clamp(
        Cesium.Math.toDegrees(viewer.camera.pitch),
        -89,
        -15,
      );
      orbit.start(target, { radius, pitch, speed: IDLE_ORBIT_DEG_PER_S });
    }, delay);
  };

  const fly = (request) => {
    stopOrbit();
    Promise.resolve(
      run('fly_to_location', {
        latitude: request.lat,
        longitude: request.lng,
        rangeM: liveFlightRangeM(request),
      }),
    ).catch((error) => console.warn('[Live] Flight failed:', error));
  };

  const unsubscribe = queue.subscribe(({ state, event }) => {
    if (event.type === 'show') fly(event.request);
    else if (event.type === 'paused') stopOrbit();
    else if (
      !state.current &&
      !state.paused &&
      ['idle', 'cleared', 'resumed'].includes(event.type)
    )
      startIdleOrbit();
    overlay.render(state);
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

  const tick = setInterval(() => {
    queue.update();
    overlay.render(queue.getState());
  }, TICK_MS);
  overlay.render(queue.getState());
  startIdleOrbit(STARTUP_IDLE_DELAY_MS);

  const api = {
    submit: (comment) => queue.submit(comment, { signal: lifetime.signal }),
    next: () => queue.next(),
    skip: () => queue.skip(),
    remove: (id) => queue.remove(id),
    pause: () => queue.pause(),
    resume: () => queue.resume(),
    togglePause: () => queue.togglePause(),
    clear: () => queue.clear(),
    getState: () => queue.getState(),
  };
  window.__gevLive = api;

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
    unsubscribe();
    overlay.destroy();
    if (window.__gevLive === api) delete window.__gevLive;
  };
  signal?.addEventListener('abort', cleanup, { once: true });
  return cleanup;
}
