import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveVoice, HOLD_TIMEOUT_MS } from './voiceControl.js';
import { voicePanel } from './control/panelModel.js';
import { sanitizeLiveCommand } from '../../server/live/relay.js';

/** A stand-in for the app's voice controller, recording what is asked of it. */
function fakeController() {
  const calls = [];
  let active = false;
  const controller = {
    status: 'idle',
    isActive: () => active,
    stop: () => {
      calls.push('stop');
      active = false;
    },
    _input: {
      pushToTalkKeyHeld: false,
      start: ({ pushToTalk }) => {
        calls.push(`start:${pushToTalk}`);
        active = true;
      },
      setMicrophoneEnabled: (on) => calls.push(`mic:${on}`),
      releasePushToTalkKey: () => calls.push('release'),
      pauseRadioForVoice: () => calls.push('radio-paused'),
    },
    _cost: {
      voiceTier: 'standard',
      setVoiceTier(tier) {
        this.voiceTier = tier;
        return tier;
      },
      costTracker: {
        state: () => ({ display: '$0.03', tier: 'mini', capReached: false }),
      },
    },
  };
  return { controller, calls };
}

/** Timers the test advances by hand. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map();
  return {
    setTimer: (fn, ms) => {
      const id = next++;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id) => pending.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...pending])
        if (timer.at <= now) {
          pending.delete(id);
          timer.fn();
        }
    },
  };
}

test('voice: hold starts listening, release stops, the session stays for the answer', () => {
  const { controller, calls } = fakeController();
  const timers = fakeTimers();
  let talks = 0;
  const voice = createLiveVoice({
    getController: () => controller,
    onTalk: () => talks++,
    ...timers,
  });
  assert.equal(voice.preferMini(), true);
  assert.equal(controller._cost.voiceTier, 'mini');

  assert.equal(voice.press(), true);
  assert.equal(talks, 1, 'talking pauses the line');
  assert.deepEqual(calls, ['radio-paused', 'start:true']);
  assert.equal(voice.state().listening, true);
  assert.equal(voice.state().active, true);
  assert.equal(voice.state().cost, '$0.03');

  voice.release();
  assert.equal(calls.at(-1), 'release');
  assert.equal(voice.state().listening, false);
  assert.equal(voice.state().active, true, 'the reply can still play');

  // The next hold reuses the open session: only the microphone opens.
  voice.press();
  assert.equal(calls.at(-1), 'mic:true');
  voice.release();
  voice.stop();
  assert.equal(calls.at(-1), 'stop');
  assert.equal(voice.state().active, false);
});

test('voice: a hold that stops sending heartbeats is released by itself', () => {
  const { controller, calls } = fakeController();
  const timers = fakeTimers();
  const voice = createLiveVoice({ getController: () => controller, ...timers });
  voice.press();
  timers.advance(HOLD_TIMEOUT_MS - 1000);
  voice.hold();
  timers.advance(HOLD_TIMEOUT_MS - 1000);
  assert.equal(voice.state().listening, true, 'heartbeats keep it open');
  timers.advance(1001);
  assert.equal(voice.state().listening, false);
  assert.equal(calls.at(-1), 'release');
});

test('voice: if the app changes, it says "Voz no disponible" and does nothing', () => {
  const voice = createLiveVoice({ getController: () => ({ status: 'idle' }) });
  assert.deepEqual(voice.state(), {
    available: false,
    active: false,
    listening: false,
  });
  assert.equal(voice.press(), false);
  assert.equal(voice.preferMini(), false);
  assert.equal(voice.stop(), false);
  assert.equal(voicePanel(voice.state()).text, 'Voz no disponible');

  // A controller that throws mid-way is caught, not passed on to live mode.
  const { controller } = fakeController();
  controller._input.start = () => {
    throw new Error('internals changed');
  };
  const broken = createLiveVoice({ getController: () => controller });
  assert.equal(broken.press(), false);
  assert.equal(broken.state().available, false);
});

test('panel voice block and relay commands', () => {
  assert.deepEqual(voicePanel(null), {
    available: false,
    listening: false,
    text: 'Voz no disponible',
    cost: '',
  });
  const voice = {
    available: true,
    active: true,
    listening: false,
    status: 'speaking',
    cost: '$0.03',
    tier: 'mini',
  };
  assert.equal(voicePanel(voice).text, 'Voz: respondiendo…');
  assert.equal(voicePanel(voice).cost, 'Gasto de la sesión: $0.03 · MINI');
  assert.equal(voicePanel(voice, true).text, '🎙 ESCUCHANDO');
  assert.equal(voicePanel(voice, true).listening, true);
  assert.equal(
    voicePanel({ ...voice, active: false }).text,
    'Voz: apagada — mantén Espacio para hablar',
  );
  assert.match(
    voicePanel({ ...voice, active: false, status: 'error' }).text,
    /^Voz: error — revisa el permiso del micrófono/,
  );
  for (const type of ['voicePress', 'voiceHold', 'voiceRelease', 'voiceStop'])
    assert.deepEqual(sanitizeLiveCommand({ type, x: 1 }), { type });
});
