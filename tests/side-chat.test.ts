/**
 * Side questions (inline clarification threads, owner design 2026-11-02):
 * the pure lesson view (spoiler rule, compaction cut), input validation,
 * the store seam, and the server service end to end on pi's faux provider.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ─────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-side-chat-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { createSideChatService } = await import("../src/server/side-chat.ts");
const { composeSideChatInstructions } = await import("../src/agent/side-chat.ts");
const { subscribe } = await import("../src/core/events.ts");
const core = await import("../src/core/index.ts");
import { createFauxCore, fauxAssistantMessage, type AssistantMessage, type ToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { LhMessage, SideChatAnchor, SideChatThread, QuestionAnswerData } from "../src/core/index.ts";
import type { PiEngine } from "../src/agent/models.ts";

const {
	parseSideAskInput,
	parseSideOpenInput,
	SideChatInputError,
	sideChatLessonDocument,
	sideChatModelTurns,
	anchorPointsAtProse,
	newCompactionMarker,
	newUserMessage,
	newThinkingMessage,
} = core;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────

let seq = 0;
function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): LhMessage {
	const base = fauxAssistantMessage("x");
	return { ...base, content, stopReason, id: `msg_a${seq++}` } as LhMessage;
}
const text = (t: string) => ({ type: "text" as const, text: t });
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id, name, arguments: args as ToolCall["arguments"] });
function result(toolCallId: string, toolName: string, details: unknown, isError = false): LhMessage {
	return { role: "toolResult", toolCallId, toolName, content: [text("ok")], details, isError, timestamp: Date.now(), id: `msg_r${seq++}` } as LhMessage;
}

const QUIZ_ARGS = {
	type: "check",
	nodeId: "limits",
	question: "Which limit defines the derivative?",
	options: [
		{ label: "Difference quotient as h→0", value: "dq" },
		{ label: "Area under the curve", value: "area" },
	],
	explanation: "SECRET-EXPLANATION the slope is the limit of secants",
	correctAnswer: "dq",
};

function answeredQuiz(): QuestionAnswerData {
	return {
		kind: "quiz",
		tool: "quiz",
		questionText: "What is 2+2?",
		options: [
			{ index: 1, label: "3" },
			{ index: 2, label: "4" },
		],
		dontKnow: false,
		answers: [{ index: 1, label: "3", value: "3" }],
		correct: false,
		correctIndices: [2],
		explanation: "Two pairs make four.",
		confidence: 70,
		thinking: "I counted wrong",
		answeredAt: new Date().toISOString(),
	};
}

// ── input validation ────────────────────────────────────────────────────────

describe("side ask input", () => {
	const anchor: SideChatAnchor = { messageId: "msg_1", partId: "msg_1-t0", blockIndex: 2, blockText: "A paragraph." };

	it("accepts a first question with an anchor and trims/clips", () => {
		const input = parseSideAskInput({ anchor, text: "  why?  ", quotes: ["  q1 ", ""] });
		assert.equal(input.text, "why?");
		assert.deepEqual(input.quotes, ["q1"]);
		assert.equal(input.anchor?.blockIndex, 2);
	});

	it("accepts a follow-up and a retry by thread id", () => {
		assert.equal(parseSideAskInput({ threadId: "side_x", text: "more" }).threadId, "side_x");
		const retry = parseSideAskInput({ threadId: "side_x", retry: true });
		assert.equal(retry.retry, true);
		assert.equal(retry.text, "");
	});

	it("refuses bad shapes", () => {
		for (const bad of [
			null,
			{ text: "" , anchor },
			{ text: "q" },
			{ text: "q", anchor: { ...anchor, partId: "other-t0" } },
			{ text: "q", anchor: { ...anchor, blockIndex: -1 } },
			{ text: "q", anchor, quotes: "nope" },
			{ text: "q", anchor, quotes: ["1", "2", "3", "4", "5", "6"] },
			{ retry: true },
			{ text: "x".repeat(8_001), anchor },
		]) {
			assert.throws(() => parseSideAskInput(bad), SideChatInputError, JSON.stringify(bad)?.slice(0, 60));
		}
		assert.throws(() => parseSideOpenInput({}), SideChatInputError);
		assert.equal(parseSideOpenInput({ open: false }), false);
	});
});

// ── the lesson document ─────────────────────────────────────────────────────

describe("side lesson document", () => {
	it("renders prose, learner text and answered checks in full", () => {
		const doc = sideChatLessonDocument([
			newUserMessage("I want to learn arithmetic"),
			assistant([text("Addition combines counts."), call("q1", "quiz", { ...QUIZ_ARGS, question: "What is 2+2?" })]),
			result("q1", "quiz", answeredQuiz()),
		]);
		assert.match(doc, /### Learner\n\nI want to learn arithmetic/);
		assert.match(doc, /### Teacher\n\nAddition combines counts\./);
		assert.match(doc, /Check question \(answered\)/);
		assert.match(doc, /- 3 \*\(chosen by the learner\)\*/);
		assert.match(doc, /- 4 \*\(correct\)\*/);
		assert.match(doc, /Verdict: incorrect/);
		assert.match(doc, /Two pairs make four/);
		assert.match(doc, /confidence: 70%/);
		assert.match(doc, /I counted wrong/);
	});

	it("shows the OPEN check without its key, explanation or committed answer", () => {
		const doc = sideChatLessonDocument([
			assistant([text("Derivatives measure change."), call("q2", "quiz", QUIZ_ARGS), call("q3", "explain", { type: "check", nodeId: "n", question: "Explain the slope.", correctAnswer: "SECRET-COMMITTED" })]),
		]);
		assert.match(doc, /OPEN question/);
		assert.match(doc, /Which limit defines the derivative\?/);
		assert.match(doc, /\d\. Difference quotient as h→0/);
		assert.match(doc, /Explain the slope\./);
		assert.doesNotMatch(doc, /SECRET-EXPLANATION/);
		assert.doesNotMatch(doc, /SECRET-COMMITTED/);
		assert.doesNotMatch(doc, /correctAnswer|"dq"/);
	});

	it("hides the ACTIVE problem's solution, reveals concluded ones", () => {
		const active = sideChatLessonDocument([
			assistant([text("Try this."), call("p1", "problem", { statement: "Integrate x dx.", modelSolution: "SECRET-SOLUTION x^2/2" })]),
			result("p1", "problem", null),
			newThinkingMessage("p1", "maybe power rule?"),
		]);
		assert.match(active, /OPEN problem/);
		assert.match(active, /Integrate x dx\./);
		assert.match(active, /maybe power rule\?/);
		assert.doesNotMatch(active, /SECRET-SOLUTION/);

		const concluded = sideChatLessonDocument([
			assistant([call("p2", "problem", { statement: "Integrate x dx.", modelSolution: "REVEALED x^2/2" })]),
			result("p2", "problem", null),
			assistant([call("c2", "conclude", { outcome: "solved", verdict: "Clean." })]),
			result("c2", "conclude", null),
		]);
		assert.doesNotMatch(concluded, /OPEN problem/);
		assert.match(concluded, /REVEALED x\^2\/2/);
	});

	it("honors the active compaction cut without disclosing a model-private summary", () => {
		const old = newUserMessage("OLD-CONTENT");
		const kept = newUserMessage("KEPT-CONTENT");
		const marker = newCompactionMarker("SUMMARY-TEXT", { firstKeptMessageId: kept.id, tokensBefore: 1, at: new Date().toISOString() });
		const doc = sideChatLessonDocument([old, kept, marker]);
		assert.match(doc, /private summary is not supplied/);
		assert.doesNotMatch(doc, /SUMMARY-TEXT/);
		assert.match(doc, /KEPT-CONTENT/);
		assert.doesNotMatch(doc, /OLD-CONTENT/);
	});

	it("validates anchors against the record's projectView numbering", () => {
		const msg = assistant([text(""), text("Second part."), call("s1", "send_to_user", { message: "Delivered prose." })]);
		const messages = [msg, result("s1", "send_to_user", null)];
		const at = (n: number) => ({ messageId: msg.id, partId: `${msg.id}-t${n}`, blockIndex: 0, blockText: "x" });
		assert.equal(anchorPointsAtProse(messages, at(0)), true, "empty text blocks still count (view.ts numbering)");
		assert.equal(anchorPointsAtProse(messages, at(2)), true, "delivered send_to_user prose is a text part");
		assert.equal(anchorPointsAtProse(messages, at(3)), false);
		assert.equal(anchorPointsAtProse(messages, { ...at(0), messageId: "msg_nope", partId: "msg_nope-t0" }), false);
		const streaming = assistant([text("live")], "pending");
		assert.equal(anchorPointsAtProse([streaming], { messageId: streaming.id, partId: `${streaming.id}-t0`, blockIndex: 0, blockText: "x" }), false);
	});

	it("puts the lesson + passage in the first turn and replays answers with notes", () => {
		const thread: SideChatThread = {
			id: "side_t",
			anchor: { messageId: "m", partId: "m-t0", blockIndex: 0, blockText: "THE-PASSAGE" },
			open: true,
			createdAt: "",
			messages: [
				{ id: "1", role: "user", text: "first?", quotes: ["HIGHLIGHT"], at: "" },
				{ id: "2", role: "assistant", text: "partial", stopped: true, at: "" },
				{ id: "3", role: "user", text: "second?", at: "" },
			],
		};
		const turns = sideChatModelTurns(thread, "LESSON-DOC");
		assert.deepEqual(turns.map((t) => t.role), ["user", "assistant", "user"]);
		assert.match(turns[0]!.text, /<lesson>\nLESSON-DOC\n<\/lesson>/);
		assert.match(turns[0]!.text, /<passage>\nTHE-PASSAGE\n<\/passage>/);
		assert.match(turns[0]!.text, /<quote>\nHIGHLIGHT\n<\/quote>/);
		assert.match(turns[1]!.text, /stopped this answer/);
		assert.doesNotMatch(turns[2]!.text, /<lesson>/);
	});
});

// ── instructions ────────────────────────────────────────────────────────────

describe("side instructions", () => {
	it("compose the side base with the shared voice/accuracy/formatting appendix", () => {
		const prompt = composeSideChatInstructions();
		assert.match(prompt, /## Side questions/);
		assert.match(prompt, /OPEN question/);
		assert.match(prompt, /## Voice/);
		assert.match(prompt, /## Accuracy/);
		assert.match(prompt, /## Formatting/);
		assert.match(prompt, /normally one or two short sentences in plain prose/);
		assert.ok(prompt.indexOf("## Side-answer brevity") > prompt.indexOf("## Formatting"), "side-specific brevity wins over the shared appendix");
		assert.match(prompt, /Use the supplied context; don't claim to have inspected files or images that weren't provided/);
		assert.doesNotMatch(prompt, /one to three|You have no tools/);
		assert.doesNotMatch(prompt, /probe_done|plan_init/, "no teaching base or tool doctrine");
	});
	it("keeps side brevity last while still honoring enabled shared overrides", async () => {
		const { PROMPTS_OVERRIDE_DIR } = await import("../config.ts");
		assert.ok(PROMPTS_OVERRIDE_DIR.startsWith(TMP_DATA + path.sep));
		const file = path.join(PROMPTS_OVERRIDE_DIR, "shared", "10-voice.md");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "OVERRIDE VOICE: a deliberately lengthy style.");
		try {
			const prompt = composeSideChatInstructions({ "shared/10-voice.md": true });
			assert.match(prompt, /OVERRIDE VOICE/);
			assert.ok(prompt.indexOf("## Side-answer brevity") > prompt.indexOf("OVERRIDE VOICE"));
			assert.doesNotMatch(composeSideChatInstructions(), /OVERRIDE VOICE/);
		} finally { fs.rmSync(file); }
	});
});

// ── store ───────────────────────────────────────────────────────────────────

describe("side store seam", () => {
	it("updates threads without touching messages, and the list omits them", () => {
		const chat = chatStore.createChat("store");
		chatStore.saveMessages(chat.id, [newUserMessage("hello")]);
		const thread: SideChatThread = { id: "side_a", anchor: { messageId: "m", partId: "m-t0", blockIndex: 0, blockText: "b" }, open: true, createdAt: "", messages: [] };
		assert.equal(chatStore.updateSideChats(chat.id, (t) => [...t, thread])?.length, 1);
		// A concurrent turn persist re-reads the record: the thread survives.
		chatStore.saveMessages(chat.id, [newUserMessage("hello"), newUserMessage("again")]);
		const record = chatStore.getChat(chat.id)!;
		assert.equal(record.sideChats?.length, 1);
		assert.equal(record.messages.length, 2);
		const summary = chatStore.listChats().find((c) => c.id === chat.id) as unknown as Record<string, unknown>;
		assert.equal(summary.sideChats, undefined);
		// Emptying drops the field; unknown chats answer null.
		chatStore.updateSideChats(chat.id, () => []);
		assert.equal(chatStore.getChat(chat.id)!.sideChats, undefined);
		assert.equal(chatStore.updateSideChats("chat_missing", (t) => t), null);
	});
});

// ── the service, end to end on the faux provider ────────────────────────────

interface Ndjson {
	type: string;
	text?: string;
	error?: string;
	thread?: SideChatThread;
}

async function readAll(res: Response): Promise<Ndjson[]> {
	const body = await res.text();
	return body
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as Ndjson);
}

function setup(opts: { tokensPerSecond?: number } = {}) {
	const faux = createFauxCore({ tokensPerSecond: opts.tokensPerSecond });
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	const contexts: TranscriptContext[] = [];
	let refusal: Response | null = null;
	const service = createSideChatService({
		chatStore,
		engineFor: async () => refusal ?? engine,
		instructions: () => "SIDE-INSTRUCTIONS",
	});
	const chat = chatStore.createChat("side");
	const prose = assistant([text("First paragraph.\n\nSecond paragraph."), call("q9", "quiz", QUIZ_ARGS)]);
	chatStore.saveMessages(chat.id, [newUserMessage("teach me"), prose]);
	const anchor: SideChatAnchor = { messageId: prose.id, partId: `${prose.id}-t0`, blockIndex: 1, blockText: "Second paragraph." };
	const answer = (reply: string | AssistantMessage) =>
		faux.appendResponses([
			(context) => {
				contexts.push(context);
				return typeof reply === "string" ? fauxAssistantMessage(reply) : reply;
			},
		]);
	return { faux, service, chatId: chat.id, anchor, answer, contexts, refuse: (r: Response | null) => (refusal = r) };
}

describe("side chat service", () => {
	it("answers a first question: NDJSON wire, saved thread, usage, events, untouched messages", async () => {
		const { service, chatId, anchor, answer, contexts } = setup();
		const events: string[] = [];
		const off = subscribe((e) => {
			if ("chatId" in e && e.chatId === chatId) events.push(e.type);
		});
		answer("Because the limit never evaluates at zero.");
		const before = chatStore.getChat(chatId)!.messages;
		const lines = await readAll(await service.ask(chatId, { anchor, text: "why h→0?", quotes: ["the limit"] }));
		off();
		assert.equal(lines[0]!.type, "thread");
		assert.equal(lines[0]!.thread!.messages.length, 1);
		assert.ok(lines.some((l) => l.type === "text"));
		const done = lines.at(-1)!;
		assert.equal(done.type, "done");
		assert.equal(done.thread!.messages[1]!.text, "Because the limit never evaluates at zero.");

		const record = chatStore.getChat(chatId)!;
		assert.deepEqual(record.messages, before, "the teaching record never changes");
		const thread = record.sideChats![0]!;
		assert.equal(thread.open, true);
		assert.equal(thread.anchor.messageId, anchor.messageId);
		assert.equal(thread.anchor.blockIndex, 0);
		assert.equal(thread.anchor.blockText, "First paragraph.\n\nSecond paragraph.");
		assert.deepEqual(thread.messages.map((m) => m.role), ["user", "assistant"]);
		assert.deepEqual(thread.messages[0]!.quotes, ["the limit"]);
		assert.ok(record.turns?.some((t) => t.messageId === thread.messages[1]!.id), "usage keyed to the side answer");
		assert.ok(events.includes("side-chats-changed"));
		assert.ok(events.includes("record-changed"));

		// What the model saw: the side instructions, the lesson as a quoted
		// document, the passage, the hidden key of the open check.
		const context = contexts[0]!;
		assert.match(JSON.stringify(context), /SIDE-INSTRUCTIONS/);
		const firstUser = JSON.stringify(context.messages.find((m) => m.role === "user"));
		assert.match(firstUser, /<lesson>/);
		assert.match(firstUser, /Second paragraph\./);
		assert.match(firstUser, /OPEN question/);
		assert.doesNotMatch(firstUser, /SECRET-EXPLANATION/);
		assert.equal(service.list(chatId)!.threads.length, 1);
	});

	it("two selections and follow-ups in the same teaching segment share one conversation", async () => {
		const { service, chatId, anchor, answer, contexts } = setup();
		answer("one");
		const first = (await readAll(await service.ask(chatId, { anchor, text: "q1", quotes: ["first selection"] }))).at(-1)!.thread!;
		answer("two");
		const second = (await readAll(await service.ask(chatId, { anchor, text: "q2", quotes: ["second selection"] }))).at(-1)!.thread!;
		assert.equal(second.id, first.id, "same segment, same conversation");
		answer("three");
		await readAll(await service.ask(chatId, { threadId: first.id, text: "q3", quotes: [] }));
		const threads = chatStore.getChat(chatId)!.sideChats!;
		assert.deepEqual(threads.map((t) => t.id), [first.id]);
		assert.deepEqual(threads[0]!.messages.map((m) => m.text), ["q1", "one", "q2", "two", "q3", "three"]);
		assert.deepEqual(contexts.at(-1)!.messages.map((m) => m.role), ["system", "user", "assistant", "user", "assistant", "user"]);
		assert.match(JSON.stringify(contexts.at(-1)!.messages), /first selection/);
		assert.match(JSON.stringify(contexts.at(-1)!.messages), /second selection/);
	});

	it("refuses bad anchors, unknown threads and a busy thread; refusals save nothing", async () => {
		const { service, chatId, anchor, answer, refuse, faux } = setup();
		assert.equal((await service.ask(chatId, { anchor: { ...anchor, messageId: "msg_missing", partId: "msg_missing-t0" }, text: "q", quotes: [] })).status, 400);
		assert.equal((await service.ask(chatId, { threadId: "side_nope", text: "q", quotes: [] })).status, 404);
		assert.equal((await service.ask("chat_nope", { anchor, text: "q", quotes: [] })).status, 404);

		refuse(Response.json({ error: "No model configured" }, { status: 503 }));
		assert.equal((await service.ask(chatId, { anchor, text: "q", quotes: [] })).status, 503);
		assert.equal(chatStore.getChat(chatId)!.sideChats, undefined, "no orphan question");
		refuse(null);

		// Hold the answer open, then ask again on the same thread.
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		faux.appendResponses([async () => (await gate, fauxAssistantMessage("held"))]);
		const res = await service.ask(chatId, { anchor, text: "q", quotes: [] });
		const threadId = chatStore.getChat(chatId)!.sideChats![0]!.id;
		assert.equal(service.list(chatId)!.answering[threadId], "");
		assert.equal((await service.ask(chatId, { threadId, text: "again", quotes: [] })).status, 409);
		release();
		await readAll(res);
		assert.deepEqual(service.list(chatId)!.answering, {});
		answer("unused");
	});

	it("stop keeps the partial answer as stopped", async () => {
		const { service, chatId, anchor, faux } = setup({ tokensPerSecond: 40 });
		faux.appendResponses([fauxAssistantMessage("word ".repeat(400))]);
		const res = await service.ask(chatId, { anchor, text: "long?", quotes: [] });
		const threadId = chatStore.getChat(chatId)!.sideChats![0]!.id;
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let seen = "";
		while (!seen.includes('word')) seen += decoder.decode((await reader.read()).value);
		assert.equal(service.stop(chatId, threadId), true);
		await service.settled(chatId, threadId);
		const last = chatStore.getChat(chatId)!.sideChats![0]!.messages.at(-1)!;
		assert.equal(last.role, "assistant");
		assert.equal(last.stopped, true);
		assert.ok(last.text.length > 0 && last.text.length < "word ".repeat(400).length);
		assert.equal(service.stop(chatId, threadId), false, "nothing left to stop");
		await reader.cancel();
	});

	it("saves a failed answer and retry re-answers the same question", async () => {
		const { service, chatId, anchor, answer } = setup();
		answer(fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream 500" }));
		await readAll(await service.ask(chatId, { anchor, text: "q", quotes: [] }));
		let thread = chatStore.getChat(chatId)!.sideChats![0]!;
		assert.equal(thread.messages.at(-1)!.error, "upstream 500");

		answer("recovered");
		await readAll(await service.ask(chatId, { threadId: thread.id, text: "", quotes: [], retry: true }));
		thread = chatStore.getChat(chatId)!.sideChats![0]!;
		assert.deepEqual(thread.messages.map((m) => [m.role, m.text, m.error]), [["user", "q", undefined], ["assistant", "", "upstream 500"], ["assistant", "recovered", undefined]]);
		assert.equal((await service.ask(chatId, { threadId: thread.id, text: "", quotes: [], retry: true })).status, 409, "nothing to retry");
	});

	it("closing keeps messages and generation; deleting the whole session never resurrects it", async () => {
		const { service, chatId, anchor, answer, faux } = setup();
		answer("a");
		const thread = (await readAll(await service.ask(chatId, { anchor, text: "q", quotes: [] }))).at(-1)!.thread!;
		const closed = service.setOpen(chatId, thread.id, false);
		assert.equal(typeof closed === "object" && closed.open, false);
		assert.equal(chatStore.getChat(chatId)!.sideChats![0]!.open, false);
		assert.equal(service.setOpen(chatId, "side_nope", true), "unknown-thread");

		// A follow-up reopens the window.
		answer("b");
		await readAll(await service.ask(chatId, { threadId: thread.id, text: "q2", quotes: [] }));
		assert.equal(chatStore.getChat(chatId)!.sideChats![0]!.open, true);

		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		faux.appendResponses([async () => (await gate, fauxAssistantMessage("late"))]);
		const res = await service.ask(chatId, { threadId: thread.id, text: "q3", quotes: [] });
		service.setOpen(chatId, thread.id, false);
		release();
		await readAll(res);
		await service.settled(chatId, thread.id);
		assert.equal(chatStore.getChat(chatId)!.sideChats![0]!.messages.at(-1)!.text, "late");
		assert.equal(chatStore.getChat(chatId)!.sideChats![0]!.open, false);

		// Session deleted while answering: the settle has nowhere to land.
		answer("x");
		const other = setup();
		let release2!: () => void;
		const gate2 = new Promise<void>((r) => (release2 = r));
		other.faux.appendResponses([async () => (await gate2, fauxAssistantMessage("orphan"))]);
		const res2 = await other.service.ask(other.chatId, { anchor: other.anchor, text: "q", quotes: [] });
		chatStore.deleteChat(other.chatId);
		other.service.stopAll(other.chatId);
		release2();
		const lines = await readAll(res2);
		assert.equal(lines.at(-1)!.type, "error");
		assert.equal(chatStore.getChat(other.chatId), null);
	});
});

describe("side chat provider routing", () => {
	it("carries the chat id as the provider session so OpenCode Go can route the answer", async () => {
		const faux = createFauxCore({});
		faux.appendResponses([() => fauxAssistantMessage("Short answer.")]);
		let seen: string | undefined;
		const engine: PiEngine = {
			model: { ...faux.getModel(), provider: "opencode-go", id: "claude-haiku-5-5" },
			streamFn: (model, context, options) => { seen = options?.sessionId; return faux.streamSimple(model, context, options); },
		};
		const service = createSideChatService({ chatStore, engineFor: async () => engine, instructions: () => "SIDE-INSTRUCTIONS" });
		const chat = chatStore.createChat("side routing");
		const prose = assistant([text("A paragraph the learner selects."), call("q-routing", "quiz", QUIZ_ARGS)]);
		chatStore.saveMessages(chat.id, [newUserMessage("teach me"), prose]);
		const anchor: SideChatAnchor = { messageId: prose.id, partId: `${prose.id}-t0`, blockIndex: 0, blockText: "A paragraph the learner selects." };
		const lines = await readAll(await service.ask(chat.id, { anchor, text: "why?", quotes: [] }));
		assert.equal(lines.at(-1)!.type, "done");
		assert.equal(seen, chat.id);
	});
});
