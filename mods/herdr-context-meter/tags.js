// Space tag badges and row label helpers for herdr-context-meter.
// Pure functions so they run under `node --test`.

/** @typedef {import("gpui-kit").Color} Color */

// Matches the shipped `spaces` mod's MARK palette so each space's tag matches its Spaces badge.
export const SPACE_MARK = /** @type {Record<string, Color>} */ ({
  ansi6: "#22a99a",
  ansi3: "#e3814f",
  ansi4: "#5b8def",
  ansi5: "#8b7cf6",
  ansi2: "#3fae6a",
  ansi1: "#d9649a",
});

/**
 * Resolve the background color for a space badge from `shared("space.colors")`.
 * @param {string} spaceId
 * @param {Record<string, string> | null | undefined} colors
 * @param {Record<string, Color>} t
 * @returns {Color}
 */
export function spaceColor(spaceId, colors, t) {
  const color = colors?.[spaceId] ?? "ansi6";
  return /** @type {Color} */ (color.startsWith("#") ? color : (SPACE_MARK[color] ?? t[color] ?? SPACE_MARK.ansi6));
}

/**
 * Compute deterministic 1- or 2-letter tag text for a space name.
 * Uses 1 letter by default; when `collide` is true, uses the first letters of the
 * first two word segments (or the first two characters for a single-word name).
 * @param {string | null | undefined} name
 * @param {boolean} collide
 * @returns {string}
 */
export function spaceTagText(name, collide) {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "?";
  const segments = trimmed.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!segments.length) return [...trimmed][0].toUpperCase();
  const firstChars = [...segments[0]];
  const initial = firstChars[0].toUpperCase();
  if (!collide) return initial;
  if (segments.length >= 2) {
    const secondChar = [...segments[1]][0];
    if (secondChar) return initial + secondChar.toUpperCase();
  }
  return firstChars.slice(0, 2).join("").toUpperCase();
}

/**
 * Build a map of `spaceId -> tagText` for all distinct spaces in `list`.
 * Spaces whose initial collides with another distinct space get a 2-letter tag.
 * @param {{ space: string, space_name?: string | null }[]} list
 * @returns {Map<string, string>}
 */
export function spaceTags(list) {
  /** @type {Map<string, string>} */
  const bySpace = new Map();
  for (const item of list) {
    if (!item.space || bySpace.has(item.space)) continue;
    bySpace.set(item.space, item.space_name ?? "");
  }
  /** @type {Map<string, number>} */
  const initialCounts = new Map();
  for (const name of bySpace.values()) {
    const ch = spaceTagText(name, false);
    initialCounts.set(ch, (initialCounts.get(ch) ?? 0) + 1);
  }
  /** @type {Map<string, string>} */
  const tags = new Map();
  for (const [id, name] of bySpace) {
    const ch = spaceTagText(name, false);
    tags.set(id, spaceTagText(name, (initialCounts.get(ch) ?? 0) > 1));
  }
  return tags;
}

/**
 * Primary display name for an agent row: the de-duplicated detail when present,
 * otherwise the tab/title label unless it is a bare automatic tab number (in which
 * case the program name wins).
 * @param {{ program?: { name?: string | null } | null }} a
 * @param {string | null | undefined} more
 * @param {string} rawLabel
 * @returns {string}
 */
export function agentRowName(a, more, rawLabel) {
  return more ?? (/^\d+$/.test(rawLabel) ? a.program?.name || rawLabel : rawLabel);
}
