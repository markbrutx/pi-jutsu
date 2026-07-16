/**
 * /btw — side question, fullscreen (alt-screen) UI with a model picker.
 *
 * Ask a quick question about the current session without polluting it.
 * Flow: /btw <question> → fullscreen model picker → answer from the chosen
 * model, streamed. Follow-ups continue the side thread with full context.
 * Nothing is stored in the main session.
 *
 * The overlay owns the terminal's alternate buffer (same as the agents
 * dashboard), so the chat behind never repaints or jumps.
 *
 * Completed answers are appended to ~/.pi/agent/btw-history.jsonl;
 * /btw-history browses them in the same fullscreen UI.
 *
 * Keys:
 *   picker:   ↑/↓ + Enter, or 1-4     choose model and ask
 *   answer:   ⏎/f follow-up · y copy · r re-ask · ↑/↓, PgUp/PgDn scroll
 *   Esc                               close (aborts the request)
 */

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import * as path from "node:path";
import {
	stream,
	type Api,
	type AssistantMessage,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	getAgentDir,
	getMarkdownTheme,
	serializeConversation,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Markdown, matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { SPINNER_FRAMES } from "../lib/picker-util.ts";

// ──────────────────────────────────────────────
// Models offered in the picker
// ──────────────────────────────────────────────

interface BtwModelSpec {
	label: string;
	provider: string;
	id: string;
}

const BTW_MODELS: BtwModelSpec[] = [
	{ label: "fable-5", provider: "anthropic", id: "claude-fable-5" },
	{ label: "opus-4-8", provider: "anthropic", id: "claude-opus-4-8" },
	{ label: "sol", provider: "openai-codex", id: "gpt-5.6-sol" },
	{ label: "terra", provider: "openai-codex", id: "gpt-5.6-terra" },
];

// Picker highlight default: remembered across /btw invocations within this process.
let lastModelIndex = 0;

const SYSTEM_PROMPT = [
	"You are answering a quick side question about an ongoing coding session.",
	"The full conversation so far is provided as context. Answer ONLY the side question.",
	"Be direct and concise. Use markdown when it helps (code blocks, lists).",
	"Do not suggest edits or next steps unless asked.",
].join(" ");

/** Upper bound on serialized conversation context sent to the side model. */
const MAX_CONTEXT_CHARS = 150_000;
/** Trailing throttle for stream-delta repaints: bounds markdown reparses during streaming. */
const STREAM_RENDER_THROTTLE_MS = 80;
const COPY_FLASH_MS = 1500;
const HISTORY_FILE = "btw-history.jsonl";
const HISTORY_LIMIT = 200;

// ──────────────────────────────────────────────
// History (JSONL in the agent dir)
// ──────────────────────────────────────────────

interface BtwHistoryEntry {
	ts: number;
	model: string;
	question: string;
	answer: string;
}

function historyPath(): string {
	return path.join(getAgentDir(), HISTORY_FILE);
}

function appendHistory(entry: BtwHistoryEntry): void {
	try {
		appendFileSync(historyPath(), `${JSON.stringify(entry)}\n`);
	} catch {
		// History is best-effort; never break the answer flow over it.
	}
}

function loadHistory(): BtwHistoryEntry[] {
	try {
		const lines = readFileSync(historyPath(), "utf8").split("\n");
		const entries: BtwHistoryEntry[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as Partial<BtwHistoryEntry>;
				if (typeof parsed.question === "string" && typeof parsed.answer === "string") {
					entries.push({
						ts: typeof parsed.ts === "number" ? parsed.ts : 0,
						model: typeof parsed.model === "string" ? parsed.model : "?",
						question: parsed.question,
						answer: parsed.answer,
					});
				}
			} catch {
				// skip malformed lines
			}
		}
		return entries.slice(-HISTORY_LIMIT);
	} catch {
		return [];
	}
}

function formatHistoryDate(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Best-effort clipboard copy (macOS pbcopy). */
function copyToClipboard(text: string): boolean {
	try {
		const proc = spawn("pbcopy");
		proc.stdin.write(text);
		proc.stdin.end();
		return true;
	} catch {
		return false;
	}
}

// ──────────────────────────────────────────────
// Conversation serialization (compaction-aware, via the harness pipeline)
// ──────────────────────────────────────────────

function buildConversationText(ctx: ExtensionCommandContext): string {
	const messages = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
	const text = serializeConversation(convertToLlm(messages));
	if (text.length <= MAX_CONTEXT_CHARS) return text;
	return `[... earlier conversation truncated]\n${text.slice(text.length - MAX_CONTEXT_CHARS)}`;
}

function buildQuestionPrompt(conversationText: string, question: string): string {
	return ["<conversation>", conversationText, "</conversation>", "", `Side question: ${question}`].join("\n");
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

// ──────────────────────────────────────────────
// Shared fullscreen markdown scroller
// ──────────────────────────────────────────────

/** Scrollable markdown viewport used by the answer view and history view. */
class MarkdownViewport {
	scrollTop = 0;
	stickBottom = true;
	lastViewportHeight = 10;

	private readonly markdown = new Markdown("", 0, 0, getMarkdownTheme());
	private lastText = "";

	reset(stickBottom: boolean): void {
		this.scrollTop = 0;
		this.stickBottom = stickBottom;
	}

	scrollBy(delta: number): void {
		this.scrollTop = Math.max(0, this.scrollTop + delta);
		// render() re-sticks to bottom when scrollTop reaches maxScroll
		this.stickBottom = false;
	}

	/** Returns the visible lines plus scroll info for the footer. */
	view(text: string, width: number, viewport: number): { lines: string[]; scrollInfo: string } {
		this.lastViewportHeight = viewport;
		if (this.lastText !== text) {
			this.markdown.setText(text);
			this.lastText = text;
		}
		const contentLines = this.markdown.render(width);
		const maxScroll = Math.max(0, contentLines.length - viewport);
		if (this.stickBottom) this.scrollTop = maxScroll;
		this.scrollTop = Math.min(this.scrollTop, maxScroll);
		if (this.scrollTop >= maxScroll) this.stickBottom = true;
		const lines = contentLines.slice(this.scrollTop, this.scrollTop + viewport);
		const scrollInfo =
			maxScroll > 0 ? ` · ${Math.min(this.scrollTop + viewport, contentLines.length)}/${contentLines.length}` : "";
		return { lines, scrollInfo };
	}

	/** True when the key was a scroll key and got handled. */
	handleScrollKey(data: string): boolean {
		if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) this.scrollBy(-1);
		else if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) this.scrollBy(1);
		else if (matchesKey(data, "pageup")) this.scrollBy(-this.lastViewportHeight);
		else if (matchesKey(data, "pagedown")) this.scrollBy(this.lastViewportHeight);
		else if (matchesKey(data, "home")) {
			this.scrollTop = 0;
			this.stickBottom = false;
		} else if (matchesKey(data, "end")) {
			this.stickBottom = true;
		} else {
			return false;
		}
		return true;
	}
}

function makeEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
}

// ──────────────────────────────────────────────
// Fullscreen component: pick → answer (+ follow-ups)
// ──────────────────────────────────────────────

type Phase = "pick" | "loading" | "done" | "error";

interface BtwComponentOptions {
	tui: TUI;
	theme: Theme;
	question: string;
	/** Lazy, memoized: sessions are only serialized once a model is actually asked. */
	getConversationText: () => string;
	ctx: ExtensionCommandContext;
	getHeight: () => number;
	requestRender: () => void;
	done: () => void;
}

class BtwComponent {
	focused = false;

	private readonly options: BtwComponentOptions;
	private phase: Phase = "pick";
	private selected = lastModelIndex;
	private text = "";
	private error = "";
	private thinking = false;
	private abort: AbortController | undefined;
	private spinnerTimer: ReturnType<typeof setInterval> | undefined;
	private spinnerFrame = 0;
	private renderThrottle: ReturnType<typeof setTimeout> | undefined;
	private readonly viewport = new MarkdownViewport();

	// Side-thread state: completed Q&A pairs plus the LLM message log for follow-ups.
	private readonly thread: { question: string; answer: string }[] = [];
	private currentQuestion: string;
	private llmMessages: (UserMessage | AssistantMessage)[] = [];

	// Follow-up input
	private readonly editor: Editor;
	private inputMode = false;

	private copiedUntil = 0;

	constructor(options: BtwComponentOptions) {
		this.options = options;
		this.currentQuestion = options.question;
		if (this.selected < 0 || this.selected >= BTW_MODELS.length) this.selected = 0;
		this.editor = new Editor(options.tui, makeEditorTheme(options.theme));
		this.editor.onSubmit = (value) => {
			const followUp = value.trim();
			this.inputMode = false;
			this.editor.setText("");
			if (followUp) this.askFollowUp(followUp);
			else this.options.requestRender();
		};
	}

	// ── asking ──────────────────────────────────

	private ask(index: number): void {
		this.selected = index;
		lastModelIndex = index;
		this.llmMessages = [userMessage(buildQuestionPrompt(this.options.getConversationText(), this.currentQuestion))];
		this.startRequest();
	}

	private askFollowUp(question: string): void {
		this.thread.push({ question: this.currentQuestion, answer: this.text });
		this.currentQuestion = question;
		this.llmMessages.push(userMessage(question));
		this.startRequest();
	}

	private reAsk(): void {
		if (this.llmMessages.at(-1)?.role === "assistant") this.llmMessages.pop();
		this.startRequest();
	}

	private startRequest(): void {
		this.abort?.abort();
		this.phase = "loading";
		this.text = "";
		this.error = "";
		this.thinking = false;
		this.viewport.reset(true);
		this.abort = new AbortController();
		this.startSpinner();
		this.options.requestRender();
		void this.run(this.abort);
	}

	private async run(abort: AbortController): Promise<void> {
		const spec = BTW_MODELS[this.selected]!;
		const { ctx } = this.options;

		try {
			const model: Model<Api> | undefined = ctx.modelRegistry.find(spec.provider, spec.id);
			if (!model) throw new Error(`Model ${spec.provider}/${spec.id} not found`);

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(auth.error);
			if (!auth.apiKey) throw new Error(`No API key for ${spec.provider}`);

			const events = stream(
				model,
				{ systemPrompt: SYSTEM_PROMPT, messages: this.llmMessages },
				{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: abort.signal },
			);

			for await (const event of events) {
				if (abort.signal.aborted) return;
				if (event.type === "thinking_start") {
					this.thinking = true;
					this.options.requestRender();
				} else if (event.type === "thinking_end") {
					this.thinking = false;
					this.options.requestRender();
				} else if (event.type === "text_delta") {
					this.thinking = false;
					if (!this.text) this.stopSpinner(); // spinner only matters before the first token
					this.text += event.delta;
					this.scheduleRender();
				}
			}

			const message = await events.result();
			if (abort.signal.aborted) return;

			if (message.stopReason === "error") {
				throw new Error(message.errorMessage ?? "Request failed");
			}
			if (message.stopReason === "aborted") return;

			if (!this.text.trim()) {
				const finalText = message.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join("\n")
					.trim();
				this.text = finalText || "_(empty response)_";
			}
			this.llmMessages.push(message);
			this.phase = "done";
			appendHistory({
				ts: Date.now(),
				model: `${spec.provider}/${spec.id}`,
				question: this.currentQuestion,
				answer: this.text,
			});
		} catch (error) {
			if (abort.signal.aborted) return;
			this.phase = "error";
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.thinking = false;
			this.stopSpinner();
			// Final render supersedes any pending throttled repaint.
			if (this.renderThrottle) {
				clearTimeout(this.renderThrottle);
				this.renderThrottle = undefined;
			}
			this.options.requestRender();
		}
	}

	// ── spinner / repaint throttling ─────────────────

	/** Coalesce stream-delta repaints so long answers are not re-parsed per token. */
	private scheduleRender(): void {
		if (this.renderThrottle) return;
		this.renderThrottle = setTimeout(() => {
			this.renderThrottle = undefined;
			this.options.requestRender();
		}, STREAM_RENDER_THROTTLE_MS);
	}

	private startSpinner(): void {
		if (this.spinnerTimer) return;
		this.spinnerTimer = setInterval(() => {
			this.spinnerFrame++;
			this.options.requestRender();
		}, 90);
	}

	private stopSpinner(): void {
		if (!this.spinnerTimer) return;
		clearInterval(this.spinnerTimer);
		this.spinnerTimer = undefined;
	}

	// ── input ───────────────────────────────────

	handleInput(data: string): void {
		if (this.inputMode) {
			if (matchesKey(data, "escape")) {
				this.inputMode = false;
				this.editor.setText("");
				this.options.requestRender();
				return;
			}
			this.editor.handleInput(data);
			this.options.requestRender();
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) {
			this.close();
			return;
		}

		if (this.phase === "pick") {
			this.handlePickerInput(data);
			return;
		}

		if (this.viewport.handleScrollKey(data)) {
			this.options.requestRender();
			return;
		}

		if (this.phase === "done") {
			if (matchesKey(data, "return") || data === "f") {
				this.inputMode = true;
				this.options.requestRender();
				return;
			}
			if (data === "y") {
				if (copyToClipboard(this.text)) {
					this.copiedUntil = Date.now() + COPY_FLASH_MS;
					this.options.requestRender();
					setTimeout(() => this.options.requestRender(), COPY_FLASH_MS + 50);
				}
				return;
			}
		}
		if ((this.phase === "done" || this.phase === "error") && data === "r") {
			this.reAsk();
			return;
		}
		if (this.phase === "error" && matchesKey(data, "return")) {
			this.close();
		}
	}

	private handlePickerInput(data: string): void {
		if (matchesKey(data, "up")) {
			this.selected = (this.selected + BTW_MODELS.length - 1) % BTW_MODELS.length;
			this.options.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.selected = (this.selected + 1) % BTW_MODELS.length;
			this.options.requestRender();
			return;
		}
		if (matchesKey(data, "return")) {
			this.ask(this.selected);
			return;
		}
		const digit = Number.parseInt(data, 10);
		if (data.length === 1 && digit >= 1 && digit <= BTW_MODELS.length) {
			this.ask(digit - 1);
		}
	}

	private close(): void {
		this.abort?.abort();
		this.options.done();
	}

	// ── render ──────────────────────────────────

	/** Full side-thread as one markdown document (older pairs + the streaming one). */
	private transcriptText(): string {
		if (this.thread.length === 0) return this.text;
		const parts = this.thread.map((pair) => `**Q: ${pair.question}**\n\n${pair.answer}`);
		parts.push(`**Q: ${this.currentQuestion}**\n\n${this.text}`);
		return parts.join("\n\n---\n\n");
	}

	render(width: number): string[] {
		const theme = this.options.theme;
		const height = Math.max(10, this.options.getHeight());
		const innerWidth = Math.max(20, width - 2);
		const lines: string[] = [];
		const bar = (content: string) => truncateToWidth(content, width, "...", true);

		// Header: title + current question
		lines.push(
			bar(
				` ${theme.bold(theme.fg("warning", "/btw"))}  ${theme.fg("muted", truncateToWidth(this.currentQuestion, innerWidth - 7))}`,
			),
		);
		lines.push(bar(theme.fg("border", "─".repeat(width))));

		if (this.phase === "pick") {
			return this.renderPicker(lines, width, height, bar);
		}

		const spec = BTW_MODELS[this.selected]!;

		// Bottom block first, so the viewport knows how many rows remain.
		const bottom: string[] = [];
		if (this.inputMode) {
			bottom.push(bar(theme.fg("border", "─".repeat(width))));
			bottom.push(bar(` ${theme.fg("accent", "Follow-up:")}`));
			for (const line of this.editor.render(innerWidth)) bottom.push(bar(` ${line}`));
			bottom.push(bar(theme.fg("dim", " ⏎ send · esc back")));
		}

		let contentLines: string[];
		let scrollInfo = "";
		if (this.phase === "error") {
			contentLines = [theme.fg("error", `Error: ${this.error || "unknown"}`), "", theme.fg("dim", "Press r to retry.")];
		} else if (this.phase === "loading" && !this.text && this.thread.length === 0) {
			const spinner = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length]!;
			const label = this.thinking ? "Thinking..." : "Answering...";
			contentLines = [theme.fg("warning", `${spinner} ${label} (${spec.label})`)];
		} else {
			const viewportRows = Math.max(3, height - lines.length - bottom.length - 2);
			let transcript = this.transcriptText();
			if (this.phase === "loading" && !this.text) {
				const spinner = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length]!;
				transcript += `\n\n${this.thinking ? `${spinner} Thinking...` : `${spinner} Answering...`}`;
			}
			const view = this.viewport.view(transcript, innerWidth, viewportRows);
			contentLines = view.lines;
			if (this.phase === "loading" && this.text) contentLines = [...contentLines, theme.fg("warning", "…")];
			scrollInfo = view.scrollInfo;
		}

		const footerRows = 2;
		const viewportTarget = height - lines.length - bottom.length - footerRows;
		for (const line of contentLines.slice(0, viewportTarget)) lines.push(bar(` ${line}`));
		while (lines.length < height - bottom.length - footerRows) lines.push(bar(""));
		lines.push(...bottom);

		// Footer
		lines.push(bar(theme.fg("border", "─".repeat(width))));
		const modelInfo = theme.fg("dim", ` ${spec.label} ·`);
		const copied = Date.now() < this.copiedUntil ? theme.fg("success", " ✓ copied ·") : "";
		const hint =
			this.phase === "loading"
				? `${modelInfo} ↑↓ scroll${scrollInfo} · esc cancel`
				: this.phase === "error"
					? `${modelInfo} r retry · esc close`
					: `${modelInfo}${copied} ⏎/f follow-up · y copy · r re-ask · ↑↓ scroll${scrollInfo} · esc close`;
		lines.push(bar(theme.fg("dim", hint)));

		return lines.slice(0, height);
	}

	private renderPicker(
		lines: string[],
		width: number,
		height: number,
		bar: (content: string) => string,
	): string[] {
		const theme = this.options.theme;
		lines.push(bar(""));
		lines.push(bar(` ${theme.bold(theme.fg("accent", "Choose a model:"))}`));
		lines.push(bar(""));
		for (let i = 0; i < BTW_MODELS.length; i++) {
			const spec = BTW_MODELS[i]!;
			const row = ` ${i + 1}. ${spec.label}  ${theme.fg("dim", `(${spec.provider}/${spec.id})`)}`;
			lines.push(bar(i === this.selected ? theme.bg("selectedBg", ` ▶${theme.bold(row)} `) : `   ${row}`));
		}
		while (lines.length < height - 2) lines.push(bar(""));
		lines.push(bar(theme.fg("border", "─".repeat(width))));
		lines.push(bar(theme.fg("dim", " ↑↓/1-4 choose · ⏎ ask · esc close")));
		return lines.slice(0, height);
	}

	invalidate(): void {}

	dispose(): void {
		this.abort?.abort();
		this.stopSpinner();
		if (this.renderThrottle) {
			clearTimeout(this.renderThrottle);
			this.renderThrottle = undefined;
		}
	}
}

// ──────────────────────────────────────────────
// Fullscreen history browser (/btw-history)
// ──────────────────────────────────────────────

interface HistoryComponentOptions {
	theme: Theme;
	getHeight: () => number;
	requestRender: () => void;
	done: () => void;
}

class BtwHistoryComponent {
	focused = false;

	private readonly options: HistoryComponentOptions;
	/** Newest first. */
	private readonly entries: BtwHistoryEntry[];
	private selected = 0;
	private mode: "list" | "view" = "list";
	private readonly viewport = new MarkdownViewport();
	private copiedUntil = 0;

	constructor(options: HistoryComponentOptions) {
		this.options = options;
		this.entries = loadHistory().reverse();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (this.mode === "view") {
				this.mode = "list";
				this.options.requestRender();
			} else {
				this.options.done();
			}
			return;
		}

		if (this.mode === "view") {
			if (this.viewport.handleScrollKey(data)) {
				this.options.requestRender();
				return;
			}
			if (data === "y") {
				const entry = this.entries[this.selected];
				if (entry && copyToClipboard(entry.answer)) {
					this.copiedUntil = Date.now() + COPY_FLASH_MS;
					this.options.requestRender();
					setTimeout(() => this.options.requestRender(), COPY_FLASH_MS + 50);
				}
			}
			return;
		}

		if (this.entries.length === 0) return;
		if (matchesKey(data, "up")) {
			this.selected = (this.selected + this.entries.length - 1) % this.entries.length;
		} else if (matchesKey(data, "down")) {
			this.selected = (this.selected + 1) % this.entries.length;
		} else if (matchesKey(data, "return")) {
			this.mode = "view";
			this.viewport.reset(false);
		} else {
			return;
		}
		this.options.requestRender();
	}

	render(width: number): string[] {
		const theme = this.options.theme;
		const height = Math.max(10, this.options.getHeight());
		const innerWidth = Math.max(20, width - 2);
		const lines: string[] = [];
		const bar = (content: string) => truncateToWidth(content, width, "...", true);

		lines.push(bar(` ${theme.bold(theme.fg("warning", "/btw"))}  ${theme.fg("muted", "history")}`));
		lines.push(bar(theme.fg("border", "─".repeat(width))));

		const footerRows = 2;
		const viewportRows = Math.max(3, height - lines.length - footerRows);
		let hint: string;

		if (this.entries.length === 0) {
			lines.push(bar(""));
			lines.push(bar(` ${theme.fg("dim", "No /btw history yet.")}`));
			hint = " esc close";
		} else if (this.mode === "view") {
			const entry = this.entries[this.selected]!;
			const text = `**Q: ${entry.question}**\n\n_${entry.model} · ${formatHistoryDate(entry.ts)}_\n\n${entry.answer}`;
			const view = this.viewport.view(text, innerWidth, viewportRows);
			for (const line of view.lines) lines.push(bar(` ${line}`));
			const copied = Date.now() < this.copiedUntil ? theme.fg("success", " ✓ copied ·") : "";
			hint = `${copied} y copy · ↑↓ scroll${view.scrollInfo} · esc back`;
		} else {
			// Window the list so the selected row stays visible.
			const offset = Math.max(0, Math.min(this.selected - Math.floor(viewportRows / 2), this.entries.length - viewportRows));
			const visible = this.entries.slice(offset, offset + viewportRows);
			for (let i = 0; i < visible.length; i++) {
				const entry = visible[i]!;
				const index = offset + i;
				const row = ` ${theme.fg("dim", formatHistoryDate(entry.ts))}  ${theme.fg("muted", entry.model.split("/")[1] ?? entry.model)}  ${entry.question.replace(/\s+/g, " ")}`;
				lines.push(bar(index === this.selected ? theme.bg("selectedBg", truncateToWidth(` ▶${row}`, width, "...", true)) : `  ${row}`));
			}
			hint = ` ${this.entries.length} entries · ↑↓ choose · ⏎ view · esc close`;
		}

		while (lines.length < height - footerRows) lines.push(bar(""));
		lines.push(bar(theme.fg("border", "─".repeat(width))));
		lines.push(bar(theme.fg("dim", hint)));
		return lines.slice(0, height);
	}

	invalidate(): void {}
	dispose(): void {}
}

// ──────────────────────────────────────────────
// Extension entry
// ──────────────────────────────────────────────

const FULLSCREEN_OVERLAY = {
	overlay: true,
	// altScreen: the overlay owns the terminal's alternate buffer, so the
	// chat behind never repaints or jumps (same as the agents dashboard).
	overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", altScreen: true },
} as const;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("btw", {
		description: "Ask a side question about the session (pick a model, fullscreen, follow-ups)",
		handler: async (args, ctx) => {
			const question = args?.trim();
			if (!question) {
				ctx.ui.notify("Usage: /btw <your question>", "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw requires interactive mode", "error");
				return;
			}

			// Lazy: serialize the session only when a model is actually asked, once.
			let conversationText: string | undefined;
			const getConversationText = () => {
				conversationText ??= buildConversationText(ctx);
				return conversationText;
			};

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new BtwComponent({
						tui,
						theme,
						question,
						getConversationText,
						ctx,
						getHeight: () => tui.terminal.rows,
						requestRender: () => tui.requestRender(),
						done: () => done(undefined),
					}),
				FULLSCREEN_OVERLAY,
			);
		},
	});

	pi.registerCommand("btw-history", {
		description: "Browse past /btw side questions and answers",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw-history requires interactive mode", "error");
				return;
			}
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new BtwHistoryComponent({
						theme,
						getHeight: () => tui.terminal.rows,
						requestRender: () => tui.requestRender(),
						done: () => done(undefined),
					}),
				FULLSCREEN_OVERLAY,
			);
		},
	});
}
