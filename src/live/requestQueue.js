import { parseLiveComment } from './commands.js';
import { LIVE_CONFIG } from './config.js';
import { judgeLivePlace } from './placePolicy.js';
import { foldText } from './text.js';

/**
 * The live request line: one place on screen, the rest waiting.
 *
 * `resolvePlace(query, { signal })` looks a place up and returns a normalized
 * geocode place or null. Time only moves when the owner calls `update()`, so
 * the queue holds no timers and tests drive it with a fake clock.
 *
 * Listeners receive `{ state, event }`. `event.type === 'show'` carries the
 * request the camera should now fly to.
 */
export function createLiveRequestQueue({
  resolvePlace,
  config = LIVE_CONFIG,
  now = Date.now,
} = {}) {
  if (typeof resolvePlace !== 'function')
    throw new TypeError('resolvePlace is required');
  const displayMs = config.displaySeconds * 1000;
  const cooldownMs = config.userCooldownSeconds * 1000;
  const listeners = new Set();
  const lastAccepted = new Map();
  const resolving = new Set();
  let upcoming = [];
  let current = null;
  let shownAt = 0;
  let pausedRemaining = null;
  let nextId = 1;

  const placeKey = (request) => foldText(request.label || request.query);

  const snapshot = () => ({
    current: current ? { ...current } : null,
    upcoming: upcoming.map((request) => ({ ...request })),
    paused: pausedRemaining !== null,
    remainingMs: current
      ? (pausedRemaining ?? Math.max(0, shownAt + displayMs - now()))
      : 0,
  });

  const emit = (event) => {
    const state = snapshot();
    for (const listener of listeners) listener({ state, event });
  };

  const show = (request) => {
    current = request;
    shownAt = now();
    if (pausedRemaining !== null) pausedRemaining = displayMs;
    emit({ type: 'show', request: { ...request } });
  };

  const advance = (outcome) => {
    const finished = current;
    current = null;
    if (finished) emit({ type: outcome, request: { ...finished } });
    const next = upcoming.shift();
    if (next) show(next);
    else emit({ type: 'idle' });
  };

  const isDuplicate = (key) =>
    (current && placeKey(current) === key) ||
    upcoming.some((request) => placeKey(request) === key);

  return {
    getState: snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Read one comment and queue it when it passes every rule. Resolves to
     * `{ ok: true, request }` or `{ ok: false, reason }`.
     */
    async submit({ user, text }, { signal } = {}) {
      const parsed = parseLiveComment(text, config);
      if (!parsed.ok) return parsed;
      const userKey = foldText(user) || '(anónimo)';
      const last = lastAccepted.get(userKey);
      if (last !== undefined && now() - last < cooldownMs)
        return { ok: false, reason: 'user-cooldown' };
      if (resolving.has(userKey)) return { ok: false, reason: 'user-cooldown' };
      if (upcoming.length >= config.maxQueue)
        return { ok: false, reason: 'queue-full' };
      if (isDuplicate(foldText(parsed.query)))
        return { ok: false, reason: 'duplicate' };

      resolving.add(userKey);
      let place;
      try {
        place = await resolvePlace(parsed.query, { signal });
      } finally {
        resolving.delete(userKey);
      }
      const verdict = judgeLivePlace(place);
      if (!verdict.ok) return verdict;

      const request = {
        id: nextId++,
        user: String(user ?? '').trim() || '(anónimo)',
        command: parsed.command,
        place: parsed.place,
        query: parsed.query,
        label: place.label || place.name || parsed.query,
        lat: place.lat,
        lng: place.lng,
        types: [...(place.types || [])],
        viewport: place.viewport || null,
        country: place.country || null,
      };
      // Checked again: the lookup was asynchronous and the line may have moved.
      if (upcoming.length >= config.maxQueue)
        return { ok: false, reason: 'queue-full' };
      if (isDuplicate(placeKey(request)))
        return { ok: false, reason: 'duplicate' };
      lastAccepted.set(userKey, now());
      upcoming.push(request);
      emit({ type: 'queued', request: { ...request } });
      if (!current && pausedRemaining === null) advance(null);
      return { ok: true, request: { ...request } };
    },

    /** Move time forward: start the first request, or end one whose time is up. */
    update() {
      if (pausedRemaining !== null) return;
      if (!current) {
        if (upcoming.length) advance(null);
        return;
      }
      if (now() - shownAt >= displayMs) advance('done');
    },

    /** Siguiente: finish the place on screen now and show the next one. */
    next() {
      if (current || upcoming.length) advance('done');
    },

    /** Saltar: drop the place on screen without letting it finish. */
    skip() {
      if (current) advance('skipped');
    },

    /** Borrar: take any waiting request out of the line. */
    remove(id) {
      const index = upcoming.findIndex((request) => request.id === id);
      if (index < 0) return false;
      const [removed] = upcoming.splice(index, 1);
      emit({ type: 'removed', request: { ...removed } });
      return true;
    },

    /** Pausa: freeze the countdown. New requests still join the line. */
    pause() {
      if (pausedRemaining !== null) return;
      pausedRemaining = current
        ? Math.max(0, shownAt + displayMs - now())
        : displayMs;
      emit({ type: 'paused' });
    },

    resume() {
      if (pausedRemaining === null) return;
      shownAt = now() - (displayMs - pausedRemaining);
      pausedRemaining = null;
      emit({ type: 'resumed' });
      if (!current && upcoming.length) advance(null);
    },

    togglePause() {
      if (pausedRemaining === null) this.pause();
      else this.resume();
    },

    /** Empty the line and the screen, and forget per-user waits. */
    clear() {
      upcoming = [];
      current = null;
      lastAccepted.clear();
      emit({ type: 'cleared' });
    },
  };
}
