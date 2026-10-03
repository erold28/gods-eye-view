/**
 * Camera distance for a live request, from the place the policy accepted.
 *
 * The flight goes to the accepted coordinates rather than searching the name
 * again: a second lookup can land somewhere else. The distance follows the
 * place's own box when the geocoder gave one, capped by its kind, so an
 * administrative area that owns far-off islands (Tokyo) still frames the city.
 */
const MIN_RANGE_M = 3_000;

const MAX_RANGE_BY_TYPE = Object.freeze([
  [['country'], 3_000_000],
  [['administrative_area_level_1'], 1_200_000],
  [['administrative_area_level_2', 'administrative_area_level_3'], 300_000],
  [['locality', 'postal_town', 'city', 'town', 'municipality'], 60_000],
  [['village'], 15_000],
  [
    ['sublocality', 'sublocality_level_1', 'neighborhood', 'colloquial_area'],
    10_000,
  ],
]);
const DEFAULT_MAX_RANGE_M = 30_000;

/** Range used when a place carries no box: half of its kind's cap. */
const range = (maxRange) => Math.max(MIN_RANGE_M, maxRange / 2);

function maxRangeFor(types) {
  for (const [kinds, maxRange] of MAX_RANGE_BY_TYPE)
    if (kinds.some((kind) => types.includes(kind))) return maxRange;
  return DEFAULT_MAX_RANGE_M;
}

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

/** Camera range in metres for an accepted place `{ types, viewport }`. */
export function liveFlightRangeM(place) {
  const types = Array.isArray(place?.types) ? place.types : [];
  const maxRange = maxRangeFor(types);
  const sw = place?.viewport?.southwest;
  const ne = place?.viewport?.northeast;
  const boxed = [sw?.lat, sw?.lng, ne?.lat, ne?.lng].every(Number.isFinite);
  if (!boxed) return range(maxRange);
  const diagonal = distanceM(sw, ne);
  return Math.round(Math.min(maxRange, Math.max(MIN_RANGE_M, diagonal * 1.2)));
}
