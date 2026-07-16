/**
 * ask_user — port of Claude Code's AskUserQuestion tool.
 *
 * Lets the LLM ask the user 1-4 multiple-choice questions mid-run. Improvements
 * over the original:
 *   - multiSelect with space toggles and checkbox UI
 *   - optional markdown `preview` per option, rendered for the focused option
 *   - "Other" free-text option with an inline editor (always available)
 *   - per-question notes (key n): free-text commentary attached to the answer
 *   - tab bar for multiple questions with answered-state markers
 *   - Esc declines gracefully (tool result tells the model not to re-ask)
 *   - idle timeout with countdown: if the user is away, the tool auto-resolves
 *     (partial answers included) so the agent turn never blocks forever and
 *     queued steering messages (e.g. shadow clone reports) can flow
 *
 * Keys: ↑↓ move · 1-9 jump · space toggle (multi) · ⏎ select/confirm ·
 * tab/←→ switch question · esc decline
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	Markdown,
	matchesKey,
	Text,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { formatCountdown } from "../lib/picker-util.ts";

const MAX_HEADER_CHARS = 16;
const DEFAULT_TIMEOUT_SECONDS = 300;
const MIN_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 3600;

// ──────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────

const OptionSchema = Type.Object({
	label: Type.String({
		description:
			"Display text for this option. Concise (1-5 words). If you recommend an option, make it the first one and append ' (Recommended)'.",
	}),
	description: Type.Optional(
		Type.String({
			description: "Short explanation of what this option means or its trade-offs. Shown under the label.",
		}),
	),
	preview: Type.Optional(
		Type.String({
			description:
				"Optional markdown preview rendered when this option is focused: code snippets, ASCII mockups, config examples. Use only when options need visual comparison.",
		}),
	),
});

const QuestionSchema = Type.Object({
	question: Type.String({
		description:
			'The complete question. Clear, specific, ends with a question mark. Example: "Which library should we use for date formatting?"',
	}),
	header: Type.String({
		description: `Very short tab label (max ${MAX_HEADER_CHARS} chars). Examples: "Auth method", "Library", "Approach".`,
	}),
	options: Type.Array(OptionSchema, {
		minItems: 2,
		maxItems: 6,
		description:
			"2-6 distinct choices. Do not add an 'Other' option — a free-text 'Other' is always provided automatically.",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "Allow selecting multiple options (space toggles). Use when choices are not mutually exclusive.",
		}),
	),
});

const AskUserParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: 4,
		description: "Questions to ask the user (1-4). Question texts must be unique.",
	}),
	timeoutSeconds: Type.Optional(
		Type.Number({
			minimum: MIN_TIMEOUT_SECONDS,
			maximum: MAX_TIMEOUT_SECONDS,
			description: `Idle timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS}). Any keypress resets it. If the user does not interact in time, the tool auto-resolves with the answers so far so the run is never blocked.`,
		}),
	),
});

type AskUserInput = Static<typeof AskUserParams>;
type AskQuestion = AskUserInput["questions"][number];

export type AskUserToolInput = AskUserInput;

interface AskUserDetails {
	answers: Record<string, string>;
	notes: Record<string, string>;
	headers: Record<string, string>;
	declined: boolean;
	timedOut: boolean;
}

// ──────────────────────────────────────────────
// Dialog state
// ──────────────────────────────────────────────

interface QuestionState {
	/** Indices of selected options; for single-select at most one entry. */
	selected: Set<number>;
	/** Free text entered via "Other", if any. */
	otherText?: string;
	/** Free-text note attached to this answer (key n). */
	note?: string;
	answered: boolean;
}

interface DialogResult {
	answers: Record<string, string>;
	notes: Record<string, string>;
	declined: boolean;
	timedOut: boolean;
}

class AskUserDialog {
	focused = false;

	private readonly questions: AskQuestion[];
	private readonly states: QuestionState[];
	private readonly theme: Theme;
	private readonly requestRender: () => void;
	private readonly done: (result: DialogResult) => void;
	private readonly editor: Editor;

	private tab = 0; // question index; questions.length = submit tab (multi only)
	private optionIndex = 0;
	private inputMode = false;
	private inputTarget: "other" | "note" = "other";
	private readonly timeoutMs: number;
	private deadline: number;
	private timer: ReturnType<typeof setInterval> | undefined;
	// One reused instance: Markdown caches by (text, width), so re-setting the
	// same preview text every countdown tick would force a reparse per second.
	private readonly previewMarkdown = new Markdown("", 0, 0, getMarkdownTheme());
	private lastPreviewText: string | undefined;

	constructor(
		tui: TUI,
		theme: Theme,
		questions: AskQuestion[],
		timeoutMs: number,
		done: (result: DialogResult) => void,
	) {
		this.theme = theme;
		this.questions = questions;
		this.states = questions.map(() => ({ selected: new Set<number>(), answered: false }));
		this.requestRender = () => tui.requestRender();
		this.done = done;
		this.timeoutMs = timeoutMs;
		this.deadline = Date.now() + timeoutMs;
		// Tick once a second: repaint the countdown and auto-resolve when the user is away,
		// so the agent turn never blocks forever on an unattended dialog.
		this.timer = setInterval(() => {
			if (Date.now() >= this.deadline) {
				this.dispose();
				this.done({ answers: this.collectAnswered(), notes: this.collectNotes(), declined: false, timedOut: true });
				return;
			}
			// The countdown is hidden while typing in the Other editor; skip the no-op repaint.
			if (!this.inputMode) this.requestRender();
		}, 1000);

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		this.editor = new Editor(tui, editorTheme);
		this.editor.onSubmit = (value) => {
			if (this.inputTarget === "note") this.submitNote(value);
			else this.submitOther(value);
		};
	}

	private get isMulti(): boolean {
		return this.questions.length > 1;
	}

	private get totalTabs(): number {
		return this.isMulti ? this.questions.length + 1 : 1;
	}

	private currentQuestion(): AskQuestion | undefined {
		return this.questions[this.tab];
	}

	private currentState(): QuestionState | undefined {
		return this.states[this.tab];
	}

	/** Option count including the trailing "Other". */
	private optionCount(question: AskQuestion): number {
		return question.options.length + 1;
	}

	private isOtherIndex(question: AskQuestion, index: number): boolean {
		return index === question.options.length;
	}

	private allAnswered(): boolean {
		return this.states.every((state) => state.answered);
	}

	// ── answers ─────────────────────────────────

	private answerFor(question: AskQuestion, state: QuestionState): string {
		const parts: string[] = [];
		for (const index of [...state.selected].sort((a, b) => a - b)) {
			if (this.isOtherIndex(question, index)) {
				if (state.otherText) parts.push(state.otherText);
			} else {
				parts.push(question.options[index]!.label);
			}
		}
		return parts.join(", ");
	}

	private submitAll(): void {
		const answers: Record<string, string> = {};
		for (let i = 0; i < this.questions.length; i++) {
			answers[this.questions[i]!.question] = this.answerFor(this.questions[i]!, this.states[i]!);
		}
		this.done({ answers, notes: this.collectNotes(), declined: false, timedOut: false });
	}

	/** Answers for questions already confirmed; used when the idle timeout fires. */
	private collectAnswered(): Record<string, string> {
		const answers: Record<string, string> = {};
		for (let i = 0; i < this.questions.length; i++) {
			if (this.states[i]!.answered) {
				answers[this.questions[i]!.question] = this.answerFor(this.questions[i]!, this.states[i]!);
			}
		}
		return answers;
	}

	collectNotes(): Record<string, string> {
		const notes: Record<string, string> = {};
		for (let i = 0; i < this.questions.length; i++) {
			const note = this.states[i]!.note;
			if (note) notes[this.questions[i]!.question] = note;
		}
		return notes;
	}

	private submitNote(value: string): void {
		const state = this.currentState();
		this.inputMode = false;
		this.editor.setText("");
		if (state) state.note = value.trim() || undefined;
		this.requestRender();
	}

	private submitOther(value: string): void {
		const state = this.currentState();
		const question = this.currentQuestion();
		this.inputMode = false;
		this.editor.setText("");
		if (!state || !question) return;

		const trimmed = value.trim();
		const otherIndex = question.options.length;
		if (trimmed) {
			state.otherText = trimmed;
			if (!question.multiSelect) state.selected.clear();
			state.selected.add(otherIndex);
			if (!question.multiSelect) {
				this.confirmQuestion();
				return;
			}
		} else {
			state.selected.delete(otherIndex);
			state.otherText = undefined;
		}
		// The selection changed after a possible earlier confirmation — require
		// a fresh Enter so the submit tab never carries a stale answer.
		state.answered = false;
		this.requestRender();
	}

	/** Mark the current question answered and advance (or submit). */
	private confirmQuestion(): void {
		const state = this.currentState();
		if (!state || state.selected.size === 0) return;
		state.answered = true;

		if (!this.isMulti) {
			this.submitAll();
			return;
		}
		if (this.allAnswered()) {
			this.tab = this.questions.length; // submit tab
		} else {
			// next unanswered question
			for (let i = 1; i <= this.questions.length; i++) {
				const candidate = (this.tab + i) % this.questions.length;
				if (!this.states[candidate]!.answered) {
					this.tab = candidate;
					break;
				}
			}
		}
		this.optionIndex = 0;
		this.requestRender();
	}

	// ── input ───────────────────────────────────

	handleInput(data: string): void {
		this.deadline = Date.now() + this.timeoutMs; // user is active — reset the idle timeout
		if (this.inputMode) {
			if (matchesKey(data, Key.escape)) {
				this.inputMode = false;
				this.editor.setText("");
				this.requestRender();
				return;
			}
			this.editor.handleInput(data);
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.done({ answers: this.collectAnswered(), notes: this.collectNotes(), declined: true, timedOut: false });
			return;
		}

		if (this.isMulti) {
			if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
				this.tab = (this.tab + 1) % this.totalTabs;
				this.optionIndex = 0;
				this.requestRender();
				return;
			}
			if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
				this.tab = (this.tab + this.totalTabs - 1) % this.totalTabs;
				this.optionIndex = 0;
				this.requestRender();
				return;
			}
		}

		// Submit tab
		if (this.isMulti && this.tab === this.questions.length) {
			if (matchesKey(data, Key.enter) && this.allAnswered()) this.submitAll();
			return;
		}

		const question = this.currentQuestion();
		const state = this.currentState();
		if (!question || !state) return;
		const count = this.optionCount(question);

		if (matchesKey(data, Key.up)) {
			this.optionIndex = (this.optionIndex + count - 1) % count;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.optionIndex = (this.optionIndex + 1) % count;
			this.requestRender();
			return;
		}

		const digit = Number.parseInt(data, 10);
		if (data.length === 1 && digit >= 1 && digit <= count) {
			this.optionIndex = digit - 1;
			if (question.multiSelect) {
				this.toggle(question, state, this.optionIndex);
			} else {
				this.selectAndConfirm(question, state, this.optionIndex);
			}
			return;
		}

		if (data === " " && question.multiSelect) {
			this.toggle(question, state, this.optionIndex);
			return;
		}

		if (data === "n") {
			this.inputTarget = "note";
			this.inputMode = true;
			this.editor.setText(state.note ?? "");
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.enter)) {
			if (question.multiSelect) {
				// Enter on "Other" opens the editor; elsewhere confirms the selection set.
				if (this.isOtherIndex(question, this.optionIndex)) {
					this.openOtherEditor(state);
					return;
				}
				if (state.selected.size > 0) this.confirmQuestion();
				return;
			}
			this.selectAndConfirm(question, state, this.optionIndex);
		}
	}

	private toggle(question: AskQuestion, state: QuestionState, index: number): void {
		if (this.isOtherIndex(question, index)) {
			if (state.selected.has(index)) {
				state.selected.delete(index);
				state.otherText = undefined;
				state.answered = false;
				this.requestRender();
			} else {
				this.openOtherEditor(state);
			}
			return;
		}
		if (state.selected.has(index)) state.selected.delete(index);
		else state.selected.add(index);
		// Any toggle invalidates an earlier confirmation of this question.
		state.answered = false;
		this.requestRender();
	}

	private selectAndConfirm(question: AskQuestion, state: QuestionState, index: number): void {
		if (this.isOtherIndex(question, index)) {
			this.openOtherEditor(state);
			return;
		}
		state.selected.clear();
		state.selected.add(index);
		this.confirmQuestion();
	}

	private openOtherEditor(state: QuestionState): void {
		this.inputTarget = "other";
		this.inputMode = true;
		this.editor.setText(state.otherText ?? "");
		this.requestRender();
	}

	// ── render ──────────────────────────────────

	render(width: number): string[] {
		const theme = this.theme;
		const renderWidth = Math.max(20, width);
		const lines: string[] = [];

		const addWrapped = (prefix: string, text: string) => {
			const prefixWidth = visibleWidth(prefix);
			const wrapped = wrapTextWithAnsi(text, Math.max(1, renderWidth - prefixWidth));
			const continuation = " ".repeat(prefixWidth);
			for (let i = 0; i < wrapped.length; i++) {
				lines.push(`${i === 0 ? prefix : continuation}${wrapped[i]}`);
			}
		};

		lines.push(theme.fg("accent", "─".repeat(renderWidth)));
		addWrapped(" ", theme.bold(theme.fg("accent", "Questions from the model")));

		// Tab bar
		if (this.isMulti) {
			const tabs: string[] = [];
			for (let i = 0; i < this.questions.length; i++) {
				const header = this.questions[i]!.header.slice(0, MAX_HEADER_CHARS);
				const answered = this.states[i]!.answered;
				const text = ` ${answered ? "■" : "□"} ${header} `;
				tabs.push(
					i === this.tab
						? theme.bg("selectedBg", theme.fg("text", text))
						: theme.fg(answered ? "success" : "muted", text),
				);
			}
			const submitText = " ✓ Submit ";
			tabs.push(
				this.tab === this.questions.length
					? theme.bg("selectedBg", theme.fg("text", submitText))
					: theme.fg(this.allAnswered() ? "success" : "dim", submitText),
			);
			addWrapped(" ", tabs.join(" "));
			lines.push("");
		}

		if (this.isMulti && this.tab === this.questions.length) {
			this.renderSubmitTab(lines, addWrapped);
		} else {
			this.renderQuestion(lines, addWrapped, renderWidth);
		}

		lines.push("");
		if (!this.inputMode) {
			const question = this.currentQuestion();
			const parts: string[] = ["↑↓ move", "1-9 jump"];
			if (question?.multiSelect) parts.push("space toggle");
			parts.push(question?.multiSelect ? "⏎ confirm" : "⏎ select");
			parts.push("n note");
			if (this.isMulti) parts.push("tab/←→ question");
			parts.push("esc decline");
			const remaining = this.deadline - Date.now();
			const countdownColor = remaining < 60_000 ? "warning" : "dim";
			parts.push(theme.fg(countdownColor, `⏱ auto ${formatCountdown(remaining)}`));
			addWrapped(" ", theme.fg("dim", parts.join(" · ")));
		}
		lines.push(theme.fg("accent", "─".repeat(renderWidth)));
		return lines;
	}

	private renderSubmitTab(lines: string[], addWrapped: (prefix: string, text: string) => void): void {
		const theme = this.theme;
		addWrapped(" ", theme.bold(theme.fg("accent", "Review answers")));
		lines.push("");
		for (let i = 0; i < this.questions.length; i++) {
			const question = this.questions[i]!;
			const state = this.states[i]!;
			const answer = state.answered ? this.answerFor(question, state) : theme.fg("warning", "(unanswered)");
			addWrapped(" ", `${theme.fg("muted", `${question.header}: `)}${answer}`);
			if (state.note) addWrapped("   ", theme.fg("dim", `✎ ${state.note}`));
		}
		lines.push("");
		addWrapped(
			" ",
			this.allAnswered()
				? theme.fg("success", "Press Enter to submit")
				: theme.fg("warning", "Answer the remaining questions first (tab/←→)"),
		);
	}

	private renderQuestion(
		lines: string[],
		addWrapped: (prefix: string, text: string) => void,
		renderWidth: number,
	): void {
		const theme = this.theme;
		const question = this.currentQuestion();
		const state = this.currentState();
		if (!question || !state) return;

		addWrapped(" ", theme.fg("text", question.question));
		if (question.multiSelect) addWrapped(" ", theme.fg("dim", "(multiple selections allowed)"));
		if (state.note) addWrapped(" ", theme.fg("dim", `✎ note: ${state.note}`));
		lines.push("");

		const count = this.optionCount(question);
		for (let i = 0; i < count; i++) {
			const isOther = this.isOtherIndex(question, i);
			const focusedRow = i === this.optionIndex;
			const isSelected = state.selected.has(i);

			const marker = question.multiSelect ? (isSelected ? "[x]" : "[ ]") : isSelected ? "◉" : "○";
			const label = isOther ? `Other${state.otherText ? `: ${state.otherText}` : "…"}` : question.options[i]!.label;
			const prefix = focusedRow ? theme.fg("accent", " ▶ ") : "   ";
			const color = focusedRow ? "accent" : isSelected ? "success" : "text";
			addWrapped(prefix, theme.fg(color, `${marker} ${i + 1}. ${label}`));

			const description = isOther ? undefined : question.options[i]!.description;
			if (description) addWrapped("       ", theme.fg("muted", description));
		}

		// Markdown preview of the focused option
		const focused = this.optionIndex < question.options.length ? question.options[this.optionIndex] : undefined;
		if (focused?.preview && !this.inputMode) {
			lines.push("");
			addWrapped(" ", theme.fg("dim", `┌ preview: ${focused.label}`));
			if (this.lastPreviewText !== focused.preview) {
				this.previewMarkdown.setText(focused.preview);
				this.lastPreviewText = focused.preview;
			}
			for (const line of this.previewMarkdown.render(Math.max(10, renderWidth - 4))) {
				lines.push(` ${theme.fg("dim", "│")} ${line}`);
			}
			addWrapped(" ", theme.fg("dim", "└"));
		}

		if (this.inputMode) {
			lines.push("");
			addWrapped(" ", theme.fg("muted", this.inputTarget === "note" ? "Note (sent to the model with your answer):" : "Your answer:"));
			for (const line of this.editor.render(Math.max(10, renderWidth - 2))) {
				lines.push(` ${line}`);
			}
			addWrapped(" ", theme.fg("dim", "⏎ submit · esc back"));
		}
	}

	invalidate(): void {}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}

// ──────────────────────────────────────────────
// Extension entry
// ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool<typeof AskUserParams, AskUserDetails>({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user 1-4 multiple choice questions to gather preferences, clarify ambiguity, or decide between approaches. Each question shows 2-6 options plus an automatic free-text 'Other'. Use multiSelect for non-exclusive choices. Options support an optional markdown preview for visual comparison (code snippets, mockups). Do not use it for plan approval or yes/no confirmations of work already described.",
		promptSnippet: "Ask the user multiple-choice questions to clarify requirements or decide between approaches",
		promptGuidelines: [
			"Use ask_user when a decision materially affects the work and the user's preference is unknown — offer 2-4 concrete options instead of guessing. Do not use ask_user to ask for approval of a plan you already described.",
		],
		parameters: AskUserParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				throw new Error("ask_user requires interactive mode");
			}
			const questions = params.questions;
			const texts = questions.map((q) => q.question);
			if (new Set(texts).size !== texts.length) {
				throw new Error("Question texts must be unique");
			}

			const timeoutMs =
				Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)) *
				1000;

			const onAbort = () => abortDialog?.();
			let abortDialog: (() => void) | undefined;
			signal?.addEventListener("abort", onAbort, { once: true });
			let result: DialogResult;
			try {
				result = await ctx.ui.custom<DialogResult>((tui, theme, _kb, done) => {
					abortDialog = () => done({ answers: {}, notes: {}, declined: true, timedOut: false });
					return new AskUserDialog(tui, theme, questions, timeoutMs, done);
				});
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}

			const headers: Record<string, string> = {};
			for (const question of questions) headers[question.question] = question.header;

			const answersText = Object.entries(result.answers)
				.map(([question, answer]) => {
					const note = result.notes[question];
					return `"${question}"="${answer}"${note ? ` (user note: ${note})` : ""}`;
				})
				.join(", ");
			const answeredCount = Object.keys(result.answers).length;

			if (result.timedOut) {
				const partial = answeredCount > 0 ? ` Answers given before that: ${answersText}.` : "";
				return {
					content: [
						{
							type: "text",
							text: `The user did not respond within the idle timeout (likely away from keyboard).${partial} For the unanswered questions, do not wait or re-ask now: proceed with your best judgment, preferring any option you marked as recommended, and note the assumption in your reply.`,
						},
					],
					details: { answers: result.answers, notes: result.notes, headers, declined: false, timedOut: true },
				};
			}

			if (result.declined) {
				const partial = answeredCount > 0 ? ` Answers given before declining: ${answersText}.` : "";
				return {
					content: [
						{
							type: "text",
							text: `User declined to answer the questions.${partial} Do not repeat the same questions; continue with your best judgment or rephrase if truly blocked.`,
						},
					],
					details: { answers: result.answers, notes: result.notes, headers, declined: true, timedOut: false },
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `User has answered your questions: ${answersText}. You can now continue with the user's answers in mind.`,
					},
				],
				details: { answers: result.answers, notes: result.notes, headers, declined: false, timedOut: false },
			};
		},

		renderCall(args, theme) {
			const questions = Array.isArray(args.questions) ? args.questions : [];
			const labels = questions
				.map((q) => (typeof q?.header === "string" ? q.header : undefined))
				.filter((h): h is string => !!h)
				.join(", ");
			let text = theme.fg("toolTitle", theme.bold("ask_user "));
			text += theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`);
			if (labels) text += theme.fg("dim", ` (${labels})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details;
			if (!details) return new Text("", 0, 0);
			const lines = Object.entries(details.answers).map(([question, answer]) => {
				const header = details.headers[question] ?? question;
				const note = details.notes?.[question];
				const noteText = note ? `\n  ${theme.fg("dim", `✎ ${note}`)}` : "";
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", header)}${theme.fg("muted", " → ")}${answer}${noteText}`;
			});
			if (details.timedOut) {
				lines.push(theme.fg("warning", "⏱ auto-continued (user away)"));
			} else if (details.declined) {
				lines.push(theme.fg("warning", "● User declined to answer"));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
