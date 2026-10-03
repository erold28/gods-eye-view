import { foldText } from './text.js';

/**
 * Spanish place names → the name a geocoder recognizes.
 *
 * The keyless geocoder (Photon/OpenStreetMap) reads a Spanish exonym as the
 * small place that literally carries it: "Londres" is a village in Argentina,
 * "Moscú" one in Venezuela, "Tokio" one in Papua New Guinea. Each entry here
 * was checked through the app's own search, which ranks results differently
 * from the service alone; some only resolve by their local name (Deutschland,
 * مصر, Bruxelles). Add a line when a viewer's city lands in the wrong place.
 * Keys match without accents, case or spaces.
 */
export const SPANISH_ALIASES = Object.freeze({
  // Ciudades
  // Nombres que existen en varios países: el que más pide este público.
  // Con el país se llega al otro: "!ir Córdoba España", "!ir Santiago RD".
  Córdoba: 'Córdoba, Argentina',
  'Santiago RD': 'Santiago de los Caballeros, República Dominicana',
  // Ciudades con el mismo nombre que su estado, cuyo nombre oficial es otro.
  Querétaro: 'Santiago de Querétaro, México',
  Tokio: 'Tokyo, Japan',
  Kioto: 'Kyoto, Japan',
  Londres: 'London, United Kingdom',
  'Nueva York': 'New York, United States',
  'Nueva Jersey': 'New Jersey, United States',
  'Nueva Orleans': 'New Orleans, United States',
  'Los Ángeles': 'Los Angeles, California, United States',
  Filadelfia: 'Philadelphia, United States',
  Washington: 'Washington, District of Columbia, United States',
  Montreal: 'Montreal, Quebec, Canada',
  Moscú: 'Moscow, Russia',
  'Nueva Delhi': 'New Delhi, India',
  'El Cairo': 'Cairo, Egypt',
  Estambul: 'Istanbul, Turkey',
  Atenas: 'Athens, Greece',
  Bruselas: 'Bruxelles',
  Estocolmo: 'Stockholm, Sweden',
  Varsovia: 'Warsaw, Poland',
  Praga: 'Prague, Czechia',
  Viena: 'Vienna, Austria',
  Venecia: 'Venezia, Italia',
  Ginebra: 'Geneva, Switzerland',
  Edimburgo: 'Edinburgh, United Kingdom',
  Jerusalén: 'Jerusalem, Israel',
  'Ciudad del Cabo': 'Cape Town, South Africa',
  Sídney: 'Sydney, Australia',
  Bangkok: 'Bangkok, Thailand',
  // Países
  Haití: 'Haiti',
  'Estados Unidos': 'United States',
  Alemania: 'Deutschland',
  Francia: 'France',
  Inglaterra: 'England',
  Egipto: 'مصر',
  Marruecos: 'Maroc',
});

const aliasKey = (value) => foldText(value).replace(/[\s-]/g, '');

const INDEX = new Map(
  Object.entries(SPANISH_ALIASES).map(([spanish, name]) => [
    aliasKey(spanish),
    name,
  ]),
);

/** The geocoder name for a Spanish exonym, or null when it is not listed. */
export function resolveSpanishAlias(place) {
  return INDEX.get(aliasKey(place)) || null;
}

/**
 * Country abbreviations a viewer may add after a city: "!ir Santo Domingo RD",
 * "!ir Miami USA", "!ir Córdoba MX". Each becomes "city, country" for the
 * geocoder. `abbreviations` match without accents, case, dots or spaces, so
 * "EE.UU.", "EE UU" and "eeuu" are the same. `names` are the ways the country
 * may already appear in an alias, so an alias for that same country is kept.
 */
export const COUNTRY_ABBREVIATIONS = Object.freeze([
  Object.freeze({
    abbreviations: Object.freeze(['RD']),
    country: 'República Dominicana',
    names: Object.freeze(['República Dominicana', 'Dominican Republic']),
  }),
  Object.freeze({
    abbreviations: Object.freeze(['EEUU', 'USA']),
    country: 'United States',
    names: Object.freeze(['United States', 'Estados Unidos']),
  }),
  Object.freeze({
    abbreviations: Object.freeze(['MX']),
    country: 'México',
    names: Object.freeze(['México', 'Mexico']),
  }),
]);

const compact = (value) => foldText(value).replace(/[\s.-]/g, '');

const ABBREVIATION_INDEX = new Map(
  COUNTRY_ABBREVIATIONS.flatMap((entry) =>
    entry.abbreviations.map((abbreviation) => [compact(abbreviation), entry]),
  ),
);

/**
 * Split a trailing country abbreviation off a place: "Santo Domingo RD" gives
 * `{ city: 'Santo Domingo', country: 'República Dominicana', names }`. A place
 * that is only the abbreviation gives `city: ''`. Null without one.
 */
export function splitCountryAbbreviation(place) {
  const words = String(place ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  // "EE UU" is two words; every other abbreviation is one.
  for (const count of [2, 1]) {
    if (words.length < count) continue;
    const entry = ABBREVIATION_INDEX.get(
      compact(words.slice(-count).join(' ')),
    );
    if (entry)
      return {
        city: words.slice(0, -count).join(' '),
        country: entry.country,
        names: entry.names,
      };
  }
  return null;
}
