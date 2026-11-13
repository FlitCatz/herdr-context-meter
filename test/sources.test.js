import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, openSync, readSync, closeSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXEC_TIMEOUT_MS, HEAD_BYTES, PROGRAMS, TAIL_SIZES, agyUuidsFromFiles, modelFromArgv, parseLsof, readAll, tailParse,
  withDescendants,
} from "../mods/herdr-context-meter/sources.js";
import { parseCodexTail } from "../mods/herdr-context-meter/usage.js";

const fixturePath = (/** @type {string} */ name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const CLAUDE = fixturePath("claude-transcript.jsonl");
const CODEX = fixturePath("codex-rollout.jsonl");
const CODEX_SUBAGENT = fixturePath("codex-subagent-rollout.jsonl");
const AGY = fixturePath("agy-transcript.jsonl");
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

/** What `head -c N file` prints: the first N bytes. */
function head(/** @type {string} */ path, /** @type {number} */ bytes) {
  const buffer = Buffer.alloc(Math.min(statSync(path).size, bytes));
  const fd = openSync(path, "r");
  readSync(fd, buffer, 0, buffer.length, 0);
  closeSync(fd);
  return buffer.toString("utf8");
}

/**
 * A host with fake programs. `files` maps the path a program is asked for to a real file;
 * `calls` records every program run, so tests can check what was (not) asked.
 * @param {{ hc?: Record<string, unknown>, sessions?: Record<string, unknown>, textFiles?: Record<string, string>,
 *   files?: Record<string, string>, ps?: string, lsof?: string, find?: string,
 *   execFails?: (command: string, args: string[]) => Error | null }} [spec]
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
      if (command === PROGRAMS.head) {
        const file = spec.files?.[args[2]];
        return file ? { code: 0, stdout: head(file, Number(args[1])), stderr: "" } : { code: 1, stdout: "", stderr: "no such file" };
      }
      if (command === PROGRAMS.ps) return { code: 0, stdout: spec.ps ?? "", stderr: "" };
      if (command === PROGRAMS.lsof) return { code: 1, stdout: spec.lsof ?? "", stderr: "" };
      if (command === PROGRAMS.find) return { code: 0, stdout: spec.find ?? "", stderr: "" };
      throw new Error(`unexpected program ${command}`);
    },
    async hc(/** @type {string[]} */ args) {
      const info = spec.hc?.[args[1]];
      return info ? { code: 0, stdout: JSON.stringify(info), stderr: "" } : { code: 1, stdout: "", stderr: "unknown terminal" };
    },
    async readTextFile(/** @type {string} */ path) {
      if (spec.textFiles && path in spec.textFiles) return spec.textFiles[path];
      const pid = /sessions\/(\d+)\.json$/.exec(path)?.[1];
      const session = pid ? spec.sessions?.[pid] : undefined;
      return session ? JSON.stringify(session) : null;
    },
  };
  return host;
}

const terminal = (/** @type {number} */ pid, /** @type {string[]} */ argv) => ({
  foreground: argv ? { pid, argv } : { pid },
});
const ctx = () => ({ paths: new Map(), subagents: new Map(), windows: {} });
const claudeAgent = (/** @type {string} */ address) => ({ address, app: "claude-code", program: { name: "Claude Code" } });
const codexAgent = (/** @type {string} */ address) => ({ address, app: "codex", program: { name: "Codex" } });
const agyAgent = (/** @type {string} */ address) => ({ address, app: "antigravity", program: { name: "Antigravity" } });
const transcriptPath = `${HOME}/.claude/projects/-work-example-project/${SESSION}.jsonl`;

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
    hc: { t1: terminal(500) },
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
    hc: { t1: terminal(500) },
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
    const host = fakeHost({ hc: { t1: terminal(500) }, sessions: { 500: session } });
    const entry = (await readAll(host, [claudeAgent("t1")], ctx())).get("t1");
    assert.deepEqual(entry, { state: "na", reason: "no session file", kind: "claude" });
    assert.deepEqual(host.calls, [], "no search by an untrusted id");
  }
});

test("Claude without a session file: n/a, and no transcript is looked for", async () => {
  const host = fakeHost({
    hc: { t1: terminal(500) },
    find: `${transcriptPath}\n`,
    files: { [transcriptPath]: CLAUDE },
  });
  const entry = (await readAll(host, [claudeAgent("t1")], ctx())).get("t1");
  assert.deepEqual(entry, { state: "na", reason: "no session file", kind: "claude" });
  assert.deepEqual(host.calls, [], "no find or tail without a session file");
});

test("Claude: no transcript yet, or no usage in it, is n/a with the reason", async () => {
  const none = fakeHost({ hc: { t1: terminal(500) }, sessions: { 500: { pid: 500, sessionId: SESSION } }, find: "" });
  assert.deepEqual((await readAll(none, [claudeAgent("t1")], ctx())).get("t1"), { state: "na", reason: "no transcript yet", kind: "claude" });
  const dir = mkdtempSync(join(tmpdir(), "ctx-claude-"));
  const path = join(dir, `${SESSION}.jsonl`);
  writeFileSync(path, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
  const empty = fakeHost({ hc: { t1: terminal(500) }, sessions: { 500: { pid: 500, sessionId: SESSION } }, find: path, files: { [path]: path } });
  assert.deepEqual((await readAll(empty, [claudeAgent("t1")], ctx())).get("t1"), { state: "na", reason: "no usage recorded yet", kind: "claude" });
});

test("Codex: the rollout the terminal's Codex has open, found through its process tree", async () => {
  const rollout = "/home/fake/.codex/sessions/2026/11/12/rollout-2026-11-12T16-17-04-aaaa.jsonl";
  const host = fakeHost({
    hc: { t5: terminal(100) },
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
    hc: { t5: terminal(100), t6: terminal(200) },
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
  const host = fakeHost({ hc: { t5: terminal(100) }, ps: "100 1\n", lsof: `p100\nn${old}\nn${fresh}\n`, files: { [old]: old, [fresh]: fresh } });
  const entry = (await readAll(host, [codexAgent("t5")], ctx())).get("t5");
  assert.equal(entry?.state === "ok" && entry.used, 30000);
});

test("Codex: nothing open, or a failed ps, is n/a with the reason", async () => {
  const closed = fakeHost({ hc: { t5: terminal(100) }, ps: "100 1\n", lsof: "p100\nn/dev/null\n" });
  assert.deepEqual((await readAll(closed, [codexAgent("t5")], ctx())).get("t5"), { state: "na", reason: "session file not found", kind: "codex" });
  const failing = fakeHost({ hc: { t5: terminal(100) }, execFails: (command) => (command === PROGRAMS.ps ? new Error("timed out") : null) });
  assert.deepEqual((await readAll(failing, [codexAgent("t5")], ctx())).get("t5"), { state: "na", reason: "read timed out", kind: "codex" });
});

/** The lines of a fixture after its first (session_meta) line. */
const afterMeta = (/** @type {string} */ path) => readTail(path).split("\n").slice(1).join("\n");

/**
 * A sub-agent's session_meta shaped like codex-cli 0.167.0 writes it: parent_thread_id early,
 * more keys, the sub-agent source at about 1.8 KB, then some 20 KB of base_instructions.
 */
function bigSubagentMeta() {
  return JSON.stringify({
    timestamp: "2026-11-12T07:41:02.275Z", type: "session_meta",
    payload: {
      id: "01a1ce7e-011a-7340-afe6-5bb98b786d87", forked_from_id: null,
      parent_thread_id: "01a1ce9e-034f-7f60-ab6b-1ae16853a9ba",
      cwd: "/work/example-project", originator: "codex_cli_rs", cli_version: "0.167.0",
      model_provider: "openai", git: { branch: "main", repository_url: "https://example.invalid/repo", padding: "g".repeat(1450) },
      source: { subagent: { other: "guardian" } },
      base_instructions: { text: "You are a reviewer. ".repeat(1000) },
    },
  });
}

test("Codex: a sub-agent's rollout, open beside the session's with a newer count, is left out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-codex-"));
  const guardian = join(dir, "rollout-guardian.jsonl");
  const meta = bigSubagentMeta();
  assert.ok(meta.indexOf('"source":{"subagent"') > 1500 && meta.length > 20000, "realistic shape");
  writeFileSync(guardian, `${meta}\n${afterMeta(CODEX_SUBAGENT)}`);
  const main = "/home/fake/.codex/sessions/2026/11/12/rollout-main.jsonl";
  const host = fakeHost({ hc: { t5: terminal(100) }, ps: "100 1\n", lsof: `p100\nn${main}\nn${guardian}\n`, files: { [main]: CODEX, [guardian]: guardian } });
  const entry = (await readAll(host, [codexAgent("t5")], ctx())).get("t5");
  assert.equal(entry?.state === "ok" && entry.used, 120170);
  assert.ok(!host.calls.some((c) => c.command === PROGRAMS.tail && c.args[2] === guardian), "the sub-agent's counts are not read");
});

test("Codex: only sub-agent rollouts open is n/a, whichever key marks them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-codex-"));
  const spawned = join(dir, "rollout-spawned.jsonl");
  const meta = { timestamp: "2026-11-12T07:41:02.275Z", type: "session_meta", payload: { id: "01a1ce7e-011a-7340-afe6-5bb98b786d88", padding: "p".repeat(1500), source: { subagent: { thread_spawn: { depth: 1 } } } } };
  writeFileSync(spawned, `${JSON.stringify(meta)}\n${afterMeta(CODEX_SUBAGENT)}`);
  for (const path of [CODEX_SUBAGENT, spawned]) {
    const host = fakeHost({ hc: { t5: terminal(100) }, ps: "100 1\n", lsof: `p100\nn/x/rollout-sub.jsonl\n`, files: { "/x/rollout-sub.jsonl": path } });
    assert.deepEqual((await readAll(host, [codexAgent("t5")], ctx())).get("t5"), { state: "na", reason: "no main session file", kind: "codex" });
  }
});

test("Codex: instruction text that mentions the sub-agent keys does not make a session a sub-agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-codex-"));
  const main = join(dir, "rollout-main.jsonl");
  const text = 'A sub-agent\'s meta has "parent_thread_id":"<id>" and "source":{"subagent":{}}. ';
  const meta = { timestamp: "2026-11-12T07:17:04.734Z", type: "session_meta", payload: { id: "01a1ce9e-034f-7f60-ab6b-1ae16853a9ba", cwd: "/work/example-project", user_instructions: text, base_instructions: { text: text.repeat(300) } } };
  writeFileSync(main, `${JSON.stringify(meta)}\n${afterMeta(CODEX)}`);
  const host = fakeHost({ hc: { t5: terminal(100) }, ps: "100 1\n", lsof: `p100\nn${main}\n`, files: { [main]: main } });
  const entry = (await readAll(host, [codexAgent("t5")], ctx())).get("t5");
  assert.equal(entry?.state === "ok" && entry.used, 120170);
});

test("Codex: a rollout whose first line is not written yet is left out, and checked again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-codex-"));
  const guardian = join(dir, "rollout-guardian.jsonl");
  const main = "/home/fake/.codex/sessions/2026/11/12/rollout-main.jsonl";
  const host = fakeHost({ hc: { t5: terminal(100) }, ps: "100 1\n", lsof: `p100\nn${main}\nn${guardian}\n`, files: { [main]: CODEX, [guardian]: guardian } });
  const shared = ctx();
  // Opened by Codex, its session_meta not written yet.
  writeFileSync(guardian, "");
  const first = (await readAll(host, [codexAgent("t5")], shared)).get("t5");
  assert.equal(first?.state === "ok" && first.used, 120170);
  writeFileSync(guardian, readTail(CODEX_SUBAGENT));
  const second = (await readAll(host, [codexAgent("t5")], shared)).get("t5");
  assert.equal(second?.state === "ok" && second.used, 120170, "the guardian's newer count is not shown");
  assert.equal(host.calls.filter((c) => c.command === PROGRAMS.head && c.args[2] === guardian).length, 2);
  assert.ok(!host.calls.some((c) => c.command === PROGRAMS.tail && c.args[2] === guardian));
});

test("Codex: the only rollout, its first line half written, is n/a until it can be told apart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-codex-"));
  const path = join(dir, "rollout-new.jsonl");
  const host = fakeHost({ hc: { t5: terminal(100) }, ps: "100 1\n", lsof: `p100\nn${path}\n`, files: { [path]: path } });
  const shared = ctx();
  writeFileSync(path, readTail(CODEX).slice(0, 60));
  assert.deepEqual((await readAll(host, [codexAgent("t5")], shared)).get("t5"), { state: "na", reason: "no main session file", kind: "codex" });
  writeFileSync(path, readTail(CODEX));
  const entry = (await readAll(host, [codexAgent("t5")], shared)).get("t5");
  assert.equal(entry?.state === "ok" && entry.used, 120170);
});

test("Codex: the first line is read with a bounded head, once per file", async () => {
  const main = "/home/fake/.codex/sessions/2026/11/12/rollout-main.jsonl";
  const sub = "/home/fake/.codex/sessions/2026/11/12/rollout-sub.jsonl";
  const host = fakeHost({ hc: { t5: terminal(100) }, ps: "100 1\n", lsof: `p100\nn${main}\nn${sub}\n`, files: { [main]: CODEX, [sub]: CODEX_SUBAGENT } });
  const shared = ctx();
  await readAll(host, [codexAgent("t5")], shared);
  const second = (await readAll(host, [codexAgent("t5")], shared)).get("t5");
  assert.equal(second?.state === "ok" && second.used, 120170);
  const heads = host.calls.filter((c) => c.command === PROGRAMS.head);
  assert.equal(HEAD_BYTES, 4096);
  assert.deepEqual(heads.map((c) => c.args).sort(), [["-c", "4096", main], ["-c", "4096", sub]]);
  assert.ok(heads.every((c) => c.timeout === EXEC_TIMEOUT_MS));
});

test("Codex: a first line that cannot be read is n/a, not a guess", async () => {
  const main = "/home/fake/.codex/sessions/2026/11/12/rollout-main.jsonl";
  const host = fakeHost({
    hc: { t5: terminal(100) }, ps: "100 1\n", lsof: `p100\nn${main}\n`, files: { [main]: CODEX },
    execFails: (command) => (command === PROGRAMS.head ? new Error("permission denied") : null),
  });
  assert.deepEqual((await readAll(host, [codexAgent("t5")], ctx())).get("t5"), { state: "na", reason: "read failed", kind: "codex" });
  assert.ok(!host.calls.some((c) => c.command === PROGRAMS.tail));
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
    hc: { t1: terminal(500), t2: terminal(501) },
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
    hc: { t1: terminal(500), t5: terminal(100) },
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

test("Agy: extracts uuid from conversations/<uuid>.db-shm and brain/<uuid> lsof paths", () => {
  const id1 = "2e8230b5-4816-4ef8-9fee-5b61efd5e974";
  const id2 = "c4e79c68-1f64-4464-80bf-592d8f51aa9f";
  assert.deepEqual(agyUuidsFromFiles([
    `${HOME}/.gemini/antigravity-cli/conversations/${id1}.db-shm`,
    `${HOME}/.gemini/antigravity-cli/conversations/${id1}.db-wal`,
    `${HOME}/.gemini/antigravity-cli/brain/${id2}/scratch/tmp.txt`,
    `${HOME}/.gemini/antigravity-cli/cli.log`,
  ]), [id1, id2]);
  assert.equal(modelFromArgv(["/opt/homebrew/bin/agy", "--model", "gemini-4-hydrogen-medium"]), "gemini-4-hydrogen-medium");
  assert.equal(modelFromArgv(["agy", "--model=gemini-4-argon-high"]), "gemini-4-argon-high");
  assert.equal(modelFromArgv(["agy"]), null);
});

test("Agy: reads transcript.jsonl via shared ps+lsof with Codex and resolves model from argv or settings", async () => {
  const agyId1 = "2e8230b5-4816-4ef8-9fee-5b61efd5e974";
  const agyId2 = "c4e79c68-1f64-4464-80bf-592d8f51aa9f";
  const transcript1 = `${HOME}/.gemini/antigravity-cli/brain/${agyId1}/.system_generated/logs/transcript.jsonl`;
  const transcript2 = `${HOME}/.gemini/antigravity-cli/brain/${agyId2}/.system_generated/logs/transcript.jsonl`;
  const rollout = "/home/fake/.codex/sessions/2026/11/12/rollout-a.jsonl";
  const host = fakeHost({
    hc: {
      t1: terminal(101, ["/opt/homebrew/bin/agy", "--model", "gemini-4-hydrogen-medium"]),
      t2: terminal(102, ["/opt/homebrew/bin/agy"]),
      t3: terminal(103, ["/opt/homebrew/bin/agy"]),
      t4: terminal(104),
    },
    ps: "101 1\n102 1\n103 1\n104 1\n",
    lsof: [
      `p101\nn${HOME}/.gemini/antigravity-cli/conversations/${agyId1}.db-shm`,
      `p102\nn${HOME}/.gemini/antigravity-cli/brain/${agyId2}`,
      `p103\nn${HOME}/.gemini/antigravity-cli/cli.log`,
      `p104\nn${rollout}`,
    ].join("\n"),
    files: { [transcript1]: AGY, [transcript2]: AGY, [rollout]: CODEX },
    textFiles: { [`${HOME}/.gemini/antigravity-cli/settings.json`]: JSON.stringify({ model: "Gemini 4 Argon (High)" }) },
  });
  const entries = await readAll(host, [agyAgent("t1"), agyAgent("t2"), agyAgent("t3"), codexAgent("t4")], ctx());
  assert.equal(host.calls.filter((c) => c.command === PROGRAMS.ps).length, 1);
  assert.equal(host.calls.filter((c) => c.command === PROGRAMS.lsof).length, 1);
  const e1 = entries.get("t1");
  assert.equal(e1?.state, "ok");
  assert.equal(e1?.state === "ok" && e1.used, 121755);
  assert.equal(e1?.state === "ok" && e1.model, "gemini-4-hydrogen-medium");
  const e2 = entries.get("t2");
  assert.equal(e2?.state, "ok");
  assert.equal(e2?.state === "ok" && e2.model, "Gemini 4 Argon (High)");
  assert.deepEqual(entries.get("t3"), { state: "na", reason: "session file not found", kind: "agy" });
  assert.equal(entries.get("t4")?.state, "ok");
});
