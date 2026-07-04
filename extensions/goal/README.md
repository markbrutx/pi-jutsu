# goal

Autonomous goal mode for the [pi coding agent](https://github.com/earendil-works/pi). Give the agent an
objective with `/goal`, and it keeps iterating — sending itself continuation prompts after each turn — until it
calls the `goal_complete` tool, hits a token budget, or you pause it.

## Install

Point the agent at this extension, either on the CLI:

```bash
pi -e /path/to/pi-jutsu/extensions/goal/index.ts
```

or in settings:

```json
{
  "extensions": ["/path/to/pi-jutsu/extensions/goal/index.ts"]
}
```

## Usage

```
/goal <objective>                 start (or replace) a goal
/goal --tokens 100k <objective>   start a goal with a token budget (k/m suffixes)
/goal                             show current goal status
/goal status                      same as above
/goal edit <objective>            change the objective (and/or budget) of the active goal
/goal pause                       pause an active goal
/goal resume                      resume a paused or budget-limited goal
/goal clear                       stop and drop the current goal (alias: /goal stop)
```

Starting a goal while one is already active (and not complete) prompts for confirmation before replacing it.

## How it works

- `/goal <objective>` injects a goal-mode system prompt for every agent turn while the goal is active, instructing
  the model to keep working end-to-end, treat the current worktree/command output/tests as authoritative, avoid
  redefining the goal into something smaller, and never stop at just a plan.
- After each agent turn (`agent_end`), if the goal is still active the extension sends itself an automatic
  continuation prompt (via `sendUserMessage` as a follow-up) so the model keeps going without user input.
- The loop stops when:
  - the model calls `goal_complete` (goal marked `complete`, status cleared after a short grace period),
  - the token budget is reached (goal marked `budget_limited`),
  - the agent aborts or errors (goal auto-paused, resumable with `/goal resume`),
  - the user runs `/goal pause` or `/goal clear`.

### `goal_complete` tool

Registered as a tool the model can call directly. It takes one parameter:

- `summary` (string): what was completed and how it was verified.

The tool's prompt guidelines tell the model to audit the goal requirement by requirement against real, verifiable
state (files, command output, tests) before calling it, and never to call it on partial progress. Calling it marks
the goal `complete`, clears goal-mode, and shows a transient "complete" status indicator.

### Budgets

`--tokens` accepts a plain integer or a `k`/`m`-suffixed shorthand (e.g. `100k`, `2m`). Usage is tracked as the sum
of assistant message input/output token usage recorded in the session since the goal started (a baseline is
captured at goal start so token counts from before the goal don't count against the budget). When usage reaches
the budget, the goal transitions to `budget_limited` and stops auto-continuing; `/goal resume` re-checks the budget
before resuming.

There is no built-in time budget/flag; elapsed time is tracked and shown in the status line and `/goal status`
output for goals without a token budget, but nothing stops the goal based on wall-clock time.

### Status line

A compact indicator is set via the UI status API:

- `◎ » active <elapsed>` or `◎ » active <used>/<budget>` while running
- `◎ ❚❚ paused` when paused
- `◎ ◑ budget <used>/<budget>` when budget-limited
- `◎ ✓ complete` briefly after completion

### State persistence

Goal state is persisted as a custom session entry (`goal-state`) via `appendEntry`, so it survives reloading the
session. On `session_start` the extension restores the most recent non-complete goal from the session's entries.
There is also a legacy flat-file cleanup path (`pi-goal-state.json` under the agent's config directory) retained
only to remove old per-cwd state left by earlier versions; new state is not written there.

## Notes

- Only one goal is tracked at a time (per session); starting a new one replaces the current goal after
  confirmation.
- Objectives are capped at 4000 characters; put long instructions in a file and reference the file path instead.
- Automatic continuation prompts are marked internally so a user manually re-sending a cancelled continuation
  prompt is not double-processed.
