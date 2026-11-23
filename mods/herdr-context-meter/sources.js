// Finding each agent's session file and reading the tail of it. All I/O goes through the
// `host` object, so the tests drive it with fakes; main.js hands it Herdr's own functions.
//
// Programs are run by absolute path, so nothing depends on the PATH Herdr was started with.
// Every file is read with `tail -c`: a bounded slice from its end, never the whole transcript.
// A Codex rollout's first line is also read, with `head -c`, only to tell a sub-agent's apart.

import {
  agyReading, claudeReading, codexReading, kindOf, missing, parseAgyTail, parseClaudeTail, parseCodexTail,
} from "./usage.js";

/**
 * @typedef {import("./usage.js").Entry} Entry
 * @typedef {{ code: number, stdout: string, stderr: string }} Ran
 * @typedef {{
 *   exec: (command: string, args: string[], options?: { timeout?: number }) => Promise<Ran>,
 *   hc: (args: string[]) => Promise<Ran>,
 *   readTextFile: (path: string) => Promise<string | null>,
 *   home: string,
 * }} Host
 * @typedef {{ address: string, app: string | null, program?: { name?: string } }} AgentRef
 * @typedef {{ promise: Promise<Foreground | null>, timedOut: boolean }} InFlightForeground
 * @typedef {(ms: number, fn: () => void) => ({ cancel?: () => void } | null | undefined)} AfterFn
 * @typedef {{ paths: Map<string, string>, subagents: Map<string, boolean>, windows: Record<string, unknown>, inFlight?: Map<string, InFlightForeground>, after?: AfterFn }} Context
 * @typedef {{ pid: number, argv?: string[] }} Foreground
 */

export const PROGRAMS = {
  tail: "/usr/bin/tail",
  head: "/usr/bin/head",
  find: "/usr/bin/find",
  ps: "/bin/ps",
  lsof: "/usr/sbin/lsof",
};

/** Each program gets this long; a read that needs several waits for each in turn. */
export const EXEC_TIMEOUT_MS = 4000;

// A record is usually within the last few KB; a tool result in between can be large, so the
// slice grows until a usage record is found, and stops at 2 MiB.
export const TAIL_SIZES = [256 * 1024, 1024 * 1024, 2 * 1024 * 1024];

// A rollout's first line, session_meta, names a sub-agent before its long base_instructions.
export const HEAD_BYTES = 4096;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT = /\/rollout-[^/]+\.jsonl$/;
const AGY_CONV = /\/\.gemini\/antigravity-cli\/(?:conversations\/([0-9a-f-]{36})\.db(?:-shm|-wal)?|brain\/([0-9a-f-]{36})(?:\/|$))/i;

/** For `.catch`: a failed optional read is just absent. @returns {null} */
const none = () => null;

/**
 * Classifies an `lsof` failure when it exited non-zero with no PID records.
 * @param {string} stderr
 * @returns {string}
 */
export function lsofFailureReason(stderr) {
  if (/timed?\s*out|\btimeout\b/i.test(stderr)) return "read timed out";
  if (/permission denied|operation not permitted|not permitted|\beacces\b|\beperm\b/i.test(stderr)) {
    return "read failed: permission denied";
  }
  if (/illegal|invalid|unacceptable|usage:/i.test(stderr)) {
    return "read failed: invalid lsof arguments";
  }
  return "read failed";
}

/** @param {unknown} err */
function reasonOf(err) {
  const custom = /** @type {{ reason?: unknown } | null | undefined} */ (err)?.reason;
  if (typeof custom === "string" && custom) return custom;
  return /time/i.test(String(/** @type {Error} */ (err)?.message)) ? "read timed out" : "read failed";
}

/**
 * Races `promise` against a `ms` timeout using `after`; without `after` it waits for `promise` alone.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {AfterFn | undefined} after
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, after) {
  if (!after) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const task = after(ms, () => {
      if (settled) return;
      settled = true;
      reject(new Error("read timed out"));
    });
    promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        task?.cancel?.();
        resolve(v);
      },
      (err) => {
        if (settled) return;
        settled = true;
        task?.cancel?.();
        reject(err);
      },
    );
  });
}

/**
 * Parses the tail of a file with growing slices. Rejects when the file can't be read.
 * @template T
 * @param {Host} host
 * @param {string} path
 * @param {(text: string) => T | null} parse
 * @returns {Promise<T | null>}
 */
export async function tailParse(host, path, parse) {
  for (const size of TAIL_SIZES) {
    const ran = await host.exec(PROGRAMS.tail, ["-c", String(size), path], { timeout: EXEC_TIMEOUT_MS });
    if (ran.code !== 0) throw new Error("unreadable");
    const found = parse(ran.stdout);
    if (found) return found;
  }
  return null;
}

/**
 * The agent's own process, from `hc get`: `foreground` is the program running in the
 * terminal now (the agent).
 * @param {Host} host
 * @param {string} address
 * @returns {Promise<Foreground | null>}
 */
export async function foregroundOf(host, address) {
  const ran = await host.hc(["get", address, "--json"]);
  if (ran.code !== 0) return null;
  const fg = JSON.parse(ran.stdout)?.foreground;
  if (!Number.isInteger(fg?.pid)) return null;
  return Array.isArray(fg.argv) ? { pid: fg.pid, argv: fg.argv } : { pid: fg.pid };
}

/**
 * Per-agent `hc get` with a timeout and in-flight deduplication: `hc` cannot be cancelled on
 * the host, so a still-pending lookup for `address` is reused rather than started again.
 * @param {Host} host
 * @param {string} address
 * @param {Map<string, InFlightForeground>} inFlight
 * @param {AfterFn | undefined} after
 * @returns {Promise<{ fg: Foreground | null, error?: unknown }>}
 */
async function lookupForeground(host, address, inFlight, after) {
  let entry = inFlight.get(address);
  if (entry?.timedOut) return { fg: null, error: new Error("read timed out") };
  if (!entry) {
    const promise = foregroundOf(host, address);
    entry = { promise, timedOut: false };
    inFlight.set(address, entry);
    const current = entry;
    const clear = () => {
      if (inFlight.get(address) === current) inFlight.delete(address);
    };
    promise.then(clear, clear);
  }
  try {
    return { fg: await withTimeout(entry.promise, EXEC_TIMEOUT_MS, after) };
  } catch (error) {
    if (inFlight.get(address) === entry && reasonOf(error) === "read timed out") {
      entry.timedOut = true;
    }
    return { fg: null, error };
  }
}

// ---- Claude ---------------------------------------------------------------------------

/**
 * Claude Code writes ~/.claude/sessions/<pid>.json for each running session; only the session
 * id is taken from it.
 * @param {Host} host
 * @param {number} pid
 * @returns {Promise<string | null>}
 */
async function claudeSessionId(host, pid) {
  const text = await host.readTextFile(`${host.home}/.claude/sessions/${pid}.json`);
  if (!text) return null;
  const o = JSON.parse(text);
  return o?.pid === pid && typeof o.sessionId === "string" && UUID.test(o.sessionId) ? o.sessionId : null;
}

/**
 * The transcript of a running Claude session, or why there is none.
 * @param {Host} host
 * @param {Foreground} fg
 * @param {Context} ctx
 * @returns {Promise<{ path: string } | { reason: string }>}
 */
async function claudeTranscript(host, fg, ctx) {
  const sessionId = await claudeSessionId(host, fg.pid).catch(none);
  if (!sessionId) return { reason: "no session file" };
  const known = ctx.paths.get(sessionId);
  if (known) return { path: known };
  const ran = await host.exec(
    PROGRAMS.find, [`${host.home}/.claude/projects`, "-maxdepth", "2", "-name", `${sessionId}.jsonl`], { timeout: EXEC_TIMEOUT_MS });
  const path = ran.stdout.split("\n")[0].trim();
  if (!path) return { reason: "no transcript yet" };
  if (ctx.paths.size > 100) ctx.paths.clear();
  ctx.paths.set(sessionId, path);
  return { path };
}

/**
 * @param {Host} host
 * @param {Foreground} fg
 * @param {Context} ctx
 * @returns {Promise<Entry>}
 */
async function readClaude(host, fg, ctx) {
  const found = await claudeTranscript(host, fg, ctx);
  if ("reason" in found) return missing(found.reason, "claude");
  try {
    const rec = await tailParse(host, found.path, parseClaudeTail);
    return rec ? claudeReading(rec, ctx.windows) : missing("no usage recorded yet", "claude");
  } catch (err) {
    for (const [id, path] of ctx.paths) if (path === found.path) ctx.paths.delete(id);
    throw err;
  }
}

// ---- Codex ----------------------------------------------------------------------------

/**
 * The pid and all its descendants, from `ps -A -o pid=,ppid=` output.
 * @param {string} psText
 * @param {number} root
 * @returns {number[]}
 */
export function withDescendants(psText, root) {
  /** @type {Map<number, number[]>} */
  const children = new Map();
  for (const line of psText.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const all = [root];
  for (let i = 0; i < all.length; i++) all.push(...(children.get(all[i]) ?? []));
  return all;
}

/**
 * Open files by pid, from `lsof -Fpn` output.
 * @param {string} text
 * @returns {Map<number, string[]>}
 */
export function parseLsof(text) {
  /** @type {Map<number, string[]>} */
  const files = new Map();
  let pid = null;
  for (const line of text.split("\n")) {
    const match = /^p(\d+)$/.exec(line);
    if (match) {
      pid = Number(match[1]);
      if (!files.has(pid)) files.set(pid, []);
    } else if (line.startsWith("n") && pid !== null) {
      files.get(pid)?.push(line.slice(1));
    }
  }
  return files;
}

/**
 * Open files per terminal address, found with one `ps` and one `lsof` across all targets.
 * @param {Host} host
 * @param {Map<string, Foreground>} targets by terminal address
 * @returns {Promise<Map<string, string[]>>}
 */
export async function openFiles(host, targets) {
  const ps = await host.exec(PROGRAMS.ps, ["-A", "-o", "pid=,ppid="], { timeout: EXEC_TIMEOUT_MS });
  if (ps.code !== 0) throw new Error("ps failed");
  /** @type {Map<string, number[]>} */
  const pids = new Map();
  for (const [address, fg] of targets) pids.set(address, withDescendants(ps.stdout, fg.pid));
  const every = [...new Set([...pids.values()].flat())];
  // lsof exits 1 when one of the pids ended meanwhile, still printing the others;
  // only a non-zero exit with no PID records at all means lsof itself failed.
  const lsof = await host.exec(PROGRAMS.lsof, ["-n", "-P", "-p", every.join(","), "-Fpn"], { timeout: EXEC_TIMEOUT_MS });
  const files = parseLsof(lsof.stdout);
  if (lsof.code !== 0 && files.size === 0) {
    const reason = lsofFailureReason(lsof.stderr ?? "");
    throw Object.assign(new Error(reason), { reason });
  }
  /** @type {Map<string, string[]>} */
  const byAddress = new Map();
  for (const [address, list] of pids) {
    byAddress.set(address, [...new Set(list.flatMap((pid) => files.get(pid) ?? []))]);
  }
  return byAddress;
}

/**
 * Whether a rollout belongs to a sub-agent thread (an approval guardian, a spawned agent),
 * from the keys of its session_meta line: only the part before `base_instructions` is looked
 * at, and only unescaped keys match, so instruction text cannot pass for one. Remembered per
 * file, which never changes role, once the read prefix is conclusive: the whole line, up to
 * `base_instructions`, or the full HEAD_BYTES. Before that (Codex opens the file, then writes
 * the line) the answer is null, not known yet. Rejects when the file can't be read.
 * @param {Host} host
 * @param {string} path
 * @param {Context} ctx
 * @returns {Promise<boolean | null>}
 */
async function isSubagentRollout(host, path, ctx) {
  const known = ctx.subagents.get(path);
  if (known !== undefined) return known;
  const ran = await host.exec(PROGRAMS.head, ["-c", String(HEAD_BYTES), path], { timeout: EXEC_TIMEOUT_MS });
  if (ran.code !== 0) throw new Error("unreadable");
  const text = ran.stdout;
  if (!text.includes("\n") && !text.includes('"base_instructions"') && text.length < HEAD_BYTES) return null;
  const meta = text.split("\n")[0].split('"base_instructions"')[0];
  const subagent = meta.includes('"parent_thread_id":"') || meta.includes('"source":{"subagent"');
  if (ctx.subagents.size > 100) ctx.subagents.clear();
  ctx.subagents.set(path, subagent);
  return subagent;
}

/**
 * Picks the most informative failure when every file failed (`read timed out` over `read failed`).
 * @param {unknown[]} errors
 */
function firstFailure(errors) {
  return errors.find((e) => reasonOf(e) === "read timed out") ?? errors[0];
}

/**
 * Of the rollout files a Codex process has open, leaving out sub-agents' (their counts are
 * another thread's context) and any not yet known to be the session's, the one with the newest token count: a resumed session has its
 * old one open too. Per-file failures are isolated so one vanished auxiliary file does not drop a readable rollout.
 * @param {Host} host
 * @param {string[]} open
 * @param {Context} ctx
 * @returns {Promise<Entry>}
 */
async function readCodex(host, open, ctx) {
  if (open.length === 0) return missing("session file not found", "codex");
  const headResults = await Promise.allSettled(open.map((path) => isSubagentRollout(host, path, ctx)));
  /** @type {string[]} */
  const paths = [];
  /** @type {unknown[]} */
  const headErrors = [];
  for (let i = 0; i < open.length; i++) {
    const r = headResults[i];
    if (r.status === "rejected") headErrors.push(r.reason);
    else if (r.value === false) paths.push(open[i]);
  }
  if (paths.length === 0) {
    if (headErrors.length === open.length) throw firstFailure(headErrors);
    return missing("no main session file", "codex");
  }
  const tailResults = await Promise.allSettled(paths.map((path) => tailParse(host, path, parseCodexTail)));
  /** @type {NonNullable<ReturnType<typeof parseCodexTail>>[]} */
  const recs = [];
  /** @type {unknown[]} */
  const tailErrors = [];
  for (const r of tailResults) {
    if (r.status === "rejected") tailErrors.push(r.reason);
    else if (r.value !== null) recs.push(r.value);
  }
  const latest = recs.sort((a, b) => b.at - a.at)[0];
  if (latest) return codexReading(latest);
  if (tailErrors.length === paths.length) throw firstFailure(tailErrors);
  return missing("no usage recorded yet", "codex");
}

// ---- Antigravity CLI (agy) ------------------------------------------------------------

/**
 * Extracts unique agy conversation UUIDs from open file paths (`conversations/<uuid>.db*`
 * or `brain/<uuid>`).
 * @param {string[]} files
 * @returns {string[]}
 */
export function agyUuidsFromFiles(files) {
  /** @type {Set<string>} */
  const uuids = new Set();
  for (const f of files) {
    const m = AGY_CONV.exec(f);
    if (m) uuids.add((m[1] ?? m[2]).toLowerCase());
  }
  return [...uuids];
}

/**
 * Extracts `--model <id>` or `--model=<id>` from process argv.
 * @param {string[] | undefined} argv
 * @returns {string | null}
 */
export function modelFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model" && typeof argv[i + 1] === "string" && argv[i + 1]) return argv[i + 1];
    if (arg.startsWith("--model=") && arg.length > 8) return arg.slice(8);
  }
  return null;
}

/**
 * Reads the configured default model from `~/.gemini/antigravity-cli/settings.json`.
 * @param {Host} host
 * @returns {Promise<string | null>}
 */
async function agySettingsModel(host) {
  const text = await host.readTextFile(`${host.home}/.gemini/antigravity-cli/settings.json`).catch(none);
  if (!text) return null;
  try {
    const o = JSON.parse(text);
    return typeof o?.model === "string" && o.model ? o.model : null;
  } catch {
    return null;
  }
}

/**
 * @param {Host} host
 * @param {string[]} open
 * @param {string | null} model
 * @param {Context} ctx
 * @returns {Promise<Entry>}
 */
async function readAgy(host, open, model, ctx) {
  const uuids = agyUuidsFromFiles(open);
  if (uuids.length === 0) return missing("session file not found", "agy");
  const paths = uuids.map((id) => `${host.home}/.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript.jsonl`);
  const recs = await Promise.all(paths.map((path) => tailParse(host, path, parseAgyTail).catch(/** @returns {null} */ (err) => {
    if (err?.message !== "unreadable") throw err;
    return null;
  })));
  const latest = recs.filter((r) => r !== null).sort((a, b) => b.at - a.at)[0];
  return latest ? agyReading(latest, model, ctx.windows) : missing("no usage recorded yet", "agy");
}

// ---- All agents ---------------------------------------------------------------------------

/**
 * One reading for each agent. Never throws: whatever cannot be read becomes an "n/a" entry
 * that says why, so a number shown is always from this read.
 * @param {Host} host
 * @param {AgentRef[]} agents
 * @param {Context} ctx
 * @returns {Promise<Map<string, Entry>>}
 */
export async function readAll(host, agents, ctx) {
  /** @type {Map<string, Entry>} */
  const entries = new Map();
  /** @type {{ agent: AgentRef, kind: "claude" | "codex" | "agy" }[]} */
  const supported = [];
  for (const agent of agents) {
    const kind = kindOf(agent.app);
    // A machine-qualified address ("vps/t7") is a terminal on another machine, whose files
    // are not here.
    if (agent.address.includes("/")) entries.set(agent.address, missing("terminal on another machine"));
    else if (!kind) entries.set(agent.address, missing(`${agent.program?.name ?? agent.app ?? "this agent"} has no readable context record`));
    else supported.push({ agent, kind });
  }

  const inFlight = ctx.inFlight ?? new Map();
  /** @type {Map<string, { fg: Foreground | null, error?: unknown }>} */
  const foreground = new Map();
  await Promise.all(supported.map(async ({ agent }) => {
    foreground.set(agent.address, await lookupForeground(host, agent.address, inFlight, ctx.after));
  }));

  /** @type {Map<string, Foreground>} */
  const lsofTargets = new Map();
  let needsAgySettings = false;
  for (const { agent, kind } of supported) {
    const fg = foreground.get(agent.address)?.fg;
    if (!fg) continue;
    if (kind === "codex" || kind === "agy") lsofTargets.set(agent.address, fg);
    if (kind === "agy" && !modelFromArgv(fg.argv)) needsAgySettings = true;
  }
  /** @type {Map<string, string[]> | null} */
  let openByAddress = null;
  /** @type {string} */
  let openFailure = "read failed";
  if (lsofTargets.size > 0) {
    try { openByAddress = await openFiles(host, lsofTargets); } catch (err) { openFailure = reasonOf(err); }
  }
  const fallbackAgyModel = needsAgySettings ? await agySettingsModel(host) : null;

  await Promise.all(supported.map(async ({ agent, kind }) => {
    const lookup = foreground.get(agent.address);
    const fg = lookup?.fg;
    try {
      if (lookup?.error) entries.set(agent.address, missing(reasonOf(lookup.error), kind));
      else if (!fg) entries.set(agent.address, missing("no agent process found", kind));
      else if (kind === "claude") entries.set(agent.address, await readClaude(host, fg, ctx));
      else if (!openByAddress) entries.set(agent.address, missing(openFailure, kind));
      else if (kind === "codex") {
        // Codex keeps its rollout file open, so the file a terminal's Codex has open is its
        // session: exact, where a folder match is not (two Codex terminals can share a folder,
        // and a session in a worktree has another cwd than the terminal).
        const rollouts = (openByAddress.get(agent.address) ?? []).filter((f) => ROLLOUT.test(f));
        entries.set(agent.address, await readCodex(host, rollouts, ctx));
      } else {
        const model = modelFromArgv(fg.argv) ?? fallbackAgyModel;
        entries.set(agent.address, await readAgy(host, openByAddress.get(agent.address) ?? [], model, ctx));
      }
    } catch (err) {
      entries.set(agent.address, missing(reasonOf(err), kind));
    }
  }));
  return entries;
}
