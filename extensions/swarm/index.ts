import {
	createAgentSession,
	defineTool,
	getAgentDir,
	getMarkdownTheme,
	getSettingsListTheme,
	SessionManager,
	type AgentSession,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ResourceLoader,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { registerShadowClones } from "./shadowclones.ts";
import {
	createSubagentLoader,
	createThrottledEmitter,
	formatDisplayItem,
	getEventUpdate,
	readSwarmSettings,
	resolveSpawnModel,
	resolveTierModel,
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
const COLLAPSED_ITEM_COUNT = 3;
const PROGRESS_EMIT_THROTTLE_MS = 100;

export const SUBAGENT_SYSTEM_PROMPT = `You are an isolated worker subagent (one-shot: you cannot report back or be steered).

Complete the assigned task end-to-end. You may read files, run shell commands, and edit or write code as needed.

Important:
- You run in parallel with sibling subagents. Stay strictly within your task scope.
- Assume siblings cannot see your changes and you cannot see theirs. Do not coordinate.
- Avoid touching files outside your task; if you must, keep changes minimal and disclose them in the report.
- Final response: a concise report of what you did, the files you touched, and anything that needs verification. If you skipped or could not complete the task, state why.`;

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
				'Model for these workers: "provider/model-id" or tier alias "architect"/"executor". Omit for the default; unknown or unauthenticated specs silently fall back to it.',
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

export function buildSwarmCommandPrompt(userRequest: string): string {
	const trimmed = userRequest.trim();
	const requestSection = trimmed
		? `\n\n## User Request\n\n${trimmed}`
		: "\n\n## User Request\n\nNo request was provided. Ask the user what to swarm on, then stop.";

	return `# Workers: Parallel Task Execution

Call the \`worker_run\` tool exactly once. Decompose the user request below into 1-${MAX_TASKS} independent parallel worker subtasks.

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

export function buildSummaryPrompt(focus: string, results: readonly SwarmAgentResult[]): string {
	const focusSection = focus.trim() ? `\n\n## Cross-cutting Focus\n\n${focus.trim()}` : "";
	const reports = results.map(formatAgentResult).join("\n\n");

	return `# Workers: Subagent Reports

The worker run completed. ${results.length} worker subagent${results.length === 1 ? "" : "s"} ran in parallel. Their reports are below.${focusSection}

## Reports

${reports || "No reports were returned."}

## Final Step

- Read briefly to verify cross-task assumptions if anything is unclear.
- If a report indicates failure or skipped work, decide whether to fix it now or surface it to the user.
- Respond with one concise summary of what was accomplished overall, plus any follow-ups needed.`;
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
	if (details.focus) lines.push(`focus: ${truncateSingleLine(details.focus, 100)}`);
	for (const agent of details.agents) {
		const activity = agent.lastActivity ? ` - ${agent.lastActivity}` : "";
		lines.push(`[${formatStatus(agent.status)}] ${agent.index + 1}. ${agent.title}${activity}`);
	}
	return lines.join("\n");
}

async function runSubagent(options: RunSubagentOptions): Promise<SwarmAgentResult> {
	const { runtime, tools, index, total, task, focus, resourceLoader, signal, onProgress } = options;
	let session: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	let lastAssistantText = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	const items: SwarmDisplayItem[] = [];

	const buildResult = (): SwarmAgentResult => {
		const failed = signal?.aborted || stopReason === STOP_REASON_ERROR || stopReason === STOP_REASON_ABORTED;
		return {
			index,
			title: task.title,
			exitCode: failed ? 1 : 0,
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
		publish({ lastActivity: "aborting" });
		void session?.abort();
	};

	if (signal?.aborted) {
		stopReason = STOP_REASON_ABORTED;
		return buildResult();
	}

	try {
		signal?.addEventListener("abort", abort, { once: true });
		publish({ lastActivity: "starting" });

		const created = await createAgentSession({
			cwd: runtime.cwd,
			agentDir: getAgentDir(),
			model: runtime.model,
			modelRegistry: runtime.modelRegistry,
			thinkingLevel: runtime.thinkingLevel,
			tools,
			resourceLoader,
			sessionManager: SessionManager.inMemory(runtime.cwd),
		});
		session = created.session;
		if (signal?.aborted) {
			stopReason = STOP_REASON_ABORTED;
			return buildResult();
		}

		unsubscribe = session.subscribe((event) => {
			const update = getEventUpdate(event, items);
			if (!update) return;
			if (update.output !== undefined) lastAssistantText = update.output;
			if (update.stopReason !== undefined) stopReason = update.stopReason;
			if (update.errorMessage !== undefined) errorMessage = update.errorMessage;
			publish({ lastActivity: update.lastActivity ?? "working", items });
		});

		await session.prompt(buildSubagentTask(task, focus, index, total), {
			expandPromptTemplates: false,
			source: "extension",
		});
		return buildResult();
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error);
		if (!stopReason) stopReason = STOP_REASON_ERROR;
		return buildResult();
	} finally {
		signal?.removeEventListener("abort", abort);
		unsubscribe?.();
		session?.dispose();
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
	// Publish to the shared registry so the unified clone dashboard can show and drill into this run.
	const title = focus || tasks[0]?.title || `${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
	const runId = startWorkerRun(origin, title, structuredClone(details));
	const emitNow = () => {
		const snapshot = structuredClone(details);
		onUpdate?.({
			content: [{ type: "text", text: summarizeSwarmDetails(details) }],
			details: snapshot,
		});
		updateWorkerRun(runId, snapshot);
	};
	const emitter = createThrottledEmitter(emitNow, PROGRESS_EMIT_THROTTLE_MS);

	details.phase = "executing";
	details.updatedAt = Date.now();
	emitter.flush();

	const resourceLoader = await createSubagentLoader(runtime.cwd, SUBAGENT_SYSTEM_PROMPT);
	if (signal?.aborted) {
		details.phase = "failed";
		details.updatedAt = Date.now();
		emitter.flush();
		finishWorkerRun(runId, structuredClone(details));
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
			const result = await runSubagent({
				runtime,
				tools: toolNames,
				index,
				total: tasks.length,
				task,
				focus,
				resourceLoader,
				signal,
				onProgress: (patch) => {
					updateAgent(details, index, patch);
					emitter.schedule();
				},
			});
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
	finishWorkerRun(runId, structuredClone(details));

	return {
		content: [{ type: "text", text: buildSummaryPrompt(focus, results) }],
		details: structuredClone(details),
	};
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
	return new Text(theme.fg("toolTitle", theme.bold("worker_run")) + detail, 0, 0);
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
	if (!opts.expanded) {
		let text = header;
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
			"Run 1-10 independent subtasks in parallel as isolated one-shot worker subagents. Each has its own fresh session and full coding tools but CANNOT report back, be steered, or itself spawn workers/clones. Use to fan out independent work (e.g. one locale per task) so each runs in a clean context.",
		parameters: SwarmRunParamsSchema,
		async execute(_toolCallId, params: SwarmRunParams, signal, onUpdate) {
			const runtime = getRuntime();
			// The caller may route this run to a specific model (or tier alias); the
			// runtime model stays the default when the request is absent or unresolvable.
			const requested = resolveSpawnModel(runtime.modelRegistry, params.model, readSwarmSettings());
			return runSwarm(
				params,
				requested ? { ...runtime, model: requested } : runtime,
				signal,
				onUpdate,
				getOrigin?.() ?? "clone",
			);
		},
		renderCall: swarmRenderCall,
		renderResult: swarmRenderResult,
	});
}

function formatAgentResult(result: SwarmAgentResult): string {
	const diagnostics: string[] = [];
	if (result.exitCode !== 0) diagnostics.push(`Subagent exited with code ${result.exitCode}.`);
	if (result.stopReason) diagnostics.push(`Stop reason: ${result.stopReason}.`);
	if (result.errorMessage) diagnostics.push(`Error: ${result.errorMessage}`);
	const diagnosticsText = diagnostics.length > 0 ? `${diagnostics.join("\n\n")}\n\n` : "";
	const output = result.output.trim() || "(no report returned)";
	return `### ${result.index + 1}. ${result.title}\n\n${diagnosticsText}${output}`;
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
	return (
		result.exitCode !== 0 || result.stopReason === STOP_REASON_ERROR || result.stopReason === STOP_REASON_ABORTED
	);
}

function registerSwarmSettingsCommand(pi: ExtensionAPI): void {
	const describe = (label: string, on: boolean) => `${label}: ${on ? "on" : "off"}`;
	pi.registerCommand("agents-settings", {
		description: "Toggle shadow-clone and worker features (applies on the next session).",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/agents-settings requires TUI mode", "error");
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
					{
						id: "modelTiers",
						label: "Model tiers",
						description: `Clones think on ${settings.cloneModel || "the session's model"} (architect), workers execute on ${settings.workerModel || "the session's model"} (executor). Set "provider/model-id" specs in swarm-settings.json; unknown or unauthenticated specs fall back to the session's model.`,
						currentValue: toOnOff(settings.modelTiers),
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
						else if (id === "modelTiers") settings.modelTiers = on;
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
		description:
			"Run 1-10 independent subtasks in parallel as isolated one-shot worker subagents. Each has its own session and full coding tools and returns a final report; workers cannot be steered or answer mid-run (watch and inspect them in the clone dashboard / \u2325K).",
		promptSnippet:
			"Spawn parallel one-shot worker subagents for independent subtasks; each returns a concise final report.",
		promptGuidelines: [
			"Use worker_run when the user invokes /workers or asks to fan out work across parallel agents. For work you may need to steer or that must report back, summon shadow clones instead.",
			"Each task in worker_run must be self-contained, independent of siblings, and not touch the same files as another task.",
			...(settings.modelTiers && settings.workerModel
				? [
						`Workers run on a cheaper executor model (${settings.workerModel}). It follows well-framed instructions faithfully but does not architect: give each task explicit file paths, tight scope, and concrete acceptance criteria.`,
					]
				: []),
			'You may route any worker_run to a different model with model: "provider/model-id" or the aliases "architect" (thinking-heavy) and "executor" (cheap, obedient). Pick per job: e.g. executor for mechanical bulk edits, architect for tasks needing judgment.',
		],
		parameters: SwarmRunParamsSchema,
		async execute(_toolCallId, params: SwarmRunParams, signal, onUpdate, ctx) {
			const requested = resolveSpawnModel(ctx.modelRegistry, params.model, settings);
			const workerModel =
				requested ?? (settings.modelTiers ? resolveTierModel(ctx.modelRegistry, settings.workerModel) : undefined);
			return runSwarm(
				params,
				{
					cwd: ctx.cwd,
					model: workerModel ?? ctx.model,
					modelRegistry: ctx.modelRegistry,
					thinkingLevel: pi.getThinkingLevel(),
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
			queueInstructionMessage(pi, ctx, buildSwarmCommandPrompt(args));
		},
	});
}
