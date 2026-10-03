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
 *
 * A request keeps the place in line it had when it ARRIVED, not when its
 * lookup finished: it is reserved at once with `status: 'pending'`, filled in
 * as `'ready'` when the place is accepted, and taken out if it is refused. The
 * line never shows past a pending request at its head; it waits for it.
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

  /** Whether the head of the line is ready to go on screen. */
  const headReady = () => upcoming[0]?.status === 'ready';

  const advance = (outcome) => {
    const finished = current;
    current = null;
    if (finished) emit({ type: outcome, request: { ...finished } });
    if (headReady()) show(upcoming.shift());
    else if (upcoming.length) emit({ type: 'waiting' });
    else emit({ type: 'idle' });
  };

  const isDuplicate = (key, exceptId = null) =>
    (current && placeKey(current) === key) ||
    upcoming.some(
      (request) => request.id !== exceptId && placeKey(request) === key,
    );

  /** Start the head of the line when the screen is free and it is ready. */
  const startIfFree = () => {
    if (!current && pausedRemaining === null && headReady()) advance(null);
  };

  /** Take a reserved request out of the line, if it is still there. */
  const drop = (id, reason) => {
    const index = upcoming.findIndex((request) => request.id === id);
    if (index < 0) return;
    const [dropped] = upcoming.splice(index, 1);
    emit({ type: 'dropped', reason, request: { ...dropped } });
    // A refused head no longer holds back the requests behind it.
    startIfFree();
  };

  return {
    getState: snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Read one comment and queue it when it passes every rule. Resolves to
     * `{ ok: true, request }` or `{ ok: false, reason }`; a cooldown refusal
     * also carries `waitMs`.
     *
     * `operator: true` marks a request typed in the control panel: it skips
     * the per-user wait (the streamer may transcribe several viewers in a row)
     * and does not start one, but every other rule still applies.
     */
    async submit({ user, text }, { signal, operator = false } = {}) {
      const parsed = parseLiveComment(text, config);
      if (!parsed.ok) return parsed;
      const userKey = foldText(user) || '(anónimo)';
      if (!operator) {
        const last = lastAccepted.get(userKey);
        if (last !== undefined && now() - last < cooldownMs)
          return {
            ok: false,
            reason: 'user-cooldown',
            waitMs: last + cooldownMs - now(),
          };
        if (resolving.has(userKey))
          return { ok: false, reason: 'user-cooldown', waitMs: cooldownMs };
      }
      if (upcoming.length >= config.maxQueue)
        return { ok: false, reason: 'queue-full' };
      if (isDuplicate(foldText(parsed.query)))
        return { ok: false, reason: 'duplicate' };

      // Reserve the place in line now, in arrival order.
      const typedUser = String(user ?? '').trim();
      const request = {
        id: nextId++,
        status: 'pending',
        user: typedUser || (operator ? config.operatorName : '(anónimo)'),
        // The streamer's own request: shown by name, without an "@".
        streamer: operator && !typedUser,
        command: parsed.command,
        place: parsed.place,
        query: parsed.query,
      };
      upcoming.push(request);
      emit({ type: 'reserved', request: { ...request } });

      if (!operator) resolving.add(userKey);
      let place;
      try {
        place = await resolvePlace(parsed.query, { signal });
      } catch (error) {
        drop(request.id, 'failed');
        throw error;
      } finally {
        if (!operator) resolving.delete(userKey);
      }
      // Borrar or a clear while the lookup ran: the reservation is gone.
      if (!upcoming.includes(request)) return { ok: false, reason: 'removed' };
      const verdict = judgeLivePlace(place);
      if (!verdict.ok) {
        drop(request.id, verdict.reason);
        return verdict;
      }
      Object.assign(request, {
        status: 'ready',
        label: place.label || place.name || parsed.query,
        lat: place.lat,
        lng: place.lng,
        types: [...(place.types || [])],
        viewport: place.viewport || null,
        country: place.country || null,
      });
      // Another spelling of a place already in line ("Paris" and "París").
      if (isDuplicate(placeKey(request), request.id)) {
        drop(request.id, 'duplicate');
        return { ok: false, reason: 'duplicate' };
      }
      if (!operator) lastAccepted.set(userKey, now());
      emit({ type: 'queued', request: { ...request } });
      startIfFree();
      return { ok: true, request: { ...request } };
    },

    /** Move time forward: start the first request, or end one whose time is up. */
    update() {
      if (pausedRemaining !== null) return;
      if (!current) {
        if (headReady()) advance(null);
        return;
      }
      if (now() - shownAt >= displayMs) advance('done');
    },

    /** Siguiente: finish the place on screen now and show the next one. */
    next() {
      if (current || headReady()) advance('done');
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
      startIfFree();
      return true;
    },

    /** Subir al primer lugar: move a waiting request to the front of the line. */
    promote(id) {
      const index = upcoming.findIndex((request) => request.id === id);
      if (index < 0) return false;
      const [promoted] = upcoming.splice(index, 1);
      upcoming.unshift(promoted);
      emit({ type: 'promoted', request: { ...promoted } });
      startIfFree();
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
      if (!current && headReady()) advance(null);
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
