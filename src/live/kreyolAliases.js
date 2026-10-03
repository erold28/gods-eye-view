import { foldText } from './text.js';

/**
 * Haitian place names in Kreyòl → the name a geocoder recognizes.
 * Keys are matched without accents, case or spaces, so "Pòtoprens",
 * "potoprens" and "Poto Prens" all match. Cities carry ", Haiti" so a name
 * shared with another country resolves in Haiti.
 */
export const KREYOL_ALIASES = Object.freeze({
  Pòtoprens: 'Port-au-Prince, Haiti',
  Okap: 'Cap-Haïtien, Haiti',
  Gonayiv: 'Gonaïves, Haiti',
  Jakmèl: 'Jacmel, Haiti',
  Okay: 'Les Cayes, Haiti',
  Pòdepè: 'Port-de-Paix, Haiti',
  Jeremi: 'Jérémie, Haiti',
  Senmak: 'Saint-Marc, Haiti',
  Fòlibète: 'Fort-Liberté, Haiti',
  Ench: 'Hinche, Haiti',
  Leyogàn: 'Léogâne, Haiti',
  Petyonvil: 'Pétion-Ville, Haiti',
  Kenskòf: 'Kenscoff, Haiti',
  Miragwàn: 'Miragoâne, Haiti',
  Kafou: 'Carrefour, Haiti',
  Dèlma: 'Delmas, Haiti',
  Kwadèbouke: 'Croix-des-Bouquets, Haiti',
  Tigwav: 'Petit-Goâve, Haiti',
  Wanament: 'Ouanaminthe, Haiti',
  Lenbe: 'Limbé, Haiti',
  Ayiti: 'Haiti',
});

const aliasKey = (value) => foldText(value).replace(/[\s-]/g, '');

const INDEX = new Map(
  Object.entries(KREYOL_ALIASES).map(([kreyol, name]) => [
    aliasKey(kreyol),
    name,
  ]),
);

/** The geocoder name for a Kreyòl place, or null when it is not an alias. */
export function resolveKreyolAlias(place) {
  return INDEX.get(aliasKey(place)) || null;
}
