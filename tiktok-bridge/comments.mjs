/**
 * Which TikTok LIVE chat messages the bridge passes on, and in what shape.
 * Kept free of the TikTok library so it is tested directly.
 */

const MAX_TEXT = 200;

/** Fold for comparing a command: lower case, no accents. */
const fold = (value) =>
  String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

/**
 * `{ user, text }` for a chat message that starts with one of `commands`
 * ("!ir París", "!ALE Okap"), or null for ordinary chat. Only requests leave
 * the bridge: the rest of the chat never reaches the app.
 */
export function requestFromChat(data, commands) {
  const text = String(data?.comment ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
  if (!text) return null;
  const first = fold(text.split(' ')[0]);
  if (!commands.some((command) => fold(command) === first)) return null;
  const user = String(data?.user?.uniqueId ?? data?.uniqueId ?? '').trim();
  return { user: user ? `@${user.replace(/^@+/, '')}` : '', text };
}

/** "@mr.eroldoficial" or a TikTok LIVE link, as the bare username. */
export function normalizeUsername(value) {
  const text = String(value ?? '').trim();
  const fromUrl = /tiktok\.com\/@([^/?#\s]+)/i.exec(text)?.[1];
  return (fromUrl || text).replace(/^@+/, '').trim();
}
