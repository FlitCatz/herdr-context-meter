import { test } from "node:test";
import assert from "node:assert/strict";
import { BAR_H, BAR_W, Meter, STALE_MS, SUB_BAR_W } from "../mods/herdr-context-meter/meter.js";

/** Tiny fluent element stub recording gpui-kit builder calls for assertions. */
function elStub(kind) {
  const node = {
    kind,
    props: /** @type {Record<string, unknown>} */ ({}),
    children: /** @type {any[]} */ ([]),
  };
  const api = new Proxy(node, {
    get(target, prop) {
      if (prop in target) return target[/** @type {keyof typeof target} */ (prop)];
      return (/** @type {any[]} */ ...args) => {
        if (prop === "child") {
          target.children.push(args[0]);
        } else if (prop === "children") {
          target.children.push(...args[0]);
        } else if (prop === "when") {
          if (args[0]) args[1](api);
        } else {
          target.props[String(prop)] = args.length <= 1 ? args[0] : args;
        }
        return api;
      };
    },
  });
  return api;
}

const ui = {
  div: () => elStub("div"),
  h_flex: () => elStub("h_flex"),
};

const THEME = /** @type {Record<string, any>} */ ({
  muted: "#888888",
  working: "#eab308",
  blocked: "#ef4444",
  dim: "#666666",
  border: "#333333",
});

function makeAgent(address = "t1", tab = "api", app = "claude-code", name = "Claude Code") {
  return /** @type {any} */ ({
    address,
    tab_name: tab,
    app,
    program: { name },
  });
}

function makeMeter(nowFn, propsFn = () => ({})) {
  return new Meter(null, {
    ui: /** @type {any} */ (ui),
    host: /** @type {any} */ ({ exec: async () => ({ code: 1, stdout: "", stderr: "" }), hc: async () => ({ code: 1, stdout: "", stderr: "" }), readTextFile: async () => null, home: "/tmp" }),
    agents: () => [],
    props: propsFn,
    now: nowFn,
  });
}

function okEntry(pct) {
  return /** @type {any} */ ({
    state: "ok",
    kind: "claude",
    pct,
    used: Math.round(pct * 2000),
    window: 200000,
    model: "claude-opus-4-6",
    assumed: false,
    parts: [["input", Math.round(pct * 2000)]],
  });
}

test("rowLine: pending before first read, then ok / warn (40%) / critical (50%) colors and bar widths", () => {
  let now = 10000;
  const meter = makeMeter(() => now);
  const a = makeAgent("t1");

  // Before first read completes: shows ellipsis and empty track
  const pendingRow = meter.rowLine(THEME, a, true);
  assert.equal(pendingRow.props.id, "ctx-t1");
  assert.equal(pendingRow.props.pl, 25);
  assert.equal(pendingRow.children[0].props.w, BAR_W);
  assert.equal(pendingRow.children[0].props.h, BAR_H);
  assert.equal(pendingRow.children[0].children.length, 0);
  assert.equal(pendingRow.children[1].children[0], "…");
  assert.equal(pendingRow.children[1].props.text_color, THEME.dim);

  // With readings: <40 muted, 40 warn, 50 critical
  meter.result = {
    at: now,
    entries: new Map([
      ["t1", okEntry(18)],
      ["t2", okEntry(40)],
      ["t3", okEntry(50)],
    ]),
  };

  const rOk = meter.rowLine(THEME, makeAgent("t1"), false);
  assert.equal(rOk.props.pl, 0);
  assert.equal(rOk.children[0].children[0].props.w, "18%");
  assert.equal(rOk.children[0].children[0].props.bg, THEME.muted);
  assert.equal(rOk.children[1].children[0], "18%");
  assert.equal(rOk.children[1].props.text_color, THEME.muted);

  const rWarn = meter.rowLine(THEME, makeAgent("t2"), true);
  assert.equal(rWarn.children[0].children[0].props.w, "40%");
  assert.equal(rWarn.children[0].children[0].props.bg, THEME.working);
  assert.equal(rWarn.children[1].children[0], "40%");
  assert.equal(rWarn.children[1].props.text_color, THEME.working);

  const rCrit = meter.rowLine(THEME, makeAgent("t3"), true);
  assert.equal(rCrit.children[0].children[0].props.w, "50%");
  assert.equal(rCrit.children[0].children[0].props.bg, THEME.blocked);
  assert.equal(rCrit.children[1].children[0], "50%");
  assert.equal(rCrit.children[1].props.text_color, THEME.blocked);
});

test("rowLine and railBar: n/a entries and stale-to-n/a transition after STALE_MS", () => {
  let now = 50000;
  const meter = makeMeter(() => now);
  meter.result = {
    at: now,
    entries: new Map([
      ["t1", okEntry(45)],
      ["t2", { state: "na", reason: "no session file" }],
    ]),
  };

  // Fresh n/a entry
  const naRow = meter.rowLine(THEME, makeAgent("t2"), true);
  assert.equal(naRow.children[0].children.length, 0);
  assert.equal(naRow.children[1].children[0], "n/a");
  assert.equal(naRow.children[1].props.text_color, THEME.dim);
  assert.match(String(naRow.props.tooltip), /no session file/);

  // Fresh railBar for 45% (warn) and n/a
  const railWarn = meter.railBar(THEME, makeAgent("t1"));
  assert.equal(railWarn.props.id, "ctx-rail-t1");
  assert.equal(railWarn.props.h, 2);
  assert.equal(railWarn.children[0].props.w, "45%");
  assert.equal(railWarn.children[0].props.bg, THEME.working);

  const railNa = meter.railBar(THEME, makeAgent("t2"));
  assert.equal(railNa.children.length, 0);

  // Advance clock past STALE_MS: cached 45% turns into n/a on both rowLine and railBar
  now += STALE_MS;
  const staleRow = meter.rowLine(THEME, makeAgent("t1"), true);
  assert.equal(staleRow.children[0].children.length, 0);
  assert.equal(staleRow.children[1].children[0], "n/a");
  assert.equal(staleRow.children[1].props.text_color, THEME.dim);
  assert.match(String(staleRow.props.tooltip), /no recent read/);

  const staleRail = meter.railBar(THEME, makeAgent("t1"));
  assert.equal(staleRail.children.length, 0);
});

test("railBar: enforces minimum visible 4% fill for 0-3% readings and respects custom props thresholds", () => {
  const now = 1000;
  const meter = makeMeter(() => now, () => ({ warn: 20, critical: 30 }));
  meter.result = {
    at: now,
    entries: new Map([
      ["t1", okEntry(1)],
      ["t2", okEntry(25)],
      ["t3", okEntry(30)],
    ]),
  };

  assert.equal(meter.railBar(THEME, makeAgent("t1")).children[0].props.w, "4%");
  assert.equal(meter.railBar(THEME, makeAgent("t1")).children[0].props.bg, THEME.muted);
  assert.equal(meter.railBar(THEME, makeAgent("t2")).children[0].props.bg, THEME.working);
  assert.equal(meter.railBar(THEME, makeAgent("t3")).children[0].props.bg, THEME.blocked);
});

test("subReading: a kept sub-agent's reading stays on one line, shorter than the row line, same colors and n/a rule", () => {
  let now = 2000;
  const meter = makeMeter(() => now);
  meter.result = {
    at: now,
    entries: new Map([
      ["k1", okEntry(52)],
      ["k2", { state: "na", reason: "no main session file" }],
    ]),
  };

  const crit = meter.subReading(THEME, makeAgent("k1"));
  assert.equal(crit.kind, "h_flex");
  assert.notEqual(crit.props.id, meter.rowLine(THEME, makeAgent("k1"), true).props.id);
  assert.ok("flex_none" in crit.props);
  assert.equal(crit.props.pl, undefined);
  assert.ok(SUB_BAR_W < BAR_W);
  assert.equal(crit.children[0].props.w, SUB_BAR_W);
  assert.equal(crit.children[0].props.h, BAR_H);
  assert.equal(crit.children[0].children[0].props.w, "52%");
  assert.equal(crit.children[0].children[0].props.bg, THEME.blocked);
  assert.equal(crit.children[1].children[0], "52%");
  assert.equal(crit.children[1].props.text_color, THEME.blocked);

  const na = meter.subReading(THEME, makeAgent("k2"));
  assert.equal(na.children[0].children.length, 0);
  assert.equal(na.children[1].children[0], "n/a");
  assert.equal(na.children[1].props.text_color, THEME.dim);
  assert.match(String(na.props.tooltip), /no main session file/);

  now += STALE_MS;
  const stale = meter.subReading(THEME, makeAgent("k1"));
  assert.equal(stale.children[1].children[0], "n/a");
});
