# fallback-guard

When the primary model hits a rate/usage limit, pi silently switches to
`retry.fallbackModels` and keeps going. Sometimes that sends the
conversation somewhere you did not want. This guard intercepts the
automatic fallback and **blocks** with a choice:

1. **Continue** with the fallback model (also the 2-minute idle-timeout
   default, so an unattended run never hangs)
2. **Stop here** — abort the retry, restore the primary model, wait for
   the limit window
3. **Roll back** — abort and navigate the session tree back to the
   checkpoint captured before your last prompt (no branch summary), then
   restore the primary model

Blocking works because the session awaits `model_select` extension
handlers inside the fallback path, before the retry run starts.

The checkpoint is captured on every interactively submitted prompt.
Rollback runs through the `/fallback-rollback` command, which the guard
queues for you (you can also run it manually right after a fallback).

No configuration; the decision timeout is the `DECISION_TIMEOUT_MS`
constant in `index.ts`.
