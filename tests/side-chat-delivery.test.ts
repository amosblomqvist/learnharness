/** Offline regressions: new raw side exchanges enter main history once,
 * atomically with write-ahead, without waiting for helper completion or
 * changing earlier context. Late activity stays queued for the next request. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { Type } from "typebox";
import { createAssistantMessageEventStream, createFauxCore, fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage, SideChatThread } from "../src/core/index.ts";

assert.equal(process.env.NODE_ENV, "test");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-side-delivery-"));
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
const { collectCitations, serializeCitation } = await import("../src/core/citations.ts");
const { parseSideAskInput, SideChatInputError } = await import("../src/core/side-chat.ts");
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
	const chat = chatStore.createChat("Append-only side conversation");
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

describe("append-only main-request delivery", () => {
	it("submits immediately and appends completion/follow-ups on later requests without revising any prior context", async () => {
		const f = fixture();
		const response = await f.service.ask(f.chatId, { anchor: f.anchor, text: "Why?", quotes: [], requestId: "ask_first" });
		const reader = await seenPartial(response);
		const before = chatStore.getChat(f.chatId)!.messages;
		const result = await mainInput(f.chatId, { type: "answer", toolCallId: "check", answer: gradedAnswer() }, f.service);
		assert.equal(result.response.status, 200);
		assert.ok(Object.hasOwn(f.service.list(f.chatId)!.answering, "side_explanation"), "teacher finishes while helper is still running");
		const record = chatStore.getChat(f.chatId)!;
		assert.deepEqual(record.messages.slice(0, before.length), before, "earlier transcript is byte-equivalent");
		assert.equal(record.sideChats![0]!.contextSnapshot, undefined);
		const markers = record.messages.filter((message) => message.role === "custom" && message.customType === "side-question");
		assert.equal(markers.length, 2);
		assert.equal(record.messages[before.length]!.role, "toolResult", "native result remains adjacent to its question call");
		const wire = JSON.stringify(result.contexts[0]);
		assert.match(wire, /Recorded learner–helper conversation/);
		assert.match(wire, /Learner:\\nWhy\?/);
		assert.match(wire, /Helper:\\nPartial helper text/);
		assert.doesNotMatch(wire, /LATE COMPLETION|FORGED-PASSAGE/);
		const frozenMain = record.messages;
		f.finish(); await f.service.settled(f.chatId, "side_explanation"); await reader.cancel();
		assert.deepEqual(chatStore.getChat(f.chatId)!.messages, frozenMain);
		assert.match(chatStore.getChat(f.chatId)!.sideChats![0]!.messages.at(-1)!.text, /LATE COMPLETION/);
		const next = await mainInput(f.chatId, { type: "text", text: "LATEST MAIN STEP" }, f.service);
		assert.equal(next.response.status, 200);
		const secondWire = JSON.stringify(next.contexts);
		assert.match(secondWire, /LATE COMPLETION/);
		assert.equal(secondWire.split("Partial helper text").length - 1, 1, "only the new suffix is appended");
		assert.deepEqual(chatStore.getChat(f.chatId)!.messages.slice(0, frozenMain.length), frozenMain);
		const secondMain = chatStore.getChat(f.chatId)!.messages;
		const later = await f.service.ask(f.chatId, { threadId: "side_explanation", text: "LATE FOLLOW-UP", quotes: [], requestId: "ask_later" });
		const laterReader = await seenPartial(later); f.finish("LATE FOLLOW-UP ANSWER");
		await f.service.settled(f.chatId, "side_explanation"); await laterReader.cancel();
		assert.match(JSON.stringify(f.contexts.at(-1)), /LATEST MAIN STEP/, "an old thread's helper still receives the latest visible lesson");
		assert.deepEqual(chatStore.getChat(f.chatId)!.messages, secondMain, "helper settlement never injects into main history");
		const third = await mainInput(f.chatId, { type: "text", text: "Continue the main lesson" }, f.service);
		assert.equal(third.response.status, 200);
		assert.match(JSON.stringify(third.contexts), /LATE FOLLOW-UP ANSWER/);
		assert.deepEqual(chatStore.getChat(f.chatId)!.messages.slice(0, secondMain.length), secondMain);
		const markerCount = chatStore.getChat(f.chatId)!.messages.filter((message) => message.role === "custom" && message.customType === "side-question").length;
		assert.deepEqual(sideConversationEntries(chatStore.getChat(f.chatId)!), []);
		await mainInput(f.chatId, { type: "text", text: "One more main input" }, f.service);
		assert.equal(chatStore.getChat(f.chatId)!.messages.filter((message) => message.role === "custom" && message.customType === "side-question").length, markerCount);
	});

	it("persists the selected prose source independently of a tool-only segment head", async () => {
		const f = fixture(); const record = chatStore.getChat(f.chatId)!;
		chatStore.saveMessages(f.chatId, [record.messages[0]!, { ...fauxAssistantMessage([fauxToolCall("read", { path: "synthetic.md" }, { id: "read_work" })], { stopReason: "toolUse" }), id: "work" },
			{ id: "read_result", role: "toolResult", toolCallId: "read_work", toolName: "read", content: [{ type: "text", text: "Synthetic" }], isError: false, timestamp: 1 }, ...record.messages.slice(1)]);
		const link = serializeCitation({ version: 1, chatId: f.chatId, messageId: "explanation", text: "Selected prose", start: 0, end: 14, prefix: "", suffix: "" });
		const input = parseSideAskInput({ anchor: f.anchor, text: "Clarify", quotes: ["Selected prose"], quoteCitations: [link] });
		const response = await f.service.ask(f.chatId, input); const reader = await seenPartial(response);
		const thread = chatStore.getChat(f.chatId)!.sideChats![0]!;
		assert.equal(thread.id, "side_work");
		assert.equal(collectCitations(thread.messages[0]!.quoteCitations![0]!)[0]!.citation.messageId, "explanation");
		f.finish(); await f.service.settled(f.chatId, thread.id); await reader.cancel();
		for (const messageId of ["missing", record.messages[0]!.id]) {
			const wrong = serializeCitation({ version: 1, chatId: f.chatId, messageId, text: "Selected prose", start: 0, end: 14, prefix: "", suffix: "" });
			assert.equal((await f.service.ask(f.chatId, { ...input, threadId: thread.id, quoteCitations: [wrong] })).status, 400);
		}
		assert.throws(() => parseSideAskInput({ anchor: f.anchor, text: "Clarify", quotes: ["Different prose"], quoteCitations: [link] }), SideChatInputError);
		assert.throws(() => parseSideAskInput({ anchor: f.anchor, text: "Clarify", quotes: [], quoteCitations: [link] }), SideChatInputError);
	});

	it("records an idle dismissal atomically, with later side activity queued for the next teacher request", async () => {
		const f = fixture();
		const response = await f.service.ask(f.chatId, { anchor: f.anchor, text: "Before dismissal", quotes: [] });
		const reader = await seenPartial(response); f.finish("Saved helper reply");
		await f.service.settled(f.chatId, "side_explanation"); await reader.cancel();
		const dismissed = await dismissRoute(new Request("http://offline.test/dismiss", { method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { type: "dismiss", toolCallId: "check", answer: { ...gradedAnswer(), dismissed: true } } }) }), { params: Promise.resolve({ id: f.chatId }) });
		assert.equal(dismissed.status, 200);
		const saved = chatStore.getChat(f.chatId)!;
		assert.equal(runningTurn(f.chatId), undefined);
		assert.equal(saved.sideChats![0]!.contextSnapshot, undefined);
		assert.match(JSON.stringify(saved.messages.at(-1)), /Saved helper reply/);
		assert.equal(saved.messages.at(-1)!.role, "custom");
		assert.match(JSON.stringify(saved.messages.at(-1)), /Recorded learner–helper conversation/);
		const later = await f.service.ask(f.chatId, { threadId: "side_explanation", text: "After dismissal", quotes: [] });
		const laterReader = await seenPartial(later); f.finish("LATE DISMISSAL REPLY");
		await f.service.settled(f.chatId, "side_explanation"); await laterReader.cancel();
		assert.deepEqual(chatStore.getChat(f.chatId)!.messages, saved.messages);
		const next = await mainInput(f.chatId, { type: "text", text: "Continue after dismissal" }, f.service);
		assert.match(JSON.stringify(next.contexts), /LATE DISMISSAL REPLY/);
		assert.deepEqual(chatStore.getChat(f.chatId)!.messages.slice(0, saved.messages.length), saved.messages);
	});

	it("records a parked dismissal's partial reply, then appends its remaining text on the next request", async () => {
		const f = fixture();
		const response = await f.service.ask(f.chatId, { anchor: f.anchor, text: "Before parked dismissal", quotes: [] });
		const reader = await seenPartial(response);
		parkDismissal(f.chatId, { type: "dismiss", toolCallId: "check", answer: { ...gradedAnswer(), dismissed: true } });
		applyParkedDismissal(chatStore, f.chatId, f.service.snapshot(f.chatId));
		const saved = chatStore.getChat(f.chatId)!;
		assert.equal(saved.sideChats![0]!.contextSnapshot, undefined);
		assert.match(JSON.stringify(saved.messages.at(-1)), /still generating/);
		assert.match(JSON.stringify(saved.messages.at(-1)), /Partial helper text/);
		f.finish(); await f.service.settled(f.chatId, "side_explanation"); await reader.cancel();
		assert.deepEqual(chatStore.getChat(f.chatId)!.messages, saved.messages);
		const next = await mainInput(f.chatId, { type: "text", text: "After parked dismissal" }, f.service);
		const wire = JSON.stringify(next.contexts);
		assert.match(wire, /LATE COMPLETION/);
		assert.equal(wire.split("Partial helper text").length - 1, 1);
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

	it("first opening a past segment still contributes new exchanges to the next teacher request", async () => {
		const f = fixture();
		await mainInput(f.chatId, { type: "answer", toolCallId: "check", answer: gradedAnswer() }, f.service);
		const response = await f.service.ask(f.chatId, { anchor: f.anchor, text: "An old question", quotes: [] });
		const reader = await seenPartial(response); f.finish(); await f.service.settled(f.chatId, "side_explanation"); await reader.cancel();
		const record = chatStore.getChat(f.chatId)!;
		assert.equal(record.sideChats![0]!.contextSnapshot, undefined);
		assert.equal(sideConversationEntries(record).length, 2);
		const next = await mainInput(f.chatId, { type: "text", text: "Keep teaching" }, f.service);
		assert.match(JSON.stringify(next.contexts), /An old question/);
		assert.deepEqual(sideConversationEntries(chatStore.getChat(f.chatId)!), []);
	});

	it("commits delivery watermarks with native input, while later thread writes preserve that native prefix", () => {
		const f = fixture();
		const thread: SideChatThread = { id: "side_explanation", anchor: f.anchor, open: true, createdAt: at, messages: [{ id: "q", role: "user", text: "Before request", at }] };
		chatStore.updateSideChats(f.chatId, () => [thread]);
		const original = chatStore.getChat(f.chatId)!.messages;
		const entries = sideConversationEntries({ messages: original, sideChats: f.service.snapshot(f.chatId) });
		chatStore.saveMessages(f.chatId, [...original, ...entries]);
		assert.deepEqual(sideConversationEntries(chatStore.getChat(f.chatId)!), []);
		chatStore.updateSideChats(f.chatId, (threads) => threads.map((entry) => ({ ...entry, messages: [...entry.messages, { id: "late", role: "assistant", text: "New raw reply", at }] })));
		const saved = chatStore.getChat(f.chatId)!;
		assert.deepEqual(saved.messages, [...original, ...entries]);
		const next = sideConversationEntries(saved);
		assert.equal(next.length, 1); assert.match(next[0]!.content, /New raw reply/);
	});

	it("a failed input write does not consume side updates or start the teacher", async () => {
		const f = fixture(); const response = await f.service.ask(f.chatId, { anchor: f.anchor, text: "Keep this exchange", quotes: [] });
		const reader = await seenPartial(response); const before = chatStore.getChat(f.chatId)!;
		const save = chatStore.saveMessages;
		chatStore.saveMessages = () => { throw new Error("Synthetic delivery write failure"); };
		try {
			const failed = await mainInput(f.chatId, { type: "answer", toolCallId: "check", answer: gradedAnswer() }, f.service);
			assert.equal(failed.response.status, 500); assert.equal(failed.contexts.length, 0);
		} finally { chatStore.saveMessages = save; }
		assert.deepEqual(chatStore.getChat(f.chatId)!.messages, before.messages);
		const accepted = await mainInput(f.chatId, { type: "answer", toolCallId: "check", answer: gradedAnswer() }, f.service);
		assert.equal(accepted.response.status, 200); assert.match(JSON.stringify(accepted.contexts), /Keep this exchange/);
		f.finish(); await f.service.settled(f.chatId, "side_explanation"); await reader.cancel();
	});

	it("keeps parallel tool results adjacent and waits until the last answer to publish current side activity", async () => {
		const f = fixture(); const original = chatStore.getChat(f.chatId)!;
		chatStore.saveMessages(f.chatId, [...original.messages.slice(0, -1), { ...fauxAssistantMessage([
			fauxToolCall("quiz", args, { id: "check" }), fauxToolCall("quiz", args, { id: "check2" }),
		], { stopReason: "toolUse" }), id: "question" }]);
		const response = await f.service.ask(f.chatId, { anchor: f.anchor, text: "A question during the batch", quotes: [] });
		const reader = await seenPartial(response);
		const first = await mainInput(f.chatId, { type: "answer", toolCallId: "check", answer: gradedAnswer() }, f.service);
		assert.equal(first.response.status, 200); assert.equal(first.contexts.length, 0);
		assert.equal(chatStore.getChat(f.chatId)!.messages.at(-1)!.role, "toolResult");
		f.finish(); await f.service.settled(f.chatId, "side_explanation"); await reader.cancel();
		const second = await mainInput(f.chatId, { type: "answer", toolCallId: "check2", answer: gradedAnswer() }, f.service);
		assert.equal(second.response.status, 200); assert.match(JSON.stringify(second.contexts), /LATE COMPLETION/);
		assert.doesNotMatch(JSON.stringify(second.contexts), /still generating/);
		assert.deepEqual(chatStore.getChat(f.chatId)!.messages.slice(2, 5).map((message) => message.role), ["assistant", "toolResult", "toolResult"]);
	});

	it("captures updates arriving after HTTP write-ahead on the first native model call, without an extra call", async () => {
		const f = fixture();
		const thread: SideChatThread = { id: "side_explanation", anchor: f.anchor, open: true, createdAt: at,
			messages: [{ id: "gap_question", role: "user", text: "A question before the main request", at }] };
		chatStore.updateSideChats(f.chatId, () => [thread]);
		let captures = 0;
		const service = { ...f.service, snapshot: (id: string) => {
			if (++captures === 2) chatStore.updateSideChats(id, (threads) => threads.map((entry) => ({ ...entry,
				messages: [...entry.messages, { id: "gap_answer", role: "assistant", text: "FIRST CALL GAP REPLY", at: new Date().toISOString() }] })));
			return f.service.snapshot(id);
		} };
		const result = await mainInput(f.chatId, { type: "answer", toolCallId: "check", answer: gradedAnswer() }, service);
		assert.equal(result.response.status, 200); assert.equal(result.contexts.length, 1);
		assert.equal(JSON.stringify(result.contexts).split("FIRST CALL GAP REPLY").length - 1, 1);
		assert.equal(chatStore.getChat(f.chatId)!.messages.filter((message) => message.role === "custom" && message.customType === "side-question").length, 2);
		assert.deepEqual(sideConversationEntries(chatStore.getChat(f.chatId)!), []);
	});

	it("shares newly available exchanges between internal model calls without scheduling extra calls or rewriting prior context", async () => {
		const f = fixture();
		const firstHelper = await f.service.ask(f.chatId, { anchor: f.anchor, text: "First helper question", quotes: [] });
		const firstReader = await seenPartial(firstHelper);
		const original = chatStore.getChat(f.chatId)!.messages;
		const main = createFauxCore({}); const contexts: TranscriptContext[] = [];
		let toolCalls = 0; let secondReader: ReadableStreamDefaultReader<Uint8Array>; let lastReader: ReadableStreamDefaultReader<Uint8Array>;
		main.appendResponses([
			(context) => { contexts.push(structuredClone(context)); return fauxAssistantMessage([fauxToolCall("offline_read", {}, { id: "read_1" })], { stopReason: "toolUse" }); },
			(context) => { contexts.push(structuredClone(context)); return fauxAssistantMessage([fauxToolCall("offline_read", {}, { id: "read_2" })], { stopReason: "toolUse" }); },
			async (context) => {
				contexts.push(structuredClone(context));
				const extra = await f.service.ask(f.chatId, { threadId: "side_explanation", text: "AFTER LAST REQUEST", quotes: [] });
				lastReader = await seenPartial(extra);
				return fauxAssistantMessage("The main turn is complete.");
			},
		]);
		const engine: PiEngine = { model: main.getModel(), streamFn: main.streamSimple };
		const response = await handleChatRequest(new Request("http://offline.test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId: f.chatId, input: { type: "answer", toolCallId: "check", answer: gradedAnswer() } }) }), (opts) => createTeacherAgent(undefined, { ...opts, engine, tools: {
				offline_read: { name: "offline_read", label: "Offline read", description: "Read a synthetic fixture", parameters: Type.Object({}), execute: async () => {
					toolCalls++;
					if (toolCalls === 1) {
						f.finish(); await f.service.settled(f.chatId, "side_explanation"); await firstReader.cancel();
						const second = await f.service.ask(f.chatId, { threadId: "side_explanation", text: "A follow-up during file reading", quotes: [] });
						secondReader = await seenPartial(second);
					} else {
						f.finish("Partial helper text SECOND TAIL"); await f.service.settled(f.chatId, "side_explanation"); await secondReader.cancel();
					}
					return { content: [{ type: "text", text: "Synthetic file contents" }], details: {} };
				} },
			} }), f.service);
		assert.equal(response.status, 200); const turn = runningTurn(f.chatId); if (turn) await new Response(turn.subscribe()).text();
		assert.equal(contexts.length, 3); assert.equal(toolCalls, 2);
		assert.doesNotMatch(JSON.stringify(contexts[0]), /LATE COMPLETION|A follow-up during file reading/);
		assert.match(JSON.stringify(contexts[1]), /LATE COMPLETION/); assert.match(JSON.stringify(contexts[1]), /A follow-up during file reading/);
		assert.match(JSON.stringify(contexts[2]), /SECOND TAIL/);
		assert.equal(JSON.stringify(contexts[2]).split("LATE COMPLETION").length - 1, 1);
		for (let i = 1; i < contexts.length; i++) assert.deepEqual(contexts[i]!.messages.slice(0, contexts[i - 1]!.messages.length), contexts[i - 1]!.messages);
		const saved = chatStore.getChat(f.chatId)!;
		assert.deepEqual(saved.messages.slice(0, original.length), original);
		for (const callId of ["read_1", "read_2"]) {
			const index = saved.messages.findIndex((message) => message.role === "toolResult" && message.toolCallId === callId);
			assert.ok(index > 0); assert.equal(saved.messages[index - 1]!.role, "assistant");
			assert.equal(saved.messages[index + 1]!.role, "custom", "updates follow the tool result, never split its native pair");
		}
		assert.doesNotMatch(JSON.stringify(saved.messages), /AFTER LAST REQUEST/, "settlement must not publish or schedule a fourth call");
		const next = await mainInput(f.chatId, { type: "text", text: "Continue" }, f.service);
		assert.match(JSON.stringify(next.contexts), /AFTER LAST REQUEST/);
		f.finish(); await f.service.settled(f.chatId, "side_explanation"); await lastReader!.cancel();
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
