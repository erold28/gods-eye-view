import * as Cesium from 'cesium';
import {
  setOverlayEntries,
  setOverlaySourceVisible,
  clearOverlaySource,
} from '../overlays/worldOverlay.js';

/**
 * Famous places near the city on screen, as labels on the map and a list in
 * the control panel ("Ir" flies there).
 *
 * The app does not query OpenStreetMap's public Overpass servers by default,
 * so this asks Wikidata (keyless, the database behind Wikipedia) for physical
 * places around the city — monuments, museums, squares, cathedrals, parks,
 * stadiums, palaces, towers, bridges, skyscrapers, beaches… — ranked by how
 * many Wikipedias describe them, with Spanish names where they exist.
 * Everything is public; a failed lookup simply shows no labels.
 */

const ENDPOINT = 'https://query.wikidata.org/sparql';
const TIMEOUT_MS = 12_000;
/** Labels shown at most: enough to explore, light on a laptop. */
export const MAX_LANDMARKS = 8;
/** Two results closer than this are the same place (a church and its tower). */
const SAME_PLACE_M = 150;

/** Wikidata classes of physical places a viewer can visit or see. */
const PLACE_CLASSES = Object.freeze([
  'Q570116', // tourist attraction
  'Q4989906', // monument
  'Q33506', // museum
  'Q174782', // square
  'Q16970', // church building
  'Q22698', // park
  'Q483110', // stadium
  'Q16560', // palace
  'Q12518', // tower
  'Q12280', // bridge
  'Q11303', // skyscraper
  'Q2319498', // landmark
  'Q839954', // archaeological site
  'Q23413', // castle
  'Q179700', // statue
  'Q5003624', // memorial
  'Q40080', // beach
  'Q43501', // zoo
  'Q24354', // theatre building
  'Q2977', // cathedral
  'Q44539', // temple
  'Q1440300', // observation tower
  'Q4817', // column
  'Q1081138', // historic site
  'Q1107656', // garden
  'Q1248784', // airport
  'Q41176', // building
  'Q811979', // architectural structure
  'Q2087181', // historic house museum
  'Q32815', // mosque
  'Q1370598', // structure of worship
]);

/** The query for famous places within `radiusKm` of a point. */
export function landmarksQuery(lat, lng, radiusKm) {
  const classes = PLACE_CLASSES.map((id) => `wd:${id}`).join(' ');
  return `SELECT DISTINCT ?item ?itemLabel ?coord ?links WHERE {
  SERVICE wikibase:around { ?item wdt:P625 ?coord . bd:serviceParam wikibase:center "Point(${Number(lng)} ${Number(lat)})"^^geo:wktLiteral . bd:serviceParam wikibase:radius "${Number(radiusKm)}" . }
  ?item wikibase:sitelinks ?links .
  FILTER(?links >= 6)
  VALUES ?cls { ${classes} }
  ?item wdt:P31/wdt:P279? ?cls .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "es,en". }
} ORDER BY DESC(?links) LIMIT 30`;
}

function distanceM(a, b) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) *
      Math.cos(b.lat * rad) *
      Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Landmarks from a SPARQL JSON answer: `{ id, name, lat, lng, links }`, most
 * famous first, without unnamed items (a bare "Q123" label), duplicates of
 * one place, or more than `max`.
 */
export function parseLandmarks(json, max = MAX_LANDMARKS) {
  const out = [];
  for (const row of json?.results?.bindings || []) {
    const id = String(row.item?.value || '')
      .split('/')
      .pop();
    const name = String(row.itemLabel?.value || '').trim();
    const point = /Point\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(
      String(row.coord?.value || ''),
    );
    if (!id || !name || /^Q\d+$/.test(name) || !point) continue;
    const place = {
      id,
      name,
      lng: Number(point[1]),
      lat: Number(point[2]),
      links: Number(row.links?.value) || 0,
    };
    if (!Number.isFinite(place.lat) || !Number.isFinite(place.lng)) continue;
    if (
      out.some(
        (seen) => seen.id === id || distanceM(seen, place) < SAME_PLACE_M,
      )
    )
      continue;
    out.push(place);
    if (out.length >= max) break;
  }
  return out;
}

/** The world-overlay source that owns the landmark labels. */
const SOURCE_ID = 'live-landmarks';
const SOURCE_OPTIONS = Object.freeze({
  maxVisible: MAX_LANDMARKS,
  hideInCockpit: true,
  // The tour orbits the city: re-place the labels as the camera moves.
  moving: true,
});

/**
 * Labels on the map for the landmarks of the current city, drawn by the app's
 * world-overlay host (the app never uses Cesium labels for world text).
 * `setVisible(on)` hides or shows them without forgetting the list.
 */
export function createLandmarkLabels({
  viewer,
  fetchImpl = (...a) => fetch(...a),
  overlays = { setOverlayEntries, setOverlaySourceVisible, clearOverlaySource },
}) {
  const cache = new Map();
  let visible = true;
  let generation = 0;
  let current = [];

  const entryFor = (place) => ({
    id: place.id,
    position: Cesium.Cartesian3.fromDegrees(
      place.lng,
      place.lat,
      place.height || 0,
    ),
    variant: 'label',
    title: place.name,
    accent: '#f0a63c',
    priority: Math.max(1, place.links || 1),
    interactive: false,
    placement: 'above',
    stateless: true,
    horizonCull: true,
    terrainOcclusion: false,
    accessibilityLabel: place.name,
  });

  const paint = () => {
    overlays.setOverlayEntries(
      SOURCE_ID,
      current.map(entryFor),
      SOURCE_OPTIONS,
    );
    overlays.setOverlaySourceVisible(SOURCE_ID, visible);
  };

  const clear = () => {
    current = [];
    overlays.clearOverlaySource(SOURCE_ID);
  };

  /** Lift each label onto the rendered ground (3D buildings or terrain). */
  const liftToGround = (list, mine) => {
    const scene = viewer?.scene;
    if (!scene?.sampleHeightSupported || !list.length) return;
    const cartos = list.map((place) =>
      Cesium.Cartographic.fromDegrees(place.lng, place.lat),
    );
    Promise.resolve(scene.sampleHeightMostDetailed(cartos))
      .then((sampled) => {
        if (mine !== generation) return;
        list.forEach((place, index) => {
          const height = sampled?.[index]?.height;
          if (Number.isFinite(height)) place.height = height;
        });
        paint();
      })
      .catch(() => {});
  };

  return {
    /**
     * Look up and label the landmarks around a city. Resolves to the list
     * (empty when the lookup fails or a newer city replaced this one).
     */
    async load(lat, lng, radiusKm) {
      const mine = ++generation;
      clear();
      const key = `${lat.toFixed(3)},${lng.toFixed(3)},${radiusKm}`;
      let list = cache.get(key);
      if (!list) {
        try {
          const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(
            landmarksQuery(lat, lng, radiusKm),
          )}`;
          const response = await fetchImpl(url, {
            headers: { Accept: 'application/sparql-results+json' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (!response.ok) return [];
          list = parseLandmarks(await response.json());
          cache.set(key, list);
        } catch {
          return [];
        }
      }
      if (mine !== generation) return [];
      current = list;
      paint();
      if (!list.some((place) => Number.isFinite(place.height)))
        liftToGround(list, mine);
      return list;
    },

    get list() {
      return current.map(({ id, name }) => ({ id, name }));
    },

    find(id) {
      return current.find((place) => place.id === id) || null;
    },

    setVisible(on) {
      visible = Boolean(on);
      overlays.setOverlaySourceVisible(SOURCE_ID, visible);
    },

    get visible() {
      return visible;
    },

    clear() {
      generation++;
      clear();
    },
  };
}
