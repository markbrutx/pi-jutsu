/**
 * fallback-guard — blocking choice on automatic rate-limit model fallback.
 *
 * When the primary model hits a rate/usage limit, pi silently switches to
 * retry.fallbackModels (e.g. fable-5 → opus-4-8) and continues. That can send
 * the conversation somewhere you did not want. This guard intercepts the
 * fallback and BLOCKS with a choice:
 *
 *   1. Continue with the fallback model (also the idle-timeout default)
 *   2. Stop here — abort the retry, restore the primary model, wait
 *   3. Stop and roll back to the checkpoint captured before the last prompt
 *
 * Blocking works because the session awaits model_select handlers inside
 * _prepareModelFallback, before the retry run starts. "Stop"/"rollback" cannot
 * cancel the continuation from inside the handler, so they schedule aborts
 * that land right after the retry run starts (before meaningful work).
 * Rollback then runs /fallback-rollback, which navigates the session tree
 * back to the pre-prompt checkpoint without a branch summary.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Auto-continue with the fallback if the user is away. */
const DECISION_TIMEOUT_MS = 120_000;

interface PendingRollback {
	leafId?: string;
	model: Model<Api>;
}

function modelSpec(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export default function (pi: ExtensionAPI) {
	// Leaf entry BEFORE the last interactively submitted prompt: the rollback target.
	let checkpointLeafId: string | undefined;
	let pendingRollback: PendingRollback | undefined;

	pi.on("input", async (event, ctx) => {
		// Extension commands bypass the input event, so /fallback-rollback itself
		// never moves the checkpoint. Extension-injected messages are ignored too.
		if (event.source === "interactive") {
			checkpointLeafId = ctx.sessionManager.getLeafId() ?? undefined;
		}
		return { action: "continue" };
	});

	pi.on("model_select", async (event, ctx) => {
		if (event.source !== "fallback" || !event.previousModel || !ctx.hasUI) return;

		const prev = modelSpec(event.previousModel);
		const next = modelSpec(event.model);
		const CONTINUE = `Continue with ${next}`;
		const STOP = `Stop here (restore ${prev}, wait for the limit)`;
		const ROLLBACK = "Stop and roll back to the pre-prompt checkpoint";

		// This select BLOCKS the fallback retry: the session awaits model_select
		// handlers before continuing the run.
		const choice = await ctx.ui.select(`${prev} unavailable → fallback to ${next}`, [CONTINUE, STOP, ROLLBACK], {
			timeout: DECISION_TIMEOUT_MS,
		});
		if (!choice || choice === CONTINUE) return;

		// The retry continuation starts right after this handler returns; abort it
		// as soon as it exists. Two shots cover the startup race.
		const abortSoon = (delay: number) =>
			setTimeout(() => {
				try {
					ctx.abort();
				} catch {
					// session may already be idle/gone
				}
			}, delay);
		abortSoon(0);
		abortSoon(300);

		if (choice === ROLLBACK) {
			pendingRollback = { leafId: checkpointLeafId, model: event.previousModel };
			// Extension commands execute immediately even during streaming.
			pi.sendUserMessage("/fallback-rollback", { deliverAs: "followUp" });
			return;
		}

		// STOP: restore the primary model once the aborted run settles.
		const primary = event.previousModel;
		setTimeout(() => {
			void pi
				.setModel(primary)
				.then((ok) => {
					ctx.ui.notify(
						ok ? `Stopped; model restored to ${prev}. Retry when the limit resets.` : `Stopped, but could not restore ${prev}.`,
						"warning",
					);
				})
				.catch(() => ctx.ui.notify(`Stopped, but could not restore ${prev}.`, "warning"));
		}, 600);
	});

	pi.registerCommand("fallback-rollback", {
		description: "Roll back to the checkpoint captured before the last prompt (used by the fallback guard)",
		handler: async (_args, ctx) => {
			const rollback = pendingRollback;
			pendingRollback = undefined;
			if (!rollback) {
				ctx.ui.notify("No pending fallback rollback.", "warning");
				return;
			}
			await ctx.waitForIdle();

			let modelRestored = false;
			try {
				modelRestored = await pi.setModel(rollback.model);
			} catch {
				// auth may be missing; the rollback below still applies
			}
			const modelNote = modelRestored ? `model restored to ${modelSpec(rollback.model)}` : "model NOT restored";

			if (!rollback.leafId) {
				ctx.ui.notify(`No pre-prompt checkpoint captured; ${modelNote}. Aborted run kept in place.`, "warning");
				return;
			}
			await ctx.navigateTree(rollback.leafId, { summarize: false, label: "pre-fallback checkpoint" });
			ctx.ui.notify(`Rolled back to the pre-prompt checkpoint; ${modelNote}.`, "info");
		},
	});
}
