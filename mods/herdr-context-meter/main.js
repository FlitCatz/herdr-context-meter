import { View, div, image, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, exec, hc, home, props, readTextFile, run, settings, theme } from "herdr";
import { Rounds } from "./rounds.js";
import { readAll } from "./sources.js";
import { contentWidth, entryWidth, fit, levelOf, percentText, thresholds, tooltip } from "./usage.js";

/** @typedef {import("gpui-kit").Context} Context */
/** @typedef {import("gpui-kit").Color} Color */
/** @typedef {import("./usage.js").Entry} Entry */

// Transcript tails are cheap to read, but a copy keeps its timer while hidden: stay modest.
const REFRESH_MS = 5000;
// A round that has not finished by now is given up on and the next tick starts a new one.
const ROUND_LIMIT_MS = 20000;
// A number older than this is not shown as current: the entry says n/a instead.
const STALE_MS = 3 * REFRESH_MS + ROUND_LIMIT_MS;

// One entry: the agent's mark, the share, a short bar.
const MARK = 13;
const BAR_W = 30;
const BAR_H = 4;
const CHIP_W = 24;
const GAP = 10;
const PAD = 12;
// The widest the block is made when it is sized to its entries; beyond that, "+N".
const MAX_BLOCK_W = 640;
const SIZES = { mark: MARK, bar: BAR_W, inner: 5, between: GAP, pad: PAD, char: 7 };

export default class ContextMeter extends View {
  /**
   * @param {unknown} _props
   * @param {Context} cx
   */
  init(_props, cx) {
    // Per copy, not module scope: copies of a mod share its module.
    this.rounds = new Rounds(ROUND_LIMIT_MS);
    /** @type {Map<string, string>} session id -> transcript path, so `find` runs once per session */
    this.paths = new Map();
    /** @type {Map<string, boolean>} rollout path -> whether it is a sub-agent's, so `head` runs once its first line can be read */
    this.subagents = new Map();
    /** @type {{ at: number, entries: Map<string, Entry> }} */
    this.result = { at: 0, entries: new Map() };
    this.width = Infinity;
    /** @type {number | null} the width last asked of the layout for this block */
    this.asked = null;
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  /** @param {Context} cx */
  refresh(cx) {
    const ticket = this.rounds.begin(Date.now());
    // Redraw either way: an entry whose last read is too old turns to n/a on its own.
    if (ticket === null) { cx.notify(); return; }
    const list = agents().map((a) => ({ address: a.address, app: a.app, program: a.program }));
    const windows = props()?.windows;
    const host = { exec, hc, readTextFile, home: home() };
    cx.spawn(async (cx) => {
      /** @type {Map<string, Entry>} */
      let entries = new Map();
      try {
        entries = await readAll(host, list, { paths: this.paths, subagents: this.subagents, windows: windows && typeof windows === "object" ? windows : {} });
      } catch { /* every entry then reads n/a */ }
      // A round given up on before it finished comes back too late to be shown.
      if (!this.rounds.finish(ticket)) return;
      this.result = { at: Date.now(), entries };
      cx.notify();
    });
  }

  /**
   * @param {Record<string, Color>} t
   * @param {import("./usage.js").Level} level
   */
  color(t, level) {
    return level === "critical" ? t.blocked : level === "warn" ? t.working : t.muted;
  }

  /**
   * Not read yet: the first round is out, or the agent appeared since the last one.
   * @param {Entry | null} entry
   * @param {boolean} fresh
   */
  pending(entry, fresh) {
    return !(fresh && entry?.state === "ok") && (this.result.at === 0 || (fresh && entry === null));
  }

  /**
   * What an entry says: its share, "…" while unread, else "n/a".
   * @param {Entry | null} entry
   * @param {boolean} fresh
   */
  text(entry, fresh) {
    if (fresh && entry?.state === "ok") return percentText(entry.pct);
    return this.pending(entry, fresh) ? "…" : "n/a";
  }

  /**
   * @param {Record<string, Color>} t
   * @param {import("herdr").AgentInfo} a
   * @param {Entry | null} entry null while the first read is out
   * @param {{ warn: number, critical: number }} limits
   * @param {boolean} fresh
   */
  entry(t, a, entry, limits, fresh) {
    const shown = fresh ? entry : null;
    const ok = shown && shown.state === "ok" ? shown : null;
    const level = ok ? levelOf(ok.pct, limits) : "ok";
    const pending = this.pending(entry, fresh);
    const text = this.text(entry, fresh);
    const label = a.program?.name ?? a.app ?? "agent";
    const hint = tooltip(a.tab_name, label, shown ?? { state: "na", reason: pending ? "reading" : "no recent read" });
    const p = a.program;
    return h_flex().id(`ctx-${a.address}`).h(20).flex_none().gap(5).items_center().tooltip(hint)
      .when(Boolean(p?.icon), (el) => el.child(p.tint
        ? svg(p.icon).size(MARK).flex_none().text_color(t.muted)
        : image(p.icon).w(MARK).h(MARK).flex_none()))
      .child(div().text_size(11.5).font_medium().text_color(ok ? this.color(t, level) : t.dim).child(text))
      .child(div().w(BAR_W).h(BAR_H).flex_none().rounded(BAR_H / 2).bg(t.border)
        .when(Boolean(ok), (el) => el.child(div().h_full().rounded(BAR_H / 2).w(`${Math.max(2, Math.round(ok.pct))}%`).bg(this.color(t, level)))));
  }

  /**
   * With the `block` prop (this block's id in the layout) the block is made as wide as its entries,
   * so what follows it in the row starts right after them. The layout only ever gives a block a
   * fixed width; this asks for a new one when the entries change.
   * @param {number} px
   */
  sizeBlock(px) {
    const id = props()?.block;
    if (typeof id !== "string" || px === this.asked) return;
    this.asked = px;
    try { run("layout.resize", { id, px }); } catch { /* the block keeps the width the layout gave it */ }
  }

  render() {
    const t = /** @type {Record<string, Color>} */ (theme());
    const limits = thresholds(props());
    const fresh = Date.now() - this.result.at < STALE_MS;
    const items = agents().map((a) => ({ a, entry: this.result.entries.get(a.address) ?? null }));
    this.sizeBlock(Math.min(MAX_BLOCK_W, contentWidth(items.map(({ entry }) => this.text(entry, fresh).length), SIZES)));
    const { shown, hidden } = fit(
      items,
      ({ entry }) => (fresh && entry?.state === "ok" ? entry.pct : -1),
      ({ entry }) => entryWidth(this.text(entry, fresh).length, SIZES),
      this.width - 2 * PAD + 1,
      { between: GAP, chip: CHIP_W },
    );
    return h_flex().id("root").size_full().min_w(0).px(PAD).gap(GAP).items_center().justify_start().overflow_hidden()
      .bg(t.chrome).border_t(1).border_color(t.border).text_color(t.muted)
      .on_size_change((size, cx) => {
        // Reported at the person's zoom; widths here (and in the layout) are at zoom 1.
        this.width = size.width / (Number(settings()?.zoom) || 1);
        cx.notify();
      })
      .children(shown.map(({ a, entry }) => this.entry(t, a, entry, limits, fresh)))
      .when(hidden > 0, (el) => el.child(div().id("ctx-more").flex_none().text_size(11.5).text_color(t.dim)
        .tooltip(`${hidden} more agents, not shown for lack of room`).child(`+${hidden}`)));
  }
}
