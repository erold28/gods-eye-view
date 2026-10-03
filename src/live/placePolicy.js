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
