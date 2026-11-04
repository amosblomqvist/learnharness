/**
 * SIDE QUESTIONS (#16), server half. The answer route runs the side agent
 * (agent/subagents/side-question.ts) over the saved record and streams
 * its answer; it never starts a turn and never writes a message. The
 * thread lives on the client until it closes.
 *
 * Gates mirror the turn's (P3): 404 unknown chat, 400 practice session or
 * bad body, 503 for no model / no provider key, the subscription catalog
 * refresh, and the compaction gate (nothing model-facing interleaves with
 * a running compaction).
 *
 * Runs never abort on a client disconnect (F9): the answer finishes in
 * the background and is held in a registry keyed by thread id, so a close
 * that arrives mid-answer can wait for it.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { isSubscriptionProvider } from "../agent/subscription-connections.ts";
import { runSideQuestion } from "../agent/subagents/side-question.ts";
import type { CallUsage } from "../core/contracts.ts";
import { emit } from "../core/events.ts";
import { danglingQuestionOf, hasUnresolvedQuestion, type LhMarkerMessage, type LhMessage } from "../core/native-messages.ts";
import type { ChatStore } from "../core/ports.ts";
import { ChatInputError } from "../core/input-events.ts";
import { modelsNotConfigured, providerKeyMissing } from "../core/settings.ts";
import { resolveSideQuestionSpec, type EffectiveModelSpec } from "../core/settings-resolution.ts";
import {
	finalTell,
	newSideQuestionMarker,
	newSideQuestionToldMarker,
	parseSideCloseInput,
	parseSideQuestionInput,
	sideTranscript,
	sideUserMessage,
	type SideCloseInput,
	type SideNote,
	type SidePair,
	type SideQuestionDetails,
	type SideQuestionInput,
} from "../core/side-questions.ts";
import { awaitCompaction } from "./compaction.ts";
import { providerKeyPresent } from "./keys.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

export type SideAnswerPair = SidePair & SideNote;

// ─── the in-flight registry (globalThis: routes share one module world) ─────

interface InFlightAnswer {
	question: string;
	answer: Promise<SideAnswerPair | null>;
}

/** How long a finished answer stays claimable by a late close. */
const SETTLED_ANSWER_TTL_MS = 10 * 60_000;

function inFlight(): Map<string, InFlightAnswer> {
	const g = globalThis as typeof globalThis & { __lhSideAnswers?: Map<string, InFlightAnswer> };
	return (g.__lhSideAnswers ??= new Map());
}

/** The thread's latest answer run (in flight, or settled within the TTL):
 *  resolves to its pair, or null when the run failed. */
export function inFlightSideAnswer(threadId: string): InFlightAnswer | undefined {
	return inFlight().get(threadId);
}

/** A close took the answer: it may not be claimed twice. */
export function forgetSideAnswer(threadId: string, entry: InFlightAnswer): void {
	if (inFlight().get(threadId) === entry) inFlight().delete(threadId);
}

function register(threadId: string, entry: InFlightAnswer): void {
	inFlight().set(threadId, entry);
	void entry.answer.finally(() => {
		setTimeout(() => forgetSideAnswer(threadId, entry), SETTLED_ANSWER_TTL_MS).unref?.();
	});
}

// ─── the answer route ────────────────────────────────────────────────────────

export interface SideQuestionDeps {
	/** Test seam: builds the engine from the resolved spec. */
	engineFor?: (spec: EffectiveModelSpec) => PiEngine;
}

/** P6: the note the toggle sends when the agent wrote none. */
export function fallbackSideNote(firstQuestion: string): SideNote {
	return { tell: false, note: `Already clarified in a side question: the learner asked "${firstQuestion}".` };
}

function toCallUsage(usage: Usage): CallUsage {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
		reasoningTokens: usage.reasoning ?? 0,
	};
}

const encoder = new TextEncoder();

export async function handleSideQuestion(chatId: string, body: unknown, deps: SideQuestionDeps = {}): Promise<Response> {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });
	if (record.kind === "practice") return Response.json({ error: "Side questions are for teaching sessions" }, { status: 400 });
	let input: SideQuestionInput;
	try { input = parseSideQuestionInput(body); }
	catch (err) {
		if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
	// A thread opened from the waiting question must name that very call.
	if (input.questionCallId !== undefined && danglingQuestionOf(record.messages)?.toolCallId !== input.questionCallId) {
		return Response.json({ error: "questionCallId is not the question waiting for the learner" }, { status: 400 });
	}

	const spec = resolveSideQuestionSpec(record.settings, stores.settingsStore.readSettings());
	if (!spec) return Response.json(modelsNotConfigured(["strong"]), { status: 503 });
	if (isSubscriptionProvider(spec.provider)) await refreshConnectionCatalog(spec.provider);
	if (!providerKeyPresent(spec.provider)) return Response.json(providerKeyMissing(spec.provider, ["strong"]), { status: 503 });
	let engine: PiEngine;
	try {
		engine = deps.engineFor
			? deps.engineFor(spec)
			: piEngineForSpec(spec, false, undefined, () => stores.settingsStore.readSettings()?.models?.strong?.cacheRetention);
	} catch {
		return Response.json({ error: "The selected model is unavailable." }, { status: 503 });
	}

	// The conversation up to the last saved message, after any compaction.
	await awaitCompaction(chatId);
	const current = stores.chatStore.getChat(chatId);
	if (!current) return Response.json({ error: "Unknown chat" }, { status: 404 });
	const userMessage = sideUserMessage(sideTranscript(current.messages), input);

	// Frames buffer until the client reads; a disconnect only stops delivery.
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	const pending: string[] = [];
	const send = (frame: unknown) => {
		const chunk = frame === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(frame)}\n\n`;
		if (controller) {
			try { controller.enqueue(encoder.encode(chunk)); } catch { controller = null; }
		} else pending.push(chunk);
	};
	let finished = false;
	const finish = () => {
		finished = true;
		if (controller) { try { controller.close(); } catch { /* the client left */ } controller = null; }
	};

	const answer = (async (): Promise<SideAnswerPair | null> => {
		try {
			const result = await runSideQuestion({
				engine,
				userMessage,
				chatId,
				pendingQuestion: input.questionCallId !== undefined,
				onText: (delta) => send({ type: "text", delta }),
				onTool: (name, label) => send({ type: "tool", name, label }),
			});
			if (result.usage.length) {
				try {
					stores.chatStore.appendTurnUsage(chatId, {
						id: crypto.randomUUID(),
						// P5: the thread id becomes the marker's id at close.
						messageId: input.threadId,
						at: new Date().toISOString(),
						model: `${engine.model.provider}:${engine.model.id}`,
						steps: result.usage.map(toCallUsage),
					});
				} catch (err) {
					console.error(`[chat ${chatId}] side question usage append failed:`, err);
				}
			}
			const note = result.note ?? fallbackSideNote(input.thread[0]?.question ?? input.question);
			send({ type: "note", tell: note.tell, note: note.note });
			return {
				question: input.question,
				answer: result.answer,
				...(input.passage !== undefined ? { passage: input.passage } : {}),
				...(input.sourceMessageId !== undefined ? { sourceMessageId: input.sourceMessageId } : {}),
				...(input.selector !== undefined ? { selector: input.selector } : {}),
				...note,
			};
		} catch (err) {
			console.error(`[chat ${chatId}] side question failed:`, err);
			send({ type: "error", errorText: "The side question failed. Try asking again." });
			return null;
		} finally {
			send("[DONE]");
			finish();
		}
	})();
	register(input.threadId, { question: input.question, answer });

	return new Response(
		new ReadableStream<Uint8Array>({
			start(c) {
				for (const chunk of pending.splice(0)) c.enqueue(encoder.encode(chunk));
				if (finished) c.close();
				else controller = c;
			},
			cancel() {
				controller = null; // the run continues (F9)
			},
		}),
		{ headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } },
	);
}

// ─── commit, park and flush (Task 5) ─────────────────────────────────────────
//
// A closed thread's marker may not land while a turn runs (persistTurn
// appends the turn's messages past the record it started from) or while a
// tutor question waits (its answer must sit right after its call, F5). It
// is PARKED instead — the dismissal-park discipline: a globalThis queue
// per chat, order kept — and flushed at the next point the lesson can take
// it: turn settle (success or failure), right after an answer or before a
// text message (handleChatInput's write-ahead), and after a dismissal.

function parked(): Map<string, LhMarkerMessage[]> {
	const g = globalThis as typeof globalThis & { __lhParkedSideQuestions?: Map<string, LhMarkerMessage[]> };
	return (g.__lhParkedSideQuestions ??= new Map());
}

/** Is this thread already saved or waiting to be? (A close is idempotent.) */
export function sideQuestionKnown(chatStore: ChatStore, chatId: string, threadId: string): boolean {
	if (parked().get(chatId)?.some((m) => m.id === threadId)) return true;
	return chatStore.getChat(chatId)?.messages.some((m) => m.id === threadId) ?? false;
}

/** Append now when the lesson can take it, else park. */
export function commitSideQuestion(chatStore: ChatStore, chatId: string, marker: LhMarkerMessage): "committed" | "parked" {
	const queue = parked().get(chatId) ?? [];
	const record = chatStore.getChat(chatId);
	if (!record || isTurnRunning(chatId) || hasUnresolvedQuestion(record.messages)) {
		parked().set(chatId, [...queue, marker]);
		return "parked";
	}
	parked().delete(chatId);
	chatStore.saveMessages(chatId, [...record.messages, ...queue, marker as LhMessage]);
	emit("record-changed", { chatId });
	return "committed";
}

/** Take the parked markers if they may follow `messagesAfter` (the record
 *  as it will stand just before them); [] while a question would dangle. */
export function takeFlushableSideQuestions(chatId: string, messagesAfter: readonly LhMessage[]): LhMessage[] {
	const queue = parked().get(chatId);
	if (!queue?.length || hasUnresolvedQuestion(messagesAfter)) return [];
	parked().delete(chatId);
	return queue as LhMessage[];
}

/** Put markers back at the front of the queue (their save failed). */
export function restoreParkedSideQuestions(chatId: string, markers: readonly LhMessage[]): void {
	if (!markers.length) return;
	parked().set(chatId, [...(markers as LhMarkerMessage[]), ...(parked().get(chatId) ?? [])]);
}

/** The settle paths and the dismiss route: append whatever may land now. */
export function flushParkedSideQuestions(chatStore: ChatStore, chatId: string): void {
	const record = chatStore.getChat(chatId);
	if (!record) return;
	const markers = takeFlushableSideQuestions(chatId, record.messages);
	if (!markers.length) return;
	try {
		chatStore.saveMessages(chatId, [...record.messages, ...markers]);
	} catch (err) {
		restoreParkedSideQuestions(chatId, markers);
		throw err;
	}
	emit("record-changed", { chatId });
}

// ─── the close route (Task 6) ────────────────────────────────────────────────

/** Threads whose close is waiting for a late answer (a repeat is a no-op). */
function closing(): Set<string> {
	const g = globalThis as typeof globalThis & { __lhClosingSideThreads?: Set<string> };
	return (g.__lhClosingSideThreads ??= new Set());
}

/** Build and commit the marker; null when nothing was answered. */
function commitThread(chatId: string, input: SideCloseInput, pairs: SideAnswerPair[]): "committed" | "parked" | null {
	if (!pairs.length) return null;
	const thread = pairs.map(({ tell: _tell, note: _note, ...pair }) => pair);
	const marker = newSideQuestionMarker(input.threadId, {
		thread,
		note: pairs[pairs.length - 1]!.note,
		toldTutor: finalTell(pairs, input.learnerTell),
		...(input.continues !== undefined ? { continues: input.continues } : {}),
	});
	return commitSideQuestion(stores.chatStore, chatId, marker);
}

/**
 * POST /api/chats/[id]/side-question/close — commit a closed thread: 200
 * committed, 202 parked (or waiting for an answer still streaming, F9),
 * 204 nothing to save. Idempotent per thread id.
 */
export async function handleSideClose(chatId: string, body: unknown): Promise<Response> {
	if (!stores.chatStore.getChat(chatId)) return Response.json({ error: "Unknown chat" }, { status: 404 });
	let input: SideCloseInput;
	try { input = parseSideCloseInput(body); }
	catch (err) {
		if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
	const key = `${chatId}\u0000${input.threadId}`;
	if (closing().has(key) || sideQuestionKnown(stores.chatStore, chatId, input.threadId)) return Response.json({ ok: true });
	await awaitCompaction(chatId);

	const entry = input.pending ? inFlightSideAnswer(input.threadId) : undefined;
	if (entry && entry.question === input.pending!.question) {
		closing().add(key);
		void entry.answer
			.then(async (late) => {
				forgetSideAnswer(input.threadId, entry);
				await awaitCompaction(chatId);
				if (!stores.chatStore.getChat(chatId) || sideQuestionKnown(stores.chatStore, chatId, input.threadId)) return;
				commitThread(chatId, input, late ? [...input.thread, late] : input.thread);
			})
			.catch((err) => console.error(`[chat ${chatId}] side thread failed to save:`, err))
			.finally(() => closing().delete(key));
		return Response.json({ ok: true, waiting: true }, { status: 202 });
	}

	// An unanswered question with no run behind it is dropped.
	const outcome = commitThread(chatId, input, input.thread);
	if (outcome === null) return new Response(null, { status: 204 });
	return outcome === "parked" ? Response.json({ ok: true, parked: true }, { status: 202 }) : Response.json({ ok: true });
}

// ─── tell the tutor later (Addendum 2026-10-31) ─────────────────────────────

/**
 * POST /api/chats/[id]/side-question/tell — a thread kept private is told
 * after all: its saved note lands at the record's end as a
 * side-question-told marker, parked like a close. 200 told (or already
 * told), 202 parked, 404 unknown thread, 409 still saving.
 */
export async function handleSideTell(chatId: string, body: unknown): Promise<Response> {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });
	const threadId = (body as { threadId?: unknown } | null)?.threadId;
	if (typeof threadId !== "string" || !threadId) return Response.json({ error: "threadId must be a non-empty string" }, { status: 400 });
	if (closing().has(`${chatId}\u0000${threadId}`)) return Response.json({ error: "The side thread is still being saved" }, { status: 409 });

	const known = [...record.messages, ...(parked().get(chatId) ?? [])];
	const thread = known.find((m) => m.id === threadId && m.role === "custom" && m.customType === "side-question") as LhMarkerMessage | undefined;
	if (!thread) return Response.json({ error: "Unknown side thread" }, { status: 404 });
	const details = thread.details as SideQuestionDetails;
	const toldId = `${threadId}_told`;
	if (details.toldTutor || known.some((m) => m.id === toldId)) return Response.json({ ok: true });

	await awaitCompaction(chatId);
	if (sideQuestionKnown(stores.chatStore, chatId, toldId)) return Response.json({ ok: true });
	const outcome = commitSideQuestion(stores.chatStore, chatId, newSideQuestionToldMarker(threadId, details.note));
	return outcome === "parked" ? Response.json({ ok: true, parked: true }, { status: 202 }) : Response.json({ ok: true });
}
