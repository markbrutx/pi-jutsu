/**
 * Shared registry of live worker runs (one-shot leaf subagent batches from worker_run).
 *
 * Workers cannot answer the lead — but the user still wants to see and inspect them.
 * runSwarm (index.ts) publishes each run here as it progresses; the unified clone
 * dashboard (shadowclones.ts) reads this registry so worker runs show up alongside
 * clones and can be drilled into. Finished runs linger briefly so results stay readable.
 */
import type { SwarmDetails } from "./index.ts";

export interface WorkerRunRecord {
	id: string;
	/** Who launched it: "lead" or a clone name. */
	origin: string;
	/** Short label (focus or task count). */
	title: string;
	startedAt: number;
	endedAt?: number;
	/** Bumped on every update so the dashboard's render cache can invalidate exactly. */
	version: number;
	details: SwarmDetails;
	/** Abort one leaf by index, or the whole run when the index is omitted. */
	cancel?: (agentIndex?: number) => void;
}

interface RegistryState {
	runs: Map<string, WorkerRunRecord>;
	listeners: Set<() => void>;
	counter: number;
}

// Extensions load in separate jiti module graphs (moduleCache: false), so plain
// module state would be duplicated per extension. Keep the registry on
// globalThis so every publisher (swarm, simplify, ...) and the dashboard share
// one instance per process.
const REGISTRY_KEY = Symbol.for("pi.swarm.worker-run-registry");

function state(): RegistryState {
	const holder = globalThis as { [REGISTRY_KEY]?: RegistryState };
	let current = holder[REGISTRY_KEY];
	if (!current) {
		current = { runs: new Map(), listeners: new Set(), counter: 0 };
		holder[REGISTRY_KEY] = current;
	}
	return current;
}

/** Finished runs stay visible this long so the user can read their results. */
const LINGER_MS = 5 * 60_000;

function notify(): void {
	for (const fn of [...state().listeners]) {
		try {
			fn();
		} catch {
			// One dashboard/widget listener must not break worker cancellation or settlement.
		}
	}
}

export function onWorkerRunsChange(fn: () => void): () => void {
	const { listeners } = state();
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

/** Oldest-first so the dashboard order is stable. */
export function listWorkerRuns(): WorkerRunRecord[] {
	return [...state().runs.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export function startWorkerRun(
	origin: string,
	title: string,
	details: SwarmDetails,
	cancel?: (agentIndex?: number) => void,
): string {
	const current = state();
	const id = `w${++current.counter}`;
	current.runs.set(id, { id, origin, title, startedAt: Date.now(), version: 0, details, cancel });
	notify();
	return id;
}

export function updateWorkerRun(id: string, details: SwarmDetails): void {
	const rec = state().runs.get(id);
	if (!rec) return;
	rec.details = details;
	rec.version++;
	notify();
}

export function finishWorkerRun(id: string, details: SwarmDetails): void {
	const rec = state().runs.get(id);
	if (!rec) return;
	rec.details = details;
	rec.version++;
	rec.endedAt = Date.now();
	delete rec.cancel;
	notify();
	const timer = setTimeout(() => {
		state().runs.delete(id);
		notify();
	}, LINGER_MS);
	timer.unref?.();
}

/**
 * Dashboard equivalent of dispelling a clone. Active work is cancelled but
 * remains visible until finishWorkerRun records its terminal snapshot. Settled
 * work is dismissed immediately.
 */
export function dispelWorkerRun(id: string, agentIndex?: number): void {
	const current = state();
	const rec = current.runs.get(id);
	if (!rec) return;
	const runActive = rec.details.phase === "preparing" || rec.details.phase === "executing";
	const agent = agentIndex === undefined ? undefined : rec.details.agents[agentIndex];
	const agentActive = agent?.status === "pending" || agent?.status === "running";
	if (runActive) {
		try {
			rec.cancel?.(agentActive ? agentIndex : undefined);
		} catch {
			// A faulty owner callback must not break the dashboard or registry lifecycle.
		}
		notify();
		return;
	}
	current.runs.delete(id);
	notify();
}

export function clearWorkerRuns(): void {
	const current = state();
	for (const run of current.runs.values()) {
		try {
			run.cancel?.();
		} catch {
			// Continue cancelling and clearing the remaining runs.
		}
	}
	current.runs.clear();
	notify();
}
