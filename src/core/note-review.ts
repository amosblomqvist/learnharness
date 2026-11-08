/**
 * NOTE REVIEWS: a side thread (side-chat.ts) with a `review` marker. The
 * learner highlights part of their notes page and asks for a check; the
 * side model gets the lesson document, the whole notes page and the
 * highlighted part. Everything else is the side-question machinery.
 *
 * Imports types only: side-chat.ts imports this module's values.
 * Browser-safe: pure logic + types, no node builtins.
 */

import type { NoteReviewTarget, SideChatThread } from "./contracts/chat.ts";
import type { SideModelTurn } from "./side-chat.ts";
import { NOTES_MAX_CHARS } from "./notes.ts";

/** The question a Review click sends. */
export const SIDE_REVIEW_REQUEST = "Review this part of my notes.";

/** Validate a review marker (highlight trimmed, never clipped: Rewrite must find it
 *  again). Throws a plain Error; parseSideAskInput reports it as a SideChatInputError. */
export function parseNoteReviewTarget(raw: unknown): NoteReviewTarget {
	if (!raw || typeof raw !== "object") throw new Error("review must be an object");
	const r = raw as Record<string, unknown>;
	const highlight = typeof r.highlight === "string" ? r.highlight.trim() : "";
	if (!highlight) throw new Error("review.highlight must be non-empty");
	if (highlight.length > NOTES_MAX_CHARS) throw new Error(`review.highlight exceeds ${NOTES_MAX_CHARS} characters`);
	if (typeof r.from !== "number" || !Number.isSafeInteger(r.from) || r.from < 0) {
		throw new Error("review.from must be a non-negative integer");
	}
	return { highlight, from: r.from };
}

/** The first user turn's context for a review: lesson, notes, highlight. */
export function noteReviewOpening(review: NoteReviewTarget, lessonDocument: string, notes: string): string {
	return [
		`<lesson>\n${lessonDocument || "(The session has no teaching content yet.)"}\n</lesson>`,
		`<notes>\n${notes.trim() ? notes : "(The notes page is empty.)"}\n</notes>`,
		`The learner highlighted this part of their notes:\n\n<highlight>\n${review.highlight}\n</highlight>`,
	].join("\n\n");
}

/** The rewrite call's single user turn: the review's context and conversation. */
export function noteRewriteModelTurns(thread: SideChatThread, lessonDocument: string, notes: string): SideModelTurn[] {
	const conversation = thread.messages
		.map((m) => `${m.role === "assistant" ? "Reviewer" : "Learner"}: ${m.text}`)
		.join("\n");
	const opening = noteReviewOpening(thread.review!, lessonDocument, notes);
	return [{ role: "user", text: `${opening}\n\n<review>\n${conversation}\n</review>\n\nRewrite the highlighted part.` }];
}

/** The inside of `text` when all of it is one fenced code block, else null. */
function unfence(text: string): string | null {
	const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
	return fenced && !/^```/m.test(fenced[1]!) ? fenced[1]! : null;
}

/** Trim the model's text and unwrap a single surrounding code fence, unless
 *  the highlight is itself a fenced block (then the fence is the note's). */
export function cleanReplacement(text: string, highlight: string): string {
	const trimmed = text.trim();
	if (unfence(highlight.trim()) !== null) return trimmed;
	return unfence(trimmed)?.trim() ?? trimmed;
}
