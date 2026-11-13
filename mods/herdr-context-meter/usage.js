// What the numbers mean: reading usage out of a transcript tail, the window each model has,
// the percentage as each tool itself reports it, and the wording. Pure functions, no
// Herdr imports, so they run under `node --test`.
//
// Only token counts, a model id and a timestamp are ever taken from a record. Nothing else
// in a line is looked at, kept or returned.

export const DEFAULT_WARN = 40;
export const DEFAULT_CRITICAL = 50;

export const STANDARD_WINDOW = 200000;
export const MILLION_WINDOW = 1000000;
export const AGY_GEMINI_WINDOW = 1024 * 1024;

// Codex's own "Context N% left" leaves this many tokens out of both the window and the
// usage (codex-rs/tui token_usage.rs: BASELINE_TOKENS), so its percentage is not total/window.
export const CODEX_BASELINE_TOKENS = 12000;

/**
 * @typedef {{ state: "ok", kind: "claude" | "codex" | "agy", pct: number, used: number, window: number,
 *   model: string | null, assumed: boolean, parts: [string, number][] }} Reading
 * @typedef {{ state: "na", reason: string, kind?: string }} Missing
 * @typedef {Reading | Missing} Entry
 * @typedef {"ok" | "warn" | "critical"} Level
 */

/** @param {string} reason @param {string} [kind] @returns {Missing} */
export const missing = (reason, kind) => (kind ? { state: "na", reason, kind } : { state: "na", reason });

const finite = (/** @type {unknown} */ n) => typeof n === "number" && Number.isFinite(n);

/**
 * Which tool an agent is, from what it reported (`agents()[i].app`).
 * @param {string | null | undefined} app
 * @returns {"claude" | "codex" | "agy" | null}
 */
export function kindOf(app) {
  if (app === "claude-code") return "claude";
  if (app === "codex") return "codex";
  if (app === "antigravity") return "agy";
  return null;
}

/**
 * Longest matching prefix in `overrides`, or null when none applies.
 * @param {string} id
 * @param {Record<string, unknown>} [overrides]
 * @returns {number | null}
 */
function windowOverride(id, overrides = {}) {
  let best = "";
  for (const key of Object.keys(overrides)) {
    if (id.startsWith(key) && key.length > best.length && finite(overrides[key]) && /** @type {number} */ (overrides[key]) > 0) best = key;
  }
  return best ? /** @type {number} */ (overrides[best]) : null;
}

// ---- Claude ---------------------------------------------------------------------------

const CLAUDE_MODEL = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/;

/**
 * Whether Claude Code gives this model a 1M window by itself (docs: model-config, "Default
 * auto-compact thresholds"): the Fable models, Sonnet and Haiku 5 and later, Opus 4.7 and
 * later. Earlier models have 1M only as an opt-in variant, which the record does not name.
 * @param {string} model
 */
function nativeMillion(model) {
  if (model.startsWith("claude-fable-")) return true;
  const m = CLAUDE_MODEL.exec(model);
  if (!m) return false;
  const major = Number(m[2]);
  const minor = Number(m[3] ?? 0);
  return m[1] === "opus" ? major > 4 || (major === 4 && minor >= 7) : major >= 5;
}

/**
 * The window of a Claude model. `overrides` maps a model id, or the start of one, to a token
 * count; the longest matching key wins and beats the built-in table.
 * @param {string | null} model
 * @param {Record<string, unknown>} [overrides]
 * @returns {{ tokens: number, assumed: boolean }}
 */
export function claudeWindow(model, overrides = {}) {
  const id = model ?? "";
  const hit = windowOverride(id, overrides);
  if (hit !== null) return { tokens: hit, assumed: false };
  if (nativeMillion(id)) return { tokens: MILLION_WINDOW, assumed: false };
  const known = CLAUDE_MODEL.test(id) || id.startsWith("claude-3");
  return { tokens: STANDARD_WINDOW, assumed: !known };
}

/**
 * The last main-conversation usage in the tail of a Claude transcript. Context in use is the
 * input side of the latest response: input + cache creation + cache read, which is also how
 * Claude Code's own status line computes `used_percentage` (output tokens are not counted).
 * @param {string} text the tail of the file; its first line may be cut
 * @returns {{ model: string, input: number, cacheWrite: number, cacheRead: number } | null}
 */
export function parseClaudeTail(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const u = o?.message?.usage;
    const model = o?.message?.model;
    // Sub-agent turns are another conversation's context; a synthetic message (an API error)
    // carries zeroed usage.
    if (o.type !== "assistant" || o.isSidechain || typeof model !== "string" || model === "<synthetic>" || !u) continue;
    const input = u.input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    if (![input, cacheWrite, cacheRead].every(finite) || input + cacheWrite + cacheRead <= 0) continue;
    return { model, input, cacheWrite, cacheRead };
  }
  return null;
}

/**
 * @param {{ model: string, input: number, cacheWrite: number, cacheRead: number }} rec
 * @param {Record<string, unknown>} [overrides]
 * @returns {Reading}
 */
export function claudeReading(rec, overrides) {
  const used = rec.input + rec.cacheWrite + rec.cacheRead;
  let { tokens: window, assumed } = claudeWindow(rec.model, overrides);
  // The record does not say whether a 1M variant is selected; more than the standard window
  // in use can only mean it is.
  if (used > window && window < MILLION_WINDOW) { window = MILLION_WINDOW; assumed = true; }
  return {
    state: "ok", kind: "claude", used, window, model: rec.model, assumed,
    pct: clampPct((used / window) * 100),
    parts: [["input", rec.input], ["cache write", rec.cacheWrite], ["cache read", rec.cacheRead]],
  };
}

// ---- Codex ----------------------------------------------------------------------------

/**
 * The latest token_count of a Codex rollout tail, and the model of its latest turn.
 * `at` is the record's own timestamp (ms), used to tell sessions apart.
 * @param {string} text the tail of the file; its first line may be cut
 * @returns {{ tokens: number, window: number, at: number, model: string | null } | null}
 */
export function parseCodexTail(text) {
  const lines = text.split("\n");
  let usage = null;
  let model = null;
  for (let i = lines.length - 1; i >= 0 && !(usage && model); i--) {
    const line = lines[i];
    const isCount = !usage && line.includes('"token_count"');
    const isTurn = !model && line.includes('"turn_context"');
    if (!isCount && !isTurn) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const p = o?.payload;
    if (isCount && p?.type === "token_count") {
      const tokens = p.info?.last_token_usage?.total_tokens;
      const window = p.info?.model_context_window;
      if (finite(tokens) && finite(window) && window > 0) usage = { tokens, window, at: Date.parse(o.timestamp) || 0 };
    } else if (isTurn && o.type === "turn_context" && typeof p?.model === "string") {
      model = p.model;
    }
  }
  return usage ? { ...usage, model } : null;
}

/**
 * Codex's "Context N% left", turned into the share used: both the usage and the window lose a
 * fixed baseline first. `last_token_usage.total_tokens` is what it counts as in the window.
 * @param {number} tokens
 * @param {number} window
 */
export function codexUsedPct(tokens, window) {
  if (window <= CODEX_BASELINE_TOKENS) return 100;
  const effective = window - CODEX_BASELINE_TOKENS;
  const used = Math.max(0, tokens - CODEX_BASELINE_TOKENS);
  return clampPct((used / effective) * 100);
}

/**
 * @param {{ tokens: number, window: number, model: string | null }} rec
 * @returns {Reading}
 */
export function codexReading(rec) {
  return {
    state: "ok", kind: "codex", used: rec.tokens, window: rec.window, model: rec.model, assumed: false,
    pct: codexUsedPct(rec.tokens, rec.window),
    parts: [],
  };
}

// ---- Antigravity CLI (agy) ------------------------------------------------------------

/**
 * The last PLANNER_RESPONSE usage in the tail of an agy `transcript.jsonl`.
 * Context in use is `input_tokens + cache_read_tokens`.
 * @param {string} text the tail of the file; its first line may be cut
 * @returns {{ input: number, cacheRead: number, output: number, at: number } | null}
 */
export function parseAgyTail(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"PLANNER_RESPONSE"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type !== "PLANNER_RESPONSE") continue;
    const input = o.input_tokens ?? 0;
    const cacheRead = o.cache_read_tokens ?? 0;
    if (!finite(input) || !finite(cacheRead) || input + cacheRead <= 0) continue;
    const output = finite(o.output_tokens) ? o.output_tokens : 0;
    return { input, cacheRead, output, at: Date.parse(o.created_at) || 0 };
  }
  return null;
}

/**
 * Normalizes an agy Claude display name (e.g. "Claude Opus 5.5 (High)") to a model id prefix
 * for `claudeWindow`.
 * @param {string} id
 */
function normalizeAgyClaudeId(id) {
  return id
    .toLowerCase()
    .replace(/\s+\((?:low|medium|high|xhigh|max)\)$/, "")
    .replace(/[.\s]+/g, "-");
}

/**
 * The context window of an agy model. `overrides` beats the built-in table; Gemini models
 * default to 1,048,576 tokens and Claude models reuse `claudeWindow`.
 * @param {string | null | undefined} model
 * @param {Record<string, unknown>} [overrides]
 * @returns {{ tokens: number, assumed: boolean }}
 */
export function agyWindow(model, overrides = {}) {
  const id = model ?? "";
  const hit = windowOverride(id, overrides);
  if (hit !== null) return { tokens: hit, assumed: false };
  if (/^claude[-\s]/i.test(id)) return claudeWindow(normalizeAgyClaudeId(id), overrides);
  const known = /^gemini[-\s]|^orchestrator\b/i.test(id);
  return { tokens: AGY_GEMINI_WINDOW, assumed: !known };
}

/**
 * @param {{ input: number, cacheRead: number, output: number }} rec
 * @param {string | null | undefined} model
 * @param {Record<string, unknown>} [overrides]
 * @returns {Reading}
 */
export function agyReading(rec, model, overrides) {
  const used = rec.input + rec.cacheRead;
  const { tokens: window, assumed } = agyWindow(model, overrides);
  return {
    state: "ok", kind: "agy", used, window, model: model ?? null, assumed,
    pct: clampPct((used / window) * 100),
    parts: [["input", rec.input], ["cache read", rec.cacheRead]],
  };
}

// ---- Thresholds and wording -------------------------------------------------------------

/** @param {number} n */
function clampPct(n) {
  return Math.min(100, Math.max(0, n));
}

/**
 * Warn and critical shares from the layout's props. A value that is missing or not a number
 * above 0 and up to 100 falls back to its own default; both fall back to the defaults when
 * warn is not below critical.
 * @param {{ warn?: unknown, critical?: unknown } | null | undefined} props
 */
export function thresholds(props) {
  const pick = (/** @type {unknown} */ v, /** @type {number} */ fallback) =>
    finite(v) && /** @type {number} */ (v) > 0 && /** @type {number} */ (v) <= 100 ? /** @type {number} */ (v) : fallback;
  const warn = pick(props?.warn, DEFAULT_WARN);
  const critical = pick(props?.critical, DEFAULT_CRITICAL);
  return warn < critical ? { warn, critical } : { warn: DEFAULT_WARN, critical: DEFAULT_CRITICAL };
}

/**
 * The level of the share as shown (rounded, as `percentText` prints it), so the color always
 * matches the number.
 * @param {number} pct
 * @param {{ warn: number, critical: number }} limits
 * @returns {Level}
 */
export function levelOf(pct, limits) {
  const shown = Math.round(pct);
  return shown >= limits.critical ? "critical" : shown >= limits.warn ? "warn" : "ok";
}

/** @param {number} pct */
export const percentText = (pct) => `${Math.round(pct)}%`;

/** @param {number} n */
export const grouped = (n) => Math.round(n).toLocaleString("en-US");

/** @param {string | null | undefined} model */
export function shortModel(model) {
  if (!model) return "";
  const trimmed = model
    .replace(/\s+\((?:Low|Medium|High|XHigh|Max)\)$/i, "")
    .replace(/-(?:low|medium|high|xhigh|max)$/i, "");
  if (/^gemini-/i.test(trimmed)) {
    return trimmed
      .split("-")
      .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join(" ");
  }
  return trimmed.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

/**
 * The hover text: the tab, then what was counted.
 * @param {string} tab
 * @param {string} label the program's name
 * @param {Entry} entry
 */
export function tooltip(tab, label, entry) {
  const head = `${tab} · ${label}`;
  if (entry.state === "na") return `${head}\nContext: n/a (${entry.reason})`;
  const lines = [head];
  if (entry.model) lines.push(entry.model);
  lines.push(`${grouped(entry.used)} of ${grouped(entry.window)} tokens (${percentText(entry.pct)})`);
  if (entry.kind === "claude" || entry.kind === "agy") {
    lines.push(entry.parts.map(([name, n]) => `${name} ${grouped(n)}`).join(" · "));
    if (entry.assumed) lines.push("Window assumed; set it with the windows prop.");
  } else {
    lines.push(`Codex counts ${grouped(CODEX_BASELINE_TOKENS)} tokens as free, like its own "Context % left".`);
  }
  return lines.join("\n");
}
