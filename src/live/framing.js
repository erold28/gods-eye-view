import { LIVE_CONFIG } from './config.js';

/**
 * How the camera frames a live request: distance to the place's centre and
 * tilt, by kind of place. The numbers live in config.js (`camera`).
 *
 * The flight goes to the accepted coordinates rather than searching the name
 * again: a second lookup can land somewhere else.
 *
 * The keyless geocoder is a poor judge of size: it calls cities and villages
 * alike "locality", reports many cities (Lima, Cap-Haïtien) as a "district"
 * (sublocality) without a box, gives towns the box of their whole municipality
 * (Cancún, 38 km), and Mexico City as a state. So every settlement is framed as
 * a city unless its box is clearly larger (a big city) or clearly smaller (a
 * town), and a state or district smaller than a city region is a big city.
 */
const KINDS = Object.freeze([
  ['country', ['country']],
  ['region', ['administrative_area_level_1']],
  ['district', ['administrative_area_level_2', 'administrative_area_level_3']],
  [
    'locality',
    [
      'locality',
      'postal_town',
      'city',
      'town',
      'municipality',
      'village',
      'sublocality',
      'sublocality_level_1',
    ],
  ],
  ['neighborhood', ['neighborhood', 'colloquial_area']],
  [
    'area',
    [
      'park',
      'natural_feature',
      'airport',
      'stadium',
      'amusement_park',
      'zoo',
      'university',
      'campus',
    ],
  ],
]);

/** Great-circle distance in metres between two { lat, lng } points. */
function distanceM(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The diagonal of the place's box in metres, or null without a box. */
function boxDiagonalM(place) {
  const sw = place?.viewport?.southwest;
  const ne = place?.viewport?.northeast;
  if (![sw?.lat, sw?.lng, ne?.lat, ne?.lng].every(Number.isFinite)) return null;
  return distanceM(sw, ne);
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Which row of the camera table a place uses. */
export function liveFramingKind(place, camera = LIVE_CONFIG.camera) {
  const types = Array.isArray(place?.types) ? place.types : [];
  const kind =
    KINDS.find(([, kinds]) =>
      kinds.some((type) => types.includes(type)),
    )?.[0] || 'other';
  const diagonal = boxDiagonalM(place);
  if (
    (kind === 'region' || kind === 'district') &&
    diagonal !== null &&
    diagonal < camera[kind].bigCityBelowKm * 1000
  )
    return 'bigCity';
  if (kind !== 'locality') return kind;
  if (diagonal === null) return types.includes('village') ? 'town' : 'city';
  if (diagonal >= camera.bigCity.fromKm * 1000) return 'bigCity';
  if (diagonal >= camera.city.fromKm * 1000) return 'city';
  return 'town';
}

/** Camera distance (m) that puts the eye `heightM` above the centre at `pitchDeg`. */
const rangeFor = (heightM, pitchDeg) =>
  Math.round(heightM / Math.sin((Math.abs(pitchDeg) * Math.PI) / 180));

/** A view: distance to the centre, tilt and the eye's height above it. */
const view = (rangeM, pitchDeg) => ({
  rangeM: Math.round(rangeM),
  pitchDeg,
  heightM: Math.round(rangeM * Math.sin((Math.abs(pitchDeg) * Math.PI) / 180)),
});

/**
 * The mini tour for an accepted place: `{ kind, overview, close }`, each view
 * `{ rangeM, pitchDeg, heightM }`. Settlements, countries, states and
 * districts have both views (a general view, then a slow descent to `close`);
 * large areas stay high, with `close: null`, following the place's own box
 * within `minMeters`/`maxMeters` (the lower limit without a box).
 */
export function liveFramingPlan(place, camera = LIVE_CONFIG.camera) {
  const kind = liveFramingKind(place, camera);
  const row = camera[kind];
  if (Number.isFinite(row.overviewHeight))
    return {
      kind,
      overview: view(
        rangeFor(row.overviewHeight, row.overviewPitch),
        row.overviewPitch,
      ),
      close: view(rangeFor(row.closeHeight, row.closePitch), row.closePitch),
    };
  const diagonal = boxDiagonalM(place);
  const rangeM =
    diagonal === null
      ? row.minMeters
      : clamp(diagonal * 1.3, row.minMeters, row.maxMeters);
  return { kind, overview: view(rangeM, row.pitch), close: null };
}

/** 0→1 with a gentle start and end. */
export const smoothstep = (t) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/**
 * The view part-way down from `overview` to `close` (0 ≤ t ≤ 1, eased).
 * Distance changes geometrically, so the descent feels even at every height.
 */
export function descentView(plan, t) {
  if (!plan.close) return { ...plan.overview };
  const s = smoothstep(t);
  const from = plan.overview;
  const to = plan.close;
  const rangeM = Math.exp(
    Math.log(from.rangeM) + (Math.log(to.rangeM) - Math.log(from.rangeM)) * s,
  );
  return view(rangeM, from.pitchDeg + (to.pitchDeg - from.pitchDeg) * s);
}
/**
 * How far to tilt the view up, in radians, so the point the camera looks at
 * sits at `screenY` (0 top, 1 bottom) instead of the centre. `fovy` is the
 * camera's vertical field of view in radians.
 */
export function screenOffsetRadians(fovy, screenY) {
  const below = Math.min(0.9, Math.max(0, (screenY - 0.5) / 0.5));
  return Math.atan(below * Math.tan(fovy / 2));
}
