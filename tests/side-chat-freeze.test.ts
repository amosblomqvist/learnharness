/** Offline regression for the approved cutoff: main input never waits for
 * helper completion. A single raw snapshot is atomic with write-ahead;
 * late replies/old-thread follow-ups stay durable but UI-only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createAssistantMessageEventStream, createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage, SideChatThread } from "../src/core/index.ts";
import { subscribe } from "../src/core/events.ts";

assert.equal(process.env.NODE_ENV, "test");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-side-freeze-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
process.env.OPENROUTER_API_KEY = "offline-test-presence-only";
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { chatStore } = await import("../src/store/chats.ts");
const { createSideChatService } = await import("../src/server/side-chat.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { buildAnswer, normalizeOptions, resolveCorrect } = await import("../src/core/question-core.ts");
const { sideConversationEntries, sideSegmentId } = await import("../src/core/side-chat.ts");
const { newUserMessage } = await import("../src/core/native-messages.ts");
const { markUnadmittedUsage } = await import("../src/agent/subscription-request-cycle.ts");
const { POST: dismissRoute } = await import("../app/api/chats/[id]/dismiss/route.ts");
const { applyParkedDismissal, parkDismissal } = await import("../src/server/dismissal-park.ts");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const args = { type: "check", nodeId: "continuity", question: "Which is continuous?", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], correctAnswer: "b", explanation: "SECRET-KEY" };
const at = "2026-11-05T00:00:00Z";
function fixture() {
	const faux = createFauxCore({});
	let stream: ReturnType<typeof createAssistantMessageEventStream>;
	let calls = 0;
	const contexts: TranscriptContext[] = [];
	const engine: PiEngine = { model: faux.getModel(), streamFn: (_model, context) => {
		calls++; contexts.push(context); stream = createAssistantMessageEventStream();
		stream.push({ type: "text_delta", contentIndex: 0, delta: "Partial helper text", partial: fauxAssistantMessage("Partial helper text") });
		return stream;
	} };
	const service = createSideChatService({ chatStore, engineFor: async () => engine, instructions: () => "Toolless clarification helper" });
	const chat = chatStore.createChat("Frozen side conversation");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	const explanation: LhMessage = { ...fauxAssistantMessage("Explanation about continuity."), id: "explanation" };
	const question: LhMessage = { ...fauxAssistantMessage([fauxToolCall("quiz", args, { id: "check" })], { stopReason: "toolUse" }), id: "question" };
	chatStore.saveMessages(chat.id, [newUserMessage("Teach me"), explanation, question]);
	const anchor = { messageId: explanation.id, partId: `${explanation.id}-t0`, blockIndex: 99_999, blockText: "FORGED-PASSAGE" };
	const finish = (text = "Partial helper text AND LATE COMPLETION") => stream!.push({ type: "done", reason: "stop", message: fauxAssistantMessage(text) });
	return { service, chatId: chat.id, anchor, finish, contexts, calls: () => calls };
}
async function seenPartial(response: Response) {
	const reader = response.body!.getReader(); const decoder = new TextDecoder(); let text = "";
	while (!text.includes('"text":"Partial helper text"')) {
		const chunk = await reader.read(); assert.equal(chunk.done, false); text += decoder.decode(chunk.value);
	}
	return reader;
}
function gradedAnswer() {
	const options = normalizeOptions(args.options);
	return buildAnswer({ id: "check", kind: "quiz", question: args.question, mode: "single-select", options,
		correctIndices: resolveCorrect(args.correctAnswer, options).indices, explanation: args.explanation, createdAt: at },
	{ values: ["b"], thinking: "My reasoning", confidence: 75 });
}
async function mainInput(chatId: string, input: unknown, service: ReturnType<typeof createSideChatService>) {
	const main = createFauxCore({}); const contexts: TranscriptContext[] = [];
	main.appendResponses([(context) => { contexts.push(context); return fauxAssistantMessage("The teacher moves on."); }]);
	const engine: PiEngine = { model: main.getModel(), streamFn: main.streamSimple };
	const response = await handleChatRequest(new Request("http://offline.test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }) }), (opts) => createTeacherAgent(undefined, { ...opts, engine }), service);
	if (response.ok) { const turn = runningTurn(chatId); if (turn) await new Response(turn.subscribe()).text(); }
	return { response, contexts };
}

describe("main submission cutoff", () => {
	it("submits immediately, freezes the current partial reply, and never revises history on completion/follow-up", async () => {
		const f = fixture();
		const response = await f.service.ask(f.chatId, { anchor: f.anchor, text: "Why?", quotes: [], requestId: "ask_first" });
		const reader = await seenPartial(response);
		const before = chatStore.getChat(f.chatId)!.messages;
		const notices: SideChatThread[][] = [];
		const unsubscribe = subscribe((event) => {
			if (event.type === "side-chats-changed" && event.chatId === f.chatId) notices.push(chatStore.getChat(f.chatId)!.sideChats!);
		});
		let result;
		try { result = await mainInput(f.chatId, { type: "answer", toolCallId: "check", answer: gradedAnswer() }, f.service); }
		finally { unsubscribe(); }
		assert.equal(result.response.status, 200);
		assert.equal(notices.length, 1, "the open companion is notified without waiting for helper completion");
		assert.equal(notices[0]![0]!.contextSnapshot?.at(-1)?.pending, true, "the notification follows the atomic cutoff save");
		assert.ok(Object.hasOwn(f.service.list(f.chatId)!.answering, "side_explanation"), "teacher finishes while helper is still running");
		const record = chatStore.getChat(f.chatId)!;
		assert.deepEqual(record.messages.slice(0, before.length), before, "earlier transcript is byte-equivalent");
		const snapshot = record.sideChats![0]!.contextSnapshot!;
		assert.equal(snapshot.at(-1)!.text, "Partial helper text");
		assert.equal(snapshot.at(-1)!.pending, true);
		const markers = record.messages.filter((message) => message.role === "custom" && message.customType === "side-question");
		assert.equal(markers.length, 1);
		const wire = JSON.stringify(result.contexts[0]);
		assert.match(wire, /Recorded learner–helper conversation/);
		assert.match(wire, /Learner:\\nWhy\?/);
		assert.match(wire, /Helper:\\nPartial helper text/);
		assert.doesNotMatch(wire, /LATE COMPLETION|FORGED-PASSAGE/);
		const frozenMain = record.messages;
		f.finish(); await f.service.settled(f.chatId, "side_explanation"); await reader.cancel();
		assert.deepEqual(chatStore.getChat(f.chatId)!.messages, frozenMain);
		assert.match(chatStore.getChat(f.chatId)!.sideChats![0]!.messages.at(-1)!.text, /LATE COMPLETION/);
		const later = await f.service.ask(f.chatId, { threadId: "side_explanation", text: "LATE FOLLOW-UP", quotes: [], requestId: "ask_later" });
		const laterReader = await seenPartial(later); f.finish("LATE FOLLOW-UP ANSWER");
		await f.service.settled(f.chatId, "side_explanation"); await laterReader.cancel();
		assert.deepEqual(chatStore.getChat(f.chatId)!.sideChats![0]!.contextSnapshot, snapshot);
		assert.deepEqual(chatStore.getChat(f.chatId)!.messages, frozenMain);
		assert.deepEqual(sideConversationEntries(chatStore.getChat(f.chatId)!), []);
		const next = await mainInput(f.chatId, { type: "text", text: "Continue the main lesson" }, f.service);
		assert.equal(next.response.status, 200);
		assert.doesNotMatch(JSON.stringify(next.contexts), /LATE FOLLOW-UP|LATE COMPLETION/);
	});

	it("freezes a side exchange when idle dismissal is saved without making a teacher request", async () => {
		const f = fixture();
		const response = await f.service.ask(f.chatId, { anchor: f.anchor, text: "Before dismissal", quotes: [] });
		const reader = await seenPartial(response); f.finish("Saved helper reply");
		await f.service.settled(f.chatId, "side_explanation"); await reader.cancel();
		const dismissed = await dismissRoute(new Request("http://offline.test/dismiss", { method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { type: "dismiss", toolCallId: "check", answer: { ...gradedAnswer(), dismissed: true } } }) }), { params: Promise.resolve({ id: f.chatId }) });
		assert.equal(dismissed.status, 200);
		const saved = chatStore.getChat(f.chatId)!;
		assert.equal(runningTurn(f.chatId), undefined);
		assert.equal(saved.sideChats![0]!.contextSnapshot!.at(-1)!.text, "Saved helper reply");
		assert.equal(saved.messages.at(-1)!.role, "custom");
		assert.match(JSON.stringify(saved.messages.at(-1)), /Recorded learner–helper conversation/);
		const later = await f.service.ask(f.chatId, { threadId: "side_explanation", text: "After dismissal", quotes: [] });
		const laterReader = await seenPartial(later); f.finish("LATE DISMISSAL REPLY");
		await f.service.settled(f.chatId, "side_explanation"); await laterReader.cancel();
		assert.deepEqual(chatStore.getChat(f.chatId)!.messages, saved.messages);
	});

	it("freezes a running helper's partial reply when a parked dismissal is committed", async () => {
		const f = fixture();
		const response = await f.service.ask(f.chatId, { anchor: f.anchor, text: "Before parked dismissal", quotes: [] });
		const reader = await seenPartial(response);
		parkDismissal(f.chatId, { type: "dismiss", toolCallId: "check", answer: { ...gradedAnswer(), dismissed: true } });
		applyParkedDismissal(chatStore, f.chatId, f.service.snapshot(f.chatId));
		const saved = chatStore.getChat(f.chatId)!;
		assert.equal(saved.sideChats![0]!.contextSnapshot!.at(-1)!.pending, true);
		assert.match(JSON.stringify(saved.messages.at(-1)), /Partial helper text/);
		f.finish(); await f.service.settled(f.chatId, "side_explanation"); await reader.cancel();
		assert.deepEqual(chatStore.getChat(f.chatId)!.messages, saved.messages);
	});

	it("deduplicates uncertain initial POSTs and can reconnect to a live answer", async () => {
		const f = fixture(); const ask = { anchor: f.anchor, text: "Why?", quotes: [], requestId: "ask_uncertain" };
		const first = await f.service.ask(f.chatId, ask); const firstReader = await seenPartial(first); await firstReader.cancel();
		const repeated = await f.service.ask(f.chatId, ask); const secondReader = await seenPartial(repeated);
		assert.equal(f.calls(), 1);
		assert.equal(chatStore.getChat(f.chatId)!.sideChats![0]!.messages.filter((message) => message.role === "user").length, 1);
		const watcher = f.service.watch(f.chatId, "side_explanation"); const watcherReader = await seenPartial(watcher);
		f.finish(); await f.service.settled(f.chatId, "side_explanation"); await secondReader.cancel(); await watcherReader.cancel();
		assert.equal((await f.service.ask(f.chatId, ask)).status, 200);
		assert.equal(f.calls(), 1);
	});

	it("normalizes a question entry and highlighted explanation to the same segment", async () => {
		const f = fixture();
		assert.equal(sideSegmentId(chatStore.getChat(f.chatId)!.messages, "question"), "explanation");
		const response = await f.service.ask(f.chatId, { anchor: { ...f.anchor, messageId: "question", partId: "question-t0" }, text: "Question wording?", quotes: ["Which is continuous?"] });
		const reader = await seenPartial(response); f.finish(); await f.service.settled(f.chatId, "side_explanation"); await reader.cancel();
		const thread = chatStore.getChat(f.chatId)!.sideChats![0]!;
		assert.equal(thread.id, "side_explanation"); assert.equal(thread.anchor.messageId, "explanation");
		assert.equal(thread.anchor.blockIndex, 0); assert.equal(thread.anchor.blockText, "Explanation about continuity.");
		assert.doesNotMatch(JSON.stringify(f.contexts), /SECRET-KEY|FORGED-PASSAGE/);
	});

	it("first opening a past segment creates a durable UI-only conversation", async () => {
		const f = fixture();
		await mainInput(f.chatId, { type: "answer", toolCallId: "check", answer: gradedAnswer() }, f.service);
		const response = await f.service.ask(f.chatId, { anchor: f.anchor, text: "An old question", quotes: [] });
		const reader = await seenPartial(response); f.finish(); await f.service.settled(f.chatId, "side_explanation"); await reader.cancel();
		const record = chatStore.getChat(f.chatId)!;
		assert.deepEqual(record.sideChats![0]!.contextSnapshot, []);
		assert.deepEqual(sideConversationEntries(record), []);
	});

	it("store cutoff and main messages land together, and later saves cannot change the cutoff", () => {
		const f = fixture();
		const thread: SideChatThread = { id: "side_explanation", anchor: f.anchor, open: true, createdAt: at, messages: [{ id: "q", role: "user", text: "Before cutoff", at }] };
		chatStore.updateSideChats(f.chatId, () => [thread]);
		const snapshots = f.service.snapshot(f.chatId);
		const original = chatStore.getChat(f.chatId)!.messages;
		const entries = sideConversationEntries({ messages: original, sideChats: snapshots });
		chatStore.saveMessages(f.chatId, [...original, ...entries], snapshots);
		chatStore.updateSideChats(f.chatId, (threads) => threads.map((entry) => ({ ...entry, messages: [...entry.messages, { id: "late", role: "assistant", text: "UI only", at }] })));
		chatStore.saveMessages(f.chatId, chatStore.getChat(f.chatId)!.messages, [{ ...thread, contextSnapshot: [{ ...thread.messages[0]!, text: "ATTEMPTED REWRITE" }] }]);
		assert.equal(chatStore.getChat(f.chatId)!.sideChats![0]!.contextSnapshot![0]!.text, "Before cutoff");
		assert.match(chatStore.getChat(f.chatId)!.sideChats![0]!.messages.at(-1)!.text, /UI only/);
	});

	it("does not charge usage marked as never admitted", async () => {
		const f = fixture();
		const faux = createFauxCore({}); const failed = fauxAssistantMessage("", { stopReason: "error", errorMessage: "Not dispatched" });
		markUnadmittedUsage(failed.usage);
		const service = createSideChatService({ chatStore, instructions: () => "Helper", engineFor: async () => ({ model: faux.getModel(), streamFn: () => {
			const stream = createAssistantMessageEventStream(); stream.push({ type: "error", reason: "error", error: failed }); return stream;
		} }) });
		await (await service.ask(f.chatId, { anchor: f.anchor, text: "Why?", quotes: [] })).text();
		assert.equal(chatStore.getChat(f.chatId)!.turns?.length ?? 0, 0);
		assert.match(chatStore.getChat(f.chatId)!.sideChats![0]!.messages.at(-1)!.error!, /Not dispatched/);
	});
});
