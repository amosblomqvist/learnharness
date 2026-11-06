/**
 * SIDE QUESTIONS: #487's durable threads and quoted visible-lesson model
 * context, combined with #451's shared floating companion and selection.
 *
 * One explanation and its associated question share a tool-less helper
 * conversation. UI history lives in `ChatRecord.sideChats`; main requests
 * append every thread's newly observed exchanges to native history. Published
 * text never changes; later replies and continuations arrive as new entries.
 *
 * This module is the pure half: input validation, thread lookup, and the
 * side model's view of the lesson. The lesson is handed over as a QUOTED
 * DOCUMENT inside the first user turn, never as the model's own history —
 * a forked transcript reads the teacher's words as its own and gets
 * role-confused (the 2026-09-27 side-chat ideation finding).
 *
 * SPOILER RULE (owner, 2026-11-02): the open check (an answerable question
 * call with no result) and the active practice problem appear WITHOUT their
 * hidden half — no answer key, explanation, committed answer or model
 * solution. Answered checks and concluded problems appear in full.
 *
 * Browser-safe: pure logic + types, no node builtins.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ChatRecord, SideChatAnchor, SideChatMessage, SideChatThread } from "./contracts/chat.ts";
import type { LhMarkerMessage, LhMessage } from "./native-messages.ts";
import type { LhViewMessage, LhViewPart } from "./view.ts";
import {
	activeProblemOf,
	failedOutputCallIds,
	newMessageId,
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	questionCallsOf,
	SEND_TO_USER_TOOL,
	sendToUserText,
	userFacingTextOf,
} from "./native-messages.ts";
import { activeCompactionOf, keptIndexFor } from "./compaction.ts";
import { citationsToReadableText, collectCitations } from "./citations.ts";
import { messageMarkdown } from "./session-markdown.ts";
import { normalizeOptions, seededRandom, shuffleOptions, type QuestionAnswerData } from "./question-core.ts";
import { QUESTION_TOOLS, toolQuestionKind } from "./pending.ts";

// ─── shared segment identity and main-agent history ──────────────────────────

/** One explanation and its check share a thread. Native assistant steps and
 * tool traffic do not create new segments; a real learner input does. Side
 * conversation markers are neutral and never split their own source segment. */
function scanSideSegments(messages: readonly LhMessage[]) {
	let segment: string | null = null;
	const byMessage = new Map<string, string | null>();
	for (const message of messages) {
		if (message.role === "user" || (message.role === "toolResult" &&
			(QUESTION_TOOLS as readonly string[]).includes(message.toolName) && !message.isError) ||
			(message.role === "custom" && ["practice-thinking", "practice-next"].includes(message.customType))) {
			segment = null;
		} else if (message.role === "assistant") {
			segment ??= message.id;
		}
		byMessage.set(message.id, segment);
	}
	return { byMessage, current: segment };
}
export function sideSegmentId(messages: readonly LhMessage[], sourceMessageId?: string): string | null {
	const segments = scanSideSegments(messages);
	return sourceMessageId ? segments.byMessage.get(sourceMessageId) ?? null : segments.current;
}

/** Native answer results do not break the continuous assistant view group.
 * Put one quiet entry at each segment boundary within that group, not merely
 * one at the group's end. The final entry is keyed by parts.length. */
export function sideEntryPoints(messages: readonly LhMessage[], view: readonly LhViewMessage[]): ReadonlyMap<string, ReadonlyMap<number, string>> {
	const { byMessage } = scanSideSegments(messages);
	const forParts = (parts: readonly LhViewPart[]) => {
		const entries = new Map<number, string>();
		let source: string | null = null;
		let visible = false;
		for (const [index, part] of parts.entries()) {
			if (part.type === "step-start") {
				const next = byMessage.get(part.sourceMessageId ?? "") ?? null;
				if (next !== source) {
					if (source && visible && !source.startsWith("c_")) entries.set(index, source);
					source = next; visible = false;
				}
			}
			visible ||= (part.type === "text" && !!part.text?.trim()) || part.type === "tool-problem" ||
				(part.type.startsWith("tool-") && (QUESTION_TOOLS as readonly string[]).includes(part.type.slice(5)));
		}
		if (source && visible && !source.startsWith("c_")) entries.set(parts.length, source);
		return entries;
	};
	return new Map(view.filter((message) => message.role === "assistant").map((message) => [message.id, forParts(message.parts)]));
}

function replyState(message: SideChatMessage): string {
	return message.pending ? "pending" : message.stopped ? "stopped" : message.error !== undefined ? "failed" : "complete";
}

/** Delivery watermarks live IN immutable native entries, not in a mutable
 * UI-thread cutoff. Recording text and its watermark is therefore one atomic
 * write. Full native history survives compaction, so these stay recoverable.
 * Legacy one-shot markers seed the same ledger without rewriting them. */
function sideDeliveryLedger(messages: readonly LhMessage[]) {
	const delivered = new Map<string, Map<string, SideChatMessage>>();
	const revisions = new Map<string, number>();
	for (const message of messages) {
		if (message.role !== "custom" || message.customType !== "side-question" || !message.details || typeof message.details !== "object") continue;
		const details = message.details as { threadId?: unknown; updates?: unknown; snapshot?: unknown };
		if (typeof details.threadId !== "string") continue;
		const updates = details.updates ?? details.snapshot;
		if (!Array.isArray(updates)) continue;
		const thread = delivered.get(details.threadId) ?? new Map<string, SideChatMessage>();
		for (const update of updates) {
			if (!update || typeof update.id !== "string" || typeof update.text !== "string" || !["user", "assistant"].includes(update.role)) continue;
			const { append, ...entry } = update as SideChatMessage & { append?: boolean };
			thread.set(entry.id, { ...entry, text: append ? (thread.get(entry.id)?.text ?? "") + entry.text : entry.text });
		}
		delivered.set(details.threadId, thread);
		revisions.set(details.threadId, (revisions.get(details.threadId) ?? 0) + 1);
	}
	return { delivered, revisions };
}

/** Capture only new raw text/status from ALL side conversations. The caller
 * supplies current helper snapshots, including in-flight text, at a main
 * model-request or dismissal boundary. No helper completion waits and no changes to prior entries.
 * `after` includes newly appended tool results, keeping their adjacency. */
export function sideConversationEntries(record: Pick<ChatRecord, "messages" | "sideChats">, after: readonly LhMessage[] = record.messages): LhMarkerMessage[] {
	const { delivered, revisions } = sideDeliveryLedger(after);
	const present = new Set(after.map((message) => message.id));
	const changes: { threadId: string; message: SideChatMessage; previous?: SideChatMessage }[] = [];
	for (const thread of record.sideChats ?? []) {
		const previous = delivered.get(thread.id);
		const current = new Set(thread.messages.map((message) => message.id));
		for (const message of thread.messages) {
			const old = previous?.get(message.id);
			if (!old || old.text !== message.text || replyState(old) !== replyState(message)) changes.push({ threadId: thread.id, message, previous: old });
		}
		// An already-published partial may outlive its ephemeral run after a
		// restart/save failure. Mark it incomplete once; never silently drop it.
		for (const old of previous?.values() ?? []) {
			if (old.pending && !current.has(old.id)) changes.push({ threadId: thread.id, previous: old,
				message: { ...old, pending: false, error: "Reply interrupted before completion", at: new Date().toISOString() } });
		}
	}
	changes.sort((a, b) => (Date.parse(a.message.at) || 0) - (Date.parse(b.message.at) || 0));
	return changes.map(({ threadId, message, previous }) => {
		let revision = (revisions.get(threadId) ?? 0) + 1;
		let id = `exchange_${threadId}_update_${revision}`;
		while (present.has(id)) id = `exchange_${threadId}_update_${++revision}`;
		present.add(id); revisions.set(threadId, revision);
		const extendsPrevious = previous && message.text.startsWith(previous.text);
		const text = !previous ? message.text : extendsPrevious ? message.text.slice(previous.text.length) : message.text;
		const label = message.role === "user" ? "Learner" : "Helper";
		const kind = !previous ? "" : previous.text === message.text ? " (reply status update)" : extendsPrevious ? " (continued reply)" : " (updated wording of the earlier reply)";
		const quoted = !previous ? (message.quotes ?? []).map((quote) => `Quoted tutor passage:\n${quote}`).join("\n\n") : "";
		const status = message.pending ? "\n[This helper reply is still generating; later text will arrive in a subsequent update.]" :
			message.stopped ? "\n[The learner stopped this helper reply; it is incomplete.]" :
			message.error !== undefined ? "\n[This helper reply failed or was interrupted; any recorded text is incomplete.]" :
			previous?.pending ? "\n[This helper reply is now complete.]" : "";
		return {
			id, role: "custom", customType: "side-question",
			content: `Recorded learner–helper conversation update\nConversation: ${threadId}\n\n${quoted ? `${quoted}\n\n` : ""}${label}${kind}:\n${text}${status}\n\nEnd of recorded learner–helper conversation update.`,
			// Store only the new suffix in the ledger too, not a growing full
			// reply copy on every request. Old snapshot entries still decode.
			details: { threadId, updates: [{ ...message, text, append: extendsPrevious === true }] }, display: false, timestamp: Date.parse(message.at) || 0,
		};
	});
}

// ─── limits ──────────────────────────────────────────────────────────────────

/** The longest question the route accepts (characters). */
export const SIDE_QUESTION_MAX_CHARS = 8_000;
/** At most this many attached quotes per question. */
export const SIDE_QUOTES_MAX = 5;
/** Each attached quote / anchor block is clipped to this many characters. */
export const SIDE_QUOTE_MAX_CHARS = 4_000;

// ─── input ───────────────────────────────────────────────────────────────────

export class SideChatInputError extends Error {}

/** One ask: a follow-up in an existing thread (threadId) OR the first
 *  question of a new thread (anchor) — or a RETRY of a thread's failed
 *  last answer (threadId + retry, no text). */
export interface SideAskInput {
	threadId?: string;
	anchor?: SideChatAnchor;
	text: string;
	quotes: string[];
	quoteCitations?: string[];
	retry?: boolean;
	/** Stable across an uncertain POST retry: never generate twice for one ask. */
	requestId?: string;
	/** Current unsubmitted working; reference context, not a submitted answer. */
	working?: string;
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Validate the anchor shape; the server separately checks it points at
 *  real teacher prose in the record. */
export function parseSideAnchor(raw: unknown): SideChatAnchor {
	if (!raw || typeof raw !== "object") throw new SideChatInputError("anchor must be an object");
	const a = raw as Record<string, unknown>;
	if (typeof a.messageId !== "string" || !ID_RE.test(a.messageId)) throw new SideChatInputError("anchor.messageId is invalid");
	if (typeof a.partId !== "string" || !a.partId.startsWith(`${a.messageId}-t`)) throw new SideChatInputError("anchor.partId must belong to anchor.messageId");
	if (typeof a.blockIndex !== "number" || !Number.isSafeInteger(a.blockIndex) || a.blockIndex < 0) {
		throw new SideChatInputError("anchor.blockIndex must be a non-negative integer");
	}
	if (typeof a.blockText !== "string" || !a.blockText.trim()) throw new SideChatInputError("anchor.blockText must be non-empty");
	return {
		messageId: a.messageId,
		partId: a.partId,
		blockIndex: a.blockIndex,
		blockText: clip(a.blockText, SIDE_QUOTE_MAX_CHARS),
	};
}

/** Parse the ask route's body. Throws SideChatInputError on bad shapes. */
export function parseSideAskInput(raw: unknown): SideAskInput {
	if (!raw || typeof raw !== "object") throw new SideChatInputError("body must be an object");
	const body = raw as Record<string, unknown>;
	if (body.requestId !== undefined && (typeof body.requestId !== "string" || !ID_RE.test(body.requestId))) throw new SideChatInputError("requestId is invalid");
	if (body.working !== undefined && (typeof body.working !== "string" || body.working.length > SIDE_QUESTION_MAX_CHARS)) throw new SideChatInputError("working is invalid or too long");
	const extra = { ...(typeof body.requestId === "string" ? { requestId: body.requestId } : {}), ...(typeof body.working === "string" ? { working: body.working } : {}) };
	if (body.retry === true) {
		if (typeof body.threadId !== "string" || !ID_RE.test(body.threadId)) throw new SideChatInputError("retry needs a valid threadId");
		return { threadId: body.threadId, text: "", quotes: [], retry: true, ...extra };
	}
	const text = typeof body.text === "string" ? body.text.trim() : "";
	if (!text) throw new SideChatInputError("text must be a non-empty string");
	if (text.length > SIDE_QUESTION_MAX_CHARS) throw new SideChatInputError(`text exceeds ${SIDE_QUESTION_MAX_CHARS} characters`);
	const quotesRaw = body.quotes ?? [];
	if (!Array.isArray(quotesRaw) || quotesRaw.some((q) => typeof q !== "string")) {
		throw new SideChatInputError("quotes must be an array of strings");
	}
	const quotes = (quotesRaw as string[]).map((q) => q.trim()).filter(Boolean);
	if (quotes.length > SIDE_QUOTES_MAX) throw new SideChatInputError(`at most ${SIDE_QUOTES_MAX} quotes per question`);
	const quoteCitations = body.quoteCitations;
	if (quoteCitations !== undefined) {
		if (!Array.isArray(quoteCitations) || quoteCitations.length !== quotes.length || quotes.length !== quotesRaw.length) throw new SideChatInputError("quoteCitations must match the quotes");
		for (const [index, value] of quoteCitations.entries()) {
			const citation = typeof value === "string" && value.length <= 128_000 ? collectCitations(value) : [];
			if (citation.length !== 1 || citation[0]!.source !== value || citation[0]!.citation.text.trim() !== clip(quotes[index]!, SIDE_QUOTE_MAX_CHARS)) throw new SideChatInputError("quote citation is invalid or does not match its passage");
		}
	}
	const references = quoteCitations === undefined ? {} : { quoteCitations: quoteCitations as string[] };
	const threadId = body.threadId;
	if (threadId !== undefined) {
		if (typeof threadId !== "string" || !ID_RE.test(threadId)) throw new SideChatInputError("threadId is invalid");
		return { threadId, text, quotes: quotes.map((q) => clip(q, SIDE_QUOTE_MAX_CHARS)), ...extra, ...references };
	}
	if (body.anchor === undefined) throw new SideChatInputError("either threadId or anchor is required");
	return { anchor: parseSideAnchor(body.anchor), text, quotes: quotes.map((q) => clip(q, SIDE_QUOTE_MAX_CHARS)), ...extra, ...references };
}

/** Parse the window-state body ({open: boolean}). */
export function parseSideOpenInput(raw: unknown): boolean {
	const open = (raw as { open?: unknown } | null)?.open;
	if (typeof open !== "boolean") throw new SideChatInputError("open must be a boolean");
	return open;
}

// ─── threads ─────────────────────────────────────────────────────────────────

export function newSideThreadId(): string {
	return `side_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

export function newSideThread(anchor: SideChatAnchor, at = new Date().toISOString()): SideChatThread {
	return { id: `side_${anchor.messageId}`, anchor, open: true, createdAt: at, messages: [] };
}

export function newSideQuestion(text: string, quotes: readonly string[], at = new Date().toISOString()): SideChatMessage {
	return { id: newMessageId(), role: "user", text, ...(quotes.length > 0 ? { quotes: [...quotes] } : {}), at };
}

/** Is `partId` real, settled teacher prose in this record? The anchor's
 *  message must be a non-failed assistant message with that text part. */
export function anchorPointsAtProse(messages: readonly LhMessage[], anchor: SideChatAnchor): boolean {
	const message = messages.find((m) => m.id === anchor.messageId);
	if (!message || message.role !== "assistant") return false;
	const assistant = message as AssistantMessage;
	if (assistant.stopReason === "pending") return false;
	const suffix = anchor.partId.slice(`${anchor.messageId}-t`.length);
	if (!/^\d+$/.test(suffix)) return false;
	return Number(suffix) < textPartCount(assistant, failedOutputCallIds(messages));
}

/** How many `-t<n>` text parts projectView mints for this message: every
 *  text block (empty ones too), plus delivered send_to_user prose — the
 *  exact numbering rule of view.ts, so anchors agree with the rendering. */
function textPartCount(assistant: AssistantMessage, failedOutputs: ReadonlySet<string>): number {
	const failedGeneration = assistant.stopReason === "error" || assistant.stopReason === "aborted";
	let n = 0;
	for (const block of assistant.content) {
		if (block.type === "text") n++;
		else if (block.type === "toolCall" && block.name === SEND_TO_USER_TOOL) {
			if (failedGeneration || failedOutputs.has(block.id)) continue;
			if (sendToUserText(block) !== undefined) n++;
		}
	}
	return n;
}

// ─── the lesson document (the side model's view of the session) ─────────────

function quizHeading(answer: QuestionAnswerData, tool: string): string {
	if (tool === "probe") return "Probe";
	if (tool === "recall") return "Recall question";
	if (tool === "explain") return "Explain question";
	if (tool === "ask_user_question") return "Question to the learner";
	return answer.questionType === "predict" ? "Prediction question" : "Check question";
}

/** An ANSWERED question in full: options with the key, the learner's
 *  answer, the verdict and the explanation/committed answer. */
function answeredQuestionMarkdown(result: ToolResultMessage, input: Record<string, unknown> | undefined): string | null {
	const answer = result.details as QuestionAnswerData | undefined;
	if (!answer || typeof answer !== "object" || typeof answer.questionText !== "string") return null;
	const lines: string[] = [`### ${quizHeading(answer, result.toolName)} (answered)`];
	if (typeof answer.readingThinking === "string" && answer.readingThinking.trim()) {
		lines.push(`*The learner's notes while reading, before this question:* ${answer.readingThinking.trim()}`);
	}
	lines.push(`**Q:** ${answer.questionText}`);
	const details = typeof input?.details === "string" ? input.details.trim() : "";
	if (details) lines.push(details);
	if (answer.dismissed) {
		lines.push("The learner skipped this question.");
		return lines.join("\n\n");
	}
	const chosen = new Set((answer.answers ?? []).map((a) => a.index));
	const correct = new Set(answer.correctIndices ?? []);
	const isQuiz = answer.kind === "quiz";
	if (answer.options && answer.options.length > 0) {
		lines.push(
			answer.options
				.map((o) => {
					const marks = [isQuiz && correct.has(o.index) ? "correct" : "", chosen.has(o.index) ? "chosen by the learner" : ""].filter(Boolean);
					return `- ${o.label}${marks.length > 0 ? ` *(${marks.join(", ")})*` : ""}`;
				})
				.join("\n"),
		);
	}
	if (answer.other) lines.push(`The learner wrote their own option: "${answer.other}"`);
	if (answer.text) lines.push(`The learner answered: "${answer.text}"`);
	if (answer.dontKnow) lines.push("The learner answered \"I don't know\".");
	if (isQuiz && !answer.dontKnow && typeof answer.correct === "boolean") {
		lines.push(`Verdict: ${answer.correct ? "correct" : "incorrect"}.`);
	}
	if (typeof answer.confidence === "number") lines.push(`The learner's stated confidence: ${answer.confidence}%.`);
	const thinking = answer.thinking ?? answer.note;
	if (typeof thinking === "string" && thinking.trim()) lines.push(`*The learner's thinking:* ${thinking.trim()}`);
	if (answer.explanation) lines.push(`**Explanation shown to the learner:** ${answer.explanation}`);
	if (answer.committed) lines.push(`**The teacher's committed answer, shown to the learner:** ${answer.committed}`);
	return lines.join("\n\n");
}

/** An OPEN question: the learner-visible half only — never the key. */
function openQuestionMarkdown(tool: string, input: unknown, toolCallId: string): string | null {
	if (!input || typeof input !== "object") return null;
	const args = input as Record<string, unknown>;
	const question = typeof args.question === "string" ? args.question.trim() : "";
	if (!question) return null;
	const lines = ["### OPEN question — the learner has not answered it yet (its answer key is hidden from you)", `**Q:** ${question}`];
	const details = typeof args.details === "string" ? args.details.trim() : "";
	if (details) lines.push(details);
	if (tool !== "explain" && tool !== "recall") {
		const rawOptions = normalizeOptions(args.options as Parameters<typeof normalizeOptions>[0]);
		const options = toolQuestionKind(tool) === "quiz" ? shuffleOptions(rawOptions, seededRandom(toolCallId)) : rawOptions;
		if (options.length > 0) lines.push(options.map((o, index) => `${index + 1}. ${o.label}`).join("\n"));
	}
	return lines.join("\n\n");
}

/** The practice pose: statement only. Open ⇔ it is the active problem. */
function problemMarkdown(args: Record<string, unknown> | undefined, open: boolean): string | null {
	const statement = typeof args?.statement === "string" ? args.statement.trim() : "";
	if (!statement) return null;
	return open
		? `### OPEN problem — the learner is working on it now (its solution is hidden from you)\n\n${statement}`
		: `### Problem\n\n${statement}`;
}

/**
 * The lesson as one markdown document for the side model. Honors the
 * active compaction cut (retained tail, never its private summary).
 * An open assessment is preserved even before the cut. Teacher prose, learner text, practice
 * thinking, answered/open questions and practice problems render; other
 * tool traffic and scaffolding markers do not.
 */
export function sideChatLessonDocument(messages: readonly LhMessage[]): string {
	const blocks: string[] = [];
	let start = 0;
	const marker = activeCompactionOf(messages);
	if (marker) {
		const kept = keptIndexFor(messages, marker);
		if (kept >= 0) {
			start = kept;
			// A model-private summary may contain the open assessment's key.
			blocks.push("### Earlier session history\n\nEarlier history is omitted after compaction; its private summary is not supplied to the helper.");
		}
	}
	const calls = new Map<string, { name: string; args: Record<string, unknown> | undefined }>();
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const block of (m as AssistantMessage).content) {
			if (block.type === "toolCall") calls.set(block.id, { name: block.name, args: block.arguments as Record<string, unknown> | undefined });
		}
	}
	const openQuestions = new Set(questionCallsOf(messages).filter((c) => c.status === "answerable").map((c) => c.toolCallId));
	const activeProblem = activeProblemOf(messages)?.toolCallId ?? null;
	const failedOutputs = failedOutputCallIds(messages);
	// An assessment can outlive the retained tail: keep its visible question
	// or statement without recovering the private summary or answer key.
	for (const m of messages.slice(0, start)) {
		if (m.role === "assistant") for (const block of m.content) {
			if (block.type === "toolCall" && openQuestions.has(block.id)) {
				const open = openQuestionMarkdown(block.name, block.arguments, block.id);
				if (open) blocks.push(open);
			}
		}
		if (m.role === "toolResult" && m.toolCallId === activeProblem && !m.isError) {
			const problem = problemMarkdown(calls.get(m.toolCallId)?.args, true);
			if (problem) blocks.push(problem);
		}
	}

	for (const m of messages.slice(start)) {
		if (m.role === "user") {
			for (const text of userFacingTextOf(m.content)) blocks.push(`### Learner\n\n${text.trim()}`);
		} else if (m.role === "assistant") {
			const assistant = m as AssistantMessage;
			for (const text of userFacingTextOf(assistant.content, failedOutputs)) blocks.push(`### Teacher\n\n${text.trim()}`);
			for (const block of assistant.content) {
				if (block.type === "toolCall" && openQuestions.has(block.id)) {
					const open = openQuestionMarkdown(block.name, block.arguments, block.id);
					if (open) blocks.push(open);
				}
			}
		} else if (m.role === "toolResult") {
			const result = m as ToolResultMessage;
			if (result.isError) continue;
			if ((QUESTION_TOOLS as readonly string[]).includes(result.toolName)) {
				const md = answeredQuestionMarkdown(result, calls.get(result.toolCallId)?.args);
				if (md) blocks.push(md);
			} else if (result.toolName === PRACTICE_PROBLEM_TOOL) {
				const md = problemMarkdown(calls.get(result.toolCallId)?.args, result.toolCallId === activeProblem);
				if (md) blocks.push(md);
			} else if (result.toolName === PRACTICE_CONCLUDE_TOOL) {
				// Concluded: the shared engine reveals the committed solution.
				const md = messageMarkdown(m, m.id, false, { messages, calls, failedOutputCalls: failedOutputs });
				if (md) blocks.push(md);
			}
		} else if (m.role === "custom") {
			const marker = m as LhMarkerMessage;
			if (marker.customType === "practice-thinking") {
				const text = (marker.details as { text?: unknown } | null)?.text;
				if (typeof text === "string" && text.trim()) blocks.push(`### Learner (thinking on the problem)\n\n${text.trim()}`);
			}
		}
	}
	return citationsToReadableText(blocks.join("\n\n"));
}

// ─── the model turns ─────────────────────────────────────────────────────────

/** One text turn for the side model (the agent layer maps these onto
 *  native user/assistant messages). */
export interface SideModelTurn {
	role: "user" | "assistant";
	text: string;
}

function quoteBlocks(quotes: readonly string[] | undefined): string {
	return (quotes ?? []).map((q) => `<quote>\n${q}\n</quote>`).join("\n\n");
}

/**
 * The full turn list for answering the thread's LAST (unanswered) user
 * message. The lesson document and the anchor passage ride the first
 * user turn; earlier answers replay as assistant turns (a failed or
 * stopped answer keeps its partial text plus a note, so roles alternate).
 */
export function sideChatModelTurns(thread: SideChatThread, lessonDocument: string): SideModelTurn[] {
	const turns: SideModelTurn[] = [];
	thread.messages.forEach((message, i) => {
		if (message.role === "user") {
			const parts: string[] = [];
			if (i === 0) {
				parts.push(
					`<lesson>\n${lessonDocument || "(The session has no teaching content yet.)"}\n</lesson>`,
					`The learner opened this side question on the following passage of the lesson:\n\n<passage>\n${thread.anchor.blockText}\n</passage>`,
				);
			}
			const quotes = quoteBlocks(message.quotes);
			if (quotes) parts.push(`The learner highlighted:\n\n${quotes}`);
			parts.push(`Side question: ${message.text}`);
			turns.push({ role: "user", text: parts.join("\n\n") });
		} else {
			const notes: string[] = [];
			if (message.stopped) notes.push("(The learner stopped this answer here.)");
			if (message.error) notes.push("(This answer failed before it finished.)");
			const text = [message.text.trim(), ...notes].filter(Boolean).join("\n\n");
			turns.push({ role: "assistant", text: text || "(No answer was produced.)" });
		}
	});
	return turns;
}

/** Does the thread end in a question still waiting for an answer? */
export function sideThreadAwaitsAnswer(thread: SideChatThread): boolean {
	return thread.messages.at(-1)?.role === "user";
}
