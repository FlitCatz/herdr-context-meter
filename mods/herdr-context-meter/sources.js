// Finding each agent's session file and reading the tail of it. All I/O goes through the
// `host` object, so the tests drive it with fakes; main.js hands it Herdr's own functions.
//
// Programs are run by absolute path, so nothing depends on the PATH Herdr was started with.
// Every file is read with `tail -c`: a bounded slice from its end, never the whole transcript.
// A Codex rollout's first line is also read, with `head -c`, only to tell a sub-agent's apart.

import {
  claudeReading, codexReading, kindOf, missing, parseClaudeTail, parseCodexTail,
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
 * @typedef {{ paths: Map<string, string>, subagents: Map<string, boolean>, windows: Record<string, unknown> }} Context
 * @typedef {{ pid: number }} Foreground
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

/** For `.catch`: a failed optional read is just absent. @returns {null} */
const none = () => null;

/** @param {unknown} err */
function reasonOf(err) {
  return /time/i.test(String(/** @type {Error} */ (err)?.message)) ? "read timed out" : "read failed";
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
  return Number.isInteger(fg?.pid) ? { pid: fg.pid } : null;
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
    if (line.startsWith("p")) { pid = Number(line.slice(1)); files.set(pid, []); }
    else if (line.startsWith("n") && pid !== null) files.get(pid)?.push(line.slice(1));
  }
  return files;
}

/**
 * Codex keeps its rollout file open, so the file a terminal's Codex has open is its session:
 * exact, where a folder match is not (two Codex terminals can share a folder, and a session in
 * a worktree has another cwd than the terminal). The files of every Codex terminal are found
 * with one `ps` and one `lsof`.
 * @param {Host} host
 * @param {Map<string, Foreground>} codex by terminal address
 * @returns {Promise<Map<string, string[]>>}
 */
export async function openRollouts(host, codex) {
  const ps = await host.exec(PROGRAMS.ps, ["-A", "-o", "pid=,ppid="], { timeout: EXEC_TIMEOUT_MS });
  if (ps.code !== 0) throw new Error("ps failed");
  /** @type {Map<string, number[]>} */
  const pids = new Map();
  for (const [address, fg] of codex) pids.set(address, withDescendants(ps.stdout, fg.pid));
  const every = [...new Set([...pids.values()].flat())];
  // lsof exits 1 when one of the pids ended meanwhile, still printing the others.
  const lsof = await host.exec(PROGRAMS.lsof, ["-n", "-P", "-p", every.join(","), "-Fpn"], { timeout: EXEC_TIMEOUT_MS });
  const files = parseLsof(lsof.stdout);
  /** @type {Map<string, string[]>} */
  const byAddress = new Map();
  for (const [address, list] of pids) {
    byAddress.set(address, [...new Set(list.flatMap((pid) => files.get(pid) ?? []).filter((f) => ROLLOUT.test(f)))]);
  }
  return byAddress;
}

/**
 * Whether a rollout belongs to a sub-agent thread (an approval guardian, a spawned agent),
 * from the keys of its session_meta line: only the part before `base_instructions` is looked
 * at, and only unescaped keys match, so instruction text cannot pass for one. Remembered per
 * file, which never changes role. Rejects when the file can't be read.
 * @param {Host} host
 * @param {string} path
 * @param {Context} ctx
 * @returns {Promise<boolean>}
 */
async function isSubagentRollout(host, path, ctx) {
  const known = ctx.subagents.get(path);
  if (known !== undefined) return known;
  const ran = await host.exec(PROGRAMS.head, ["-c", String(HEAD_BYTES), path], { timeout: EXEC_TIMEOUT_MS });
  if (ran.code !== 0) throw new Error("unreadable");
  const meta = ran.stdout.split("\n")[0].split('"base_instructions"')[0];
  const subagent = meta.includes('"parent_thread_id":"') || meta.includes('"source":{"subagent"');
  if (ctx.subagents.size > 100) ctx.subagents.clear();
  ctx.subagents.set(path, subagent);
  return subagent;
}

/**
 * Of the rollout files a Codex process has open, leaving out sub-agents' (their counts are
 * another thread's context), the one with the newest token count: a resumed session has its
 * old one open too.
 * @param {Host} host
 * @param {string[]} open
 * @param {Context} ctx
 * @returns {Promise<Entry>}
 */
async function readCodex(host, open, ctx) {
  if (open.length === 0) return missing("session file not found", "codex");
  const subagent = await Promise.all(open.map((path) => isSubagentRollout(host, path, ctx)));
  const paths = open.filter((_, i) => !subagent[i]);
  if (paths.length === 0) return missing("no main session file", "codex");
  const recs = await Promise.all(paths.map((path) => tailParse(host, path, parseCodexTail)));
  const latest = recs.filter((r) => r !== null).sort((a, b) => b.at - a.at)[0];
  return latest ? codexReading(latest) : missing("no usage recorded yet", "codex");
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
  /** @type {{ agent: AgentRef, kind: "claude" | "codex" }[]} */
  const supported = [];
  for (const agent of agents) {
    const kind = kindOf(agent.app);
    // A machine-qualified address ("vps/t7") is a terminal on another machine, whose files
    // are not here.
    if (agent.address.includes("/")) entries.set(agent.address, missing("terminal on another machine"));
    else if (!kind) entries.set(agent.address, missing(`${agent.program?.name ?? agent.app ?? "this agent"} has no readable context record`));
    else supported.push({ agent, kind });
  }

  /** @type {Map<string, Foreground | null>} */
  const foreground = new Map();
  await Promise.all(supported.map(async ({ agent }) => {
    foreground.set(agent.address, await foregroundOf(host, agent.address).catch(none));
  }));

  /** @type {Map<string, Foreground>} */
  const codex = new Map();
  for (const { agent, kind } of supported) {
    const fg = foreground.get(agent.address);
    if (fg && kind === "codex") codex.set(agent.address, fg);
  }
  /** @type {Map<string, string[]> | null} */
  let rollouts = null;
  /** @type {string} */
  let rolloutsFailure = "read failed";
  if (codex.size > 0) {
    try { rollouts = await openRollouts(host, codex); } catch (err) { rolloutsFailure = reasonOf(err); }
  }

  await Promise.all(supported.map(async ({ agent, kind }) => {
    const fg = foreground.get(agent.address);
    try {
      if (!fg) entries.set(agent.address, missing("no agent process found", kind));
      else if (kind === "claude") entries.set(agent.address, await readClaude(host, fg, ctx));
      else if (!rollouts) entries.set(agent.address, missing(rolloutsFailure, kind));
      else entries.set(agent.address, await readCodex(host, rollouts.get(agent.address) ?? [], ctx));
    } catch (err) {
      entries.set(agent.address, missing(reasonOf(err), kind));
    }
  }));
  return entries;
}
