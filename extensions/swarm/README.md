# swarm

A pi extension for multi-agent orchestration: persistent named shadow-clone
subagents that work in the background and report back, plus one-shot parallel
worker fan-out, with a live TUI dashboard to watch and steer everything.

Two kinds of subagents:

- **Shadow clones** — persistent, named (`@itachi`, `@kakashi`, ...), summoned
  in batches. They work in the background while the chat stays usable, report
  back automatically, ask the lead questions when blocked, accept steering
  mid-run, and return distilled "memories" when dispelled.
- **Workers** — one-shot leaf subagents (`worker_run`): fire-and-forget
  parallel fan-out of 1-10 independent subtasks, each in a fresh isolated
  session with a final report. Workers cannot be steered and cannot spawn
  further agents.

Everything is off by default; enable features via `/agents-settings`.

## Tools

Registered on the lead agent (gated by settings):

| Tool | Purpose |
| --- | --- |
| `shadowclone_summon` | Summon 1-8 clones in one call. Per clone: task, optional name, `keep` (stay alive for follow-ups), persona, git worktree, model. Returns immediately. |
| `shadowclone_send` | Send instructions/answers to a live clone. Busy clones get a steering interrupt; idle ones start working; paused ones revive. |
| `shadowclone_status` | Status, last activity, touched files, and recent actions of live clones (also lists clones of other pi sessions on the machine). |
| `shadowclone_dispel` | Dispel a clone (or `all`), aborting in-progress work and returning its memories. |
| `worker_run` | Run 1-10 independent subtasks in parallel as one-shot workers. Optional tool restriction and per-run model. |

Clones themselves get the coding toolset plus:

- `report_to_lead` — `question` (clone stops and waits for the answer) or
  `update` (interim finding; clone keeps working).
- `wait_for` — cheap blocking wait (file_exists / file_changed /
  file_contains / command_succeeds) polled inside one tool call. A steering
  message from the lead interrupts an in-progress wait.
- `worker_run` — only when "Clones can run workers" is enabled.

## Commands and keys

- `/agents-settings` — settings menu (TUI): toggle clones, workers,
  clone-workers, model tiers.
- `/workers <request>` — ask the agent to decompose the request and run it
  via `worker_run`.
- `/shadowclones` — open the clone dashboard.
- `/shadowclone-pop <name>` — debug: crash a working clone to test the
  failure-pause path.
- `alt+k` (⌥K on macOS) — open the dashboard from anywhere.
- `Down` from an empty editor — focus the agents tray; `Down`/`Enter` again
  opens the dashboard.

While agents are live, a status line above the editor shows each clone's
state (or aggregate counts) and active worker runs:

![Agents tray](../../docs/tray.png)

![Clone dashboard](../../docs/dashboard.png) The dashboard is a
two-pane master/detail view: agents on the left, the selected agent's full
transcript (tool calls, thinking, messages) on the right, with scrolling,
steering input (`Enter`), abort (`a`), dispel (`d`), and thinking toggle
(`t`). Worker runs appear alongside clones read-only, with per-worker
progress and reports.

The extension also blocks the lead's own `bash sleep N` calls (>= 10s) — the
sleep-polling pattern that clone reports and `wait_for` exist to replace.

## Install

Copy (or clone) this directory, then either add it to `settings.json`:

```json
{
  "extensions": ["/path/to/pi-jutsu/extensions/swarm"]
}
```

or place it in an auto-discovery location (`~/.pi/agent/extensions/swarm/` or
`.pi/extensions/swarm/` in a project), or run ad hoc:

```bash
pi -e /path/to/pi-jutsu/extensions/swarm/index.ts
```

Imports resolve against the harness's own packages
(`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`,
`@earendil-works/pi-tui`, `typebox`); no separate install step.

## Configuration

Persisted in `<agent-dir>/swarm-settings.json` (e.g.
`~/.pi/agent/swarm-settings.json`), edited via `/agents-settings`. Flags are
read at extension load, so changes apply on the next session.

```json
{
  "workers": false,
  "clones": false,
  "cloneWorkers": false,
  "modelTiers": false,
  "cloneModel": "",
  "workerModel": ""
}
```

- `workers` — register `worker_run` and `/workers` on the lead.
- `clones` — register the `shadowclone_*` tools, dashboard, and widget.
- `cloneWorkers` — let clones call `worker_run` too (deepest, costliest
  tier; requires `clones`).
- `modelTiers` — route clones to an "architect" model (`cloneModel`) and
  workers to a cheaper "executor" model (`workerModel`). Specs are
  `"provider/model-id"`. Empty specs (the default) and unknown or
  unauthenticated specs fall back to the session's current model, so a bad
  spec can never block a spawn.

Per spawn, the lead can also pass `model` to any clone or worker run: a
`"provider/model-id"` spec or the tier aliases `"architect"` / `"executor"`.

Limits: 8 clones per session, 24 across all pi sessions on the machine
(tracked via a registry in the temp dir).

## How it works

**Clone sessions.** Each clone is a full agent session created in-process
(`createAgentSession`) with an in-memory session manager, its own system
prompt (scope discipline, report protocol, sibling awareness), and its own
toolset. Clones run in the lead's cwd by default, or in an existing git
worktree passed at summon time, so parallel clones can work on disjoint
branches. If the [pi-dev-worktrees](https://github.com/lanquarden/pi-dev-worktrees)
extension is active, clones inherit the lead's active worktree automatically. Summon batches of 2+ clones form a "wave": when the last member
settles, one aggregate summary is delivered with the individual reports.

**Reports and steering.** Clone-to-lead traffic has two lanes. Urgent
messages (questions, failures) are delivered as steering interrupts to the
lead's current turn. Non-urgent ones (updates, completions) are buffered and
flushed as one consolidated message at the next boundary — when the lead goes
idle or its current run ends — so a finishing wave lands as a single turn
instead of trickling in. Lead-to-clone messages steer a busy clone mid-stream
(and cut short an in-progress `wait_for`), start an idle one, or revive a
paused one. Each clone streams its activity to a per-clone log file
(`tail -f`-able) and an in-memory transcript that powers the dashboard.

**Failure handling.** A clone whose turn fails retries once automatically
(most provider errors are transient). A second failure pauses the clone with
its session and context intact, and the lead gets the reason, touched files,
and recent tool calls — rephrase via `shadowclone_send` or dispel. Errors
that look like safety-classifier blocks skip the retry (the flagged content
stays in context and would just re-trigger the block) and the advice says to
resummon fresh instead.

**Memories on dispel.** Dispelling a clone distills its transcript into a
compact digest via a separate model call (bounded, with a hard timeout),
falling back to the last output plus a raw transcript tail. Touched files and
the log path are appended deterministically, so the lead always gets a
reliable list of what to verify and commit.

**Worker runs.** `worker_run` executes its tasks concurrently, each in a
fresh isolated session restricted to the requested tools, streaming progress
(current tool, last activity) into the tool call. Results come back as a
consolidated report prompt. Every run is also published to a shared
in-process registry, which is what lets the dashboard show live and recently
finished worker runs — including ones started by clones — next to the clones
themselves.
