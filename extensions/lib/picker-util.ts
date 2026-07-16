/**
 * Shared TUI helpers for the user-level extensions in ~/.pi/agent/extensions
 * (btw.ts, ask-user.ts). Lives in lib/ (no index.ts) so extension
 * auto-discovery never loads it as an extension itself.
 */

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** mm:ss countdown for idle-timeout footers. */
export function formatCountdown(ms: number): string {
	const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
