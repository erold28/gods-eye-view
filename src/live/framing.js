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

/**
 * `{ kind, rangeM, pitchDeg }` for an accepted place. Rows with a fixed
 * `meters` always use it; rows with `minMeters`/`maxMeters` follow the
 * place's own box within those limits (the lower limit without a box).
 */
export function liveFramingPlan(place, camera = LIVE_CONFIG.camera) {
  const kind = liveFramingKind(place, camera);
  const row = camera[kind];
  let rangeM = row.meters;
  if (!Number.isFinite(rangeM)) {
    const diagonal = boxDiagonalM(place);
    rangeM =
      diagonal === null
        ? row.minMeters
        : clamp(diagonal * 1.3, row.minMeters, row.maxMeters);
  }
  return { kind, rangeM: Math.round(rangeM), pitchDeg: row.pitch };
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
