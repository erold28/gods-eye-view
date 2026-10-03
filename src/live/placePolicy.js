import { LIVE_CONFIG } from './config.js';
import { foldText } from './text.js';

/**
 * Which geocode results a live viewer may send the camera to: public areas
 * only. Countries, regions, cities, towns, neighbourhoods and large public
 * places pass; streets, addresses, buildings and any untyped precise result
 * do not, so a comment can never point the stream at someone's home.
 */
const PUBLIC_PLACE_TYPES = Object.freeze(
  new Set([
    'country',
    'administrative_area_level_1',
    'administrative_area_level_2',
    'administrative_area_level_3',
    'locality',
    'postal_town',
    'city',
    'town',
    'village',
    'municipality',
    'sublocality',
    'sublocality_level_1',
    'neighborhood',
    'colloquial_area',
    'park',
    'natural_feature',
    'airport',
    'stadium',
    'amusement_park',
    'zoo',
    'university',
    'campus',
  ]),
);

/** Types that always mean a private or exact location, whatever else is listed. */
const PRIVATE_PLACE_TYPES = Object.freeze(
  new Set([
    'street_address',
    'premise',
    'subpremise',
    'route',
    'intersection',
    'street_number',
    'plus_code',
    'postal_code',
  ]),
);

/**
 * Judge one normalized geocode place (`{ lat, lng, label, types, exact }`).
 * Returns `{ ok: true }` or `{ ok: false, reason }`.
 *
 * `exact` results without types are typed coordinates and are refused; the
 * bundled city presets carry `locality` and pass like any other city.
 */
export function judgeLivePlace(place) {
  if (!place) return { ok: false, reason: 'not-found' };
  if (!Number.isFinite(place.lat) || !Number.isFinite(place.lng))
    return { ok: false, reason: 'not-found' };
  const types = Array.isArray(place.types) ? place.types : [];
  if (types.some((type) => PRIVATE_PLACE_TYPES.has(type)))
    return { ok: false, reason: 'private-place' };
  if (!types.some((type) => PUBLIC_PLACE_TYPES.has(type)))
    return { ok: false, reason: 'not-public-place' };
  return { ok: true };
}

/**
 * A city that shares its name with its state or province (Puebla, São Paulo,
 * Guadalajara in Spain) comes back from the keyless geocoder as the state.
 * Asking again as "Name, Name, Country" reaches the city. The second answer is
 * used only when it is a settlement of that same name inside the state's box;
 * otherwise the first answer stands.
 *
 * Small states are left alone: Mexico City arrives as a ~75 km "state" and is
 * already framed as a big city (camera.region.bigCityBelowKm).
 */
const STATE_TYPES = Object.freeze([
  'administrative_area_level_1',
  'administrative_area_level_2',
  'administrative_area_level_3',
]);

const SETTLEMENT_TYPES = Object.freeze([
  'locality',
  'postal_town',
  'city',
  'town',
  'municipality',
  'village',
  'sublocality',
  'sublocality_level_1',
]);

const hasType = (place, types) =>
  (place?.types || []).some((type) => types.includes(type));

function boxDiagonalKm(viewport) {
  const sw = viewport?.southwest;
  const ne = viewport?.northeast;
  if (![sw?.lat, sw?.lng, ne?.lat, ne?.lng].every(Number.isFinite)) return null;
  const rad = Math.PI / 180;
  const h =
    Math.sin(((ne.lat - sw.lat) * rad) / 2) ** 2 +
    Math.cos(sw.lat * rad) *
      Math.cos(ne.lat * rad) *
      Math.sin(((ne.lng - sw.lng) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const insideBox = (viewport, { lat, lng }) =>
  lat >= viewport.southwest.lat &&
  lat <= viewport.northeast.lat &&
  lng >= viewport.southwest.lng &&
  lng <= viewport.northeast.lng;

/** The state's own name: its `name`, or the first part of its label. */
const stateName = (place) =>
  String(place.name || String(place.label || '').split(',')[0]).trim();

/** The country part of a label: its last comma-separated part. */
const labelCountry = (place) => {
  const parts = String(place.label || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts.at(-1) : '';
};

/** The second query for a state, or null when none should be made. */
export function cityRetryQuery(place, camera = LIVE_CONFIG.camera) {
  if (!place || !hasType(place, STATE_TYPES)) return null;
  const diagonal = boxDiagonalKm(place.viewport);
  const smallBelowKm = camera.region.bigCityBelowKm;
  if (diagonal !== null && diagonal < smallBelowKm) return null;
  const name = stateName(place);
  if (!name) return null;
  const country = labelCountry(place);
  return country ? `${name}, ${name}, ${country}` : `${name}, ${name}`;
}

/**
 * The city of the same name for a state answer, or the answer unchanged.
 * `geocode(query)` resolves to a place or null.
 */
export async function preferCityOverState(
  place,
  geocode,
  camera = LIVE_CONFIG.camera,
) {
  const query = cityRetryQuery(place, camera);
  if (!query) return place;
  let city = null;
  try {
    city = await geocode(query);
  } catch {
    return place;
  }
  if (!city || !hasType(city, SETTLEMENT_TYPES)) return place;
  const name = foldText(stateName(place));
  if (!foldText(stateName(city)).startsWith(name)) return place;
  if (place.viewport && !insideBox(place.viewport, city)) return place;
  return city;
}
