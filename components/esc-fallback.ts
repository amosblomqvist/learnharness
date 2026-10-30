/**
 * The window-level Esc fallback chain (keyboard-shortcuts.tsx), bottom-up.
 * Reached only when nothing surfaced claims Esc (see docs/keyboard.md):
 *
 *   1. cancel dictation  (a live capture; discards the transcript)
 *   2. stop read aloud   (audio playing or being fetched; ElevenLabs voice slice 7)
 *   3. abort the turn    (the abort seam in Chat decides what is stoppable)
 *
 * One Esc, one action: the first live step consumes the key.
 */

export type EscFallbackTarget = "cancel-dictation" | "stop-read-aloud" | "abort-turn";

export function escFallbackTarget(state: { dictationActive: boolean; playing: boolean }): EscFallbackTarget {
	if (state.dictationActive) return "cancel-dictation";
	if (state.playing) return "stop-read-aloud";
	return "abort-turn";
}

export interface EscFallbackDeps {
	isDictationActive: () => boolean;
	/** The window's read-aloud player (the slice of it Esc needs). */
	player: { getSnapshot(): { sourceId: string | null }; stop(): void };
	/** Dispatches a window CustomEvent by name. */
	dispatch: (name: string) => void;
}

export function runEscFallback(e: { preventDefault(): void }, deps: EscFallbackDeps): void {
	const target = escFallbackTarget({
		dictationActive: deps.isDictationActive(),
		playing: deps.player.getSnapshot().sourceId !== null,
	});
	if (target === "cancel-dictation") {
		e.preventDefault();
		deps.dispatch("lh:kbd-cancel-dictation");
	} else if (target === "stop-read-aloud") {
		e.preventDefault();
		deps.player.stop();
	} else {
		deps.dispatch("lh:kbd-abort-turn");
	}
}
