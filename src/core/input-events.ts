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
 *   retry   — retry a failed model response (issue #110), without new
 *             input. Failed attempts stay in the record; only the retry's
 *             temporary agent history omits the trailing failures.
 *
 * (The plan verdict input died 2026-09-26 with the verdict itself — the
 * learner's post-plan reply is a natural text message.)
 *
 * Server-originated delivery (the wake pipeline's steers) is NOT a client
 * input — the handler accepts it on the same path (TurnInput) so every
 * turn rides one composition.
 */

import type { QuestionAnswerData } from "./question-core.ts";
import type { ImageContent } from "@earendil-works/pi-ai";
import { validatePluginSubmissionImageArray, validatePluginSubmissionImages, type PluginSubmissionImages, type PluginSubmissionOccurrence } from "./plugin-submissions.ts";
import type { LhMessage } from "./native-messages.ts";
import {
	activeProblemOf,
	activeProblemOccurrenceOf,
	concludedByDismissalPair,
	danglingQuestionOf,
	newAnswerResult,
	newNextMessage,
	newProblemDismissedMarker,
	newThinkingMessage,
	newUserMessage,
	newMessageId,
	questionCallsOf,
	pluginQuestionCallsOf,
	pendingProblemDismissalOf,
} from "./native-messages.ts";
import { QUESTION_TOOLS, toolQuestionKind } from "./pending.ts";
import { isPluginQuestionJson, type JsonValue, type PluginQuestionOccurrence } from "./plugin-questions.ts";

export type PluginQuestionAnswerInput = { type: "plugin-question-answer"; questionId: string; occurrence: PluginQuestionOccurrence; answer: JsonValue; thinking?: string; readingThinking?: string; images?: PluginSubmissionImages };
export type DismissPluginQuestionInput = { type: "dismiss-plugin-question"; questionId?: string; occurrence: PluginQuestionOccurrence };

/** One client-originated input event (the POST body's `input`). */
export type ChatInput =
	| PluginQuestionAnswerInput
	| { type: "text"; text: string; images?: ImageContent[] }
	| { type: "answer"; toolCallId: string; answer: QuestionAnswerData; occurrence?: PluginSubmissionOccurrence }
	| { type: "continue" }
	/** The failed-turn retry (issue #110): the banner's Retry button. */
	| { type: "retry" }
	/** Explicit replacement of the current malformed question batch. */
	| { type: "retry-question"; messageId: string; contentIndex: number; toolCallId: string }
	/** The practice dock's two buttons (owner, 2026-10-04): the learner's
	 *  thinking on the ACTIVE problem — one lane (owner 2026-10-05):
	 *  whether it claims an answer is read from the text. One
	 *  problem may carry many submissions; each is its own turn. */
	| { type: "thinking"; problemCallId: string; text: string; images?: ImageContent[]; occurrence?: PluginSubmissionOccurrence }
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
	| DismissPluginQuestionInput
	| { type: "dismiss"; toolCallId: string; answer: QuestionAnswerData }
	/** The problem discard (practice, owner 2026-10-04): ask-style — the
	 *  silent route appends the UI-only marker and wakes nothing; the
	 *  conclude pair rides the user's NEXT input (inputAppends). */
	| { type: "dismiss-problem"; problemCallId: string };

/** Parse and validate a dismissal event off a request body. */
export function parseDismissInput(input: unknown): DismissInput {
	if (typeof input !== "object" || input === null) throw new ChatInputError("input must be an object");
	const i = input as Record<string, unknown>;
	if (i.type === "dismiss-plugin-question") {
		if (i.questionId !== undefined && (typeof i.questionId !== "string" || !i.questionId)) throw new ChatInputError("dismiss-plugin-question requires a valid questionId");
		return { type: "dismiss-plugin-question", ...(i.questionId !== undefined ? { questionId: i.questionId as string } : {}), occurrence: parsePluginQuestionOccurrence(i.occurrence) };
	}
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
export type UserSteerInput = { type: "steer"; id: string; text: string; images?: ImageContent[] };

/** Parse and validate a steer event off a request body. */
export function parseUserSteerInput(input: unknown): UserSteerInput {
	if (typeof input !== "object" || input === null) throw new ChatInputError("input must be an object");
	const i = input as Record<string, unknown>;
	if (i.type !== "steer") throw new ChatInputError(`unknown input type: ${String(i.type)}`);
	if (typeof i.id !== "string" || i.id.length === 0) {
		throw new ChatInputError("steer input requires a client-minted id");
	}
	const images = parseImages(i.images);
	if (typeof i.text !== "string" || (!i.text.trim() && !images)) {
		throw new ChatInputError("steer input requires non-empty text or images");
	}
	return { type: "steer", id: i.id, text: i.text, ...(images ? { images } : {}) };
}

/** The native appends a dismissal makes (pure — same orphan discipline
 *  as answers: the call must be a DANGLING question call, or — the
 *  practice variant — the ACTIVE problem). */
export function dismissAppends(record: { messages: LhMessage[] }, input: DismissInput): LhMessage[] {
	assertPluginQuestionInputAllowed(record.messages, input);
	if (input.type === "dismiss-plugin-question") throw new ChatInputError("Plugin question dismissal requires canonical server validation");
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

/** A malformed input event (the honest 400 — the orphan-trap discipline). */
export class ChatInputError extends Error {}

/** New-question gate only: builtin semantics/settings are unchanged. Call
 * before effects and again against saved truth. New protocol requests still
 * require canonical server validation; this guard is not answer validation. */
export function assertPluginQuestionInputAllowed(messages: readonly LhMessage[], input: unknown): void {
	const type = input && typeof input === "object" ? (input as { type?: unknown }).type : undefined;
	if (type === "plugin-question-answer" || type === "dismiss-plugin-question") return;
	if (pluginQuestionCallsOf(messages).some(call => call.status === "answerable" || call.status === "unreadable")) {
		throw new ChatInputError("Answer or dismiss the pending plugin question first");
	}
}

function parsePluginQuestionOccurrence(value: unknown): PluginQuestionOccurrence {
	if (!value || typeof value !== "object") throw new ChatInputError("Plugin question input requires an exact occurrence");
	const o = value as Record<string, unknown>;
	if (typeof o.messageId !== "string" || !o.messageId || typeof o.toolCallId !== "string" || !o.toolCallId || typeof o.toolName !== "string" || !o.toolName || typeof o.contentIndex !== "number" || !Number.isSafeInteger(o.contentIndex) || o.contentIndex < 0) throw new ChatInputError("Plugin question input requires an exact occurrence");
	return { messageId: o.messageId, contentIndex: o.contentIndex, toolCallId: o.toolCallId, toolName: o.toolName };
}

function parseImages(value: unknown): ImageContent[] | undefined {
	if (value === undefined) return undefined;
	try {
		const images = validatePluginSubmissionImageArray(value);
		return images.length ? images : undefined;
	} catch (error) { throw new ChatInputError(error instanceof Error ? error.message : "Invalid submission images"); }
}
function parseImageChannels(value: unknown): PluginSubmissionImages | undefined {
	if (value === undefined) return undefined;
	try {
		const images = validatePluginSubmissionImages(value);
		return Object.keys(images).length ? images : undefined;
	} catch (error) { throw new ChatInputError(error instanceof Error ? error.message : "Invalid submission image channels"); }
}
function parseOptionalOccurrence(value: unknown, images: unknown): PluginSubmissionOccurrence | undefined {
	if (value !== undefined) return parsePluginQuestionOccurrence(value);
	if (images) throw new ChatInputError("Image-bearing submissions require an exact occurrence");
	return undefined;
}

/** Parse and validate an input event off a request body. */
export function parseChatInput(input: unknown): ChatInput {
	if (typeof input !== "object" || input === null) throw new ChatInputError("input must be an object");
	const i = input as Record<string, unknown>;
	switch (i.type) {
		case "plugin-question-answer": {
			if (typeof i.questionId !== "string" || !i.questionId) throw new ChatInputError("plugin-question-answer requires questionId");
			if (!isPluginQuestionJson(i.answer)) throw new ChatInputError("plugin-question-answer requires finite JSON answer");
			if ((i.thinking !== undefined && typeof i.thinking !== "string") || (i.readingThinking !== undefined && typeof i.readingThinking !== "string")) throw new ChatInputError("Plugin question thinking must be text");
			const images = parseImageChannels(i.images);
			return { type: "plugin-question-answer", questionId: i.questionId, occurrence: parsePluginQuestionOccurrence(i.occurrence), answer: i.answer, ...(i.thinking !== undefined ? { thinking: i.thinking as string } : {}), ...(i.readingThinking !== undefined ? { readingThinking: i.readingThinking as string } : {}), ...(images ? { images } : {}) };
		}
		case "text": {
			const images = parseImages(i.images);
			if (typeof i.text !== "string" || (!i.text.trim() && !images)) {
				throw new ChatInputError("text input requires non-empty text or images");
			}
			return { type: "text", text: i.text, ...(images ? { images } : {}) };
		}
		case "answer": {
			if (typeof i.toolCallId !== "string" || i.toolCallId.length === 0) {
				throw new ChatInputError("answer input requires toolCallId");
			}
			if (typeof i.answer !== "object" || i.answer === null) {
				throw new ChatInputError("answer input requires the graded answer object");
			}
			const answer = i.answer as QuestionAnswerData;
			const images = parseImageChannels(answer.images);
			const occurrence = parseOptionalOccurrence(i.occurrence, images);
			const { images: _images, ...fields } = answer;
			return { type: "answer", toolCallId: i.toolCallId, answer: { ...fields, ...(images ? { images } : {}) }, ...(occurrence ? { occurrence } : {}) };
		}
		case "continue":
			return { type: "continue" };
		case "retry":
			return { type: "retry" };
		case "retry-question":
			if (typeof i.messageId !== "string" || !i.messageId || typeof i.toolCallId !== "string" || !i.toolCallId ||
				typeof i.contentIndex !== "number" || !Number.isSafeInteger(i.contentIndex) || i.contentIndex < 0) {
				throw new ChatInputError("retry-question input requires an exact question occurrence");
			}
			return { type: "retry-question", messageId: i.messageId, contentIndex: i.contentIndex, toolCallId: i.toolCallId };
		case "thinking": {
			if (typeof i.problemCallId !== "string" || i.problemCallId.length === 0) {
				throw new ChatInputError("thinking input requires problemCallId");
			}
			const images = parseImages(i.images);
			const occurrence = parseOptionalOccurrence(i.occurrence, images);
			if (typeof i.text !== "string" || (!i.text.trim() && !images)) {
				throw new ChatInputError("thinking input requires non-empty text or images");
			}
			return { type: "thinking", problemCallId: i.problemCallId, text: i.text, ...(images ? { images } : {}), ...(occurrence ? { occurrence } : {}) };
		}
		case "next":
			return { type: "next" };
		default:
			throw new ChatInputError(`unknown input type: ${String(i.type)}`);
	}
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
	assertPluginQuestionInputAllowed(record.messages, input);
	assertNativeSubmissionTarget(record.messages, input);
	switch (input.type) {
		case "plugin-question-answer":
			throw new ChatInputError("Plugin question answers require canonical server validation");
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
		case "retry":
			// The input already landed write-ahead. retryDrops affects only
			// the temporary agent history — nothing new appends here.
			return [];
		case "retry-question":
			return questionRecoveryAppends(record.messages, input);
		case "thinking": {
			const active = activeProblemOf(record.messages);
			if (!active || active.toolCallId !== input.problemCallId) {
				throw new ChatInputError("thinking input targets no active problem");
			}
			return [...dismissalConclusion(record), newThinkingMessage(input.problemCallId, input.text, input.images)];
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

/** Reusable post-await guard against canonical saved truth. Legacy text-only
 * callers retain their existing ID-based contract; fresh images require binding. */
export function assertNativeSubmissionTarget(messages: readonly LhMessage[], input: ChatInput): void {
	if (input.type !== "answer" && input.type !== "thinking") return;
	const hasImages = input.type === "answer"
		? Object.values(input.answer.images ?? {}).some(images => images?.length)
		: !!input.images?.length;
	if (!input.occurrence) {
		if (hasImages) throw new ChatInputError("Image-bearing submissions require an exact occurrence");
		return;
	}
	let occurrence: PluginSubmissionOccurrence | undefined;
	if (input.type === "answer") {
		const pending = questionCallsOf(messages).find(call => call.status === "answerable");
		if (pending && pending.toolCallId === input.toolCallId) occurrence = {
			messageId: pending.messageId, contentIndex: pending.contentIndex, toolCallId: pending.toolCallId, toolName: pending.tool,
		};
	} else {
		const active = activeProblemOccurrenceOf(messages);
		if (active?.toolCallId === input.problemCallId) occurrence = active;
	}
	if (!occurrence || occurrence.messageId !== input.occurrence.messageId || occurrence.contentIndex !== input.occurrence.contentIndex || occurrence.toolCallId !== input.occurrence.toolCallId || occurrence.toolName !== input.occurrence.toolName) {
		throw new ChatInputError("Submission target is no longer active. Refresh the session.");
	}
}

/** Validate before any turn effects, then again against current saved truth.
 * Never accepts a failed/aborted generation (the existing Retry/new-message
 * paths own those), a stale occurrence, or an answerable sibling. */
export function questionRecoveryAppends(
	messages: readonly LhMessage[],
	input: Extract<ChatInput, { type: "retry-question" }>,
): LhMessage[] {
	assertPluginQuestionInputAllowed(messages, input);
	const calls = questionCallsOf(messages);
	const target = calls.find(call => call.messageId === input.messageId && call.contentIndex === input.contentIndex && call.toolCallId === input.toolCallId);
	if (!target || target.status !== "malformed") throw new ChatInputError("This malformed question is no longer available to retry. Refresh the session.");
	if (calls.some(call => call.status === "answerable")) throw new ChatInputError("Answer or discard the remaining question before retrying this one.");
	return calls.filter(call => call.status === "malformed").map(call => ({
		id: newMessageId(), role: "toolResult", toolCallId: call.toolCallId, toolName: call.tool,
		content: [{ type: "text", text: `Tool call "${call.tool}" could not be displayed as a complete question. The learner requested a replacement, not an answer. Re-issue the question with complete, valid arguments.` }],
		details: { questionRecovery: true }, isError: true, timestamp: Date.now(),
	}));
}

/** The failure owning the ephemeral banner. Plan presentation and
 * compaction do not resolve an error; substantive later input/output does.
 * This is deliberately broader than Retry eligibility below. */
export function failedResponseAtEnd(messages: readonly LhMessage[]): Extract<LhMessage, { role: "assistant" }> | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "custom" && (m.customType === "plan-block" || m.customType === "compaction")) continue;
		return m.role === "assistant" && m.stopReason === "error" ? m : undefined;
	}
	return undefined;
}

/** Does the record end in a failure with input that can be retried?
 * Aborts are deliberate stops; compaction after a failure requires new
 * learner input rather than a retry using a changed context. */
export function endsInFailedTurn(messages: readonly LhMessage[]): boolean {
	const { ids, before } = failedTail(messages);
	return ids.size > 0 && before !== undefined && before.role !== "assistant";
}

/** The ids omitted ONLY from the retry's temporary agent history.
 * Failed attempts (including partial text and their ids) stay on disk.
 * Pi's provider conversion already skips error/aborted responses, but
 * continue() rejects an assistant tail BEFORE conversion. Omitting the
 * trailing failures lets that continuation start from the saved input or
 * completed tool results without replaying tools or resubmitting input.
 * Plan blocks may follow the failure and stay; later compaction blocks
 * Retry without changing compaction itself. */
export function retryDrops(messages: readonly LhMessage[]): Set<string> {
	const { ids, before } = failedTail(messages);
	if (ids.size === 0) {
		const failure = failedResponseAtEnd(messages);
		if (failure) {
			throw new ChatInputError(`${failure.errorMessage ?? "An error occurred."}\n\nThis response cannot be retried after compaction. Send a new message to continue.`);
		}
		throw new ChatInputError("retry input requires a failed turn to retry");
	}
	if (!before || before.role === "assistant") throw new ChatInputError("retry input leaves no input to continue from");
	return ids;
}

/** Walk back over failed assistants and UI-only plan blocks. A compaction
 * is a boundary, not a marker Retry may cross. A failure AFTER a compaction
 * can still retry: that compacted context was already its starting state. */
function failedTail(messages: readonly LhMessage[]): { ids: Set<string>; before: LhMessage | undefined } {
	const ids = new Set<string>();
	let i = messages.length - 1;
	for (; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "assistant" && m.stopReason === "error") ids.add(m.id);
		else if (!(m.role === "custom" && m.customType === "plan-block")) break;
	}
	return { ids, before: messages[i] };
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
