/**
 * THE INPUT-EVENTS CONTRACT (Wave B, owner ruling 2026-09-26: "input
 * events now, in the same pass"): POST /api/chat carries `{chatId, input}`
 * — ONE explicit event, never a client transcript. The server owns the
 * record; a send tells it what HAPPENED, not what the client's list looks
 * like. The 409 merge-retry died with the full-list body (an input event
 * retries idempotently: nothing was appended when a POST is refused).
 *
 * The four events (the complete client-originated input taxonomy):
 *   text    — a learner-authored user message (composer send, initial
 *             topic, the demo error-fix loop)
 *   answer  — the pending question's graded result (QuestionAnswerData,
 *             built client-side exactly as today; a dismissal is an answer
 *             carrying its flag). Server-side this becomes the call's
 *             native tool result — fork 1's normal agent history.
 *   continue — run the next turn on the current record (mount
 *             continuations, job-settle re-syncs: the record ends at an
 *             answered question with no teacher reaction yet).
 *
 * (The plan verdict input died 2026-09-26 with the verdict itself — the
 * learner's post-plan reply is a natural text message.)
 *
 * Server-originated delivery (the wake pipeline's steers) is NOT a client
 * input — the handler accepts it on the same path (TurnInput) so every
 * turn rides one composition.
 */

import type { QuestionAnswerData } from "./question-core.ts";
import type { LhMessage } from "./native-messages.ts";
import {
	activeProblemOf,
	concludedByDismissalPair,
	danglingQuestionOf,
	newAnswerResult,
	newNextMessage,
	newProblemDismissedMarker,
	newThinkingMessage,
	newUserMessage,
	pendingProblemDismissalOf,
} from "./native-messages.ts";
import { QUESTION_TOOLS, toolQuestionKind } from "./pending.ts";
import { ChatInputError } from "./input-error.ts";
import { parseComposerImages, type ComposerImage } from "./images.ts";

/** One client-originated input event (the POST body's `input`). */
export type ChatInput =
	/** Images ride the text event (composer paste): `text` may be empty when
	 *  the learner sent a picture alone. */
	| { type: "text"; text: string; images?: ComposerImage[] }
	| { type: "answer"; toolCallId: string; answer: QuestionAnswerData }
	| { type: "continue" }
	/** The practice dock's two buttons (owner, 2026-10-04): the learner's
	 *  thinking on the ACTIVE problem — one lane (owner 2026-10-05):
	 *  whether it claims an answer is read from the text. One
	 *  problem may carry many submissions; each is its own turn. */
	| { type: "thinking"; problemCallId: string; text: string }
	/** The practice move-on signal (owner round 16): the learner's
	 *  explicit go-ahead during the between-problems pause — the Next
	 *  chip or Enter on an empty composer. Practice sessions only, and
	 *  only with nothing active (mid-problem input rides the dock). */
	| { type: "next" };

/** A wake-pipeline steer delivery — same turn composition, server-origin.
 *  Wave C (2026-09-26): the idle wake carries EVERY queued marker as its
 *  input appends — with claimSteers deleted, the pump's wake is the only
 *  steer appender left (the in-run path hands markers to pi's own
 *  follow-up queue instead, so it never builds an input event). */
export type SteerInput = { type: "steers"; steers: LhMessage[] };

/** Every input the turn composition accepts. */
export type TurnInput = ChatInput | SteerInput;

/** The dismissal event (owner design 2026-10-03, "A2"): NEVER composes a
 *  turn — the silent route appends + persists and wakes nothing. The
 *  answer rides the event (mirroring the answer event) but must actually
 *  BE a dismissal: the silent path must never inject a live answer
 *  wake-free. Parallel question calls each get their own dismiss event;
 *  results reference their calls by id, so the appends stay independent. */
export type DismissInput =
	| { type: "dismiss"; toolCallId: string; answer: QuestionAnswerData }
	/** The problem discard (practice, owner 2026-10-04): ask-style — the
	 *  silent route appends the UI-only marker and wakes nothing; the
	 *  conclude pair rides the user's NEXT input (inputAppends). */
	| { type: "dismiss-problem"; problemCallId: string };

/** Parse and validate a dismissal event off a request body. */
export function parseDismissInput(input: unknown): DismissInput {
	if (typeof input !== "object" || input === null) throw new ChatInputError("input must be an object");
	const i = input as Record<string, unknown>;
	if (i.type === "dismiss-problem") {
		if (typeof i.problemCallId !== "string" || i.problemCallId.length === 0) {
			throw new ChatInputError("dismiss-problem input requires problemCallId");
		}
		return { type: "dismiss-problem", problemCallId: i.problemCallId };
	}
	if (i.type !== "dismiss") throw new ChatInputError(`unknown input type: ${String(i.type)}`);
	if (typeof i.toolCallId !== "string" || i.toolCallId.length === 0) {
		throw new ChatInputError("dismiss input requires toolCallId");
	}
	const answer = i.answer as QuestionAnswerData | undefined;
	if (typeof answer !== "object" || answer === null) {
		throw new ChatInputError("dismiss input requires the dismissal answer object");
	}
	if (answer.dismissed !== true) {
		throw new ChatInputError("dismiss input's answer must be a dismissal (dismissed: true)");
	}
	return { type: "dismiss", toolCallId: i.toolCallId, answer };
}

/** A mid-turn steer (owner arc 2026-10-03): the learner's composer message
 *  for a RUNNING turn — queued on pi's steering rail (agent.steer, drained
 *  at the next response boundary INSIDE the same run). NOT a follow-up:
 *  it never extends an ended run, and it never composes a turn of its own
 *  (a send with no live turn is a plain text send, which already exists).
 *  The id is client-minted (steer_<localid>): the queued indicator keys on
 *  it, and the drain's message events upsert the real card by the same id. */
export type UserSteerInput = { type: "steer"; id: string; text: string };

/** Parse and validate a steer event off a request body. */
export function parseUserSteerInput(input: unknown): UserSteerInput {
	if (typeof input !== "object" || input === null) throw new ChatInputError("input must be an object");
	const i = input as Record<string, unknown>;
	if (i.type !== "steer") throw new ChatInputError(`unknown input type: ${String(i.type)}`);
	if (typeof i.id !== "string" || i.id.length === 0) {
		throw new ChatInputError("steer input requires a client-minted id");
	}
	if (typeof i.text !== "string" || i.text.trim().length === 0) {
		throw new ChatInputError("steer input requires non-empty text");
	}
	return { type: "steer", id: i.id, text: i.text };
}

/** The native appends a dismissal makes (pure — same orphan discipline
 *  as answers: the call must be a DANGLING question call, or — the
 *  practice variant — the ACTIVE problem). */
export function dismissAppends(record: { messages: LhMessage[] }, input: DismissInput): LhMessage[] {
	if (input.type === "dismiss-problem") {
		const active = activeProblemOf(record.messages);
		if (!active || active.toolCallId !== input.problemCallId) {
			throw new ChatInputError("dismiss-problem input targets no active problem");
		}
		return [newProblemDismissedMarker(input.problemCallId)];
	}
	const pending = danglingQuestionOf(record.messages);
	if (!pending || pending.toolCallId !== input.toolCallId) {
		throw new ChatInputError("dismiss input targets no pending question call");
	}
	if (input.answer.kind !== toolQuestionKind(pending.tool)) {
		throw new ChatInputError("dismiss input's answer kind does not match the question");
	}
	return [newAnswerResult(input.toolCallId, pending.tool, input.answer)];
}

export { ChatInputError };

/** The text event: words, pictures (composer paste), or both. The image
 *  rules are the core's (images.ts); an ImageInputError IS a ChatInputError,
 *  so its refusal is the same honest 400. */
function parseTextInput(i: Record<string, unknown>): ChatInput {
	const text = typeof i.text === "string" ? i.text : "";
	const images: ComposerImage[] = i.images === undefined ? [] : parseComposerImages(i.images);
	if (text.trim().length === 0 && images.length === 0) throw new ChatInputError("text input requires non-empty text");
	return { type: "text", text, ...(images.length > 0 ? { images } : {}) };
}

function parseAnswerInput(i: Record<string, unknown>): ChatInput {
	if (typeof i.toolCallId !== "string" || i.toolCallId.length === 0) {
		throw new ChatInputError("answer input requires toolCallId");
	}
	if (typeof i.answer !== "object" || i.answer === null) {
		throw new ChatInputError("answer input requires the graded answer object");
	}
	return { type: "answer", toolCallId: i.toolCallId, answer: i.answer as QuestionAnswerData };
}

function parseThinkingInput(i: Record<string, unknown>): ChatInput {
	if (typeof i.problemCallId !== "string" || i.problemCallId.length === 0) {
		throw new ChatInputError("thinking input requires problemCallId");
	}
	if (typeof i.text !== "string" || i.text.trim().length === 0) {
		throw new ChatInputError("thinking input requires non-empty text");
	}
	return { type: "thinking", problemCallId: i.problemCallId, text: i.text };
}

/** One validating parser per client input type (a Map: no prototype keys). */
const INPUT_PARSERS = new Map<unknown, (i: Record<string, unknown>) => ChatInput>([
	["text", parseTextInput],
	["answer", parseAnswerInput],
	["continue", () => ({ type: "continue" })],
	["thinking", parseThinkingInput],
	["next", () => ({ type: "next" })],
]);

/** Parse and validate an input event off a request body. */
export function parseChatInput(input: unknown): ChatInput {
	if (typeof input !== "object" || input === null) throw new ChatInputError("input must be an object");
	const i = input as Record<string, unknown>;
	const parse = INPUT_PARSERS.get(i.type);
	if (!parse) throw new ChatInputError(`unknown input type: ${String(i.type)}`);
	return parse(i);
}

/**
 * The native appends an input event makes to the record (pure). The caller
 * persists them write-ahead; the agent's context is the record plus these.
 *
 * Answer validation is the orphan-400 discipline: the call must be a
 * DANGLING QUESTION call in the record (posed, never answered) — anything
 * else 400s honestly instead of silently interrupting a question or
 * double-answering.
 */
export function inputAppends(
	record: { messages: LhMessage[]; kind?: string },
	input: ChatInput,
): LhMessage[] {
	switch (input.type) {
		case "text":
			return [...dismissalConclusion(record), newUserMessage(input.text, input.images)];
		case "answer": {
			const pending = danglingQuestionOf(record.messages);
			if (!pending || pending.toolCallId !== input.toolCallId) {
				throw new ChatInputError("answer input targets no pending question call");
			}
			return [newAnswerResult(input.toolCallId, pending.tool, input.answer)];
		}
		case "continue":
			return dismissalConclusion(record);
		case "thinking": {
			const active = activeProblemOf(record.messages);
			if (!active || active.toolCallId !== input.problemCallId) {
				throw new ChatInputError("thinking input targets no active problem");
			}
			return [...dismissalConclusion(record), newThinkingMessage(input.problemCallId, input.text)];
		}
		case "next": {
			// Honest 400s, the thinking gate's discipline: the signal is a
			// between-problems affordance — practice sessions only, nothing
			// active (mid-problem input rides the dock), and the client gates
			// make violations unreachable in practice anyway.
			if (record.kind !== "practice") {
				throw new ChatInputError("next input is a practice-session affordance");
			}
			if (activeProblemOf(record.messages)) {
				throw new ChatInputError("next input requires no active problem");
			}
			return [...dismissalConclusion(record), newNextMessage()];
		}
	}
}

/** The deferred conclude synthesis (owner ruling, 2026-10-04): a
 *  problem-dismissal marker waits for the user's next input — the pair
 *  (synthetic conclude call + ack) rides ahead of it, so the agent reads
 *  the dismissal through its own vocabulary and the slot frees. Pure;
 *  empty when nothing dismissals pend. */
function dismissalConclusion(record: { messages: LhMessage[] }): LhMessage[] {
	const problemCallId = pendingProblemDismissalOf(record.messages);
	return problemCallId ? concludedByDismissalPair(problemCallId) : [];
}

/** Is this tool name a question tool (dock-owned, answer-gated)? */
export function isQuestionTool(name: string): boolean {
	return (QUESTION_TOOLS as readonly string[]).includes(name);
}
