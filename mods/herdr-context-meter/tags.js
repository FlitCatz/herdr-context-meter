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

// Matches the shipped `spaces` mod's space badge (`size(18)`, `rounded(5)`, `text_size(10.5)`, `gap(9)`, no padding).
export const SPACE_TAG_W = 18;
export const SPACE_TAG_H = 18;
export const SPACE_TAG_RADIUS = 5;
export const SPACE_TAG_FONT_SIZE = 10.5;
export const SPACE_TAG_GAP = 9;

/**
 * Tag letter for a space name: exactly the Spaces list badge letter (the name's
 * first character, uppercased). Spaces sharing an initial differ by badge color.
 * @param {string | null | undefined} name
 * @returns {string}
 */
export function spaceTagText(name) {
  return [...(name ?? "")][0]?.toUpperCase() ?? "?";
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
