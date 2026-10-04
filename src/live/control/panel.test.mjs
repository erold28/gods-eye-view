import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatClock,
  normalizeUser,
  placeWithCountry,
  rejectionText,
  remainingNow,
  shortcutFor,
  sourceText,
} from './panelModel.js';
import {
  LIVE_CONTROL_PAGE,
  liveControlPagePath,
} from '../../../server/live/relay.js';
import { createLiveRequestQueue } from '../requestQueue.js';
import { LIVE_CONFIG } from '../config.js';

test('panel: a typed user always becomes an @handle', () => {
  assert.equal(normalizeUser('juan'), '@juan');
  assert.equal(normalizeUser('@juan'), '@juan');
  assert.equal(normalizeUser('  @@juan  '), '@juan');
  assert.equal(normalizeUser('juan perez'), '@juanperez');
  assert.equal(normalizeUser(''), '');
  assert.equal(normalizeUser('   '), '');
  assert.equal(normalizeUser('@'), '');
});

test('panel: refusals read in plain Spanish', () => {
  assert.equal(
    rejectionText({ reason: 'private-place' }),
    'es una calle o dirección',
  );
  assert.equal(
    rejectionText({ reason: 'not-public-place' }),
    'no es una ciudad ni lugar público',
  );
  assert.equal(
    rejectionText({ reason: 'has-numbers' }),
    'tiene números (parece dirección o coordenadas)',
  );
  assert.equal(
    rejectionText({ reason: 'user-cooldown', waitMs: 41_200 }),
    'este usuario debe esperar 42 s',
  );
  assert.equal(rejectionText({ reason: 'duplicate' }), 'ya está en la fila');
  assert.equal(rejectionText({ reason: 'algo-nuevo' }), 'algo-nuevo');
  assert.equal(sourceText('panel-fly'), 'volar ahora');
  assert.equal(
    placeWithCountry({ place: 'Lima', country: 'Perú' }),
    'Lima, Perú',
  );
  assert.equal(placeWithCountry({ place: 'Egipto', country: null }), 'Egipto');
});

test('panel: countdown keeps moving between updates unless paused', () => {
  const state = { current: {}, remainingMs: 20_000, at: 1_000, paused: false };
  assert.equal(remainingNow(state, 6_000), 15_000);
  assert.equal(remainingNow({ ...state, paused: true }, 6_000), 20_000);
  assert.equal(remainingNow(state, 60_000), 0);
  assert.equal(remainingNow({ current: null }, 0), 0);
  assert.equal(formatClock(14_200), '0:15');
  assert.equal(formatClock(75_000), '1:15');
});

test('panel: N S P E act only outside text fields and without modifiers', () => {
  const key = (key, extra = {}) => ({
    key,
    target: { tagName: 'BODY' },
    ...extra,
  });
  assert.equal(shortcutFor(key('n')), 'next');
  assert.equal(shortcutFor(key('N')), 'next');
  assert.equal(shortcutFor(key('s')), 'skip');
  assert.equal(shortcutFor(key('p')), 'togglePause');
  assert.equal(shortcutFor(key('e')), 'extend');
  assert.equal(shortcutFor(key('a')), 'toggleFlights');
  assert.equal(shortcutFor(key('n', { target: { tagName: 'INPUT' } })), null);
  assert.equal(
    shortcutFor(key('n', { target: { isContentEditable: true } })),
    null,
  );
  assert.equal(
    shortcutFor(key('n', { target: { tagName: 'BUTTON' } })),
    'next',
  );
  assert.equal(shortcutFor(key('s', { ctrlKey: true })), null);
  assert.equal(shortcutFor(key('p', { repeat: true })), null);
  assert.equal(shortcutFor(key('x')), null);
});

test('panel page is served at /live-control', () => {
  assert.equal(liveControlPagePath('/live-control'), LIVE_CONTROL_PAGE);
  assert.equal(liveControlPagePath('/live-control/'), LIVE_CONTROL_PAGE);
  assert.equal(
    liveControlPagePath('/live-control?x=1'),
    `${LIVE_CONTROL_PAGE}?x=1`,
  );
  assert.equal(liveControlPagePath('/live-controls'), null);
  assert.equal(liveControlPagePath('/'), null);
});

test('queue: Extender adds time to the place on screen, paused or not', async () => {
  let time = 0;
  const queue = createLiveRequestQueue({
    now: () => time,
    resolvePlace: async (query) => ({
      lat: 1,
      lng: 2,
      label: query,
      types: ['locality'],
    }),
  });
  const displayMs = LIVE_CONFIG.displaySeconds * 1000;
  const extendMs = LIVE_CONFIG.extendSeconds * 1000;
  assert.equal(queue.extend(), false, 'nothing on screen');
  await queue.submit({ user: 'a', text: '!ir Lima' });
  time += 5_000;
  assert.equal(queue.extend(), true);
  assert.equal(queue.getState().remainingMs, displayMs - 5_000 + extendMs);
  queue.pause();
  queue.extend();
  assert.equal(queue.getState().remainingMs, displayMs - 5_000 + 2 * extendMs);
  queue.resume();
  time += displayMs - 5_000 + 2 * extendMs - 1;
  queue.update();
  assert.equal(queue.getState().current.place, 'Lima');
  time += 1;
  queue.update();
  assert.equal(queue.getState().current, null);
});

test('queue: Vaciar fila empties the line but keeps the place on screen', async () => {
  const queue = createLiveRequestQueue({
    now: () => 0,
    resolvePlace: async (query) => ({
      lat: 1,
      lng: 2,
      label: query,
      types: ['locality'],
    }),
  });
  for (const [user, place] of [
    ['a', 'Lima'],
    ['b', 'Quito'],
    ['c', 'Roma'],
  ])
    await queue.submit({ user, text: `!ir ${place}` });
  assert.equal(queue.clearLine(), 2);
  assert.equal(queue.getState().current.place, 'Lima');
  assert.deepEqual(queue.getState().upcoming, []);
});
