/**
 * Push-to-talk voice for the live control panel.
 *
 * The streamer holds a key (or a button) in the PANEL window; the map window,
 * which owns the microphone and the voice session, starts listening and stops
 * as soon as the hold ends. It never stays open: a hold that stops sending its
 * heartbeat (the panel closed, lost focus or lost the connection) is released
 * after `HOLD_TIMEOUT_MS`.
 *
 * This drives the app's own voice controller (`window.__gevVoiceCommands`) the
 * way its Space shortcut does. Those are the author's internals, so every
 * access is guarded: if they change, `state().available` turns false, the panel
 * shows "Voz no disponible" and the rest of live mode carries on.
 */

/** The hold is released when no heartbeat arrives for this long. */
export const HOLD_TIMEOUT_MS = 6000;

/** The pieces of the app's voice controller this module relies on. */
function voiceParts(getController) {
  try {
    const controller = getController();
    const input = controller?._input;
    const cost = controller?._cost;
    if (
      typeof controller?.isActive !== 'function' ||
      typeof controller?.stop !== 'function' ||
      typeof input?.start !== 'function' ||
      typeof input?.setMicrophoneEnabled !== 'function' ||
      typeof input?.releasePushToTalkKey !== 'function' ||
      typeof cost?.costTracker?.state !== 'function'
    )
      return null;
    return { controller, input, cost };
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {() => object} [options.getController] the app's voice controller
 * @param {() => void} [options.onTalk] called when a hold starts (the line
 *   pauses and the tour lets go of the camera, so the voice can move it)
 * @param {() => void} [options.onChange] called when the voice state changes
 */
export function createLiveVoice({
  getController = () => globalThis.window?.__gevVoiceCommands,
  onTalk = () => {},
  onChange = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let holding = false;
  let watchdog = null;
  let failed = false;

  const guard = (fn, fallback) => {
    try {
      return fn();
    } catch (error) {
      console.warn('[Live] Voz no disponible:', error);
      failed = true;
      onChange();
      return fallback;
    }
  };

  const armWatchdog = () => {
    if (watchdog !== null) clearTimer(watchdog);
    watchdog = setTimer(() => {
      watchdog = null;
      release();
    }, HOLD_TIMEOUT_MS);
  };

  const release = () => {
    if (watchdog !== null) clearTimer(watchdog);
    watchdog = null;
    if (!holding) return false;
    holding = false;
    const parts = voiceParts(getController);
    if (parts) guard(() => parts.input.releasePushToTalkKey(), null);
    onChange();
    return true;
  };

  return {
    /** Live mode uses the cheaper MINI model by default. */
    preferMini() {
      const parts = voiceParts(getController);
      if (!parts || typeof parts.cost.setVoiceTier !== 'function') return false;
      return guard(() => parts.cost.setVoiceTier('mini') === 'mini', false);
    },

    /** Start listening (and the session, if it is not running yet). */
    press() {
      const parts = voiceParts(getController);
      if (!parts || failed) return false;
      armWatchdog();
      if (holding) return true;
      holding = true;
      onTalk();
      return guard(() => {
        const { controller, input } = parts;
        input.pauseRadioForVoice?.();
        input.pushToTalkKeyHeld = true;
        if (controller.isActive()) input.setMicrophoneEnabled(true);
        else input.start({ pushToTalk: true });
        onChange();
        return true;
      }, false);
    },

    /** The panel is still holding: keep listening a little longer. */
    hold() {
      if (holding) armWatchdog();
      return holding;
    },

    /** Stop listening; the AI finishes its answer. */
    release,

    /** End the voice session completely. */
    stop() {
      release();
      const parts = voiceParts(getController);
      if (!parts) return false;
      guard(() => parts.controller.stop(), null);
      onChange();
      return true;
    },

    /**
     * What the panel shows: `{ available, active, listening, status, cost,
     * tier }`. `cost` is the session's estimated spend ("$0.03").
     */
    state() {
      const parts = voiceParts(getController);
      if (!parts || failed)
        return { available: false, active: false, listening: false };
      return guard(
        () => {
          const meter = parts.cost.costTracker.state();
          return {
            available: true,
            active: Boolean(parts.controller.isActive()),
            listening: holding,
            status: String(parts.controller.status || 'idle'),
            cost: meter.display,
            tier: String(parts.cost.voiceTier || meter.tier || ''),
            capped: Boolean(meter.capReached),
          };
        },
        { available: false, active: false, listening: false },
      );
    },

    destroy() {
      release();
    },
  };
}
