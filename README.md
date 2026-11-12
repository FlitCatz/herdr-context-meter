# herdr-context-meter

A [Herdr](https://herdr.dev) mod that shows how full each agent's context window is, in the
bottom status bar, at its left end, before the built-in `This computer · branch · N agents`
text (`workspace-status`, unchanged). Each agent gets a compact entry: its mark, the share of the window in use, a short bar, and a color. The point
is to see, at a glance, which agent is getting full enough that you would rather `/clear`
than let it compact.

```
▣ 18% ▬  ▣ 42% ▬  ▣ 55% ▬  ◉ 30% ▬  ◉ 52% ▬  A n/a ▬   This computer  ● main  ● 6 agents · 1 needs you        ⌘⇧P commands
```

- The share turns yellow (the theme's `working` color) from **40%** and red (the theme's
  `blocked` color) from **50%**. Both are props.
- Hover an entry for the tab name, the model, and the token counts.
- It only displays. It never clears or compacts anything.

## What it shows, per agent

| Agent | Context in use | Window | Matches the tool's own figure |
|---|---|---|---|
| Claude Code | `input + cache creation + cache read` tokens of the latest response (output not counted) | per-model table, below | Claude Code's status line (`used_percentage` is computed the same way) |
| Codex | `last_token_usage.total_tokens` of the latest `token_count`, with Codex's 12,000-token baseline taken off both the usage and the window | `model_context_window` from the same record | Codex's `Context N% left` |
| anything else (agy, pi, ...) | not read | | shown as `n/a`, hover says why |

An agent whose number cannot be read **always shows `n/a`** with the reason on hover; a stale or
guessed number is never shown as current.

### Cross-check against each tool's own status line

Compared at the same moment:

| Tool | Record | Mod says | The tool says |
|---|---|---|---|
| Claude Code (Sonnet 5.5, 1M window) | 130,631 tokens | 13.1% used, 86.9% left | `87% context left` |
| Claude Code (same session, later) | 195,093 tokens | 19.5% used, 80.5% left | `80% context left` |
| Codex | 120,170 tokens, window 258,400 | 43.9% used, 56.1% left | `Context 56% left` |

The plain ratio for the Codex record would be 46.5% used (53.5% left), which is not what
Codex shows; with the baseline `(window - 12000 - (tokens - 12000)) / (window - 12000)` it is.
The Codex record in that comparison is a sanitized sample kept as a test fixture
(`test/fixtures/codex-rollout.jsonl`); the Claude figures were read from a live session.

### Claude windows

Claude transcripts do not record the window, so the mod has a table (`claudeWindow` in
`mods/herdr-context-meter/usage.js`), following Claude Code's documentation:

| Model | Window |
|---|---|
| Fable models, Sonnet 5 and later, Haiku 5 and later, Opus 4.7 and later | 1,000,000 |
| earlier models (Opus/Sonnet 4.6 and before, Claude 3, ...) | 200,000 |
| an id the table cannot place | 200,000, marked "window assumed" on hover |

The 1M variants of the earlier models are an opt-in that the transcript does not name. If an
agent shows more than 200,000 tokens in use on such a model, the mod switches that agent to
1,000,000 (and says so on hover). To change a window, use the `windows` prop.

### Auto-compact: no marker is drawn

Neither tool's auto-compact point can be read from its records, so no marker is drawn:

- **Claude Code** compacts at about 967K tokens by default on 1M models and at the context limit
  elsewhere, but the point moves with `autoCompactWindow`, `/autocompact`, `--autocompact`,
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, none of which is in
  the transcript.
- **Codex** compacts at 90% of the model's context window by default (a configured
  `model_auto_compact_token_limit` is clamped to that), while the rollout's
  `model_context_window` is the usable window, 95% of it for the model seen. So it lies
  somewhere above 90% of the window the mod shows, and moves with the config.

Either way it is far past the 40-50% where you would clear, so the thresholds are shares of the
window, as shown.

## How an agent is matched to its session

The mod asks Herdr for the agents (`agents()`), then for each local one runs `hc get <address>
--json`, which reports the agent's own process (`foreground`) and so its pid.

- **Claude Code.** `~/.claude/sessions/<pid>.json` names the running session; its transcript is
  `~/.claude/projects/*/<session id>.jsonl`, found once and remembered. Without that session
  file the entry is `n/a` ("no session file").
- **Codex.** Codex keeps its rollout file (`~/.codex/sessions/.../rollout-*.jsonl`) open, so the
  mod finds the rollout through the process tree (`ps`, then `lsof`). That is exact: it works
  when two Codex terminals share a folder and when the session's folder is a worktree. Codex
  also writes a rollout for each sub-agent thread (an approval guardian, a spawned agent),
  whose counts are that thread's context, not the session's; a rollout whose first line
  (`session_meta`) has a `parent_thread_id` or a `subagent` source is left out, and so is one
  whose first line is not fully written yet, until a later round can read it. A resumed
  session has its old rollout open too; of the rest, the one with the newest `token_count` is
  used.

Limits, all of which show `n/a` rather than a guess:

- Terminals on another machine (`machine/t7`): their files are not here.
- Claude without a session file (`~/.claude/sessions/<pid>.json`), as in an older Claude Code.
- A Codex that does not have its rollout open, or a failed `ps` or `lsof`.
- A Codex whose only open rollouts are sub-agents', or not fully started yet ("no main session
  file").
- A new session that has not recorded a response yet.

Both Claude's session file and Codex's open rollout are implementation details of those tools,
not documented interfaces; if one changes, the entry reads `n/a` until the mod is updated.

The numbers are as of the last completed response: during a long tool run the entry shows the
context of the response before it. After `/compact` it updates with the next response; after
`/clear` the next round finds the new session.

## What is read, and what is not

Only the last part of each file is read, with `tail -c` (256 KiB, growing to 2 MiB only when no
usage record is in it), never a whole transcript. From each line only token counts, the model
id and the record's timestamp are taken. Of a Codex rollout, the first 4 KiB are also read, with
`head -c` (again each round only until its first line can be read), only to see whether its `session_meta` names a sub-agent; the text from
`base_instructions` on is not looked at. Conversation text is not looked at, kept, logged or
shown, and nothing is stored.

The only change it makes to Herdr is the `layout.resize` of its own block when `block` is set. Everything else runs through Herdr's `exec`, `hc` and `readTextFile`, by absolute program path
(`/usr/bin/tail`, `/usr/bin/head`, `/usr/bin/find`, `/bin/ps`, `/usr/sbin/lsof`: macOS locations,
listed in `PROGRAMS` in `sources.js` for other systems), so nothing depends on the `PATH` or
folder Herdr was started from.

## Refreshing

Every 5 seconds, one round at a time. Each program in a round has a 4-second limit. A round that
has not finished after 20 seconds is given up on: the next tick starts a new one, and the old
round's late answer is discarded, so one stuck read cannot freeze later updates. An entry whose
last successful read is older than 35 seconds turns to `n/a` instead of showing an old number.
(`hc get` has no time limit of its own; if it hangs, the round is abandoned the same way.)

## Add it

1. Copy `mods/herdr-context-meter/` into `~/.config/herdr-app/mods/` (the `.js` files and
   `mod.json`; `jsconfig.json` is only for editing).
2. Herdr's own layouts are read-only, so use a clone (the one you already have, or
   `herdr-app do layout.clone '{"name":"main","as":"my-main"}'`).
3. In the clone, find the `status` block, which shows `workspace-status`:

   ```json
   { "id": "status", "type": "block", "size": { "px": 28 }, "content": { "mod": "workspace-status" } }
   ```

   and turn it into a row with the meter first and `workspace-status` unchanged after it:

   ```json
   {
     "id": "status", "type": "row", "size": { "px": 28 },
     "children": [
       { "id": "context-meter", "type": "block", "size": { "px": 120 },
         "content": { "mod": "herdr-context-meter", "props": { "block": "context-meter" } } },
       { "id": "status-info", "type": "block", "content": { "mod": "workspace-status" } }
     ]
   }
   ```

   The bar keeps its 28 px height. `workspace-status` keeps its text and its palette hint at the
   right edge; it just starts where the meter ends.
4. Check it: `herdr-app check ~/.config/herdr-app/mods/herdr-context-meter`.

A layout can only give a block a fixed width, but the meter's width depends on how many agents
there are. With the `block` prop set to the block's own id (`"context-meter"` above), the meter
asks Herdr to resize that block to fit its entries (`layout.resize`) whenever they change, up to
640 px, so `workspace-status` always follows right after them. The `px` in the layout is only the
width before the first read. If more agents than 640 px holds are running, the fullest ones stay
and a `+N` shows how many are left out. Without `block`, the block keeps the width the layout
gave it (94 px per agent plus 14 fits them all) and the entries sit at its left.

### Props

| Prop | Default | Meaning |
|---|---|---|
| `block` | none | This block's own id in the layout. When set, the meter resizes that block to fit its entries (see above). |
| `warn` | `40` | Share (percent of the window) from which the entry is yellow. |
| `critical` | `50` | Share from which it is red. A missing value, or one that is not a number above 0 and up to 100, falls back to its own default; if `warn` is then not below `critical`, both fall back to the defaults. |
| `windows` | `{}` | Window per Claude model, in tokens: `{ "claude-opus-5": 500000 }`. A key is a model id or its start; the longest match wins and beats the built-in table. Setting a smaller window than the real one makes the shares reach the thresholds sooner. |

## Develop

Plain JavaScript with `checkJs`, no build step. `usage.js` (reading and wording rules),
`sources.js` (finding and tailing session files; all I/O through an injected host),
`rounds.js` (the no-stall round tickets) are pure and tested; `main.js` is the view.

```sh
npm test            # node --test: matching, usage math on fixtures, thresholds, tail reader, no-stall
npm run check       # herdr-app check (also writes gpui-kit.d.ts) and tsc
```
