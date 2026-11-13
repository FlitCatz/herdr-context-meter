import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, exec, hc, home, props, readTextFile } from "herdr";
import { Rounds } from "./rounds.js";
import { readAll } from "./sources.js";
import { levelOf, percentText, thresholds, tooltip } from "./usage.js";

/** @typedef {import("gpui-kit").Context} Context */
/** @typedef {import("gpui-kit").Color} Color */
/** @typedef {import("./usage.js").Entry} Entry */
/** @typedef {import("./usage.js").Level} Level */

const REFRESH_MS = 5000;
const ROUND_LIMIT_MS = 20000;
const STALE_MS = 3 * REFRESH_MS + ROUND_LIMIT_MS;

const BAR_W = 56;
const BAR_H = 4;

export class Meter {
  /** @param {Context} cx */
  constructor(cx) {
    this.rounds = new Rounds(ROUND_LIMIT_MS);
    /** @type {Map<string, string>} */
    this.paths = new Map();
    /** @type {Map<string, boolean>} */
    this.subagents = new Map();
    /** @type {{ at: number, entries: Map<string, Entry> }} */
    this.result = { at: 0, entries: new Map() };
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  /** @param {Context} cx */
  refresh(cx) {
    const ticket = this.rounds.begin(Date.now());
    if (ticket === null) { cx.notify(); return; }
    const list = agents().map((a) => ({ address: a.address, app: a.app, program: a.program }));
    const windows = props()?.windows;
    const host = { exec, hc, readTextFile, home: home() };
    cx.spawn(async (cx) => {
      /** @type {Map<string, Entry>} */
      let entries = new Map();
      try {
        entries = await readAll(host, list, {
          paths: this.paths,
          subagents: this.subagents,
          windows: windows && typeof windows === "object" ? windows : {},
        });
      } catch { /* every entry then reads n/a */ }
      if (!this.rounds.finish(ticket)) return;
      this.result = { at: Date.now(), entries };
      cx.notify();
    });
  }

  /**
   * @param {Record<string, Color>} t
   * @param {Level} level
   */
  color(t, level) {
    return level === "critical" ? t.blocked : level === "warn" ? t.working : t.muted;
  }

  /**
   * @param {Entry | null} entry
   * @param {boolean} fresh
   */
  pending(entry, fresh) {
    return !(fresh && entry?.state === "ok") && (this.result.at === 0 || (fresh && entry === null));
  }

  /**
   * @param {Entry | null} entry
   * @param {boolean} fresh
   */
  text(entry, fresh) {
    if (fresh && entry?.state === "ok") return percentText(entry.pct);
    return this.pending(entry, fresh) ? "…" : "n/a";
  }

  /** @param {import("herdr").AgentInfo} a */
  inspect(a) {
    const limits = thresholds(props());
    const fresh = Date.now() - this.result.at < STALE_MS;
    const entry = this.result.entries.get(a.address) ?? null;
    const shown = fresh ? entry : null;
    const ok = shown && shown.state === "ok" ? shown : null;
    const level = ok ? levelOf(ok.pct, limits) : /** @type {Level} */ ("ok");
    const pending = this.pending(entry, fresh);
    const text = this.text(entry, fresh);
    const label = a.program?.name ?? a.app ?? "agent";
    const hint = tooltip(a.tab_name, label, shown ?? { state: "na", reason: pending ? "reading" : "no recent read" });
    return { ok, level, text, hint };
  }

  /**
   * Second line under an expanded agent row: a small bar and the percentage.
   * @param {Record<string, Color>} t
   * @param {import("herdr").AgentInfo} a
   * @param {boolean} hasIcon
   */
  rowLine(t, a, hasIcon) {
    const { ok, level, text, hint } = this.inspect(a);
    return h_flex()
      .id(`ctx-${a.address}`)
      .pl(hasIcon ? 25 : 0)
      .gap(6)
      .items_center()
      .tooltip(hint)
      .child(
        div()
          .w(BAR_W)
          .h(BAR_H)
          .flex_none()
          .rounded(BAR_H / 2)
          .bg(t.border)
          .when(Boolean(ok), (el) =>
            el.child(
              div()
                .h_full()
                .rounded(BAR_H / 2)
                .w(`${Math.max(2, Math.round(ok.pct))}%`)
                .bg(this.color(t, level)),
            ),
          ),
      )
      .child(
        div()
          .text_size(11)
          .font_medium()
          .text_color(ok ? this.color(t, level) : t.dim)
          .child(text),
      );
  }

  /**
   * Thin bar under a collapsed rail row so warning/critical agents stay visible.
   * @param {Record<string, Color>} t
   * @param {import("herdr").AgentInfo} a
   */
  railBar(t, a) {
    const { ok, level, hint } = this.inspect(a);
    return div()
      .id(`ctx-rail-${a.address}`)
      .w_full()
      .h(2)
      .rounded(1)
      .bg(t.border)
      .tooltip(hint)
      .when(Boolean(ok), (el) =>
        el.child(
          div()
            .h_full()
            .rounded(1)
            .w(`${Math.max(4, Math.round(ok.pct))}%`)
            .bg(this.color(t, level)),
        ),
      );
  }
}
