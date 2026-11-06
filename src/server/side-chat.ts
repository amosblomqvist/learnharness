/**
 * SIDE QUESTIONS — the server half (inline side questions, owner design
 * 2026-11-02). A side answer is NOT an application turn: it never claims
 * turn liveness, never touches `messages`, never steers, never extracts,
 * never compacts. It may run while a teaching turn runs, while a check is
 * pending, while a problem is active.
 *
 * Lifecycle of one ask:
 *   1. Resolve the session's model through the SAME gates as a turn
 *      (models configured, provider key present) — before anything is
 *      saved, so a refusal leaves no orphan question.
 *   2. One synchronous section: re-read the record, resolve the thread
 *      (existing by id, or a NEW one at a validated teacher-prose anchor —
 *      a block may carry several), refuse a thread already answering,
 *      save the question, register the run.
 *   3. Stream the answer. The run is server-owned: a closed browser tab
 *      detaches the VIEW, never the run — the answer is saved when it
 *      finishes and announced on the event bus.
 *   4. Settle: append the answer (partial + `stopped` on stop, `error` on
 *      failure), log usage into the session's `turns` (the cost meter —
 *      the compaction precedent: an entry keyed to a non-transcript id;
 *      the context meter reads messages only), announce.
 *
 * The NDJSON wire (one JSON object per line):
 *   {"type":"thread","thread":…}  the saved question (first line)
 *   {"type":"text","text":"…"}    the FULL answer so far (replace, never append)
 *   {"type":"done","thread":…}    the settled thread
 *   {"type":"error","error":"…"}  the run could not start/settle
 */

import { emit } from "../core/events.ts";
import type { ChatRecord, SideChatMessage, SideChatThread } from "../core/contracts.ts";
import type { ChatStore } from "../core/ports.ts";
import { newMessageId } from "../core/native-messages.ts";
import {
	anchorPointsAtProse,
	newSideQuestion,
	newSideThread,
	sideChatLessonDocument,
	sideChatModelTurns,
	sideThreadAwaitsAnswer,
	type SideAskInput,
} from "../core/side-chat.ts";
import { resolveConversationSpec } from "../core/settings-resolution.ts";
import { modelsNotConfigured, providerKeyMissing as providerKeyMissingEnvelope } from "../core/settings.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { isSubscriptionProvider } from "../agent/subscription-connections.ts";
import { composeSideChatInstructions, streamSideAnswer } from "../agent/side-chat.ts";
import { composeNoteReviewInstructions } from "../agent/note-review.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { providerKeyPresent } from "./keys.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";

export type SideStreamEvent =
	| { type: "thread"; thread: SideChatThread }
	| { type: "text"; text: string }
	| { type: "done"; thread: SideChatThread }
	| { type: "error"; error: string };

export interface SideChatDeps {
	chatStore: ChatStore;
	/** The session's engine through the turn gates, or the refusal response. */
	engineFor: (record: ChatRecord) => Promise<PiEngine | Response>;
	/** The side model's system prompt for this thread (composed fresh per ask). */
	instructions: (thread: SideChatThread) => string;
}

interface SideRun {
	controller: AbortController;
	text: string;
	listeners: Set<(event: SideStreamEvent) => void>;
	settled: Promise<void>;
}

export interface SideChatService {
	/** The record's threads plus the ids currently answering. Null = unknown chat. */
	list(chatId: string): { threads: SideChatThread[]; answering: Record<string, string> } | null;
	/** Ask (or retry) — the NDJSON streaming response, or a JSON refusal. */
	ask(chatId: string, input: SideAskInput): Promise<Response>;
	/** Open/close a thread's window. */
	setOpen(chatId: string, threadId: string, open: boolean): SideChatThread | "unknown-chat" | "unknown-thread";
	/** Delete a thread (stops its answer first). */
	remove(chatId: string, threadId: string): "ok" | "unknown-chat" | "unknown-thread";
	/** Stop a running answer; false when nothing is running. */
	stop(chatId: string, threadId: string): boolean;
	/** Stop every running answer of a chat (session deletion). */
	stopAll(chatId: string): void;
	/** Test seam: resolves when the thread's run (if any) has settled. */
	settled(chatId: string, threadId: string): Promise<void>;
}

const runKey = (chatId: string, threadId: string) => `${chatId}\u0000${threadId}`;

export function createSideChatService(deps: SideChatDeps): SideChatService {
	const runs = new Map<string, SideRun>();

	function announce(chatId: string): void {
		emit("side-chats-changed", { chatId });
	}

	function list(chatId: string) {
		const record = deps.chatStore.getChat(chatId);
		if (!record) return null;
		const answering: Record<string, string> = {};
		for (const thread of record.sideChats ?? []) {
			const run = runs.get(runKey(chatId, thread.id));
			if (run) answering[thread.id] = run.text;
		}
		return { threads: record.sideChats ?? [], answering };
	}

	async function ask(chatId: string, input: SideAskInput): Promise<Response> {
		const initial = deps.chatStore.getChat(chatId);
		if (!initial) return Response.json({ error: "Unknown chat" }, { status: 404 });
		const engineOrRefusal = await deps.engineFor(initial);
		if (engineOrRefusal instanceof Response) return engineOrRefusal;
		const engine = engineOrRefusal;

		// THE SYNCHRONOUS SECTION — no awaits until the run is registered.
		const record = deps.chatStore.getChat(chatId);
		if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });
		const threads = record.sideChats ?? [];
		let target: SideChatThread | undefined;
		if (input.threadId !== undefined) {
			target = threads.find((t) => t.id === input.threadId);
			if (!target) return Response.json({ error: "Unknown side thread" }, { status: 404 });
		} else if (input.anchor) {
			if (!anchorPointsAtProse(record.messages, input.anchor)) {
				return Response.json({ error: "The anchor does not point at settled teacher prose in this session" }, { status: 400 });
			}
			// Every first question at an anchor is its own thread (window) —
			// a block may carry several (owner, 2026-11-02 follow-up).
			target = newSideThread(input.anchor, undefined, input.review);
		}
		if (!target) return Response.json({ error: "either threadId or anchor is required" }, { status: 400 });
		const key = runKey(chatId, target.id);
		if (runs.has(key)) return Response.json({ error: "This side question is still being answered" }, { status: 409 });

		let thread: SideChatThread;
		if (input.retry) {
			// Retry re-answers the last question: drop a failed answer, keep
			// the question. Anything else has nothing to retry.
			const last = target.messages.at(-1);
			const failed = last?.role === "assistant" && last.error !== undefined;
			if (!failed && !sideThreadAwaitsAnswer(target)) {
				return Response.json({ error: "Nothing to retry in this side thread" }, { status: 409 });
			}
			thread = { ...target, open: true, messages: failed ? target.messages.slice(0, -1) : target.messages };
		} else {
			thread = { ...target, open: true, messages: [...target.messages, newSideQuestion(input.text, input.quotes)] };
		}
		const stored = deps.chatStore.updateSideChats(chatId, (current) =>
			current.some((t) => t.id === thread.id) ? current.map((t) => (t.id === thread.id ? thread : t)) : [...current, thread],
		);
		if (!stored) return Response.json({ error: "Unknown chat" }, { status: 404 });

		const controller = new AbortController();
		const listeners = new Set<(event: SideStreamEvent) => void>();
		const run: SideRun = { controller, text: "", listeners, settled: Promise.resolve() };
		runs.set(key, run);
		const broadcast = (event: SideStreamEvent) => {
			for (const listener of [...listeners]) {
				try {
					listener(event);
				} catch {
					/* a detached view never breaks the run */
				}
			}
		};
		announce(chatId);

		const modelId = `${engine.model.provider}:${engine.model.id}`;
		const turns = sideChatModelTurns(thread, sideChatLessonDocument(record.messages), record.notes ?? "");
		run.settled = (async () => {
			let settledThread: SideChatThread | undefined;
			try {
				const result = await streamSideAnswer({
					engine,
					instructions: deps.instructions(thread),
					turns,
					signal: controller.signal,
					onText: (text) => {
						run.text = text;
						broadcast({ type: "text", text });
					},
				});
				const at = new Date().toISOString();
				const answer: SideChatMessage = {
					id: newMessageId(),
					role: "assistant",
					text: result.text,
					at,
					model: modelId,
					...(result.outcome === "aborted" ? { stopped: true } : {}),
					...(result.outcome === "error" ? { error: result.errorMessage ?? "The model call failed." } : {}),
				};
				deps.chatStore.updateSideChats(chatId, (current) =>
					current.map((t) => {
						if (t.id !== thread.id) return t;
						settledThread = { ...t, messages: [...t.messages, answer] };
						return settledThread;
					}),
				);
				if (result.usage) {
					try {
						deps.chatStore.appendTurnUsage(chatId, {
							id: crypto.randomUUID(),
							messageId: answer.id,
							at,
							model: modelId,
							steps: [
								{
									inputTokens: result.usage.input,
									outputTokens: result.usage.output,
									cacheReadTokens: result.usage.cacheRead,
									cacheWriteTokens: result.usage.cacheWrite,
									cacheWrite1hTokens: result.usage.cacheWrite1h ?? 0,
									reasoningTokens: result.usage.reasoning ?? 0,
								},
							],
						});
					} catch {
						/* the session was deleted mid-answer — nothing to bill against */
					}
				}
			} catch (err) {
				console.error(`[chat ${chatId}] side answer failed to settle:`, err);
				broadcast({ type: "error", error: "The side answer could not be saved." });
			} finally {
				runs.delete(key);
				announce(chatId);
				// The cost meter lives on the record (turns); idle views refetch.
				emit("record-changed", { chatId });
				if (settledThread) broadcast({ type: "done", thread: settledThread });
				listeners.clear();
			}
		})();

		const encoder = new TextEncoder();
		let detach: (() => void) | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(stream) {
				let closed = false;
				const write = (event: SideStreamEvent) => {
					try {
						stream.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
					} catch {
						/* the view went away */
					}
				};
				const close = () => {
					if (closed) return;
					closed = true;
					try {
						stream.close();
					} catch {
						/* already closed */
					}
				};
				const listener = (event: SideStreamEvent) => {
					if (closed) return;
					write(event);
					if (event.type === "done" || event.type === "error") {
						listeners.delete(listener);
						close();
					}
				};
				write({ type: "thread", thread });
				listeners.add(listener);
				detach = () => {
					closed = true;
					listeners.delete(listener);
				};
				// Backstop: a settle that broadcast no terminal (the thread was
				// deleted mid-answer) still ends this view, with stored truth.
				void run.settled.then(() => {
					if (closed) return;
					const latest = deps.chatStore.getChat(chatId)?.sideChats?.find((t) => t.id === thread.id);
					write(latest ? { type: "done", thread: latest } : { type: "error", error: "The side thread is gone." });
					close();
				});
			},
			cancel() {
				// Closing the view detaches it; the answer keeps running and saves.
				detach?.();
			},
		});
		return new Response(body, {
			headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" },
		});
	}

	function setOpen(chatId: string, threadId: string, open: boolean) {
		let found: SideChatThread | undefined;
		const stored = deps.chatStore.updateSideChats(chatId, (current) =>
			current.map((t) => {
				if (t.id !== threadId) return t;
				found = { ...t, open };
				return found;
			}),
		);
		if (!stored) return "unknown-chat" as const;
		if (!found) return "unknown-thread" as const;
		announce(chatId);
		return found;
	}

	function remove(chatId: string, threadId: string) {
		runs.get(runKey(chatId, threadId))?.controller.abort();
		let existed = false;
		const stored = deps.chatStore.updateSideChats(chatId, (current) => {
			existed = current.some((t) => t.id === threadId);
			return current.filter((t) => t.id !== threadId);
		});
		if (!stored) return "unknown-chat" as const;
		if (!existed) return "unknown-thread" as const;
		announce(chatId);
		return "ok" as const;
	}

	function stop(chatId: string, threadId: string): boolean {
		const run = runs.get(runKey(chatId, threadId));
		if (!run) return false;
		run.controller.abort();
		return true;
	}

	function stopAll(chatId: string): void {
		const prefix = `${chatId}\u0000`;
		for (const [key, run] of runs) if (key.startsWith(prefix)) run.controller.abort();
	}

	function settled(chatId: string, threadId: string): Promise<void> {
		return runs.get(runKey(chatId, threadId))?.settled ?? Promise.resolve();
	}

	return { list, ask, setOpen, remove, stop, stopAll, settled };
}

/** Slot policy, read fresh per call (the chat-handler's retentionForSlot). */
function strongRetention() {
	return stores.settingsStore.readSettings()?.models?.strong?.cacheRetention;
}

/** The production engine resolution: the turn's own gate sequence for the
 *  conversation chain (chat override → strong slot), as a FOREGROUND call. */
export async function productionEngineFor(record: ChatRecord): Promise<PiEngine | Response> {
	const effective = effectiveSettings();
	const conversation = resolveConversationSpec(record.settings, effective.models.strong);
	if (!conversation) return Response.json(modelsNotConfigured(["strong"]), { status: 503 });
	if (isSubscriptionProvider(conversation.provider)) await refreshConnectionCatalog(conversation.provider);
	if (!providerKeyPresent(conversation.provider)) {
		return Response.json(providerKeyMissingEnvelope(conversation.provider, ["strong"]), { status: 503 });
	}
	try {
		return piEngineForSpec(conversation, false, undefined, strongRetention);
	} catch {
		return Response.json({ error: "The selected model is unavailable." }, { status: 503 });
	}
}

interface SideChatGlobal {
	__lhSideChatService?: SideChatService;
}

/** The app's ONE side-chat service — on globalThis so separate Next module
 *  entries in one process share the run registry (the jobs precedent). */
export const sideChats: SideChatService = ((globalThis as typeof globalThis & SideChatGlobal).__lhSideChatService ??=
	createSideChatService({
		chatStore: stores.chatStore,
		engineFor: productionEngineFor,
		instructions: (thread) => {
			const switches = effectiveSettings().agent.prompts;
			return thread.review ? composeNoteReviewInstructions(switches) : composeSideChatInstructions(switches);
		},
	}));
