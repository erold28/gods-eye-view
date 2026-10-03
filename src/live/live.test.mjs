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

test('overlay model: banner text, handle, progress and queue limit', async () => {
  const { liveOverlayModel, liveHandle } = await import('./overlay.js');
  assert.equal(liveHandle('ana'), '@ana');
  assert.equal(liveHandle('@@ana'), '@ana');
  assert.equal(liveHandle('(anónimo)'), '(anónimo)');
  const request = (id, place, extra = {}) => ({
    id,
    user: `u${id}`,
    place,
    label: 'نام داخلی',
    types: ['locality'],
    country: 'Perú',
    ...extra,
  });
  const model = liveOverlayModel({
    current: request(1, 'okap', {
      label: 'Cap-Haïtien, Nord, Ayiti',
      country: 'Haití',
    }),
    upcoming: [2, 3, 4, 5, 6, 7, 8].map((id) => request(id, `lugar ${id}`)),
    paused: false,
    remainingMs: (LIVE_CONFIG.displaySeconds * 1000) / 2,
  });
  assert.equal(model.mode, 'showing');
  // The viewer's own word and a Spanish country; never the geocoder label.
  assert.deepEqual(model.current, {
    handle: '@u1',
    place: 'Okap',
    country: 'Haití',
    progress: 0.5,
  });
  assert.equal(model.upcoming.length, LIVE_CONFIG.queueRowsShown);
  assert.deepEqual(model.upcoming[0], {
    position: 1,
    handle: '@u2',
    place: 'Lugar 2',
    country: 'Perú',
  });
  assert.equal(model.more, 7 - LIVE_CONFIG.queueRowsShown);
  const show = (current) =>
    liveOverlayModel({ current, upcoming: [], remainingMs: 0 }).current;
  // A country request ("Egipto", geocoded as "مصر") shows only the word typed.
  assert.deepEqual(
    show(request(1, 'Egipto', { types: ['country'], country: 'Egipto' })),
    { handle: '@u1', place: 'Egipto', country: '', progress: 1 },
  );
  // The viewer already wrote the country; no unknown country, no suffix.
  assert.equal(show(request(1, 'perú', { types: ['locality'] })).country, '');
  assert.equal(show(request(1, 'Lima', { country: null })).country, '');
  assert.equal(liveOverlayModel({ current: null, upcoming: [] }).mode, 'idle');
});

test('country lookup names the containing or nearest country in Spanish', async () => {
  const { createCountryLookup, spanishCountryName } =
    await import('./countryNames.js');
  const { readFile } = await import('node:fs/promises');
  const pack = JSON.parse(
    await readFile(
      new URL(
        '../data/local_data/natural_earth/countries.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  let loads = 0;
  const lookup = createCountryLookup({
    loadPack: async () => {
      loads++;
      return pack;
    },
  });
  const at = async (lat, lng) => (await lookup.countryAt(lat, lng))?.name;
  assert.equal(await at(48.86, 2.35), 'Francia');
  assert.equal(await at(19.76, -72.2), 'Haití'); // Cap-Haïtien, on the coast
  assert.equal(await at(35.68, 139.76), 'Japón');
  assert.equal(await at(30.04, 31.24), 'Egipto');
  assert.equal(await at(-12.05, -77.03), 'Perú');
  assert.equal(await at(0, -140), undefined); // open Pacific
  assert.equal(loads, 1);
  assert.equal(spanishCountryName('DE'), 'Alemania');
  assert.equal(spanishCountryName('-99', 'Somaliland'), 'Somaliland');
});

test('spanish aliases send exonyms to the right place', async () => {
  const { resolveSpanishAlias } = await import('./spanishAliases.js');
  assert.equal(resolveSpanishAlias('Tokio'), 'Tokyo, Japan');
  assert.equal(resolveSpanishAlias('nueva york'), 'New York, United States');
  assert.equal(
    resolveSpanishAlias('Los Angeles'),
    'Los Angeles, California, United States',
  );
  assert.equal(resolveSpanishAlias('Lima'), null);
  assert.equal(parseLiveComment('!ir Londres').query, 'London, United Kingdom');
  assert.equal(
    parseLiveComment('!ale Pòtoprens').query,
    'Port-au-Prince, Haiti',
  );
});

test('flight range follows the place box, capped by its kind', async () => {
  const { liveFlightRangeM } = await import('./framing.js');
  const box = (s, w, n, e) => ({
    southwest: { lat: s, lng: w },
    northeast: { lat: n, lng: e },
  });
  // A city box ~20 km across frames at ~1.2x its diagonal.
  const city = liveFlightRangeM({
    types: ['locality'],
    viewport: box(48.8, 2.25, 48.9, 2.42),
  });
  assert.ok(city > 15_000 && city < 30_000, String(city));
  // Tokyo's administrative box reaches far islands; the city cap holds.
  assert.equal(
    liveFlightRangeM({ types: ['locality'], viewport: box(20, 136, 36, 154) }),
    60_000,
  );
  assert.equal(
    liveFlightRangeM({ types: ['country'], viewport: box(-60, -120, 70, 160) }),
    3_000_000,
  );
  // No box: half of the kind's cap, never below the minimum.
  assert.equal(liveFlightRangeM({ types: ['village'] }), 7_500);
  assert.equal(
    liveFlightRangeM({
      types: ['sublocality'],
      viewport: box(1, 1, 1.001, 1.001),
    }),
    3_000,
  );
});

/** A queue whose lookups finish only when the test says so. */
function deferredQueue() {
  const lookups = new Map();
  const events = [];
  const queue = createLiveRequestQueue({
    now: () => 0,
    resolvePlace: (query) =>
      new Promise((resolve) => lookups.set(query, resolve)),
  });
  queue.subscribe(({ event }) => events.push(event));
  const finish = async (query, place = city(query)) => {
    lookups.get(query)(place);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const line = () =>
    queue.getState().upcoming.map((r) => `${r.place}:${r.status}`);
  const shows = () =>
    events.filter((e) => e.type === 'show').map((e) => e.request.place);
  return { queue, finish, line, shows };
}

test('queue: requests keep the order they arrived in, not lookup order', async () => {
  const q = deferredQueue();
  const paris = q.queue.submit({ user: 'a', text: '!ir Paris' });
  const lima = q.queue.submit({ user: 'b', text: '!ir Lima' });
  const quito = q.queue.submit({ user: 'c', text: '!ir Quito' });
  assert.deepEqual(q.line(), [
    'Paris:pending',
    'Lima:pending',
    'Quito:pending',
  ]);
  await q.finish('Quito');
  await q.finish('Lima');
  // Lima and Quito are ready, but Paris arrived first: nothing shows yet.
  assert.deepEqual(q.shows(), []);
  assert.deepEqual(q.line(), ['Paris:pending', 'Lima:ready', 'Quito:ready']);
  await q.finish('Paris');
  await Promise.all([paris, lima, quito]);
  assert.deepEqual(q.shows(), ['Paris']);
  assert.deepEqual(q.line(), ['Lima:ready', 'Quito:ready']);
});

test('queue: a refused request leaves its reserved place and frees the line', async () => {
  const q = deferredQueue();
  const casa = q.queue.submit({ user: 'a', text: '!ir Casa' });
  const lima = q.queue.submit({ user: 'b', text: '!ir Lima' });
  await q.finish('Lima');
  assert.deepEqual(q.shows(), []);
  await q.finish('Casa', city('Casa', { types: ['street_address'] }));
  assert.equal((await casa).reason, 'private-place');
  assert.equal((await lima).ok, true);
  assert.deepEqual(q.shows(), ['Lima']);
  assert.deepEqual(q.line(), []);
});

test('queue: Borrar works on a request still being looked up', async () => {
  const q = deferredQueue();
  const roma = q.queue.submit({ user: 'a', text: '!ir Roma' });
  const lima = q.queue.submit({ user: 'b', text: '!ir Lima' });
  await q.finish('Lima');
  const pending = q.queue.getState().upcoming[0];
  assert.equal(pending.status, 'pending');
  q.queue.remove(pending.id);
  assert.deepEqual(q.shows(), ['Lima'], 'the ready request behind it starts');
  await q.finish('Roma');
  assert.equal((await roma).reason, 'removed');
  assert.equal((await lima).ok, true);
});

test('overlay: requests still being looked up are never on air', async () => {
  const { liveOverlayModel } = await import('./overlay.js');
  const model = liveOverlayModel({
    current: null,
    upcoming: [
      { id: 1, user: 'a', place: 'Roma', status: 'pending' },
      { id: 2, user: 'b', place: 'Lima', status: 'ready', types: ['locality'] },
    ],
  });
  assert.deepEqual(
    model.upcoming.map((r) => r.place),
    ['Lima'],
  );
});
