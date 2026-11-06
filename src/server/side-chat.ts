/** Combined side-question service: #487's durable, server-owned lifecycle
 * behind #451's floating companion. One thread per explanation/check segment.
 * Main submission freezes a separate raw context snapshot; later side activity
 * stays usable in the UI and cannot change that snapshot. */
import { emit } from "../core/events.ts";
import type { ChatRecord, SideChatMessage, SideChatThread } from "../core/contracts.ts";
import type { ChatStore } from "../core/ports.ts";
import { failedOutputCallIds, newMessageId, userFacingTextOf } from "../core/native-messages.ts";
import {
	newSideQuestion, newSideThread, sideSegmentId, sideChatLessonDocument,
	sideChatModelTurns, sideThreadAwaitsAnswer, type SideAskInput,
} from "../core/side-chat.ts";
import { COMPACTION_RESERVE_TOKENS } from "../core/compaction.ts";
import { resolveSideQuestionSpec } from "../core/settings-resolution.ts";
import { modelsNotConfigured, providerKeyMissing as providerKeyMissingEnvelope } from "../core/settings.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { isSubscriptionProvider } from "../agent/subscription-connections.ts";
import { usageWasAdmitted } from "../agent/subscription-request-cycle.ts";
import { composeSideChatInstructions, streamSideAnswer } from "../agent/side-chat.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { providerKeyPresent } from "./keys.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";
import { awaitCompaction } from "./compaction.ts";

export type SideStreamEvent =
	| { type: "thread"; thread: SideChatThread }
	| { type: "text"; text: string }
	| { type: "done"; thread: SideChatThread }
	| { type: "error"; error: string };
type SideEngine = PiEngine & { sideUsageAdmitted?: () => boolean };
export interface SideChatDeps {
	chatStore: ChatStore;
	engineFor: (record: ChatRecord) => Promise<SideEngine | Response>;
	instructions: () => string;
	beforeAsk?: (chatId: string) => Promise<void>;
}
interface SideRun {
	controller: AbortController;
	text: string;
	answerId: string;
	model: string;
	at: string;
	operationId?: string;
	listeners: Set<(event: SideStreamEvent) => void>;
	settled: Promise<void>;
}
export interface SideChatService {
	list(chatId: string): { threads: SideChatThread[]; answering: Record<string, string> } | null;
	ask(chatId: string, input: SideAskInput): Promise<Response>;
	watch(chatId: string, threadId: string): Response;
	/** Pure snapshot, including current streamed text. Saved atomically with
	 * the main input, never before it; no waiting for a provider. */
	snapshot(chatId: string): SideChatThread[];
	setOpen(chatId: string, threadId: string, open: boolean): SideChatThread | "unknown-chat" | "unknown-thread";
	stop(chatId: string, threadId: string): boolean;
	stopAll(chatId: string): void;
	settled(chatId: string, threadId: string): Promise<void>;
}
const runKey = (chatId: string, threadId: string) => `${chatId}\u0000${threadId}`;
const encoder = new TextEncoder();

export function createSideChatService(deps: SideChatDeps): SideChatService {
	const runs = new Map<string, SideRun>();
	const announce = (chatId: string) => emit("side-chats-changed", { chatId });

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

	function responseFor(chatId: string, thread: SideChatThread, run?: SideRun): Response {
		let detach = () => {};
		const body = new ReadableStream<Uint8Array>({
			start(stream) {
				let closed = false;
				const write = (event: SideStreamEvent) => {
					if (!closed) { try { stream.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); } catch { closed = true; } }
				};
				const close = () => {
					if (closed) return;
					closed = true;
					try { stream.close(); } catch { /* detached view */ }
				};
				const listener = (event: SideStreamEvent) => {
					write(event);
					if (event.type === "done" || event.type === "error") { run?.listeners.delete(listener); close(); }
				};
				write({ type: "thread", thread });
				if (!run) { write({ type: "done", thread }); close(); return; }
				write({ type: "text", text: run.text });
				run.listeners.add(listener);
				detach = () => { closed = true; run.listeners.delete(listener); };
				void run.settled.then(() => {
					if (closed) return;
					const latest = deps.chatStore.getChat(chatId)?.sideChats?.find((entry) => entry.id === thread.id);
					write(latest ? { type: "done", thread: latest } : { type: "error", error: "The session is gone." });
					run.listeners.delete(listener);
					close();
				});
			},
			cancel() { detach(); }, // closing/reloading a view does not kill the call
		});
		return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" } });
	}

	function watch(chatId: string, threadId: string): Response {
		const record = deps.chatStore.getChat(chatId);
		if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });
		const thread = record.sideChats?.find((entry) => entry.id === threadId);
		return thread ? responseFor(chatId, thread, runs.get(runKey(chatId, threadId))) : Response.json({ error: "Unknown side conversation" }, { status: 404 });
	}

	async function ask(chatId: string, input: SideAskInput): Promise<Response> {
		await deps.beforeAsk?.(chatId);
		const initial = deps.chatStore.getChat(chatId);
		if (!initial) return Response.json({ error: "Unknown chat" }, { status: 404 });
		const engine = await deps.engineFor(initial);
		if (engine instanceof Response) return engine;
		// No awaits between reading, deduplicating, saving and registration.
		const record = deps.chatStore.getChat(chatId);
		if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });
		const threads = record.sideChats ?? [];
		let target = input.threadId ? threads.find((thread) => thread.id === input.threadId) : undefined;
		if (input.threadId && !target) return Response.json({ error: "Unknown side conversation" }, { status: 404 });
		if (!target && input.anchor) {
			const segment = sideSegmentId(record.messages, input.anchor.messageId);
			if (!segment) return Response.json({ error: "The source is not a teaching segment in this session" }, { status: 400 });
			target = threads.find((thread) => thread.anchor.messageId === segment) ?? newSideThread({
				...input.anchor, messageId: segment, partId: `${segment}-t0`, blockIndex: 0,
				// The client chooses a segment, not what the tutor allegedly said.
				blockText: userFacingTextOf(record.messages.find((message) => message.id === segment && message.role === "assistant")?.content ?? [], failedOutputCallIds(record.messages)).join("\n\n").slice(0, 4_000) || "This teaching segment and its associated question.",
			});
			// First opening an old segment must not introduce new teacher context.
			if (!threads.includes(target) && segment !== sideSegmentId(record.messages)) target = { ...target, contextSnapshot: [] };
		}
		if (!target) return Response.json({ error: "A teaching segment or threadId is required" }, { status: 400 });
		const key = runKey(chatId, target.id);
		const active = runs.get(key);
		if (input.requestId && (active?.operationId === input.requestId || target.messages.some((message) => message.id === input.requestId || message.requestId === input.requestId))) {
			return responseFor(chatId, target, active);
		}
		if (active) return Response.json({ error: "This side conversation is still being answered" }, { status: 409 });

		let thread = target;
		let modelThread = target;
		if (input.retry) {
			const last = target.messages.at(-1);
			if (last?.role === "assistant" && last.error !== undefined) {
				// Keep failed evidence in durable/UI history; omit only from this retry request.
				modelThread = { ...target, messages: target.messages.slice(0, target.messages.findLastIndex((message) => message.role === "user") + 1) };
			} else if (!sideThreadAwaitsAnswer(target)) return Response.json({ error: "Nothing to retry" }, { status: 409 });
		} else {
			const question = newSideQuestion(input.text, input.quotes);
			if (input.requestId) question.id = input.requestId;
			thread = { ...target, open: true, messages: [...target.messages, question] };
			modelThread = thread;
		}
		const lesson = sideChatLessonDocument(record.messages);
		const turns = sideChatModelTurns(modelThread, lesson);
		if (input.working?.trim()) turns[turns.length - 1]!.text += `\n\nLearner's current working (not submitted):\n${input.working.trim()}`;
		const instructions = deps.instructions();
		const estimatedTokens = Math.ceil((instructions.length + turns.reduce((sum, turn) => sum + turn.text.length, 0)) / 4);
		if (engine.model.contextWindow > 0 && estimatedTokens > Math.max(1, engine.model.contextWindow - Math.min(COMPACTION_RESERVE_TOKENS, engine.model.maxTokens))) {
			return Response.json({ error: "This side conversation and lesson exceed the selected model's context window. Select a model with a larger context window." }, { status: 400 });
		}
		const stored = deps.chatStore.updateSideChats(chatId, (current) => current.some((entry) => entry.id === thread.id)
			? current.map((entry) => entry.id === thread.id ? thread : entry) : [...current, thread]);
		if (!stored) return Response.json({ error: "Unknown chat" }, { status: 404 });
		const run: SideRun = {
			controller: new AbortController(), text: "", answerId: newMessageId(), at: new Date().toISOString(),
			model: `${engine.model.provider}:${engine.model.id}`, operationId: input.requestId,
			listeners: new Set(), settled: Promise.resolve(),
		};
		runs.set(key, run);
		const broadcast = (event: SideStreamEvent) => {
			for (const listener of [...run.listeners]) { try { listener(event); } catch { /* detached view */ } }
		};
		announce(chatId);
		run.settled = (async () => {
			let settledThread: SideChatThread | undefined;
			try {
				const result = await streamSideAnswer({ engine, instructions, turns, signal: run.controller.signal, chatId, runId: run.answerId,
					onText: (text) => { run.text = text; broadcast({ type: "text", text }); },
				});
				const at = new Date().toISOString();
				const answer: SideChatMessage = {
					id: run.answerId, role: "assistant", text: result.text, at, model: run.model, requestId: input.requestId,
					...(result.outcome === "aborted" ? { stopped: true } : {}),
					...(result.outcome === "error" ? { error: result.errorMessage ?? "The model call failed." } : {}),
				};
				deps.chatStore.updateSideChats(chatId, (current) => current.map((entry) => {
					if (entry.id !== thread.id) return entry;
					settledThread = { ...entry, messages: [...entry.messages, answer] };
					return settledThread;
				}));
				if (result.usage && usageWasAdmitted(result.usage) && engine.sideUsageAdmitted?.() !== false) {
					try {
						deps.chatStore.appendTurnUsage(chatId, { id: run.answerId, messageId: answer.id, at, model: run.model, steps: [{
							inputTokens: result.usage.input, outputTokens: result.usage.output, cacheReadTokens: result.usage.cacheRead,
							cacheWriteTokens: result.usage.cacheWrite, cacheWrite1hTokens: result.usage.cacheWrite1h ?? 0,
							reasoningTokens: result.usage.reasoning ?? 0,
						}] });
					} catch { /* deleted session has no usage destination */ }
				}
			} catch (error) {
				console.error(`[chat ${chatId}] side answer failed to save:`, error);
				broadcast({ type: "error", error: "The side answer could not be saved." });
			} finally {
				runs.delete(key);
				announce(chatId);
				emit("record-changed", { chatId });
				if (settledThread) broadcast({ type: "done", thread: settledThread });
				run.listeners.clear();
			}
		})();
		return responseFor(chatId, thread, run);
	}

	function snapshot(chatId: string): SideChatThread[] {
		return (deps.chatStore.getChat(chatId)?.sideChats ?? []).map((thread) => {
			if (thread.contextSnapshot !== undefined) return thread;
			const run = runs.get(runKey(chatId, thread.id));
			const messages = run ? [...thread.messages, {
				id: run.answerId, role: "assistant" as const, text: run.text, at: run.at, model: run.model, pending: true,
			}] : [...thread.messages];
			return { ...thread, contextSnapshot: messages };
		});
	}
	function setOpen(chatId: string, threadId: string, open: boolean) {
		let found: SideChatThread | undefined;
		const stored = deps.chatStore.updateSideChats(chatId, (current) => current.map((thread) => {
			if (thread.id !== threadId) return thread;
			found = { ...thread, open }; return found;
		}));
		if (!stored) return "unknown-chat" as const;
		if (!found) return "unknown-thread" as const;
		announce(chatId); return found;
	}
	function stop(chatId: string, threadId: string): boolean {
		const run = runs.get(runKey(chatId, threadId));
		if (!run) return false;
		run.controller.abort(); return true;
	}
	function stopAll(chatId: string): void {
		for (const [key, run] of runs) if (key.startsWith(`${chatId}\u0000`)) run.controller.abort();
	}
	return { list, ask, watch, snapshot, setOpen, stop, stopAll,
		settled: (chatId, threadId) => runs.get(runKey(chatId, threadId))?.settled ?? Promise.resolve() };
}

async function productionEngineFor(record: ChatRecord): Promise<SideEngine | Response> {
	const spec = resolveSideQuestionSpec(record.settings, stores.settingsStore.readSettings());
	if (!spec) return Response.json(modelsNotConfigured(["strong"]), { status: 503 });
	if (isSubscriptionProvider(spec.provider)) await refreshConnectionCatalog(spec.provider);
	if (!providerKeyPresent(spec.provider)) return Response.json(providerKeyMissingEnvelope(spec.provider, ["strong"]), { status: 503 });
	try {
		let denied = false;
		const engine = piEngineForSpec(spec, false, { captured() {}, beforeDispatch() {}, noDispatch() { denied = true; } },
			() => stores.settingsStore.readSettings()?.models?.strong?.cacheRetention);
		return { ...engine, sideUsageAdmitted: () => !denied };
	} catch { return Response.json({ error: "The selected model is unavailable." }, { status: 503 }); }
}
interface SideChatGlobal { __lhSideChatService?: SideChatService }
export const sideChats: SideChatService = ((globalThis as typeof globalThis & SideChatGlobal).__lhSideChatService ??= createSideChatService({
	chatStore: stores.chatStore, engineFor: productionEngineFor, beforeAsk: awaitCompaction,
	instructions: () => composeSideChatInstructions(effectiveSettings().agent.prompts),
}));
