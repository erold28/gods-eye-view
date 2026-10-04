import test from 'node:test';
import assert from 'node:assert/strict';
import {
  landmarksQuery,
  parseLandmarks,
  createLandmarkLabels,
  MAX_LANDMARKS,
} from './landmarks.js';
import { liveFramingPlan } from './framing.js';
import { sanitizeLiveCommand } from '../../server/live/relay.js';
import { runLiveCommand } from './relayClient.js';

const row = (id, name, lng, lat, links) => ({
  item: { value: `http://www.wikidata.org/entity/${id}` },
  itemLabel: { value: name },
  coord: { value: `Point(${lng} ${lat})` },
  links: { value: String(links) },
});

test('landmarks: query asks for places near the point, ranked by fame', () => {
  const query = landmarksQuery(19.4326, -99.1332, 6);
  assert.match(query, /Point\(-99\.1332 19\.4326\)/);
  assert.match(query, /wikibase:radius "6"/);
  assert.match(query, /ORDER BY DESC\(\?links\)/);
  assert.match(query, /wd:Q4989906/, 'monuments');
  assert.match(query, /"es,en"/, 'Spanish names first');
});

test('landmarks: parse keeps named places, drops duplicates and caps the list', () => {
  const json = {
    results: {
      bindings: [
        row('Q1', 'Catedral Metropolitana', -99.1333, 19.4345, 61),
        row('Q2', 'Monumento a la Independencia', -99.1677, 19.427, 40),
        // Unnamed item: its label is just its id.
        row('Q3', 'Q3', -99.15, 19.43, 30),
        // Same place twice (a building and its tower, 50 m apart).
        row('Q4', 'Torre de la Catedral', -99.1334, 19.4349, 20),
        row('Q1', 'Catedral Metropolitana', -99.1333, 19.4345, 61),
        { item: { value: 'x/Q5' }, itemLabel: { value: 'Sin punto' } },
      ],
    },
  };
  assert.deepEqual(
    parseLandmarks(json).map((p) => p.name),
    ['Catedral Metropolitana', 'Monumento a la Independencia'],
  );
  const [first] = parseLandmarks(json);
  assert.deepEqual(first, {
    id: 'Q1',
    name: 'Catedral Metropolitana',
    lat: 19.4345,
    lng: -99.1333,
    links: 61,
  });
  const many = {
    results: {
      bindings: Array.from({ length: 20 }, (_, i) =>
        row(`Q${i + 10}`, `Lugar ${i}`, -99 + i * 0.01, 19, 50 - i),
      ),
    },
  };
  assert.equal(parseLandmarks(many).length, MAX_LANDMARKS);
  assert.deepEqual(parseLandmarks(null), []);
});

test('landmarks: flying to one frames it closer than a city', () => {
  const plan = liveFramingPlan({ types: ['landmark'] });
  assert.equal(plan.kind, 'landmark');
  assert.ok(plan.overview.heightM < 3000 && plan.close.heightM >= 400);
});

test('landmarks: panel commands', () => {
  assert.deepEqual(
    sanitizeLiveCommand({ type: 'flyToLandmark', landmark: 'Q2', x: 1 }),
    { type: 'flyToLandmark', landmark: 'Q2' },
  );
  assert.deepEqual(sanitizeLiveCommand({ type: 'toggleLandmarks' }), {
    type: 'toggleLandmarks',
  });
  const calls = [];
  const api = {
    flyToLandmark: (id) => calls.push(['fly', id]),
    toggleLandmarks: () => calls.push(['toggle']),
  };
  runLiveCommand(api, { type: 'flyToLandmark', landmark: 'Q2' });
  runLiveCommand(api, { type: 'toggleLandmarks' });
  assert.deepEqual(calls, [['fly', 'Q2'], ['toggle']]);
});

test('landmarks: labels go through the world-overlay host', async () => {
  const calls = [];
  const overlays = {
    setOverlayEntries: (source, entries) =>
      calls.push([
        'set',
        source,
        entries.map((e) => [e.id, e.title, e.variant]),
      ]),
    setOverlaySourceVisible: (source, on) =>
      calls.push(['visible', source, on]),
    clearOverlaySource: (source) => calls.push(['clear', source]),
  };
  const json = {
    results: { bindings: [row('Q2', 'Ángel', -99.1677, 19.427, 40)] },
  };
  const labels = createLandmarkLabels({
    viewer: null,
    overlays,
    fetchImpl: async () => ({ ok: true, json: async () => json }),
  });
  const list = await labels.load(19.43, -99.13, 6);
  assert.equal(list.length, 1);
  assert.deepEqual(labels.list, [{ id: 'Q2', name: 'Ángel' }]);
  assert.deepEqual(calls.at(-2), [
    'set',
    'live-landmarks',
    [['Q2', 'Ángel', 'label']],
  ]);
  labels.setVisible(false);
  assert.deepEqual(calls.at(-1), ['visible', 'live-landmarks', false]);
  assert.equal(labels.visible, false);
  labels.clear();
  assert.deepEqual(calls.at(-1), ['clear', 'live-landmarks']);
  assert.deepEqual(labels.list, []);
});
