/**
 * The NOTE REVIEW model call's instructions: the note-review base, then
 * the same shared appendix as side questions. The call itself is
 * streamSideAnswer (a note review is a side thread with a `review` marker).
 */

import path from "node:path";
import { composeSideChatInstructions, PROMPTS_DIR, readSource } from "./side-chat.ts";

export const NOTE_REVIEW_BASE = "note-review/00-base.md";

export function composeNoteReviewInstructions(switches: Record<string, boolean> = {}): string {
	return composeSideChatInstructions(switches, NOTE_REVIEW_BASE);
}

export const NOTE_REWRITE_BASE = "note-rewrite/00-base.md";

/** The rewrite base alone: its output is pasted into the notes, so no shared appendix. */
export function composeNoteRewriteInstructions(): string {
	return readSource(path.join(PROMPTS_DIR, ...NOTE_REWRITE_BASE.split("/"))).trim();
}
