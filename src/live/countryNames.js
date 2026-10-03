import { decodeRing, polygonsContain } from '../data/adminBoundaries.js';

/**
 * The country a live request landed in, named in Spanish.
 *
 * The geocoder names countries in their own language ("Ayiti", "日本", "مصر"),
 * which viewers cannot read, so the overlay instead finds the country whose
 * Natural Earth outline (bundled with the app) contains the accepted point
 * and names its ISO code in Spanish.
 */
const PACK_URL = new URL(
  '../data/local_data/natural_earth/countries.json',
  import.meta.url,
);

/** Coastal cities can sit just outside the simplified outline. */
const NEAREST_COUNTRY_KM = 30;

const spanishRegions =
  typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['es'], { type: 'region' })
    : null;

/** Spanish name for an ISO 3166 alpha-2 code, or the fallback. */
export function spanishCountryName(iso2, fallback = '') {
  if (/^[A-Z]{2}$/.test(String(iso2 || ''))) {
    try {
      const name = spanishRegions?.of(iso2);
      if (name && name !== iso2) return name;
    } catch {
      // An unknown code keeps the fallback.
    }
  }
  return fallback;
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) *
      Math.cos(lat2 * rad) *
      Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function decodeCountries(pack) {
  const decimals = pack?.meta?.decimals ?? 3;
  return (pack?.features || []).map((feature) => {
    const polygons = (feature.polygons || []).map((polygon) =>
      polygon.map((ring) => decodeRing(ring, decimals)),
    );
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const [outer] of polygons)
      for (const [lon, lat] of outer) {
        west = Math.min(west, lon);
        east = Math.max(east, lon);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
      }
    return {
      iso2: feature.iso2,
      name: spanishCountryName(feature.iso2, feature.name),
      polygons,
      bbox: [west, south, east, north],
    };
  });
}

const near = ({ bbox: [west, south, east, north] }, lat, lng, margin) =>
  lat >= south - margin &&
  lat <= north + margin &&
  lng >= west - margin &&
  lng <= east + margin;

/**
 * `countryAt(lat, lng)` resolves to `{ iso2, name }` or null. The outline
 * pack loads once, on the first lookup; `loadPack` is injectable for tests.
 */
export function createCountryLookup({
  loadPack = () => fetch(PACK_URL).then((response) => response.json()),
} = {}) {
  let countries = null;
  const load = () => {
    countries ??= Promise.resolve()
      .then(loadPack)
      .then(decodeCountries)
      .catch((error) => {
        countries = null;
        throw error;
      });
    return countries;
  };
  return {
    async countryAt(lat, lng) {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const all = await load();
      const inside = all.find(
        (country) =>
          near(country, lat, lng, 0) &&
          polygonsContain(country.polygons, lat, lng),
      );
      if (inside) return { iso2: inside.iso2, name: inside.name };
      let best = null;
      let bestKm = NEAREST_COUNTRY_KM;
      for (const country of all) {
        if (!near(country, lat, lng, 0.5)) continue;
        for (const [outer] of country.polygons)
          for (const [lon, vertexLat] of outer) {
            const km = distanceKm(lat, lng, vertexLat, lon);
            if (km < bestKm) {
              bestKm = km;
              best = country;
            }
          }
      }
      return best ? { iso2: best.iso2, name: best.name } : null;
    },
  };
}
