# pi-jutsu

Techniques for the pi coding agent.

[pi](https://github.com/earendil-works/pi) is a minimal, extensible coding agent for the terminal. pi-jutsu is a curated collection of extensions for it, built and hardened through daily use. The flagship extension runs Naruto-style shadow-clone agent swarms — hence the name (jutsu: technique).

> **Note:** for the full experience these extensions expect my private `pif` fork of pi (alt-screen fullscreen UIs, per-clone auth accounts, rate-limit fallback events — see [Compatibility](#compatibility)). Most of them still run fine on published pi, just with fewer tricks. If you want the fork — reach out ([@markbrutx](https://github.com/markbrutx) or open an issue) and I'll share access.

## Extensions

| Extension | What it does |
|-----------|--------------|
| [swarm](extensions/swarm/) | Persistent shadow-clone subagents plus parallel one-shot workers, with a live TUI dashboard, per-clone model tiers, per-clone auth accounts, pause/resume, and rate-limit auto-pause. |
| [goal](extensions/goal/) | Autonomous goal mode: the agent keeps iterating until it verifiably completes the goal, under token and time budgets. |
| [browser](extensions/browser/) | Browser control through stealth Chromium via the `agent-browser` CLI, with persistent profiles. |
| [simplify](extensions/simplify/) | A configurable council of parallel review subagents over your changed code (default: reuse, quality, efficiency), with a fullscreen model-per-role picker. |
| [btw](extensions/btw/) | Fullscreen side questions with a model picker, follow-up threads, clipboard copy, and `/btw-history` — without touching the session. |
| [ask-user](extensions/ask-user/) | `ask_user` tool: multiple-choice questions with markdown previews, multi-select, notes, and an idle timeout that never blocks the run. |
| [fallback-guard](extensions/fallback-guard/) | Blocking choice when a rate limit triggers a model fallback: continue, stop, or roll back to the pre-prompt checkpoint. |

![Clone dashboard](docs/dashboard.png)

The swarm dashboard, mid-flight: four shadow clones porting this very repository into the open. The tray keeps clone status visible while you keep chatting:

![Agents tray](docs/tray.png)

## Install

Clone the repo:

```bash
git clone https://github.com/markbrutx/pi-jutsu.git
```

Register the extensions you want in `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/path/to/pi-jutsu/extensions/swarm",
    "/path/to/pi-jutsu/extensions/goal",
    "/path/to/pi-jutsu/extensions/browser",
    "/path/to/pi-jutsu/extensions/simplify",
    "/path/to/pi-jutsu/extensions/btw",
    "/path/to/pi-jutsu/extensions/ask-user",
    "/path/to/pi-jutsu/extensions/fallback-guard"
  ]
}
```

Or load one for a single session:

```bash
pi -e /path/to/pi-jutsu/extensions/swarm
```

Each extension's README covers its own configuration and requirements.

## Compatibility

These extensions track the `pif` fork of pi, which runs slightly ahead of
the published pi packages. Extensions load at runtime via jiti, so on the
fork everything just works. Against the latest published pi: `goal`,
`browser`, `btw`, and `ask-user` run as-is (fullscreen views degrade to
regular overlays and PgUp/PgDn scrolling to ↑↓ where fork TUI APIs are
missing); `fallback-guard` loads but only triggers on the fork's
rate-limit fallback events; `swarm` and `simplify` use fork APIs
(per-clone auth storage, fallback events) that have not landed in a
published release yet — `npm run check` reflects exactly that gap.

## Why

These extensions come out of daily production use of agentic coding, not demos. They encode multi-agent orchestration patterns that hold up under real workloads: a lead/clone hierarchy with steering interrupts, memory distillation across sessions, and model tiering — an expensive architect model for open-ended thinking, a cheap executor model for mechanical work.

## License

[MIT](LICENSE)
