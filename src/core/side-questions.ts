/**
 * SIDE QUESTIONS (#16, "/btw"): the learner asks a quick clarification in
 * a side thread that never enters the tutor's conversation. On close, ONE
 * side-question marker lands in the record: its `content` (the model face)
 * is the side agent's note when the learner left "Tell tutor" on, else ""
 * (toLlmMessages skips it); `details` keeps the whole thread for the UI.
 *
 * This module is the pure half: wire shapes and their parsers, the side
 * agent's read-only view of the lesson (sideTranscript — built from the
 * tutor's own wire, toLlmMessages, so compaction and citation expansion
 * match what the tutor sees), and the marker. Browser-safe.
 */

import type { Message } from "@earendil-works/pi-ai";
import { CITATION_CONTEXT_LENGTH } from "./citations.ts";
import { COMPACTED_HISTORY_HEADER } from "./contracts/chat.ts";
import { ChatInputError } from "./input-events.ts";
import {
	SEND_TO_USER_TOOL,
	asAgentMessages,
	questionCallsOf,
	sendToUserText,
	toLlmMessages,
	type LhMarkerMessage,
	type LhMessage,
} from "./native-messages.ts";

export const SIDE_QUESTION_MAX_CHARS = 2_000;
/** The Cite limit (core/citations.ts CITATION_MAX_TEXT_LENGTH). */
export const SIDE_PASSAGE_MAX_CHARS = 8_000;
export const SIDE_THREAD_MAX_PAIRS = 20;
/** The learner's unsubmitted working on a waiting question. */
export const SIDE_WORKING_MAX_CHARS = 8_000;
const SIDE_THREAD_ID_MAX_CHARS = 128;
/** A note is ≤ 600 chars from the agent; the fallback quotes the first
 *  question, so the close wire allows a question's worth more. */
const SIDE_NOTE_MAX_CHARS = SIDE_QUESTION_MAX_CHARS + 600;
const SIDE_RESULT_MAX_CHARS = 2_000;

/** One answered side question. The passage is per pair (F7). */
export interface SidePair {
	question: string;
	answer: string;
	passage?: string;
	sourceMessageId?: string;
	/** Where the passage sits in its tutor message (Cite's text selector,
	 *  minus the text), so the quote links back to it. */
	selector?: PassageSelector;
}

export interface PassageSelector {
	start: number;
	end: number;
	prefix: string;
	suffix: string;
}

/** The side agent's recommendation and draft note for the tutor. */
export interface SideNote {
	tell: boolean;
	note: string;
}

/** POST /api/chats/[id]/side-question — stateless: the client sends the
 *  thread so far with every question. */
export interface SideQuestionInput {
	threadId: string;
	thread: SidePair[];
	question: string;
	passage?: string;
	sourceMessageId?: string;
	selector?: PassageSelector;
	/** The agent's newest note, which the next one rewrites to cover the
	 *  whole thread (F10). */
	note?: string;
	/** Set when the thread was opened from the question waiting for the
	 *  learner's answer (its tool call id): the agent nudges, never answers,
	 *  and the server checks the call really is the waiting question. */
	questionCallId?: string;
	/** The learner's current, unsubmitted working on that question, so a
	 *  nudge can respond to it. Only with `questionCallId`. */
	working?: string;
}

/** POST /api/chats/[id]/side-question/close. `learnerTell` is the
 *  learner's last hand-set toggle (null = never flipped, F10); `pending`
 *  is a question whose answer was still streaming at close (F9). */
export interface SideCloseInput {
	threadId: string;
	thread: Array<SidePair & SideNote>;
	learnerTell: boolean | null;
	/** The closed thread this one continues (its chip gives way). */
	continues?: string;
	pending?: { question: string; passage?: string; sourceMessageId?: string; selector?: PassageSelector };
}

/** The marker's UI payload (never model-visible). */
export interface SideQuestionDetails {
	thread: SidePair[];
	note: string;
	toldTutor: boolean;
	/** A continuation's predecessor: the view hides that thread's chip. */
	continues?: string;
}

// ─── the wire parsers ────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function threadIdOf(v: unknown): string {
	if (typeof v !== "string" || !v || v.length > SIDE_THREAD_ID_MAX_CHARS) {
		throw new ChatInputError(`threadId must be a non-empty string of at most ${SIDE_THREAD_ID_MAX_CHARS} characters`);
	}
	return v;
}

function questionOf(v: unknown, field: string): string {
	if (typeof v !== "string" || !v.trim()) throw new ChatInputError(`${field} must be non-empty text`);
	if (v.length > SIDE_QUESTION_MAX_CHARS) throw new ChatInputError(`${field} is longer than ${SIDE_QUESTION_MAX_CHARS} characters`);
	return v;
}

function selectorOf(raw: unknown, field: string): PassageSelector {
	const s = raw as Partial<Record<keyof PassageSelector, unknown>>;
	const index = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
	const context = (v: unknown) => typeof v === "string" && v.length <= CITATION_CONTEXT_LENGTH;
	if (!isObject(raw) || !index(s.start) || !index(s.end) || (s.end as number) <= (s.start as number) || !context(s.prefix) || !context(s.suffix)) {
		throw new ChatInputError(`${field}.selector must be { start, end, prefix, suffix } with end > start`);
	}
	return { start: s.start as number, end: s.end as number, prefix: s.prefix as string, suffix: s.suffix as string };
}

/** The optional passage, its source id and selector, copied only when present. */
function passageOf(raw: Record<string, unknown>, field: string): { passage?: string; sourceMessageId?: string; selector?: PassageSelector } {
	const out: { passage?: string; sourceMessageId?: string; selector?: PassageSelector } = {};
	if (raw.passage !== undefined) {
		if (typeof raw.passage !== "string" || !raw.passage.trim()) throw new ChatInputError(`${field}.passage must be non-empty text`);
		if (raw.passage.length > SIDE_PASSAGE_MAX_CHARS) throw new ChatInputError(`${field}.passage is longer than ${SIDE_PASSAGE_MAX_CHARS} characters`);
		out.passage = raw.passage;
	}
	if (raw.sourceMessageId !== undefined) {
		if (typeof raw.sourceMessageId !== "string" || !raw.sourceMessageId) throw new ChatInputError(`${field}.sourceMessageId must be a string`);
		out.sourceMessageId = raw.sourceMessageId;
	}
	if (raw.selector !== undefined) {
		if (out.passage === undefined) throw new ChatInputError(`${field}.selector needs a passage`);
		out.selector = selectorOf(raw.selector, field);
	}
	return out;
}

function pairOf(raw: unknown, index: number): SidePair {
	const field = `thread[${index}]`;
	if (!isObject(raw)) throw new ChatInputError(`${field} must be an object`);
	if (typeof raw.answer !== "string") throw new ChatInputError(`${field}.answer must be a string`);
	return { question: questionOf(raw.question, `${field}.question`), answer: raw.answer, ...passageOf(raw, field) };
}

function noteOf(raw: Record<string, unknown>, index: number): SideNote {
	const field = `thread[${index}]`;
	if (typeof raw.tell !== "boolean") throw new ChatInputError(`${field}.tell must be a boolean`);
	if (typeof raw.note !== "string" || raw.note.length > SIDE_NOTE_MAX_CHARS) {
		throw new ChatInputError(`${field}.note must be a string of at most ${SIDE_NOTE_MAX_CHARS} characters`);
	}
	return { tell: raw.tell, note: raw.note };
}

function threadOf(v: unknown, maxPairs: number): unknown[] {
	if (!Array.isArray(v)) throw new ChatInputError("thread must be an array");
	if (v.length > maxPairs) throw new ChatInputError(`a side thread holds at most ${SIDE_THREAD_MAX_PAIRS} questions`);
	return v;
}

export function parseSideQuestionInput(raw: unknown): SideQuestionInput {
	if (!isObject(raw)) throw new ChatInputError("body must be an object");
	const threadId = threadIdOf(raw.threadId);
	// The new question makes one more pair, so a full thread takes no more.
	const thread = threadOf(raw.thread, SIDE_THREAD_MAX_PAIRS - 1).map(pairOf);
	const out: SideQuestionInput = { threadId, thread, question: questionOf(raw.question, "question"), ...passageOf(raw, "body") };
	if (raw.note !== undefined) {
		if (typeof raw.note !== "string" || raw.note.length > SIDE_NOTE_MAX_CHARS) {
			throw new ChatInputError(`note must be a string of at most ${SIDE_NOTE_MAX_CHARS} characters`);
		}
		out.note = raw.note;
	}
	if (raw.questionCallId !== undefined) out.questionCallId = threadIdOf(raw.questionCallId);
	if (raw.working !== undefined) {
		if (out.questionCallId === undefined) throw new ChatInputError("working needs questionCallId");
		if (typeof raw.working !== "string" || raw.working.length > SIDE_WORKING_MAX_CHARS) {
			throw new ChatInputError(`working must be a string of at most ${SIDE_WORKING_MAX_CHARS} characters`);
		}
		if (raw.working.trim()) out.working = raw.working.trim();
	}
	return out;
}

export function parseSideCloseInput(raw: unknown): SideCloseInput {
	if (!isObject(raw)) throw new ChatInputError("body must be an object");
	const threadId = threadIdOf(raw.threadId);
	const thread = threadOf(raw.thread, SIDE_THREAD_MAX_PAIRS).map((p, i) => ({ ...pairOf(p, i), ...noteOf(p as Record<string, unknown>, i) }));
	if (raw.learnerTell !== null && typeof raw.learnerTell !== "boolean") throw new ChatInputError("learnerTell must be a boolean or null");
	const out: SideCloseInput = { threadId, thread, learnerTell: raw.learnerTell };
	if (raw.continues !== undefined) out.continues = threadIdOf(raw.continues);
	if (raw.pending !== undefined) {
		if (!isObject(raw.pending)) throw new ChatInputError("pending must be an object");
		out.pending = { question: questionOf(raw.pending.question, "pending.question"), ...passageOf(raw.pending, "pending") };
	}
	return out;
}

/** F10: the learner's last hand-set toggle wins; otherwise the newest
 *  recommendation (nothing answered = nothing to tell). */
export function finalTell(pairs: ReadonlyArray<SideNote>, learnerTell: boolean | null): boolean {
	return learnerTell ?? pairs[pairs.length - 1]?.tell ?? false;
}

// ─── the side agent's view of the lesson ─────────────────────────────────────

/** Tags marker text before the wire flattens it into user text, so the
 *  transcript can label it [NOTE] instead of [LEARNER]. A private-use
 *  character: no learner or model text carries it. */
const NOTE_TAG = "side-note";

/** The question arguments that answer it: hidden while it waits (#402). */
const ANSWER_KEY_FIELDS = ["correctAnswer", "explanation"];

function withoutAnswerKey(args: unknown): unknown {
	if (!isObject(args)) return args;
	return Object.fromEntries(Object.entries(args).filter(([key]) => !ANSWER_KEY_FIELDS.includes(key)));
}

function textOf(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content.map((b) => (b.type === "text" ? b.text : b.type === "image" ? "(image)" : "")).filter(Boolean).join("\n");
}

function truncated(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}… (truncated)` : text;
}

/**
 * The tutor conversation as labelled text (F4) — the tutor's own wire, so
 * compaction is honoured and citations arrive expanded. A question still
 * waiting for the learner (P1) shows without its answer key, and its
 * synthesized "interrupted" result is dropped: the side agent must not be
 * able to leak the answer.
 */
export function sideTranscript(record: readonly LhMessage[]): string {
	const pending = new Set(questionCallsOf(record).filter((c) => c.status === "answerable").map((c) => c.toolCallId));
	const tagged = record.map((m) =>
		m.role === "custom" && m.customType !== "compaction" && m.content ? { ...m, content: NOTE_TAG + m.content } : m,
	);
	const lines: string[] = [];
	const silentResults = new Set<string>();
	for (const message of toLlmMessages(asAgentMessages(tagged))) {
		if (message.role === "user") {
			const text = textOf(message.content);
			if (!text.trim()) continue;
			if (text.startsWith(NOTE_TAG)) lines.push(`[NOTE] ${text.slice(NOTE_TAG.length)}`);
			else if (text.startsWith(COMPACTED_HISTORY_HEADER)) lines.push(`[SUMMARY] ${text}`);
			else lines.push(`[LEARNER] ${text}`);
		} else if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text") {
					if (block.text.trim()) lines.push(`[TUTOR] ${block.text}`);
				} else if (block.type === "toolCall") {
					const prose = sendToUserText(block);
					if (block.name === SEND_TO_USER_TOOL) {
						if (prose) lines.push(`[TUTOR] ${prose}`);
						silentResults.add(block.id);
					} else if (pending.has(block.id)) {
						lines.push(`[TUTOR] (question ${block.name}, waiting for the learner's answer: ${JSON.stringify(withoutAnswerKey(block.arguments))})`);
					} else {
						lines.push(`[TUTOR] (tool call ${block.name}: ${JSON.stringify(block.arguments)})`);
					}
				}
			}
		} else if (message.role === "toolResult") {
			if (pending.has(message.toolCallId) || silentResults.has(message.toolCallId)) continue;
			lines.push(`[RESULT for ${message.toolName}] ${truncated(textOf(message.content), SIDE_RESULT_MAX_CHARS)}`);
		}
	}
	return lines.join("\n\n");
}

function passageLine(passage: string | undefined): string[] {
	return passage ? [`Passage: "${passage}"`] : [];
}

/** The side agent's user message, rebuilt for every answer (stateless). */
export function sideUserMessage(
	transcript: string,
	input: Pick<SideQuestionInput, "thread" | "question" | "passage" | "note" | "questionCallId" | "working">,
): string {
	const parts = [`<tutor_transcript>\n${transcript}\n</tutor_transcript>`];
	if (input.questionCallId) {
		parts.push(
			`<waiting_question>The learner opened this thread from the question that is waiting for their answer (the last question in the transcript marked "waiting").${
				input.working ? `\nTheir working so far, not yet submitted:\n${input.working}` : "\nThey have not written any working yet."
			}</waiting_question>`,
		);
	}
	if (input.thread.length) {
		const pairs = input.thread.map((p) => [...passageLine(p.passage), `Learner: ${p.question}`, `You: ${p.answer}`].join("\n"));
		if (input.note) pairs.push(`Your last note: ${input.note}`);
		parts.push(`<side_thread>\n${pairs.join("\n\n")}\n</side_thread>`);
	}
	parts.push([...passageLine(input.passage), `Learner: ${input.question}`].join("\n"));
	return parts.join("\n\n");
}

// ─── the record marker ───────────────────────────────────────────────────────

/** "Tell tutor" after close: a thread kept private can still be told. The
 *  note lands at the record's end (the tutor may have read past the
 *  original marker); the view folds it into the original chip. */
export function newSideQuestionToldMarker(threadId: string, note: string): LhMarkerMessage {
	return {
		id: `${threadId}_told`,
		role: "custom",
		customType: "side-question-told",
		content: note,
		display: false,
		details: { threadId },
		timestamp: Date.now(),
	};
}

/** The closed thread's marker. The thread id is its record id, so the
 *  side answers' usage entries (messageId = threadId) fold onto its chip. */
export function newSideQuestionMarker(threadId: string, details: SideQuestionDetails): LhMarkerMessage {
	return {
		id: threadId,
		role: "custom",
		customType: "side-question",
		content: details.toldTutor ? details.note : "",
		display: true,
		details,
		timestamp: Date.now(),
	};
}
