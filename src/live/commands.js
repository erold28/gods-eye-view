import { LIVE_CONFIG } from './config.js';
import { resolveKreyolAlias } from './kreyolAliases.js';
import {
  resolveSpanishAlias,
  splitCountryAbbreviation,
} from './spanishAliases.js';
import { foldText } from './text.js';

/**
 * Read a live comment such as "!ir París" or "!ale Okap".
 *
 * Returns `{ ok: true, command, place, query }`, where `place` is what the
 * viewer wrote and `query` is what to search (a Kreyòl or Spanish alias is
 * translated),
 * or `{ ok: false, reason }`. A comment without a command is `not-command`, so
 * ordinary chat is ignored quietly.
 *
 * Any digit rejects the request: coordinates and street addresses
 * ("Calle 5 #123") both need numbers, and city names almost never do.
 */
export function parseLiveComment(text, config = LIVE_CONFIG) {
  const raw = String(text ?? '').trim();
  const match = /^(\S+)\s*(.*)$/su.exec(raw);
  if (!match) return { ok: false, reason: 'not-command' };
  const command = foldText(match[1]);
  if (!config.commands.includes(command))
    return { ok: false, reason: 'not-command' };
  const place = match[2].replace(/\s+/g, ' ').trim();
  if (!place) return { ok: false, reason: 'empty' };
  if (place.length > config.maxPlaceLength)
    return { ok: false, reason: 'too-long' };
  if (/\p{N}/u.test(place)) return { ok: false, reason: 'has-numbers' };
  if (/https?:|www\.|\.\w{2,}\//iu.test(place) || place.includes('@'))
    return { ok: false, reason: 'link-or-mention' };
  if (containsBlockedWord(place, config.blockedWords))
    return { ok: false, reason: 'blocked-word' };
  return { ok: true, command, place, query: placeQuery(place) };
}

const aliasFor = (place) =>
  resolveKreyolAlias(place) || resolveSpanishAlias(place);

/**
 * What to search for a place as written. A whole-name alias wins ("Santiago
 * RD"); then a trailing country abbreviation turns "Santo Domingo RD" into
 * "Santo Domingo, República Dominicana". The city keeps its own alias only
 * when that alias is in the same country ("Nueva York USA" still reaches New
 * York, while "Córdoba MX" leaves the Argentine default for Mexico's).
 */
export function placeQuery(place) {
  const whole = aliasFor(place);
  if (whole) return whole;
  const split = splitCountryAbbreviation(place);
  if (!split) return place;
  if (!split.city) return split.country;
  const alias = aliasFor(split.city);
  const sameCountry =
    alias &&
    split.names.some((name) => foldText(alias).includes(foldText(name)));
  return sameCountry ? alias : `${split.city}, ${split.country}`;
}

/**
 * The forms of one blocked word or phrase that are refused: as written, its
 * plural (-s, -es), and, for a phrase, written as one word ("sal pwòp" also
 * blocks "salpwòp" and "salpwòps"). Matching ignores accents and case.
 */
export function blockedWordForms(blocked) {
  const phrase = foldText(blocked).replace(/-/g, ' ').trim();
  if (!phrase) return [];
  const joined = phrase.replace(/\s+/g, '');
  const bases = [...new Set([phrase, joined])];
  return [...new Set(bases.flatMap((base) => [base, `${base}s`, `${base}es`]))];
}

function containsBlockedWord(place, blockedWords) {
  if (!blockedWords?.length) return false;
  const padded = ` ${foldText(place).replace(/-/g, ' ')} `;
  return blockedWords.some((blocked) =>
    blockedWordForms(blocked).some((form) => padded.includes(` ${form} `)),
  );
}

/**
 * The words in palabras-bloqueadas.txt: one per line; empty lines and lines
 * starting with "#" are ignored.
 */
export function parseBlockedWordsText(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}
