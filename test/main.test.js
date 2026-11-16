import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// main.js imports Herdr's runtime modules, which only exist inside the app: answer them with stubs.
const NOOP = "() => undefined";
const HERDR_NAMES = ["exec", "hc", "home", "terminals", "panes", "focused", "spaces", "run", "theme", "shared",
  "setShared", "setAgentOrder", "openOverlay", "closeOverlay", "props", "readTextFile", "window", "layout"];
const STUBS = {
  "gpui-kit": `export class View {}; ${["div", "image", "svg"].map((n) => `export const ${n} = ${NOOP};`).join(" ")}`,
  "gpui-base": `${["v_flex", "h_flex"].map((n) => `export const ${n} = ${NOOP};`).join(" ")}`,
  herdr: `${HERDR_NAMES.map((n) => `export const ${n} = ${NOOP};`).join(" ")} export const agents = () => []; export const checking = () => globalThis.__checking === true;`,
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
