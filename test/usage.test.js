import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CODEX_BASELINE_TOKENS, claudeReading, claudeWindow, codexReading, codexUsedPct, fit, grouped, kindOf, levelOf,
  parseClaudeTail, parseCodexTail, percentText, thresholds, tooltip,
} from "../mods/herdr-context-meter/usage.js";

const fixture = (/** @type {string} */ name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("kindOf maps the app an agent reports", () => {
  assert.equal(kindOf("claude-code"), "claude");
  assert.equal(kindOf("codex"), "codex");
  assert.equal(kindOf("agy"), null);
  assert.equal(kindOf(null), null);
});

test("Claude windows: native 1M models and 200K ones", () => {
  for (const id of ["claude-fable-5-2", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5-5-20270101"]) {
    assert.deepEqual(claudeWindow(id), { tokens: 1000000, assumed: false }, id);
  }
  for (const id of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-sonnet-4-5-20250929", "claude-opus-4-1-20250805", "claude-3-5-sonnet-20241022", "claude-haiku-4-5"]) {
    assert.deepEqual(claudeWindow(id), { tokens: 200000, assumed: false }, id);
  }
  // An id the table cannot place gets the standard window, flagged as a guess.
  assert.deepEqual(claudeWindow("my-gateway-alias"), { tokens: 200000, assumed: true });
  assert.deepEqual(claudeWindow(null), { tokens: 200000, assumed: true });
});

test("window overrides: the longest matching prefix wins, bad values are ignored", () => {
  const overrides = { "claude-opus-5": 500000, "claude-opus-5-5": 400000, "claude-sonnet": "big", "claude-haiku": -1 };
  assert.deepEqual(claudeWindow("claude-opus-5-5", overrides), { tokens: 400000, assumed: false });
  assert.deepEqual(claudeWindow("claude-opus-5-6", overrides), { tokens: 500000, assumed: false });
  assert.deepEqual(claudeWindow("claude-sonnet-5-5", overrides), { tokens: 1000000, assumed: false });
  assert.deepEqual(claudeWindow("claude-haiku-5-5", overrides), { tokens: 1000000, assumed: false });
});

test("Claude tail: the last main-conversation usage, skipping sub-agents and synthetic errors", () => {
  const rec = parseClaudeTail(fixture("claude-transcript.jsonl"));
  assert.deepEqual(rec, { model: "claude-sonnet-5-5", input: 2, cacheWrite: 1551, cacheRead: 129078 });
});

test("Claude tail: a cut first line and unrelated lines are tolerated, no usage gives null", () => {
  const text = fixture("claude-transcript.jsonl");
  const cut = text.slice(text.indexOf("\n") + 20);
  assert.equal(parseClaudeTail(cut)?.cacheRead, 129078);
  assert.equal(parseClaudeTail(""), null);
  assert.equal(parseClaudeTail('{"type":"user"}\nnot json "usage" "type":"assistant"\n'), null);
});

test("Claude tail: only the numbers and the model come back, never conversation text", () => {
  const rec = parseClaudeTail(fixture("claude-transcript.jsonl"));
  assert.deepEqual(Object.keys(rec).sort(), ["cacheRead", "cacheWrite", "input", "model"]);
  assert.ok(!JSON.stringify(claudeReading(rec)).includes("SECRET"));
});

test("Claude reading: input + cache write + cache read over the window, as Claude Code's own status line", () => {
  const r = claudeReading({ model: "claude-sonnet-5-5", input: 2, cacheWrite: 1551, cacheRead: 129078 });
  assert.equal(r.used, 130631);
  assert.equal(r.window, 1000000);
  assert.ok(Math.abs(r.pct - 13.0631) < 1e-9);
  // Recorded live: the status line of that session said "87% context left".
  assert.equal(100 - Math.round(r.pct), 87);
  assert.deepEqual(r.parts, [["input", 2], ["cache write", 1551], ["cache read", 129078]]);
});

test("Claude reading: more in use than a 200K window means a 1M variant, flagged assumed", () => {
  const r = claudeReading({ model: "claude-opus-4-6", input: 10, cacheWrite: 50000, cacheRead: 300000 });
  assert.equal(r.window, 1000000);
  assert.equal(r.assumed, true);
  const small = claudeReading({ model: "claude-opus-4-6", input: 10, cacheWrite: 50000, cacheRead: 100000 });
  assert.equal(small.window, 200000);
  assert.equal(small.assumed, false);
  assert.ok(Math.abs(small.pct - 75.005) < 1e-9);
});

test("Claude reading: a window override changes the share", () => {
  const r = claudeReading({ model: "claude-sonnet-5-5", input: 2, cacheWrite: 1551, cacheRead: 129078 }, { "claude-sonnet-5": 400000 });
  assert.equal(r.window, 400000);
  assert.equal(Math.round(r.pct), 33);
});

test("Codex tail: the latest token_count, its window and the model of the latest turn", () => {
  const rec = parseCodexTail(fixture("codex-rollout.jsonl"));
  assert.deepEqual(rec, { tokens: 120170, window: 258400, at: Date.parse("2026-11-12T07:40:16.066Z"), model: "gpt-6.1-sol" });
});

test("Codex tail: a cut first line is tolerated, an empty info or no event gives null", () => {
  const text = fixture("codex-rollout.jsonl");
  assert.equal(parseCodexTail(text.slice(10))?.tokens, 120170);
  assert.equal(parseCodexTail('{"type":"event_msg","payload":{"type":"token_count","info":null}}\n'), null);
  assert.equal(parseCodexTail('{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":5}}}}\n'), null);
  assert.equal(parseCodexTail(""), null);
});

test("Codex share used follows Codex's own 'Context N% left' (baseline taken off both sides)", () => {
  // Recorded live: total_tokens 120170 in a 258400 window, and the TUI said "Context 56% left".
  const used = codexUsedPct(120170, 258400);
  assert.ok(Math.abs(used - 43.9006) < 1e-3);
  assert.equal(100 - Math.round(used), 56);
  // The plain ratio would say 53% left: not what Codex shows.
  assert.notEqual(100 - Math.round(used), 100 - Math.round((120170 / 258400) * 100));
  assert.equal(codexUsedPct(CODEX_BASELINE_TOKENS, 258400), 0);
  assert.equal(codexUsedPct(0, 258400), 0);
  assert.equal(codexUsedPct(900000, 258400), 100);
  assert.equal(codexUsedPct(5000, CODEX_BASELINE_TOKENS), 100);
});

test("Codex reading carries the raw token counts", () => {
  const r = codexReading({ tokens: 120170, window: 258400, model: "gpt-6.1-sol" });
  assert.equal(r.used, 120170);
  assert.equal(r.window, 258400);
  assert.equal(percentText(r.pct), "44%");
});

test("thresholds: defaults 40 and 50, layout props override, bad pairs fall back together", () => {
  assert.deepEqual(thresholds(undefined), { warn: 40, critical: 50 });
  assert.deepEqual(thresholds({}), { warn: 40, critical: 50 });
  assert.deepEqual(thresholds({ warn: 30, critical: 60 }), { warn: 30, critical: 60 });
  assert.deepEqual(thresholds({ warn: 25 }), { warn: 25, critical: 50 });
  assert.deepEqual(thresholds({ critical: 80 }), { warn: 40, critical: 80 });
  assert.deepEqual(thresholds({ warn: 70, critical: 60 }), { warn: 40, critical: 50 });
  assert.deepEqual(thresholds({ warn: "40", critical: 0 }), { warn: 40, critical: 50 });
  assert.deepEqual(thresholds({ warn: 50, critical: 50 }), { warn: 40, critical: 50 });
});

test("levels: yellow from warn, red from critical, both inclusive", () => {
  const limits = { warn: 40, critical: 50 };
  assert.equal(levelOf(0, limits), "ok");
  assert.equal(levelOf(39.4, limits), "ok");
  assert.equal(levelOf(40, limits), "warn");
  assert.equal(levelOf(49.4, limits), "warn");
  assert.equal(levelOf(50, limits), "critical");
  assert.equal(levelOf(100, limits), "critical");
  assert.equal(levelOf(30, { warn: 25, critical: 30 }), "critical");
});

test("levels follow the number shown: 39.6 reads 40% and is yellow, 49.7 reads 50% and is red", () => {
  const limits = { warn: 40, critical: 50 };
  assert.equal(percentText(39.6), "40%");
  assert.equal(levelOf(39.6, limits), "warn");
  assert.equal(percentText(49.7), "50%");
  assert.equal(levelOf(49.7, limits), "critical");
});

test("fit keeps everything when it fits, else the fullest ones in order plus a count", () => {
  const items = [{ n: "a", f: 10 }, { n: "b", f: 80 }, { n: "c", f: -1 }, { n: "d", f: 45 }, { n: "e", f: 60 }];
  assert.deepEqual(fit(items, (x) => x.f, 5), { shown: items, hidden: 0 });
  // Four slots: three entries and the "+N" chip.
  const four = fit(items, (x) => x.f, 4);
  assert.deepEqual(four.shown.map((x) => x.n), ["b", "d", "e"]);
  assert.equal(four.hidden, 2);
  // Ties keep the earlier one; one slot is only the chip.
  assert.equal(fit(items, (x) => x.f, 1).shown.length, 0);
  assert.equal(fit(items, (x) => x.f, 1).hidden, 5);
});

test("tooltip: tab, model, counts; n/a says why; no conversation text", () => {
  const claude = claudeReading({ model: "claude-sonnet-5-5", input: 2, cacheWrite: 1551, cacheRead: 129078 });
  const text = tooltip("fix login", "Claude Code", claude);
  assert.match(text, /^fix login · Claude Code\n/);
  assert.match(text, /claude-sonnet-5-5/);
  assert.match(text, /130,631 of 1,000,000 tokens \(13%\)/);
  assert.match(text, /input 2 · cache write 1,551 · cache read 129,078/);
  const codex = tooltip("ci", "Codex", codexReading({ tokens: 120170, window: 258400, model: null }));
  assert.match(codex, /120,170 of 258,400 tokens \(44%\)/);
  assert.match(tooltip("x", "Codex", { state: "na", reason: "session file not found" }), /Context: n\/a \(session file not found\)/);
  assert.equal(grouped(1234567), "1,234,567");
});
