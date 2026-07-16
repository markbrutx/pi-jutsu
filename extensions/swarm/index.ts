import {
	createAgentSession,
	defineTool,
	getAgentDir,
	getMarkdownTheme,
	getSettingsListTheme,
	formatSize,
	SessionManager,
	type AgentSession,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ResourceLoader,
	type Theme,
	type ToolRenderResultOptions,
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { isContextOverflow, StringEnum, type AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { registerShadowClones } from "./shadowclones.ts";
import {
	createLinkedAbortControllers,
	createSubagentLoader,
	createThrottledEmitter,
	formatDisplayItem,
	formatModelSpec,
	getEventUpdate,
	getModelTransition,
	readSwarmSettings,
	resolveAccountLabel,
	resolveSpawnModel,
	resolveSpawnThinkingLevel,
	SPAWN_THINKING_LEVELS,
	STOP_REASON_ABORTED,
	STOP_REASON_ERROR,
	type SwarmSettings,
	truncateSingleLine,
	type SwarmDisplayItem,
	writeSwarmSettings,
} from "./shared.ts";
import { finishWorkerRun, startWorkerRun, updateWorkerRun } from "./registry.ts";

export const SWARM_COMMAND_DESCRIPTION =
	"Decompose a request into independent subtasks and run them in parallel via subagents.";

export const SWARM_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;
const MAX_TASKS = 10;
export const DEFAULT_WORKER_RUN_TIMEOUT_SECONDS = 60 * 60;
const COLLAPSED_ITEM_COUNT = 3;
const PROGRESS_EMIT_THROTTLE_MS = 100;
const MAX_CONTEXT_RESTARTS = 1;
export const OVERFLOW_RECOVERY_TIMEOUT_MS = 5 * 60_000;
const ABORT_QUIESCE_GRACE_MS = 2_000;
const RECOVERY_HANDOFF_MAX_BYTES = 8 * 1024;
const RECOVERY_TASK_MAX_BYTES = 16 * 1024;
const RECOVERY_FOCUS_MAX_BYTES = 4 * 1024;
const SUMMARY_FOCUS_MAX_BYTES = 4 * 1024;
const WORKER_PARENT_PROMPT_MAX_BYTES = 50 * 1024;
const WORKER_REPORT_TOTAL_MAX_BYTES = 28 * 1024;
const WORKER_REPORT_PER_AGENT_MAX_BYTES = 16 * 1024;
const WORKER_REPORT_MIN_BYTES = 2 * 1024;
const WORKER_ITEMS_MAX = 100;

export const SUBAGENT_SYSTEM_PROMPT = `You are an isolated worker subagent (one-shot: you cannot report back or be steered).

Complete the assigned task end-to-end. You may read files, run shell commands, and edit or write code as needed.

Important:
- You run in parallel with sibling subagents. Stay strictly within your task scope.
- Assume siblings cannot see your changes and you cannot see theirs. Do not coordinate.
- Avoid touching files outside your task; if you must, keep changes minimal and disclose them in the report.
- Keep context lean: use targeted reads/searches instead of dumping whole large files. For long tasks, persist useful findings in the requested project file so a fresh context can resume safely.
- Final response: a concise report of what you did, the files you touched, and anything that needs verification. Do not paste raw pages, full datasets, or long command output. If you skipped or could not complete the task, state why.`;

const SwarmTaskSchema = Type.Object({
	title: Type.String({ description: "Short label for this subtask, shown in the UI." }),
	prompt: Type.String({
		description: "Self-contained instructions for this subagent. Must be completable without seeing other subtasks.",
	}),
});

const SwarmRunParamsSchema = Type.Object({
	tasks: Type.Array(SwarmTaskSchema, {
		minItems: 1,
		maxItems: MAX_TASKS,
		description: "Independent subtasks to run in parallel.",
	}),
	focus: Type.Optional(
		Type.String({ description: "Optional cross-cutting note appended to every subtask." }),
	),
	tools: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Restrict the leaf subagents to this subset of read/write/edit/bash/grep/find/ls. Default: all. Use a tight set (e.g. [read, write]) for focused, safe writers that cannot run shell commands.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				'Model for these workers: an exact "provider/model-id" from --list-models. Omit to inherit the caller\'s model.',
		}),
	),
	thinking: Type.Optional(
		StringEnum(SPAWN_THINKING_LEVELS, {
			description: "Thinking level for these workers. Omit for the default, medium.",
		}),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			minimum: 60,
			maximum: 7200,
			description: `Hard wall-clock limit for the entire worker run. Default ${DEFAULT_WORKER_RUN_TIMEOUT_SECONDS}s.`,
		}),
	),
});

type SwarmRunParams = Static<typeof SwarmRunParamsSchema>;
type SwarmTask = Static<typeof SwarmTaskSchema>;

export type SwarmStatus = "pending" | "running" | "done" | "failed";
export type SwarmPhase = "preparing" | "executing" | "done" | "failed";

export interface SwarmAgentProgress {
	index: number;
	title: string;
	/** "provider/model-id" this agent runs on when it differs per agent (e.g. a review council). */
	model?: string;
	/** /acc account profile for this agent's provider auth, when known. */
	account?: string;
	/** Effective thinking level after model-specific validation or fallback. */
	thinking?: ReturnType<ExtensionAPI["getThinkingLevel"]>;
	status: SwarmStatus;
	lastActivity: string;
	output: string;
	items: SwarmDisplayItem[];
	exitCode?: number;
	stopReason?: string;
	errorMessage?: string;
}

export interface SwarmDetails {
	phase: SwarmPhase;
	focus: string;
	agents: SwarmAgentProgress[];
	startedAt: number;
	updatedAt: number;
	/** "provider/model-id" selected for workers at run start; undefined = the caller's model. */
	model?: string;
	/** Effective thinking level selected for every worker in this run. */
	thinking?: ReturnType<ExtensionAPI["getThinkingLevel"]>;
	/** /acc account profile the run's provider auth resolved to at start, when known. */
	account?: string;
}

export interface SwarmAgentResult {
	index: number;
	title: string;
	exitCode: number;
	output: string;
	items: SwarmDisplayItem[];
	stopReason?: string;
	errorMessage?: string;
}

export interface SwarmRuntime {
	cwd: string;
	model: ExtensionContext["model"];
	modelRegistry: ExtensionContext["modelRegistry"];
	thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
}

interface RunSubagentOptions {
	runtime: SwarmRuntime;
	tools: string[];
	index: number;
	total: number;
	task: SwarmTask;
	focus: string;
	resourceLoader: ResourceLoader;
	signal: AbortSignal | undefined;
	onProgress: ProgressCallback;
}

type ProgressPatch = Partial<Omit<SwarmAgentProgress, "index" | "title">>;
type ProgressCallback = (patch: ProgressPatch) => void;

export function buildSwarmCommandPrompt(userRequest: string, preferCloneDelegation = false): string {
	const trimmed = userRequest.trim();
	const requestSection = trimmed
		? `\n\n## User Request\n\n${trimmed}`
		: "\n\n## User Request\n\nNo request was provided. Ask the user what to swarm on, then stop.";
	const delegationSection = preferCloneDelegation
		? `\n\nworker_run BLOCKS the calling agent for the entire run. Unless the user needs the results before anything else can happen, prefer summoning ONE shadow clone (shadowclone_summon) whose task is to run this exact worker_run fan-out and verify the results; the clone works in the background and reports back while you stay responsive.`
		: "";

	return `# Workers: Parallel Task Execution

Call the \`worker_run\` tool exactly once. Decompose the user request below into 1-${MAX_TASKS} independent parallel worker subtasks.${delegationSection}

Each subtask must be:
- self-contained: include all file paths, intent, and constraints needed to complete it without seeing the others;
- non-overlapping: do not touch the same files as another subtask;
- order-independent: it must not depend on outputs of sibling subtasks.

If the request cannot be cleanly parallelized, prefer a single task over forcing a split.

After the tool returns:
- read each subagent's report;
- verify briefly with reads or quick checks if anything looks off;
- if a subagent failed or skipped work, decide whether to fix it inline now;
- write one concise summary of what was accomplished overall.${requestSection}`;
}

export function buildSubagentTask(task: SwarmTask, focus: string, index: number, total: number): string {
	const focusSection = focus.trim() ? `\n\n## Cross-cutting Focus\n\n${focus.trim()}` : "";

	return `# Worker Task ${index + 1}/${total}: ${task.title}

${task.prompt.trim()}${focusSection}

## Reporting

When done, return a concise report containing:
- what you changed (file paths and what was modified);
- any key decisions or assumptions;
- anything the parent agent should verify.

If you cannot complete the task, return exactly what blocked you.`;
}

export function truncateWorkerReport(output: string, maxBytes: number): string {
	const normalized = output.trim() || "(no report returned)";
	const budget = Math.max(0, Math.floor(maxBytes));
	const totalBytes = Buffer.byteLength(normalized, "utf8");
	if (totalBytes <= budget) return normalized;
	if (budget === 0) return "";

	const marker = `[Worker report truncated from ${formatSize(totalBytes)} to fit the parent context. The full report is preserved in worker_run details.]`;
	const markerBytes = Buffer.byteLength(`\n\n${marker}\n\n`, "utf8");
	if (markerBytes >= budget) return truncateTail(marker, { maxBytes: budget, maxLines: 1 }).content;
	const contentBudget = budget - markerBytes;
	const headBudget = Math.max(1, Math.floor(contentBudget / 2));
	const tailBudget = Math.max(1, contentBudget - headBudget);
	const head = truncateHead(normalized, { maxBytes: headBudget, maxLines: 1000 }).content;
	const tail = truncateTail(normalized, { maxBytes: tailBudget, maxLines: 1000 }).content;
	return [head, marker, tail].filter(Boolean).join("\n\n");
}

export function buildSummaryPrompt(focus: string, results: readonly SwarmAgentResult[]): string {
	const rawFocus = focus.trim();
	const truncatedFocus = truncateHead(rawFocus, { maxBytes: SUMMARY_FOCUS_MAX_BYTES, maxLines: 100 });
	const focusText = truncatedFocus.truncated
		? `${truncatedFocus.content}\n\n[Focus truncated from ${formatSize(truncatedFocus.totalBytes)}.]`
		: truncatedFocus.content;
	const focusSection = focusText ? `\n\n## Cross-cutting Focus\n\n${focusText}` : "";
	const perAgentBudget = Math.min(
		WORKER_REPORT_PER_AGENT_MAX_BYTES,
		Math.max(WORKER_REPORT_MIN_BYTES, Math.floor(WORKER_REPORT_TOTAL_MAX_BYTES / Math.max(1, results.length))),
	);
	const reports = results.map((result) => formatAgentResult(result, perAgentBudget)).join("\n\n");

	const prompt = `# Workers: Subagent Reports

The worker run completed. ${results.length} worker subagent${results.length === 1 ? "" : "s"} ran in parallel. Their reports are below.${focusSection}

## Reports

${reports || "No reports were returned."}

## Final Step

- Read briefly to verify cross-task assumptions if anything is unclear.
- If a report indicates failure or skipped work, decide whether to fix it now or surface it to the user.
- Respond with one concise summary of what was accomplished overall, plus any follow-ups needed.`;
	const marker =
		"[Worker summary truncated to the 50KB tool-output limit. Full reports are preserved in worker_run details.]";
	const markerBytes = Buffer.byteLength(`\n\n${marker}`, "utf8");
	const truncated = truncateHead(prompt, {
		maxBytes: WORKER_PARENT_PROMPT_MAX_BYTES - markerBytes,
		maxLines: 1998,
	});
	return truncated.truncated ? `${truncated.content}\n\n${marker}` : prompt;
}

export function buildSubagentRecoveryTask(
	task: SwarmTask,
	focus: string,
	index: number,
	total: number,
	previousOutput: string,
	items: readonly SwarmDisplayItem[],
): string {
	const boundInput = (value: string, maxBytes: number, label: string): string => {
		const truncated = truncateHead(value.trim(), { maxBytes, maxLines: 500 });
		return truncated.truncated
			? `${truncated.content}\n\n[${label} truncated from ${formatSize(truncated.totalBytes)} for fresh-context recovery.]`
			: truncated.content;
	};
	const boundedTask = {
		title: truncateSingleLine(task.title, 200),
		prompt: boundInput(task.prompt, RECOVERY_TASK_MAX_BYTES, "Task"),
	};
	const boundedFocus = boundInput(focus, RECOVERY_FOCUS_MAX_BYTES, "Focus");
	const output = previousOutput.trim()
		? truncateWorkerReport(previousOutput, RECOVERY_HANDOFF_MAX_BYTES)
		: "(no usable partial report was produced)";
	const recentActivity = items
		.slice(-12)
		.map((item) => `- ${truncateSingleLine(formatDisplayItem(item), 300)}`)
		.join("\n");
	return `${buildSubagentTask(boundedTask, boundedFocus, index, total)}

## Fresh-context recovery

The previous isolated session exhausted its context window and could not recover in place. Continue this same task once in this fresh context.

- Inspect the current working tree and any files already created or modified before doing more work.
- Preserve successful work; do not blindly repeat writes or expensive research.
- Finish the original task and return the requested concise report.

### Partial report from the previous context

${output}

### Recent activity

${recentActivity || "(no recorded tool activity)"}`;
}

function isIncompleteContextOverflow(message: AssistantMessage, contextWindow: number): boolean {
	return message.stopReason !== "stop" && isContextOverflow(message, contextWindow);
}

export function createSwarmDetails(focus: string, tasks: readonly SwarmTask[]): SwarmDetails {
	const now = Date.now();
	return {
		phase: "preparing",
		focus: focus.trim(),
		agents: tasks.map((task, index) => ({
			index,
			title: task.title,
			status: "pending",
			lastActivity: "waiting",
			output: "",
			items: [],
		})),
		startedAt: now,
		updatedAt: now,
	};
}

export function summarizeSwarmDetails(details: SwarmDetails): string {
	const taskCount = details.agents.length;
	const lines = [`worker_run: ${details.phase} (${taskCount} task${taskCount === 1 ? "" : "s"})`];
	if (details.model) {
		lines.push(
			`start model: ${details.model}${details.thinking ? ` · thinking: ${details.thinking}` : ""}${details.account ? ` · acc: ${details.account}` : ""}`,
		);
	}
	if (details.focus) lines.push(`focus: ${truncateSingleLine(details.focus, 100)}`);
	for (const agent of details.agents) {
		const activity = agent.lastActivity ? ` - ${agent.lastActivity}` : "";
		lines.push(`[${formatStatus(agent.status)}] ${agent.index + 1}. ${agent.title}${activity}`);
	}
	return lines.join("\n");
}

export async function runSubagent(
	options: RunSubagentOptions,
	sessionFactory: typeof createAgentSession = createAgentSession,
	overflowRecoveryTimeoutMs: number = OVERFLOW_RECOVERY_TIMEOUT_MS,
): Promise<SwarmAgentResult> {
	const { runtime, tools, index, total, task, focus, resourceLoader, signal, onProgress } = options;
	let session: AgentSession | undefined;
	let lastAssistantText = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let activeModel = runtime.model;
	let contextRestarts = 0;
	let rejectActivePrompt: ((error: Error) => void) | undefined;
	const items: SwarmDisplayItem[] = [];

	const buildResult = (): SwarmAgentResult => {
		const succeeded = !signal?.aborted && stopReason === "stop" && !errorMessage;
		return {
			index,
			title: task.title,
			exitCode: succeeded ? 0 : 1,
			output: lastAssistantText,
			items,
			stopReason: signal?.aborted ? STOP_REASON_ABORTED : stopReason,
			errorMessage,
		};
	};

	const publish = (patch: ProgressPatch) => {
		onProgress({
			status: "running",
			output: lastAssistantText,
			stopReason,
			errorMessage,
			...patch,
		});
	};

	const abort = () => {
		stopReason = STOP_REASON_ABORTED;
		errorMessage = "Worker cancelled.";
		publish({ lastActivity: "aborting" });
		session?.abortCompaction();
		void session?.abort();
		rejectActivePrompt?.(new Error(errorMessage));
	};

	if (signal?.aborted) {
		stopReason = STOP_REASON_ABORTED;
		return buildResult();
	}

	signal?.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			if (signal?.aborted) {
				stopReason = STOP_REASON_ABORTED;
				return buildResult();
			}

			let unsubscribe: (() => void) | undefined;
			let lastAssistantMessage: AssistantMessage | undefined;
			let overflowRecoveryTimedOut = false;
			let overflowTimer: ReturnType<typeof setTimeout> | undefined;
			let rejectOverflowRecovery: (error: Error) => void = () => {};
			const overflowRecoveryFailure = new Promise<never>((_resolve, reject) => {
				rejectOverflowRecovery = reject;
			});
			const clearOverflowWatchdog = () => {
				if (!overflowTimer) return;
				clearTimeout(overflowTimer);
				overflowTimer = undefined;
			};
			const armOverflowWatchdog = () => {
				if (overflowTimer) return;
				overflowTimer = setTimeout(() => {
					overflowRecoveryTimedOut = true;
					stopReason = STOP_REASON_ERROR;
					errorMessage = `Context overflow recovery did not settle within ${Math.round(overflowRecoveryTimeoutMs / 1000)}s.`;
					publish({
						lastActivity:
							contextRestarts < MAX_CONTEXT_RESTARTS
								? "context recovery timed out; restarting fresh"
								: "context recovery timed out; failing worker",
						items,
					});
					rejectOverflowRecovery(new Error(errorMessage));
				}, overflowRecoveryTimeoutMs);
				overflowTimer.unref?.();
			};

			try {
				stopReason = undefined;
				errorMessage = undefined;
				publish({
					lastActivity: contextRestarts === 0 ? "starting" : "starting fresh context after overflow",
					items,
				});

				const creationCancellation = new Promise<never>((_resolve, reject) => {
					rejectActivePrompt = reject;
				});
				const created = await Promise.race([
					sessionFactory({
						cwd: runtime.cwd,
						agentDir: getAgentDir(),
						model: activeModel,
						modelRegistry: runtime.modelRegistry,
						thinkingLevel: runtime.thinkingLevel,
						tools,
						resourceLoader,
						sessionManager: SessionManager.inMemory(runtime.cwd),
					}),
					creationCancellation,
				]);
				rejectActivePrompt = undefined;
				session = created.session;
				publish({ thinking: session.thinkingLevel });
				if (signal?.aborted) {
					stopReason = STOP_REASON_ABORTED;
					return buildResult();
				}

				unsubscribe = session.subscribe((event) => {
					if (event.type === "thinking_level_changed") {
						publish({ thinking: event.level, lastActivity: `thinking level: ${event.level}` });
						return;
					}
					const transition = getModelTransition(event);
					if (transition) {
						activeModel = transition.model;
						publish({
							model: formatModelSpec(transition.model),
							account: resolveAccountLabel(runtime.modelRegistry.authStorage, transition.model.provider),
							lastActivity: transition.activity,
						});
						return;
					}
					if (event.type === "compaction_start" && event.reason === "overflow") {
						publish({ lastActivity: "compacting after context overflow", items });
						return;
					}
					if (event.type === "compaction_end" && event.reason === "overflow") {
						if (event.result && event.willRetry) {
							stopReason = undefined;
							errorMessage = undefined;
							publish({ lastActivity: "context compacted; retrying", items });
						} else {
							if (event.errorMessage) errorMessage = event.errorMessage;
							publish({
								lastActivity: event.aborted ? "context compaction aborted" : "context compaction failed",
								items,
							});
						}
						return;
					}
					if (event.type === "agent_settled") {
						clearOverflowWatchdog();
						return;
					}

					let overflow = false;
					if (event.type === "message_end" && event.message.role === "assistant") {
						lastAssistantMessage = event.message;
						overflow = isIncompleteContextOverflow(event.message, activeModel?.contextWindow ?? 0);
						if (overflow) armOverflowWatchdog();
						else if (event.message.stopReason !== STOP_REASON_ERROR) clearOverflowWatchdog();
					}

					const update = getEventUpdate(event, items);
					if (!update) return;
					if (update.output?.trim()) lastAssistantText = update.output;
					if ("stopReason" in update) stopReason = update.stopReason;
					if ("errorMessage" in update) errorMessage = update.errorMessage;
					if (items.length > WORKER_ITEMS_MAX) items.splice(0, items.length - WORKER_ITEMS_MAX);
					publish({
						lastActivity: overflow ? "context overflow detected; recovering" : (update.lastActivity ?? "working"),
						items,
					});
				});

				const prompt =
					contextRestarts === 0
						? buildSubagentTask(task, focus, index, total)
						: buildSubagentRecoveryTask(task, focus, index, total, lastAssistantText, items);
				const cancellationFailure = new Promise<never>((_resolve, reject) => {
					rejectActivePrompt = reject;
				});
				await Promise.race([
					session.prompt(prompt, { expandPromptTemplates: false, source: "extension" }),
					overflowRecoveryFailure,
					cancellationFailure,
				]);
				rejectActivePrompt = undefined;

				const overflow = lastAssistantMessage
					? isIncompleteContextOverflow(lastAssistantMessage, activeModel?.contextWindow ?? 0)
					: false;
				if (overflow && contextRestarts < MAX_CONTEXT_RESTARTS && !signal?.aborted) {
					contextRestarts++;
					stopReason = undefined;
					errorMessage = undefined;
					publish({ lastActivity: "context overflow persisted; restarting once in a fresh session", items });
					continue;
				}
				return buildResult();
			} catch (error) {
				const overflow =
					overflowRecoveryTimedOut ||
					(lastAssistantMessage
						? isIncompleteContextOverflow(lastAssistantMessage, activeModel?.contextWindow ?? 0)
						: false);
				if (overflow && contextRestarts < MAX_CONTEXT_RESTARTS && !signal?.aborted) {
					if (overflowRecoveryTimedOut && session) {
						session.abortCompaction();
						await new Promise<void>((resolve) => {
							const timer = setTimeout(resolve, ABORT_QUIESCE_GRACE_MS);
							timer.unref?.();
							void session?.abort().then(
								() => {
									clearTimeout(timer);
									resolve();
								},
								() => {
									clearTimeout(timer);
									resolve();
								},
							);
						});
					}
					contextRestarts++;
					stopReason = undefined;
					errorMessage = undefined;
					publish({ lastActivity: "context recovery failed; restarting once in a fresh session", items });
					continue;
				}
				errorMessage = error instanceof Error ? error.message : String(error);
				stopReason = signal?.aborted ? STOP_REASON_ABORTED : STOP_REASON_ERROR;
				return buildResult();
			} finally {
				clearOverflowWatchdog();
				rejectActivePrompt = undefined;
				unsubscribe?.();
				session?.dispose();
				session = undefined;
			}
		}
	} finally {
		signal?.removeEventListener("abort", abort);
	}
}

export async function runSwarm(
	params: SwarmRunParams,
	runtime: SwarmRuntime,
	signal: AbortSignal | undefined,
	onUpdate: ((update: { content: { type: "text"; text: string }[]; details: SwarmDetails }) => void) | undefined,
	origin: string = "lead",
): Promise<{ content: { type: "text"; text: string }[]; details: SwarmDetails }> {
	const focus = params.focus?.trim() ?? "";
	const tasks = params.tasks;
	const details = createSwarmDetails(focus, tasks);
	// Pin model, thinking, and account at run start so every surface (tool result,
	// registry, dashboard) can attribute the workers to their actual configuration.
	details.model = formatModelSpec(runtime.model);
	details.thinking = runtime.thinkingLevel;
	details.account = runtime.model
		? resolveAccountLabel(runtime.modelRegistry.authStorage, runtime.model.provider)
		: undefined;
	// Publish to the shared registry so the unified clone dashboard can show and drill into this run.
	const title = focus || tasks[0]?.title || `${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
	const aborts = createLinkedAbortControllers(tasks.length, signal);
	const timeoutSeconds = params.timeoutSeconds ?? DEFAULT_WORKER_RUN_TIMEOUT_SECONDS;
	const timedOutAgents = new Set<number>();
	let rejectStartupTimeout: ((error: Error) => void) | undefined;
	let runId = "";
	const emitNow = () => {
		const snapshot = structuredClone(details);
		onUpdate?.({
			content: [{ type: "text", text: summarizeSwarmDetails(details) }],
			details: snapshot,
		});
		updateWorkerRun(runId, snapshot);
	};
	const emitter = createThrottledEmitter(emitNow, PROGRESS_EMIT_THROTTLE_MS);
	const cancel = (agentIndex?: number) => {
		const indices = agentIndex === undefined ? details.agents.map((agent) => agent.index) : [agentIndex];
		for (const index of indices) {
			const agent = details.agents[index];
			if (agent?.status === "pending" || agent?.status === "running") {
				updateAgent(details, index, { lastActivity: "aborting" });
			}
		}
		aborts.abort(agentIndex);
		emitter.flush();
	};
	runId = startWorkerRun(origin, title, structuredClone(details), cancel);
	const runTimeout = setTimeout(() => {
		for (const agent of details.agents) {
			if (agent.status !== "pending" && agent.status !== "running") continue;
			timedOutAgents.add(agent.index);
			updateAgent(details, agent.index, { lastActivity: `timed out after ${timeoutSeconds}s; aborting` });
		}
		aborts.abort();
		emitter.flush();
		rejectStartupTimeout?.(new Error(`Worker run timed out after ${timeoutSeconds}s during startup.`));
	}, timeoutSeconds * 1000);
	runTimeout.unref?.();

	try {
		details.phase = "executing";
		details.updatedAt = Date.now();
		emitter.flush();

		const startupTimeout = new Promise<never>((_resolve, reject) => {
			rejectStartupTimeout = reject;
		});
		const abortStartup = () => rejectStartupTimeout?.(new Error("Worker run aborted during startup."));
		if (signal?.aborted) abortStartup();
		else signal?.addEventListener("abort", abortStartup, { once: true });
		let resourceLoader: ResourceLoader;
		try {
			resourceLoader = await Promise.race([
				createSubagentLoader(runtime.cwd, SUBAGENT_SYSTEM_PROMPT),
				startupTimeout,
			]);
		} finally {
			signal?.removeEventListener("abort", abortStartup);
			rejectStartupTimeout = undefined;
		}
		if (signal?.aborted) {
			for (const agent of details.agents) {
				updateAgent(details, agent.index, {
					status: "failed",
					lastActivity: "aborted before start",
					exitCode: 1,
					stopReason: STOP_REASON_ABORTED,
					errorMessage: "Worker run aborted before subagents started.",
				});
			}
			details.phase = "failed";
			details.updatedAt = Date.now();
			emitter.flush();
			return {
				content: [{ type: "text", text: "Worker run aborted before subagents started." }],
				details: structuredClone(details),
			};
		}

		const allowed = new Set<string>(SWARM_TOOL_NAMES);
		const requested = (params.tools ?? []).filter((t) => allowed.has(t));
		const toolNames = requested.length > 0 ? requested : [...SWARM_TOOL_NAMES];
		const results = await Promise.all(
			tasks.map(async (task, index) => {
				updateAgent(details, index, { status: "running", lastActivity: "starting", output: "" });
				emitter.schedule();
				let result: SwarmAgentResult;
				try {
					result = await runSubagent({
						runtime,
						tools: toolNames,
						index,
						total: tasks.length,
						task,
						focus,
						resourceLoader,
						signal: aborts.signals[index],
						onProgress: (patch) => {
							updateAgent(details, index, patch);
							emitter.schedule();
						},
					});
				} catch (error) {
					result = {
						index,
						title: task.title,
						exitCode: 1,
						output: "",
						items: [],
						stopReason: STOP_REASON_ERROR,
						errorMessage: error instanceof Error ? error.message : String(error),
					};
				}
				if (timedOutAgents.has(index)) {
					result = {
						...result,
						exitCode: 1,
						stopReason: STOP_REASON_ERROR,
						errorMessage: `Worker timed out after ${timeoutSeconds}s. Partial output was preserved.`,
					};
				}
				const failed = isFailedResult(result);
				updateAgent(details, index, {
					status: failed ? "failed" : "done",
					lastActivity: failed ? "failed" : "completed",
					output: result.output,
					items: result.items,
					exitCode: result.exitCode,
					stopReason: result.stopReason,
					errorMessage: result.errorMessage,
				});
				emitter.schedule();
				return result;
			}),
		);

		details.phase = results.some(isFailedResult) ? "failed" : "done";
		details.updatedAt = Date.now();
		emitter.flush();

		return {
			content: [{ type: "text", text: buildSummaryPrompt(focus, results) }],
			details: structuredClone(details),
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const aborted = signal?.aborted === true;
		for (const agent of details.agents) {
			if (agent.status === "pending" || agent.status === "running") {
				updateAgent(details, agent.index, {
					status: "failed",
					lastActivity: aborted ? "aborted during startup" : "worker infrastructure failed",
					stopReason: aborted ? STOP_REASON_ABORTED : STOP_REASON_ERROR,
					errorMessage,
				});
			}
		}
		details.phase = "failed";
		details.updatedAt = Date.now();
		emitter.flush();
		const results = details.agents.map<SwarmAgentResult>((agent) => ({
			index: agent.index,
			title: agent.title,
			exitCode: agent.exitCode ?? 1,
			output: agent.output,
			items: agent.items,
			stopReason: agent.stopReason,
			errorMessage: agent.errorMessage,
		}));
		return {
			content: [{ type: "text", text: buildSummaryPrompt(focus, results) }],
			details: structuredClone(details),
		};
	} finally {
		rejectStartupTimeout = undefined;
		clearTimeout(runTimeout);
		aborts.dispose();
		// Always settle the registry run, or the dashboard would show it as live forever.
		finishWorkerRun(runId, structuredClone(details));
	}
}

function swarmRenderCall(args: SwarmRunParams, theme: Theme) {
	const tasks = args.tasks ?? [];
	const titles = tasks
		.slice(0, 3)
		.map((task) => task?.title ?? "task")
		.join(", ");
	const remaining = tasks.length > 3 ? ` +${tasks.length - 3}` : "";
	const detail = tasks.length
		? theme.fg("dim", ` ${tasks.length} task${tasks.length === 1 ? "" : "s"}: ${truncateSingleLine(titles, 80)}${remaining}`)
		: "";
	const model = args.model?.trim() ? theme.fg("dim", ` → ${args.model.trim()}`) : "";
	const thinking = args.thinking ? theme.fg("dim", ` · thinking ${args.thinking}`) : "";
	return new Text(theme.fg("toolTitle", theme.bold("worker_run")) + model + thinking + detail, 0, 0);
}

/** Initial "model · acc" attribution line for a worker run, when known. */
function workerAttribution(details: SwarmDetails, theme: Theme): string | undefined {
	if (!details.model) return undefined;
	return (
		theme.fg("muted", "start model: ") +
		theme.fg("text", details.model) +
		(details.thinking ? theme.fg("muted", ` · thinking: ${details.thinking}`) : "") +
		(details.account ? theme.fg("muted", " · acc: ") + theme.fg("accent", details.account) : "")
	);
}

function swarmRenderResult(result: AgentToolResult<SwarmDetails>, opts: ToolRenderResultOptions, theme: Theme) {
	const details = result.details;
	if (!details) {
		const text = result.content.find((part) => part.type === "text")?.text ?? "";
		return new Text(text, 0, 0);
	}
	const taskCount = details.agents.length;
	const phaseColor = details.phase === "failed" ? "error" : details.phase === "done" ? "success" : "warning";
	const header = `${theme.fg("toolTitle", theme.bold("worker_run"))} ${theme.fg(phaseColor, `${details.phase} (${taskCount} task${taskCount === 1 ? "" : "s"})`)}`;
	const attribution = workerAttribution(details, theme);
	if (!opts.expanded) {
		let text = header;
		if (attribution) text += `\n${attribution}`;
		if (details.focus) text += `\n${theme.fg("muted", `focus: ${truncateSingleLine(details.focus, 100)}`)}`;
		for (const agent of details.agents) {
			const activity = agent.lastActivity ? ` ${theme.fg("dim", truncateSingleLine(agent.lastActivity, 100))}` : "";
			text += `\n${renderStatus(agent.status, theme)} ${theme.fg("accent", `${agent.index + 1}. ${agent.title}`)}${activity}`;
			for (const item of agent.items.slice(-COLLAPSED_ITEM_COUNT)) {
				text += `\n  ${theme.fg("muted", formatDisplayItem(item))}`;
			}
		}
		text += `\n${theme.fg("muted", "expand tool output for full subagent reports")}`;
		return new Text(text, 0, 0);
	}
	const container = new Container();
	container.addChild(new Text(header, 0, 0));
	if (attribution) container.addChild(new Text(attribution, 0, 0));
	if (details.focus) container.addChild(new Text(theme.fg("muted", `focus: ${details.focus}`), 0, 0));
	const markdownTheme = getMarkdownTheme();
	for (const agent of details.agents) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(`${renderStatus(agent.status, theme)} ${theme.fg("accent", theme.bold(`${agent.index + 1}. ${agent.title}`))}`, 0, 0));
		if (agent.lastActivity) container.addChild(new Text(theme.fg("dim", agent.lastActivity), 0, 0));
		for (const item of agent.items) {
			container.addChild(new Text(theme.fg("muted", `- ${formatDisplayItem(item)}`), 0, 0));
		}
		if (agent.output.trim()) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(agent.output.trim(), 0, 0, markdownTheme));
		}
	}
	return container;
}

export function createSwarmTool(getRuntime: () => SwarmRuntime, getOrigin?: () => string) {
	return defineTool<typeof SwarmRunParamsSchema, SwarmDetails>({
		name: "worker_run",
		label: "Worker Run",
		description:
			"Run 1-10 independent subtasks in parallel as isolated one-shot worker subagents. Each has its own fresh session and full coding tools but CANNOT report back, be steered, or itself spawn workers/clones. This call BLOCKS your turn until every worker finishes. Context overflow recovery is bounded: compact/retry, then one fresh-session restart; a failed leaf returns diagnostics instead of blocking forever. The whole run has a 60-minute default hard timeout (configurable up to 2 hours). Active workers can be cancelled from the agents dashboard.",
		parameters: SwarmRunParamsSchema,
		async execute(_toolCallId, params: SwarmRunParams, signal, onUpdate) {
			const runtime = getRuntime();
			const requested = resolveSpawnModel(runtime.modelRegistry, params.model);
			const model = requested ?? runtime.model;
			const thinkingLevel = resolveSpawnThinkingLevel(model, params.thinking);
			return runSwarm(
				params,
				{ ...runtime, model, thinkingLevel },
				signal,
				onUpdate,
				getOrigin?.() ?? "clone",
			);
		},
		renderCall: swarmRenderCall,
		renderResult: swarmRenderResult,
	});
}

function formatAgentResult(result: SwarmAgentResult, outputBudget: number): string {
	const diagnostics: string[] = [];
	if (result.exitCode !== 0) diagnostics.push(`Subagent exited with code ${result.exitCode}.`);
	if (result.stopReason) diagnostics.push(`Stop reason: ${truncateSingleLine(result.stopReason, 200)}.`);
	if (result.errorMessage) diagnostics.push(`Error: ${truncateSingleLine(result.errorMessage, 1000)}`);
	const diagnosticsText = diagnostics.length > 0 ? `${diagnostics.join("\n\n")}\n\n` : "";
	const output = truncateWorkerReport(result.output, outputBudget);
	return `### ${result.index + 1}. ${truncateSingleLine(result.title, 200)}\n\n${diagnosticsText}${output}`;
}

function updateAgent(details: SwarmDetails, index: number, patch: ProgressPatch): void {
	const agent = details.agents[index];
	if (!agent) return;
	Object.assign(agent, patch);
	details.updatedAt = Date.now();
}

function queueInstructionMessage(pi: ExtensionAPI, ctx: ExtensionCommandContext, prompt: string): void {
	pi.sendMessage(
		{
			customType: "worker-command",
			content: prompt,
			display: false,
		},
		{ triggerTurn: true, deliverAs: ctx.isIdle() ? "steer" : "followUp" },
	);
}

function formatStatus(status: SwarmStatus): string {
	switch (status) {
		case "pending":
			return "WAIT";
		case "running":
			return "RUN";
		case "done":
			return "OK";
		case "failed":
			return "ERR";
	}
}

function renderStatus(status: SwarmStatus, theme: Theme): string {
	const label = formatStatus(status);
	if (status === "done") return theme.fg("success", label);
	if (status === "failed") return theme.fg("error", label);
	if (status === "running") return theme.fg("warning", label);
	return theme.fg("muted", label);
}

function isFailedResult(result: SwarmAgentResult): boolean {
	return result.exitCode !== 0 || result.stopReason !== "stop" || !!result.errorMessage;
}

function registerSwarmSettingsCommand(pi: ExtensionAPI): void {
	const describe = (label: string, on: boolean) => `${label}: ${on ? "on" : "off"}`;
	pi.registerCommand("agents-settings", {
		description: "Toggle shadow-clone and worker features (applies on the next session).",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/swarm-settings requires TUI mode", "error");
				return;
			}
			const settings = readSwarmSettings();
			const toOnOff = (value: boolean) => (value ? "on" : "off");
			await ctx.ui.custom((tui, theme, _kb, done) => {
				const items: SettingItem[] = [
					{
						id: "clones",
						label: "Shadow clones",
						description: "Lead can summon persistent clone subagents that report back and can be steered (shadowclone_* tools).",
						currentValue: toOnOff(settings.clones),
						values: ["off", "on"],
					},
					{
						id: "workers",
						label: "Workers",
						description: "Lead can fan work out to one-shot parallel worker subagents (worker_run tool, /workers).",
						currentValue: toOnOff(settings.workers),
						values: ["off", "on"],
					},
					{
						id: "cloneWorkers",
						label: "Clones can run workers",
						description: "Clones may call worker_run too (deepest, costliest tier). Needs Shadow clones on.",
						currentValue: toOnOff(settings.cloneWorkers),
						values: ["off", "on"],
					},
				];
				const container = new Container();
				container.addChild(new Text(theme.fg("accent", theme.bold("Agent settings (clones & workers)")), 0, 0));
				container.addChild(new Text(theme.fg("muted", "All off by default. Changes apply on the next session."), 0, 0));
				const list = new SettingsList(
					items,
					items.length + 2,
					getSettingsListTheme(),
					(id, value) => {
						const on = value === "on";
						if (id === "workers") settings.workers = on;
						else if (id === "clones") settings.clones = on;
						else if (id === "cloneWorkers") settings.cloneWorkers = on;
						writeSwarmSettings(settings);
						ctx.ui.setStatus("swarm-settings", describe(id, on));
						tui.requestRender();
					},
					() => done(undefined),
				);
				container.addChild(list);
				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						list.handleInput?.(data);
						tui.requestRender();
					},
				};
			});
			ctx.ui.setStatus("swarm-settings", undefined);
		},
	});
}

export default function swarmExtension(pi: ExtensionAPI) {
	// The settings menu is always available so the user can opt in; everything else
	// is gated by the persisted flags (all off by default). Disabled tools and
	// commands are never registered, so the model cannot reach them at all.
	registerSwarmSettingsCommand(pi);

	const settings: SwarmSettings = readSwarmSettings();
	if (settings.clones) registerShadowClones(pi);
	if (!settings.workers) return;

	pi.registerTool<typeof SwarmRunParamsSchema, SwarmDetails>({
		name: "worker_run",
		label: "Worker Run",
		description: `Run 1-10 independent subtasks in parallel as isolated one-shot worker subagents. Each has its own session and full coding tools and returns a final report; workers cannot be steered or answer mid-run${settings.clones ? " (watch, inspect, or cancel them in the agents dashboard / \u2325K)" : ""}. This call BLOCKS your turn until every worker finishes. Context overflow recovery is bounded: compact/retry, then one fresh-session restart; a failed leaf returns diagnostics instead of blocking forever. The whole run has a 60-minute default hard timeout (configurable up to 2 hours).`,
		promptSnippet:
			"Spawn parallel one-shot worker subagents for independent subtasks; each returns a concise final report. Blocks your turn until all workers finish.",
		promptGuidelines: [
			settings.clones
				? "Use worker_run when the user invokes /workers or asks to fan out work across parallel agents. For work you may need to steer or that must report back, summon shadow clones instead."
				: "Use worker_run when the user invokes /workers or asks to fan out work across parallel agents.",
			...(settings.clones && settings.cloneWorkers
				? [
						"worker_run BLOCKS your whole turn until every worker finishes. Prefer summoning ONE shadow clone whose task is to run the worker_run fan-out and verify the results — the clone works in the background while you stay responsive. Call worker_run directly only when you cannot continue without the results.",
					]
				: []),
			"Each task in worker_run must be self-contained, independent of siblings, and not touch the same files as another task.",
			'Model and thinking are yours to choose per run: pass an exact "provider/model-id" from --list-models and a thinking level when you judge the tasks need them. Omitted model inherits yours; omitted thinking defaults to medium.',
		],
		parameters: SwarmRunParamsSchema,
		async execute(_toolCallId, params: SwarmRunParams, signal, onUpdate, ctx) {
			const requested = resolveSpawnModel(ctx.modelRegistry, params.model);
			const model = requested ?? ctx.model;
			return runSwarm(
				params,
				{
					cwd: ctx.cwd,
					model,
					modelRegistry: ctx.modelRegistry,
					thinkingLevel: resolveSpawnThinkingLevel(model, params.thinking),
				},
				signal,
				onUpdate,
				"lead",
			);
		},
		renderCall: swarmRenderCall,
		renderResult: swarmRenderResult,
	});

	pi.registerCommand("workers", {
		description: SWARM_COMMAND_DESCRIPTION,
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) await ctx.waitForIdle();
			queueInstructionMessage(pi, ctx, buildSwarmCommandPrompt(args, settings.clones && settings.cloneWorkers));
		},
	});
}
