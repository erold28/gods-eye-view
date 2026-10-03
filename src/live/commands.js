import { LIVE_CONFIG } from './config.js';
import { resolveKreyolAlias } from './kreyolAliases.js';
import { foldText } from './text.js';

/**
 * Read a live comment such as "!ir París" or "!ale Okap".
 *
 * Returns `{ ok: true, command, place, query }`, where `place` is what the
 * viewer wrote and `query` is what to search (a Kreyòl alias is translated),
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
  return {
    ok: true,
    command,
    place,
    query: resolveKreyolAlias(place) || place,
  };
}

function containsBlockedWord(place, blockedWords) {
  if (!blockedWords?.length) return false;
  const padded = ` ${foldText(place).replace(/-/g, ' ')} `;
  return blockedWords.some((blocked) => {
    const phrase = foldText(blocked);
    return phrase && padded.includes(` ${phrase} `);
  });
}
