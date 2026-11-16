import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// main.js imports Herdr's runtime modules, which only exist inside the app: answer them with stubs.
const EL_STUB = `function el(kind) {
  const node = { kind, props: {}, kids: [] };
  const api = new Proxy(node, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...args) => {
        if (prop === "child") target.kids.push(args[0]);
        else if (prop === "children") target.kids.push(...args[0]);
        else if (prop === "when") { if (args[0]) args[1](api); }
        else target.props[String(prop)] = args.length <= 1 ? args[0] : args;
        return api;
      };
    },
  });
  return api;
}`;
const HERDR_NAMES = ["exec", "hc", "home", "terminals", "panes", "focused", "spaces", "run", "theme", "shared",
  "setShared", "setAgentOrder", "openOverlay", "closeOverlay", "props", "readTextFile", "window", "layout"];
const STUBS = {
  "gpui-kit": `export class View {}; ${EL_STUB} ${["div", "image", "svg"].map((n) => `export const ${n} = () => el("${n}");`).join(" ")}`,
  "gpui-base": `${EL_STUB} ${["v_flex", "h_flex"].map((n) => `export const ${n} = () => el("${n}");`).join(" ")}`,
  herdr: `${HERDR_NAMES.map((n) => `export const ${n} = (...a) => globalThis.__herdrMock?.${n}?.(...a);`).join(" ")} export const agents = () => globalThis.__herdrMock?.agents?.() ?? []; export const checking = () => globalThis.__checking === true;`,
};
const hooks = `const STUBS = ${JSON.stringify(STUBS)};
export function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "stub:" + specifier, shortCircuit: true };
  return next(specifier, context);
}
export function load(url, context, next) {
  if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
  return next(url, context);
}`;
register("data:text/javascript," + encodeURIComponent(hooks));

const { default: Agents, clean, title } = await import("../mods/herdr-context-meter/main.js");

/** @param {Record<string, string>} saved */
function runInit(saved) {
  const removed = [];
  globalThis.localStorage = {
    getItem: (/** @type {string} */ k) => saved[k] ?? null,
    setItem: () => {},
    removeItem: (/** @type {string} */ k) => removed.push(k),
  };
  const timers = [];
  let polls = 0;
  const cx = { timer: { every: (/** @type {number} */ ms) => timers.push(ms) }, spawn: () => polls++, notify: () => {} };
  const view = new Agents();
  view.init({}, cx);
  return { view, timers, polls, removed };
}

test("clean drops a status glyph and its separator", () => {
  assert.equal(clean("✦  Working"), "Working");
  assert.equal(clean("⠋ - Thinking"), "Thinking");
  assert.equal(clean(null), "");
});

test("clean keeps a title that starts with an opening bracket or quote", () => {
  assert.equal(clean("[web] login"), "[web] login");
  assert.equal(clean("“quoted” plan"), "“quoted” plan");
  assert.equal(clean("✦ [web] login"), "[web] login");
});

test("clean strips Codex's blinking [ ! ] / [ . ] mark", () => {
  assert.equal(clean("[ ! ] fix login"), "fix login");
  assert.equal(clean("[ . ] fix login"), "fix login");
});

test("title uses a telling live title, but not one that is the terminal's own id or address", () => {
  const tab = { name: "shell", named: false };
  assert.equal(title(tab, { terminal: "t_1", title: "fix login" }), "fix login");
  assert.equal(title(tab, { terminal: "t_1", title: "t_1" }), "shell");
  assert.equal(title(tab, { address: "a_9", title: "✦ a_9" }), "shell");
});

test("init survives corrupt saved values", () => {
  for (const [changed, pins] of [["{not json", "[oops"], ["[1,2]", '{"a":1}'], ["null", "null"], ['"text"', '"text"']]) {
    const { view } = runInit({ changed, pins });
    assert.deepEqual(view.changed, {}, changed);
    assert.deepEqual(view.pendingPins, [], pins);
  }
});

test("init keeps valid saved values", () => {
  const { view, removed } = runInit({ changed: '{"a":{"s":"idle","at":1}}', pins: '["a"]' });
  assert.deepEqual(view.changed, { a: { s: "idle", at: 1 } });
  assert.deepEqual(view.pendingPins, ["a"]);
  assert.deepEqual(removed, []);
});

test("init starts the meter polling unless Herdr is checking the mod", () => {
  globalThis.__checking = false;
  const live = runInit({});
  assert.equal(live.timers.length, 2);
  assert.equal(live.polls, 1);
  globalThis.__checking = true;
  try {
    const checked = runInit({});
    assert.equal(checked.timers.length, 1);
    assert.equal(checked.polls, 0);
  } finally {
    delete globalThis.__checking;
  }
});

/**
 * Find the first element node whose props match `pred`, returning `[node, parent]`.
 * @param {any} node
 * @param {(n: any) => boolean} pred
 * @param {any} [parent]
 * @returns {[any, any] | null}
 */
function findEl(node, pred, parent = null) {
  if (!node || typeof node !== "object") return null;
  if (pred(node)) return [node, parent];
  for (const child of node.kids ?? []) {
    const found = findEl(child, pred, node);
    if (found) return found;
  }
  return null;
}

test("render draws Priority space tag at exact Spaces dimensions (18x18, r5, 10.5px, 0 padding, 9px gap) and aligns rowLine", () => {
  globalThis.__checking = true;
  /** @type {any} */ (globalThis).__herdrMock = {
    theme: () => ({ chrome: "#111", border: "#222", dim: "#666", foreground: "#eee", muted: "#999", selected: "#333", hover: "#222", working: "#eb0", blocked: "#e44", idle: "#777" }),
    layout: () => ({ id: "sidebar", size: { px: 268 } }),
    shared: (/** @type {string} */ k) => (k === "agents.sort" ? "priority" : k === "space.colors" ? { s1: "ansi4" } : undefined),
    agents: () => [
      { address: "t1", space: "s1", space_name: "mail-server", tab: "tab1", pane: "p1", status: "working", seq: 1, pinned: false, focused: false, program: { name: "Claude Code", icon: "claude.svg", tint: true } },
      { address: "t2", space: "s2", space_name: "herdr-context-meter", tab: "tab2", pane: "p2", status: "idle", seq: 2, pinned: false, focused: false, program: null },
      { address: "t3", space: "s3", space_name: "herdr-firstmate", tab: "tab3", pane: "p3", status: "idle", seq: 3, pinned: false, focused: false, program: null },
    ],
    terminals: () => [],
    panes: () => [],
    focused: () => ({}),
    spaces: () => [],
  };
  try {
    const { view } = runInit({});
    const tree = view.render(/** @type {any} */ ({}));

    const [tag1, row1Line1] = findEl(tree, (n) => n.props?.id === "ag-tag-t1") ?? [];
    assert.ok(tag1, "single-letter space tag should render");
    assert.equal(tag1.kids[0], "M");
    assert.equal(tag1.props.w, 18);
    assert.equal(tag1.props.h, 18);
    assert.equal(tag1.props.rounded, 5);
    assert.equal(tag1.props.text_size, 10.5);
    for (const pad of ["p", "px", "py", "pt", "pb", "pl", "pr"]) {
      assert.equal(tag1.props[pad], undefined, `tag should have no ${pad} padding`);
    }
    assert.equal(row1Line1.props.gap, 9);

    // Second line aligns under agent name: tag (18) + gap (9) + icon+gap (25) = 52
    const [ctx1] = findEl(tree, (n) => n.props?.id === "ctx-t1") ?? [];
    assert.equal(ctx1.props.pl, 52);

    // Collision tag (2 letters) keeps the same 18x18 box and aligns without icon (18 + 9 = 27)
    const [tag2] = findEl(tree, (n) => n.props?.id === "ag-tag-t2") ?? [];
    assert.equal(tag2.kids[0], "HC");
    assert.equal(tag2.props.w, 18);
    assert.equal(tag2.props.h, 18);
    assert.equal(tag2.props.text_size, 9.5);
    const [ctx2] = findEl(tree, (n) => n.props?.id === "ctx-t2") ?? [];
    assert.equal(ctx2.props.pl, 27);
  } finally {
    delete globalThis.__checking;
    delete /** @type {any} */ (globalThis).__herdrMock;
  }
});
