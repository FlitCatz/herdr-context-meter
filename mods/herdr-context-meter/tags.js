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

export const SPACE_TAG_MAX = 3;
export const SPACE_TAG_W = 8 + 8 * SPACE_TAG_MAX;

/**
 * Tag text of `length` characters for a space name. Length 1 is exactly the Spaces
 * list badge letter; longer tags take the initials of the name's word segments,
 * then fill up with the following characters of the last segment used.
 * @param {string | null | undefined} name
 * @param {number} length
 * @returns {string}
 */
export function spaceTagText(name, length) {
  const first = [...(name ?? "")][0]?.toUpperCase() ?? "?";
  const segments = (name ?? "").split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((seg) => [...seg]);
  if (length <= 1 || !segments.length) return first;
  const used = segments.slice(0, length);
  const chars = used.map((seg) => seg[0]);
  chars.push(...used[used.length - 1].slice(1, 1 + length - chars.length));
  return chars.join("").toUpperCase();
}

/**
 * Fixed pixel width of the space-tag badge column, sized for SPACE_TAG_MAX (3 letters)
 * so every row's icon, name, and second line align at one shared x.
 * @param {string} [_tag]
 * @returns {number}
 */
export function spaceTagWidth(_tag) {
  return SPACE_TAG_W;
}

/**
 * Build a map of `spaceId -> tagText` for all distinct spaces in `list`.
 * Every space starts with its Spaces badge letter; spaces whose tag collides with
 * another distinct space get one more letter, up to SPACE_TAG_MAX.
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
  /** @type {Map<string, string>} */
  const tags = new Map();
  for (const [id, name] of bySpace) tags.set(id, spaceTagText(name, 1));
  for (let length = 2; length <= SPACE_TAG_MAX; length++) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const tag of tags.values()) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    for (const [id, tag] of tags) {
      if ((counts.get(tag) ?? 0) > 1) tags.set(id, spaceTagText(bySpace.get(id), length));
    }
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
