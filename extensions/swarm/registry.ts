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
}

const runs = new Map<string, WorkerRunRecord>();
const listeners = new Set<() => void>();
let counter = 0;

/** Finished runs stay visible this long so the user can read their results. */
const LINGER_MS = 5 * 60_000;

function notify(): void {
	for (const fn of [...listeners]) fn();
}

export function onWorkerRunsChange(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

/** Oldest-first so the dashboard order is stable. */
export function listWorkerRuns(): WorkerRunRecord[] {
	return [...runs.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export function startWorkerRun(origin: string, title: string, details: SwarmDetails): string {
	const id = `w${++counter}`;
	runs.set(id, { id, origin, title, startedAt: Date.now(), version: 0, details });
	notify();
	return id;
}

export function updateWorkerRun(id: string, details: SwarmDetails): void {
	const rec = runs.get(id);
	if (!rec) return;
	rec.details = details;
	rec.version++;
	notify();
}

export function finishWorkerRun(id: string, details: SwarmDetails): void {
	const rec = runs.get(id);
	if (!rec) return;
	rec.details = details;
	rec.version++;
	rec.endedAt = Date.now();
	notify();
	const timer = setTimeout(() => {
		runs.delete(id);
		notify();
	}, LINGER_MS);
	timer.unref?.();
}

export function clearWorkerRuns(): void {
	runs.clear();
	notify();
}
