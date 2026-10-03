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
