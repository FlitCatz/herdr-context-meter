import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, openSync, readSync, closeSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXEC_TIMEOUT_MS, PROGRAMS, TAIL_SIZES, encodeCwd, parseLsof, readAll, tailParse, withDescendants,
} from "../mods/herdr-context-meter/sources.js";
import { parseCodexTail } from "../mods/herdr-context-meter/usage.js";

const fixturePath = (/** @type {string} */ name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const CLAUDE = fixturePath("claude-transcript.jsonl");
const CODEX = fixturePath("codex-rollout.jsonl");
const SESSION = "11111111-2222-4333-8444-555555555555";
const HOME = "/home/fake";

/** What `tail -c N file` prints: the last N bytes. */
function tail(/** @type {string} */ path, /** @type {number} */ bytes) {
  const size = statSync(path).size;
  const length = Math.min(size, bytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  readSync(fd, buffer, 0, length, size - length);
  closeSync(fd);
  return buffer.toString("utf8");
}

/**
 * A host with fake programs. `files` maps the path a program is asked for to a real file;
 * `calls` records every program run, so tests can check what was (not) asked.
 * @param {{ hc?: Record<string, unknown>, sessions?: Record<string, unknown>, files?: Record<string, string>,
 *   ps?: string, lsof?: string, find?: string, ls?: string, execFails?: (command: string, args: string[]) => Error | null }} [spec]
 */
function fakeHost(spec = {}) {
  /** @type {{ command: string, args: string[], timeout?: number }[]} */
  const calls = [];
  const host = {
    home: HOME,
    calls,
    async exec(/** @type {string} */ command, /** @type {string[]} */ args, /** @type {{ timeout?: number }} */ options = {}) {
      calls.push({ command, args, timeout: options.timeout });
      const failure = spec.execFails?.(command, args);
      if (failure) throw failure;
      if (command === PROGRAMS.tail) {
        const file = spec.files?.[args[2]];
        return file ? { code: 0, stdout: tail(file, Number(args[1])), stderr: "" } : { code: 1, stdout: "", stderr: "no such file" };
      }
      if (command === PROGRAMS.ps) return { code: 0, stdout: spec.ps ?? "", stderr: "" };
      if (command === PROGRAMS.lsof) return { code: 1, stdout: spec.lsof ?? "", stderr: "" };
      if (command === PROGRAMS.find) return { code: 0, stdout: spec.find ?? "", stderr: "" };
      if (command === PROGRAMS.ls) return { code: 0, stdout: spec.ls ?? "", stderr: "" };
      throw new Error(`unexpected program ${command}`);
    },
    async hc(/** @type {string[]} */ args) {
      const info = spec.hc?.[args[1]];
      return info ? { code: 0, stdout: JSON.stringify(info), stderr: "" } : { code: 1, stdout: "", stderr: "unknown terminal" };
    },
    async readTextFile(/** @type {string} */ path) {
      const pid = /sessions\/(\d+)\.json$/.exec(path)?.[1];
      const session = pid ? spec.sessions?.[pid] : undefined;
      return session ? JSON.stringify(session) : null;
    },
  };
  return host;
}

const terminal = (/** @type {number} */ pid, /** @type {string} */ cwd) => ({ cwd: "/somewhere/else", foreground: { pid, cwd } });
const ctx = () => ({ paths: new Map(), windows: {} });
const claudeAgent = (/** @type {string} */ address) => ({ address, app: "claude-code", program: { name: "Claude Code" } });
const codexAgent = (/** @type {string} */ address) => ({ address, app: "codex", program: { name: "Codex" } });
const transcriptPath = `${HOME}/.claude/projects/-work-example-project/${SESSION}.jsonl`;

test("encodeCwd matches Claude Code's project folder names", () => {
  assert.equal(
    encodeCwd("/Users/dev-r/.treehouse/herdr-context-meter-2215a8/1/herdr-context-meter"),
    "-Users-dev-r--treehouse-herdr-context-meter-2215a8-1-herdr-context-meter",
  );
});

test("tail reader: only a bounded slice from the end, growing until a record is found", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-tail-"));
  const path = join(dir, "rollout.jsonl");
  // The only record sits behind 400 KiB of lines that are not records.
  const filler = `${JSON.stringify({ type: "response_item", payload: { text: "x".repeat(1000) } })}\n`.repeat(400);
  writeFileSync(path, `${readTail(CODEX)}${filler}`);
  const host = fakeHost({ files: { [path]: path } });
  const rec = await tailParse(host, path, parseCodexTail);
  assert.equal(rec?.tokens, 120170);
  const sizes = host.calls.map((c) => Number(c.args[1]));
  assert.deepEqual(sizes, [TAIL_SIZES[0], TAIL_SIZES[1]]);
  assert.ok(host.calls.every((c) => c.command === PROGRAMS.tail && c.args[0] === "-c" && c.timeout === EXEC_TIMEOUT_MS));
  assert.ok(Math.max(...sizes) < statSync(path).size * 4, "never asks for the whole of a large file");
});

/** All of a file, as text. */
function readTail(/** @type {string} */ path) { return tail(path, 1 << 30); }

test("tail reader: stops at the largest slice, and rejects when the file cannot be read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-tail-"));
  const path = join(dir, "empty.jsonl");
  writeFileSync(path, "not a record\n");
  const host = fakeHost({ files: { [path]: path } });
  assert.equal(await tailParse(host, path, parseCodexTail), null);
  assert.equal(host.calls.length, TAIL_SIZES.length);
  await assert.rejects(tailParse(fakeHost(), "/missing", parseCodexTail));
});

test("ps and lsof output: a process and its descendants, files by pid", () => {
  const ps = "  1     0\n 10     1\n 11    10\n 12    11\n 20     1\n bad line\n";
  assert.deepEqual(withDescendants(ps, 10), [10, 11, 12]);
  assert.deepEqual(withDescendants(ps, 99), [99]);
  const lsof = "p11\nn/a/b/rollout-1.jsonl\nn/dev/null\np12\nn/c/rollout-2.jsonl\n";
  assert.deepEqual([...parseLsof(lsof)], [[11, ["/a/b/rollout-1.jsonl", "/dev/null"]], [12, ["/c/rollout-2.jsonl"]]]);
});

test("Claude: the session file names the session, whose transcript gives the share", async () => {
  const host = fakeHost({
    hc: { t1: terminal(500, "/work/example-project") },
    sessions: { 500: { pid: 500, sessionId: SESSION, cwd: "/work/example-project", name: "must not matter" } },
    find: `${transcriptPath}\n`,
    files: { [transcriptPath]: CLAUDE },
  });
  const entries = await readAll(host, [claudeAgent("t1")], ctx());
  const entry = entries.get("t1");
  assert.equal(entry?.state, "ok");
  assert.equal(entry?.state === "ok" && entry.used, 130631);
  assert.equal(entry?.state === "ok" && Math.round(entry.pct), 13);
  assert.ok(!JSON.stringify([...entries]).includes("SECRET"), "no conversation text in a result");
  const find = host.calls.find((c) => c.command === PROGRAMS.find);
  assert.deepEqual(find?.args, [`${HOME}/.claude/projects`, "-maxdepth", "2", "-name", `${SESSION}.jsonl`]);
});

test("Claude: the transcript path is found once per session, not on every round", async () => {
  const host = fakeHost({
    hc: { t1: terminal(500, "/work/example-project") },
    sessions: { 500: { pid: 500, sessionId: SESSION } },
    find: transcriptPath,
    files: { [transcriptPath]: CLAUDE },
  });
  const shared = ctx();
  await readAll(host, [claudeAgent("t1")], shared);
  await readAll(host, [claudeAgent("t1")], shared);
  assert.equal(host.calls.filter((c) => c.command === PROGRAMS.find).length, 1);
});

test("Claude: a session file of another pid or with a bad id is not trusted", async () => {
  for (const session of [{ pid: 999, sessionId: SESSION }, { pid: 500, sessionId: "../../etc/passwd" }]) {
    const host = fakeHost({ hc: { t1: terminal(500, "/work/example-project") }, sessions: { 500: session }, ls: "" });
    const entry = (await readAll(host, [claudeAgent("t1")], ctx())).get("t1");
    assert.equal(entry?.state, "na");
    assert.ok(!host.calls.some((c) => c.command === PROGRAMS.find), "no search by an untrusted id");
  }
});

test("Claude without a session file: the newest transcript of the folder when it is unambiguous", async () => {
  const dir = `${HOME}/.claude/projects/-work-example-project`;
  const host = fakeHost({
    hc: { t1: terminal(500, "/work/example-project") },
    ls: `${SESSION}.jsonl\nolder.jsonl\nsubfolder\n`,
    files: { [`${dir}/${SESSION}.jsonl`]: CLAUDE },
  });
  const entry = (await readAll(host, [claudeAgent("t1")], ctx())).get("t1");
  assert.equal(entry?.state === "ok" && entry.used, 130631);
  assert.deepEqual(host.calls.find((c) => c.command === PROGRAMS.ls)?.args, ["-t", dir]);
});

test("Claude without a session file, two terminals in one folder: n/a rather than a guess", async () => {
  const host = fakeHost({
    hc: { t1: terminal(500, "/work/example-project"), t2: terminal(501, "/work/example-project") },
    ls: `${SESSION}.jsonl\n`,
    files: { [`${HOME}/.claude/projects/-work-example-project/${SESSION}.jsonl`]: CLAUDE },
  });
  const entries = await readAll(host, [claudeAgent("t1"), claudeAgent("t2")], ctx());
  for (const address of ["t1", "t2"]) {
    assert.deepEqual(entries.get(address), { state: "na", reason: "several Claude terminals share this folder", kind: "claude" });
  }
});

test("Claude: no transcript yet, or no usage in it, is n/a with the reason", async () => {
  const none = fakeHost({ hc: { t1: terminal(500, "/w") }, sessions: { 500: { pid: 500, sessionId: SESSION } }, find: "" });
  assert.equal((await readAll(none, [claudeAgent("t1")], ctx())).get("t1")?.state === "na" && "no transcript yet", "no transcript yet");
  const dir = mkdtempSync(join(tmpdir(), "ctx-claude-"));
  const path = join(dir, `${SESSION}.jsonl`);
  writeFileSync(path, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
  const empty = fakeHost({ hc: { t1: terminal(500, "/w") }, sessions: { 500: { pid: 500, sessionId: SESSION } }, find: path, files: { [path]: path } });
  assert.deepEqual((await readAll(empty, [claudeAgent("t1")], ctx())).get("t1"), { state: "na", reason: "no usage recorded yet", kind: "claude" });
});

test("Codex: the rollout the terminal's Codex has open, found through its process tree", async () => {
  const rollout = "/home/fake/.codex/sessions/2026/11/12/rollout-2026-11-12T16-17-04-aaaa.jsonl";
  const host = fakeHost({
    hc: { t5: terminal(100, "/work/example-project") },
    // 100 is the node wrapper; the codex binary is its grandchild and holds the file.
    ps: "100 1\n101 100\n102 101\n200 1\n",
    lsof: `p102\nn${rollout}\nn/home/fake/.codex/logs/other.log\np200\nn/home/fake/.codex/sessions/2026/11/12/rollout-zzz.jsonl\n`,
    files: { [rollout]: CODEX },
  });
  const entry = (await readAll(host, [codexAgent("t5")], ctx())).get("t5");
  assert.equal(entry?.state, "ok");
  assert.equal(entry?.state === "ok" && entry.used, 120170);
  assert.equal(entry?.state === "ok" && entry.window, 258400);
  assert.equal(entry?.state === "ok" && Math.round(100 - entry.pct), 56);
  const lsof = host.calls.find((c) => c.command === PROGRAMS.lsof);
  assert.deepEqual(lsof?.args, ["-n", "-P", "-p", "100,101,102", "-Fpn"], "asks only about this terminal's processes");
});

test("Codex: two terminals in the same folder each get their own session, one ps and one lsof for all", async () => {
  const a = "/home/fake/.codex/sessions/2026/11/12/rollout-a.jsonl";
  const dir = mkdtempSync(join(tmpdir(), "ctx-codex-"));
  const b = join(dir, "rollout-b.jsonl");
  // Session b is at 50 000 tokens.
  writeFileSync(b, `${JSON.stringify({ timestamp: "2026-11-12T08:00:00Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 50000 }, model_context_window: 258400 } } })}\n`);
  const host = fakeHost({
    hc: { t5: terminal(100, "/work/policy-kernel"), t6: terminal(200, "/work/policy-kernel") },
    ps: "100 1\n101 100\n200 1\n201 200\n",
    lsof: `p101\nn${a}\np201\nn${b}\n`,
    files: { [a]: CODEX, [b]: b },
  });
  const entries = await readAll(host, [codexAgent("t5"), codexAgent("t6")], ctx());
  assert.equal(entries.get("t5")?.state === "ok" && entries.get("t5").used, 120170);
  assert.equal(entries.get("t6")?.state === "ok" && entries.get("t6").used, 50000);
  assert.equal(host.calls.filter((c) => c.command === PROGRAMS.ps).length, 1);
  assert.equal(host.calls.filter((c) => c.command === PROGRAMS.lsof).length, 1);
});

test("Codex: of several open rollouts (a resumed session) the one with the newest count wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-codex-"));
  const record = (/** @type {string} */ at, /** @type {number} */ total) => `${JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: total }, model_context_window: 258400 } } })}\n`;
  const old = join(dir, "rollout-old.jsonl");
  const fresh = join(dir, "rollout-new.jsonl");
  writeFileSync(old, record("2026-11-11T10:00:00Z", 200000));
  writeFileSync(fresh, record("2026-11-12T10:00:00Z", 30000));
  const host = fakeHost({ hc: { t5: terminal(100, "/w") }, ps: "100 1\n", lsof: `p100\nn${old}\nn${fresh}\n`, files: { [old]: old, [fresh]: fresh } });
  const entry = (await readAll(host, [codexAgent("t5")], ctx())).get("t5");
  assert.equal(entry?.state === "ok" && entry.used, 30000);
});

test("Codex: nothing open, or a failed ps, is n/a with the reason", async () => {
  const closed = fakeHost({ hc: { t5: terminal(100, "/w") }, ps: "100 1\n", lsof: "p100\nn/dev/null\n" });
  assert.deepEqual((await readAll(closed, [codexAgent("t5")], ctx())).get("t5"), { state: "na", reason: "session file not found", kind: "codex" });
  const failing = fakeHost({ hc: { t5: terminal(100, "/w") }, execFails: (command) => (command === PROGRAMS.ps ? new Error("timed out") : null) });
  assert.deepEqual((await readAll(failing, [codexAgent("t5")], ctx())).get("t5"), { state: "na", reason: "read timed out", kind: "codex" });
});

test("agents it cannot read are n/a, each with its own reason", async () => {
  const host = fakeHost({ hc: {} });
  const entries = await readAll(host, [
    { address: "t9", app: "agy", program: { name: "Antigravity" } },
    { address: "vps/t7", app: "codex", program: { name: "Codex" } },
    claudeAgent("t1"),
  ], ctx());
  assert.deepEqual(entries.get("t9"), { state: "na", reason: "Antigravity has no readable context record" });
  assert.deepEqual(entries.get("vps/t7"), { state: "na", reason: "terminal on another machine" });
  assert.deepEqual(entries.get("t1"), { state: "na", reason: "no agent process found", kind: "claude" });
  assert.ok(!host.calls.some((c) => c.command === PROGRAMS.ps), "no process scan without a local Codex");
});

test("one failing read does not take the others down, and no number is carried over", async () => {
  const good = `${HOME}/.claude/projects/-w/${SESSION}.jsonl`;
  const host = fakeHost({
    hc: { t1: terminal(500, "/w"), t2: terminal(501, "/w") },
    sessions: { 500: { pid: 500, sessionId: SESSION }, 501: { pid: 501, sessionId: "99999999-2222-4333-8444-555555555555" } },
    find: good,
    files: { [good]: CLAUDE },
    execFails: (command, args) => (command === PROGRAMS.find && args[4].startsWith("9999") ? new Error("timed out") : null),
  });
  const entries = await readAll(host, [claudeAgent("t1"), claudeAgent("t2")], ctx());
  assert.equal(entries.get("t1")?.state, "ok");
  assert.deepEqual(entries.get("t2"), { state: "na", reason: "read timed out", kind: "claude" });
});

test("every program is run by absolute path with a time limit", async () => {
  const rollout = "/home/fake/.codex/sessions/2026/11/12/rollout-a.jsonl";
  const host = fakeHost({
    hc: { t1: terminal(500, "/w"), t5: terminal(100, "/w") },
    sessions: { 500: { pid: 500, sessionId: SESSION } },
    find: transcriptPath,
    ps: "100 1\n",
    lsof: `p100\nn${rollout}\n`,
    files: { [transcriptPath]: CLAUDE, [rollout]: CODEX },
  });
  await readAll(host, [claudeAgent("t1"), codexAgent("t5")], ctx());
  assert.ok(host.calls.length >= 4);
  for (const call of host.calls) {
    assert.ok(call.command.startsWith("/"), call.command);
    assert.equal(call.timeout, EXEC_TIMEOUT_MS, call.command);
  }
});
