import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLiveComment } from './commands.js';
import { resolveKreyolAlias } from './kreyolAliases.js';
import { judgeLivePlace } from './placePolicy.js';
import { createLiveRequestQueue } from './requestQueue.js';
import { LIVE_CONFIG } from './config.js';

const city = (label, extra = {}) => ({
  lat: 10,
  lng: 20,
  label,
  types: ['locality'],
  ...extra,
});

function harness({ config = LIVE_CONFIG, places = {} } = {}) {
  let time = 1_000_000;
  const events = [];
  const queue = createLiveRequestQueue({
    config,
    now: () => time,
    resolvePlace: async (query) =>
      query in places ? places[query] : city(query),
  });
  queue.subscribe(({ event }) => events.push(event));
  return {
    queue,
    events,
    shows: () =>
      events.filter((e) => e.type === 'show').map((e) => e.request.label),
    advance(seconds) {
      time += seconds * 1000;
      queue.update();
    },
  };
}

test('commands: !ir and !ale in any case, with or without accents', () => {
  assert.deepEqual(parseLiveComment('!ir París'), {
    ok: true,
    command: '!ir',
    place: 'París',
    query: 'París',
  });
  assert.equal(parseLiveComment('!IR   Lima ').place, 'Lima');
  assert.equal(parseLiveComment('!ale Okap').query, 'Cap-Haïtien, Haiti');
  assert.equal(parseLiveComment('!Alé Jakmel').query, 'Jacmel, Haiti');
});

test('commands: ordinary chat and unknown commands are ignored', () => {
  assert.equal(parseLiveComment('hola desde Lima').reason, 'not-command');
  assert.equal(parseLiveComment('!go Paris').reason, 'not-command');
  assert.equal(parseLiveComment('!irParis').reason, 'not-command');
  assert.equal(parseLiveComment('!ir').reason, 'empty');
});

test('commands: numbers, links, mentions and long text are refused', () => {
  assert.equal(parseLiveComment('!ir Calle 5 #123').reason, 'has-numbers');
  assert.equal(parseLiveComment('!ir 18.54, -72.33').reason, 'has-numbers');
  assert.equal(
    parseLiveComment('!ir www.example.com/x').reason,
    'link-or-mention',
  );
  assert.equal(parseLiveComment('!ir @alguien').reason, 'link-or-mention');
  assert.equal(parseLiveComment(`!ir ${'a'.repeat(61)}`).reason, 'too-long');
});

test('commands: blocked words and phrases', () => {
  const config = { ...LIVE_CONFIG, blockedWords: ['feo', 'muy malo'] };
  assert.equal(
    parseLiveComment('!ir Ciudad Feó', config).reason,
    'blocked-word',
  );
  assert.equal(
    parseLiveComment('!ir lugar muy malo', config).reason,
    'blocked-word',
  );
  assert.equal(parseLiveComment('!ir Feodosia', config).ok, true);
});

test('kreyòl aliases ignore accents, case and spaces', () => {
  assert.equal(resolveKreyolAlias('Pòtoprens'), 'Port-au-Prince, Haiti');
  assert.equal(resolveKreyolAlias('potoprens'), 'Port-au-Prince, Haiti');
  assert.equal(resolveKreyolAlias('Sen Mak'), 'Saint-Marc, Haiti');
  assert.equal(resolveKreyolAlias('Senmak'), 'Saint-Marc, Haiti');
  assert.equal(resolveKreyolAlias('Kwadèbouke'), 'Croix-des-Bouquets, Haiti');
  assert.equal(resolveKreyolAlias('Ayiti'), 'Haiti');
  assert.equal(resolveKreyolAlias('París'), null);
});

test('place policy: public areas pass, addresses and bare points do not', () => {
  for (const type of [
    'country',
    'locality',
    'town',
    'village',
    'municipality',
    'park',
    'natural_feature',
  ])
    assert.equal(judgeLivePlace(city('X', { types: [type] })).ok, true, type);
  assert.equal(
    judgeLivePlace(city('X', { types: ['street_address'] })).reason,
    'private-place',
  );
  assert.equal(
    judgeLivePlace(city('X', { types: ['route'] })).reason,
    'private-place',
  );
  assert.equal(
    judgeLivePlace(city('X', { types: ['locality', 'premise'] })).reason,
    'private-place',
  );
  assert.equal(
    judgeLivePlace(city('X', { types: [] })).reason,
    'not-public-place',
  );
  assert.equal(
    judgeLivePlace(city('X', { types: [], exact: true })).reason,
    'not-public-place',
  );
  assert.equal(judgeLivePlace(null).reason, 'not-found');
});

test('queue: the first request shows at once and each lasts displaySeconds', async () => {
  const h = harness();
  await h.queue.submit({ user: 'ana', text: '!ir Paris' });
  await h.queue.submit({ user: 'beto', text: '!ir Lima' });
  assert.deepEqual(h.shows(), ['Paris']);
  assert.equal(h.queue.getState().current.user, 'ana');
  assert.deepEqual(
    h.queue.getState().upcoming.map((r) => r.label),
    ['Lima'],
  );
  h.advance(LIVE_CONFIG.displaySeconds - 1);
  assert.deepEqual(h.shows(), ['Paris']);
  h.advance(1);
  assert.deepEqual(h.shows(), ['Paris', 'Lima']);
  h.advance(LIVE_CONFIG.displaySeconds);
  assert.equal(h.queue.getState().current, null);
  assert.equal(h.events.at(-1).type, 'idle');
});

test('queue: per-user cooldown, duplicates, full line and refused places', async () => {
  const config = { ...LIVE_CONFIG, maxQueue: 2 };
  const h = harness({
    config,
    places: { Casa: city('Casa', { types: ['street_address'] }) },
  });
  assert.equal(
    (await h.queue.submit({ user: 'ana', text: '!ir Paris' })).ok,
    true,
  );
  assert.equal(
    (await h.queue.submit({ user: 'Ana', text: '!ir Lima' })).reason,
    'user-cooldown',
  );
  assert.equal(
    (await h.queue.submit({ user: 'beto', text: '!ir paris' })).reason,
    'duplicate',
  );
  assert.equal(
    (await h.queue.submit({ user: 'beto', text: '!ir Casa' })).reason,
    'private-place',
  );
  await h.queue.submit({ user: 'beto', text: '!ir Lima' });
  await h.queue.submit({ user: 'caro', text: '!ir Quito' });
  assert.equal(
    (await h.queue.submit({ user: 'dani', text: '!ir Roma' })).reason,
    'queue-full',
  );
  h.advance(LIVE_CONFIG.userCooldownSeconds);
  assert.equal(
    (await h.queue.submit({ user: 'ana', text: '!ir Roma' })).ok,
    true,
  );
});

test('queue: Siguiente, Saltar and Borrar', async () => {
  const h = harness();
  for (const [user, place] of [
    ['a', 'Paris'],
    ['b', 'Lima'],
    ['c', 'Quito'],
    ['d', 'Roma'],
  ])
    await h.queue.submit({ user, text: `!ir ${place}` });
  h.queue.next();
  assert.equal(h.events.find((e) => e.type === 'done').request.label, 'Paris');
  h.queue.skip();
  assert.equal(
    h.events.find((e) => e.type === 'skipped').request.label,
    'Lima',
  );
  const roma = h.queue.getState().upcoming.find((r) => r.label === 'Roma');
  assert.equal(h.queue.remove(roma.id), true);
  assert.equal(h.queue.remove(roma.id), false);
  assert.deepEqual(h.queue.getState().upcoming, []);
  assert.deepEqual(h.shows(), ['Paris', 'Lima', 'Quito']);
});

test('queue: Pausa freezes the countdown but still accepts requests', async () => {
  const h = harness();
  await h.queue.submit({ user: 'a', text: '!ir Paris' });
  h.advance(10);
  h.queue.pause();
  h.advance(600);
  assert.equal(h.queue.getState().current.label, 'Paris');
  assert.equal(
    h.queue.getState().remainingMs,
    (LIVE_CONFIG.displaySeconds - 10) * 1000,
  );
  await h.queue.submit({ user: 'b', text: '!ir Lima' });
  assert.equal(h.queue.getState().upcoming.length, 1);
  h.queue.resume();
  h.advance(LIVE_CONFIG.displaySeconds - 10);
  assert.deepEqual(h.shows(), ['Paris', 'Lima']);
});

test('queue: a paused empty screen waits for resume before showing', async () => {
  const h = harness();
  h.queue.pause();
  await h.queue.submit({ user: 'a', text: '!ir Paris' });
  h.advance(5);
  assert.equal(h.queue.getState().current, null);
  h.queue.resume();
  assert.deepEqual(h.shows(), ['Paris']);
});
