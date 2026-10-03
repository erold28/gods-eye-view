/** Fold text for comparisons: lower case, no accents, single spaces. */
export function foldText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}!@#\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
