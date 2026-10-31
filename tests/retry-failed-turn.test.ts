/**
 * Failed-response Retry (issue #110). Input is already durable. Retry
 * omits the trailing failures from the temporary agent context, never
 * deletes them from the transcript, and appends only genuinely new output.
 * Scripted faux engines: no real provider calls or learning data.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it, mock } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { Type } from "typebox";
import type { AgentBuildOptions, TeachingAgent } from "../src/agent/teacher-agent.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { QuestionData } from "../src/core/question-core.ts";
import type { SteerMessage } from "../src/core/contracts.ts";

// Set the storage/auth seams BEFORE any app/config-loading imports.
assert.equal(process.env.NODE_ENV, "test", "Run with NODE_ENV=test; these tests must not invoke real providers.");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-retry-failed-turn-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
process.env.OPENROUTER_API_KEY = "test-key-presence-gate";
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");

const { SessionModel } = await import("../components/session-core.ts");
const { createPracticeAgent, createProberAgent, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { clearTurnFailure, rememberTurnFailure, runningTurn, turnFailure } = await import("../src/server/turn-runs.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { subscribe } = await import("../src/core/events.ts");
const { buildAnswer, normalizeOptions, resolveCorrect } = await import("../src/core/question-core.ts");
const { ChatInputError, endsInFailedTurn, failedResponseAtEnd, inputAppends, parseChatInput, retryDrops } = await import("../src/core/input-events.ts");
const { INTERRUPTED_TEXT, asAgentMessages, hasProbeDone, newHandoffMessage, newPlanBlockMessage, newUserMessage, reconstructRequestCause, toLlmMessages } = await import("../src/core/native-messages.ts");
const { phaseAt3Lh } = await import("../src/core/phases.ts");
const { newCompactionMarker } = await import("../src/core/compaction.ts");

after(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});

const QUIZ_INPUT = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
	type: "check",
	nodeId: "planet-order",
};

const networkFailure: FauxResponseStep = () => { throw new Error("fetch failed"); };

/** Record the actual model context after the app's native conversion. */
function scripted(steps: FauxResponseStep[]) {
	const contexts: string[][] = [];
	const histories: string[] = [];
	const faux = createFauxCore({});
	faux.setResponses(steps.map((step) => (context, options, state, model) => {
		contexts.push(context.messages.map((m) => m.role).filter((role) => role !== "system"));
		histories.push(JSON.stringify(context.messages));
		return typeof step === "function" ? step(context, options, state, model) : step;
	}));
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	return { engine, contexts, histories };
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

type AgentFactory = (opts: AgentBuildOptions & { teaching: boolean }) => TeachingAgent;

/** POST one event; after acceptance drain the server-owned turn. */
async function turn(engine: PiEngine, chatId: string, input: unknown, buildAgent?: AgentFactory): Promise<Response> {
	const ack = await handleChatRequest(
		post(chatId, input),
		buildAgent ?? ((opts) => createTeacherAgent(undefined, { ...opts, engine })),
	);
	if (ack.status === 200) {
		const handle = runningTurn(chatId);
		if (handle) await new Response(handle.subscribe()).text();
	}
	return ack;
}

function createConfiguredChat(title: string, kind?: "practice") {
	const chat = chatStore.createChat(title, kind);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveTree(chat.id, { nodes: [{ id: "planet-order", title: "Planet order" }], edges: [], version: 1 });
	return chat;
}

function gradedAnswer() {
	const options = normalizeOptions(QUIZ_INPUT.options);
	const qd: QuestionData = {
		id: "call-1",
		kind: "quiz",
		question: QUIZ_INPUT.question,
		mode: "single-select",
		options,
		correctIndices: resolveCorrect(QUIZ_INPUT.correctAnswer, options).indices,
		explanation: QUIZ_INPUT.explanation,
		createdAt: new Date().toISOString(),
	};
	return buildAnswer(qd, { values: ["Mercury"], thinking: "Mercury is the innermost", readingThinking: "I followed the planet ordering", confidence: 80 });
}

const roles = (chatId: string) => chatStore.getChat(chatId)!.messages.map((m) => m.role);
const failed = (id: string, text = ""): LhMessage => ({
	...fauxAssistantMessage(text, { stopReason: "error", errorMessage: "fetch failed" }), id,
});
const compaction = (firstKeptMessageId: string) => newCompactionMarker("summary", {
	firstKeptMessageId, tokensBefore: 100, model: "fixture", at: "2026-01-01T00:00:00Z",
});

function assertPreserved(before: LhMessage[], saved: LhMessage[]): void {
	assert.deepEqual(saved.slice(0, before.length), before, "all previous messages, ids and partial content stay intact");
}

describe("failed-response Retry (issue #110)", () => {
	it("retries from the saved answer, preserving the full input and failed attempt", async () => {
		const { engine, contexts, histories } = scripted([
			() => fauxAssistantMessage([fauxToolCall("quiz", QUIZ_INPUT, { id: "call-1" })], { stopReason: "toolUse" }),
			networkFailure,
			() => fauxAssistantMessage([fauxText("Right — Mercury it is.")]),
		]);
		const chat = createConfiguredChat("Test: retry after failed answer");
		const answer = gradedAnswer();

		await turn(engine, chat.id, { type: "text", text: "teach me the planets" });
		await turn(engine, chat.id, { type: "answer", toolCallId: "call-1", answer });
		const before = chatStore.getChat(chat.id)!.messages;
		assert.deepEqual(roles(chat.id), ["user", "assistant", "toolResult", "assistant"]);
		assert.ok(endsInFailedTurn(before));
		assert.equal((await turn(engine, chat.id, { type: "answer", toolCallId: "call-1", answer })).status, 400);
		assert.equal((await turn(engine, chat.id, { type: "retry" })).status, 200);

		const saved = chatStore.getChat(chat.id)!.messages;
		assertPreserved(before, saved);
		assert.deepEqual(roles(chat.id), ["user", "assistant", "toolResult", "assistant", "assistant"]);
		assert.equal(endsInFailedTurn(saved), false, "a new successful response supersedes the retained failure");
		const results = saved.filter((m) => m.role === "toolResult" && m.toolCallId === "call-1");
		assert.equal(results.length, 1, "the learner's answer was not submitted twice");
		const result = results[0]!;
		assert.ok(result.role === "toolResult");
		assert.deepEqual(result.details, JSON.parse(JSON.stringify(answer)));
		assert.match(JSON.stringify(saved.at(-1)), /Mercury it is/);
		assert.deepEqual(contexts.at(-1), ["user", "assistant", "toolResult"]);
		assert.match(histories.at(-1)!, /Mercury is the innermost/);
	});

	it("a failed text turn retries without adding another learner message", async () => {
		const { engine, contexts } = scripted([networkFailure, () => fauxAssistantMessage("Hello again.")]);
		const chat = createConfiguredChat("Test: retry after failed text");
		await turn(engine, chat.id, { type: "text", text: "hello" });
		const before = chatStore.getChat(chat.id)!.messages;
		assert.ok(endsInFailedTurn(before));
		assert.equal((await turn(engine, chat.id, { type: "retry" })).status, 200);
		const saved = chatStore.getChat(chat.id)!.messages;
		assertPreserved(before, saved);
		assert.deepEqual(roles(chat.id), ["user", "assistant", "assistant"]);
		assert.deepEqual(contexts.at(-1), ["user"]);
		assert.match(JSON.stringify(saved.at(-1)), /Hello again/);
	});

	it("preserves partial text and its usage reference before the replacement succeeds", { timeout: 5_000 }, async () => {
		const chat = createConfiguredChat("Test: retained partial reply");
		const before = [newUserMessage("hello"), failed("partial", "A partial explanation already shown.")];
		chatStore.saveMessages(chat.id, before);
		const usage = { id: "original-turn", messageId: "partial", at: "2026-01-01T00:00:00Z", model: "faux:fixture", steps: [] };
		chatStore.appendTurnUsage(chat.id, usage);
		let release!: () => void;
		let started!: () => void;
		const waiting = new Promise<void>((resolve) => { release = resolve; });
		const entered = new Promise<void>((resolve) => { started = resolve; });
		const { engine, histories } = scripted([async () => {
			started();
			await waiting;
			return fauxAssistantMessage("Replacement response.");
		}]);
		const retry = turn(engine, chat.id, { type: "retry" });
		await entered;
		try {
			assert.deepEqual(chatStore.getChat(chat.id)!.messages, before, "write-ahead must not delete the failed attempt");
			assert.deepEqual(chatStore.getChat(chat.id)!.turns, [usage]);
			assert.doesNotMatch(histories.at(-1)!, /partial explanation/);
		} finally {
			release();
			await retry;
		}
		const saved = chatStore.getChat(chat.id)!;
		assertPreserved(before, saved.messages);
		assert.ok(saved.turns?.some((entry) => entry.id === usage.id && entry.messageId === "partial"));
		assert.equal(saved.messages.length, before.length + 1, "the persistence offset counts the temporary prefix, not the full saved record");
	});

	it("keeps every failed attempt across repeated retries, then appends success once", async () => {
		const { engine, contexts } = scripted([networkFailure, networkFailure, () => fauxAssistantMessage("Recovered.")]);
		const chat = createConfiguredChat("Test: repeated model failure");
		await turn(engine, chat.id, { type: "text", text: "hello" });
		const first = chatStore.getChat(chat.id)!.messages;
		await turn(engine, chat.id, { type: "retry" });
		const second = chatStore.getChat(chat.id)!.messages;
		assertPreserved(first, second);
		assert.equal(second.length, first.length + 1);
		assert.ok(endsInFailedTurn(second));
		await turn(engine, chat.id, { type: "retry" });
		const saved = chatStore.getChat(chat.id)!.messages;
		assertPreserved(second, saved);
		assert.equal(saved.length, second.length + 1);
		assert.deepEqual(contexts, [["user"], ["user"], ["user"]]);
		assert.equal(new SessionModel({ chatId: chat.id, initialMessages: saved }).getState().error, null);
	});

	it("preserves a trailing plan block while retrying from the preceding input", async () => {
		const { engine, contexts } = scripted([networkFailure, () => fauxAssistantMessage("Planned reply.")]);
		const chat = createConfiguredChat("Test: retry past a plan block");
		await turn(engine, chat.id, { type: "text", text: "hello" });
		const before = [...chatStore.getChat(chat.id)!.messages, newPlanBlockMessage("plan-1", {})];
		chatStore.saveMessages(chat.id, before);
		assert.ok(endsInFailedTurn(before));
		assert.equal((await turn(engine, chat.id, { type: "retry" })).status, 200);
		const saved = chatStore.getChat(chat.id)!.messages;
		assertPreserved(before, saved);
		assert.deepEqual(roles(chat.id), ["user", "assistant", "custom", "assistant"]);
		assert.deepEqual(contexts.at(-1), ["user"], "the plan block remains UI-only");
	});

	it("does not reexecute completed tools before a later model failure", async () => {
		let executions = 0;
		const { engine, contexts } = scripted([
			() => fauxAssistantMessage([fauxToolCall("save_note", {}, { id: "note-1" })], { stopReason: "toolUse" }),
			networkFailure,
			() => fauxAssistantMessage("The saved note is ready."),
		]);
		const tools: AgentBuildOptions["tools"] = {
			save_note: {
				name: "save_note", label: "save_note", description: "Record one fixture side effect.", parameters: Type.Object({}),
				execute: async () => {
					executions++;
					return { content: [{ type: "text", text: "Note saved" }], details: { saved: true } };
				},
			},
		};
		const factory: AgentFactory = (opts) => createTeacherAgent(undefined, { ...opts, engine, tools });
		const chat = createConfiguredChat("Test: no completed tool replay");
		await turn(engine, chat.id, { type: "text", text: "save a note" }, factory);
		assert.equal(executions, 1);
		const before = chatStore.getChat(chat.id)!.messages;
		assert.deepEqual(roles(chat.id), ["user", "assistant", "toolResult", "assistant"]);
		assert.equal((await turn(engine, chat.id, { type: "retry" }, factory)).status, 200);
		assert.equal(executions, 1, "Retry requests another response, not execution of stored calls");
		assertPreserved(before, chatStore.getChat(chat.id)!.messages);
		assert.deepEqual(contexts.at(-1), ["user", "assistant", "toolResult"]);
	});

	it("never executes tool calls carried by a failed partial response", async () => {
		let executions = 0;
		const { engine, contexts } = scripted([
			() => fauxAssistantMessage([fauxToolCall("save_note", {}, { id: "unexecuted" })], { stopReason: "error", errorMessage: "cut off" }),
			() => fauxAssistantMessage("Recovered without running the partial call."),
		]);
		const factory: AgentFactory = (opts) => createTeacherAgent(undefined, {
			...opts, engine,
			tools: {
				save_note: {
					name: "save_note", label: "save_note", description: "Must not execute.", parameters: Type.Object({}),
					execute: async () => { executions++; return { content: [], details: {} }; },
				},
			},
		});
		const chat = createConfiguredChat("Test: unexecuted partial tool call");
		await turn(engine, chat.id, { type: "text", text: "hello" }, factory);
		assert.equal(executions, 0);
		const before = chatStore.getChat(chat.id)!.messages;
		assert.equal((await turn(engine, chat.id, { type: "retry" }, factory)).status, 200);
		assert.equal(executions, 0);
		assertPreserved(before, chatStore.getChat(chat.id)!.messages);
		assert.deepEqual(contexts.at(-1), ["user"]);
	});

	it("a retained failed probe retries with the prober, concludes once, then selects the teacher", async () => {
		const input = { assessment: { strands: [{ strand: "planet order", assessment: "Names known; ordering needs work." }] } };
		const { engine, histories } = scripted([
			() => fauxAssistantMessage([fauxToolCall("probe_done", input, { id: "failed-probe" })], { stopReason: "error", errorMessage: "cut off" }),
			() => fauxAssistantMessage([fauxToolCall("probe_done", input, { id: "fresh-probe" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage("Assessment ready."),
			() => fauxAssistantMessage("Now planning the lesson."),
		]);
		const chat = createConfiguredChat("Test: failed probe recovery");
		const delivered: SteerMessage[] = [];
		const selections: boolean[] = [];
		const factory: AgentFactory = (opts) => {
			selections.push(opts.teaching);
			if (opts.teaching) return createTeacherAgent(undefined, { ...opts, engine });
			return createProberAgent({
				chatId: chat.id, chatStore, jobStore, deliver: (s) => delivered.push(s), spawn: () => {},
			}, { ...opts, engine });
		};
		await turn(engine, chat.id, { type: "text", text: "teach me planet order" }, factory);
		const before = chatStore.getChat(chat.id)!.messages;
		assert.ok(endsInFailedTurn(before));
		assert.equal(hasProbeDone(before), false);
		assert.equal(phaseAt3Lh(before), "probe");
		assert.equal(delivered.length, 0, "the stored failed call never ran");

		assert.equal((await turn(engine, chat.id, { type: "retry" }, factory)).status, 200);
		const recovered = chatStore.getChat(chat.id)!.messages;
		assertPreserved(before, recovered);
		assert.deepEqual(selections, [false, false], "Retry must still build the prober");
		assert.equal(hasProbeDone(recovered), true);
		assert.equal(phaseAt3Lh(recovered), "plan");
		assert.equal(delivered.length, 1, "the full retained-store guard accepts the fresh conclusion");
		assert.deepEqual(recovered.filter((m) => m.role === "toolResult").map((m) => m.role === "toolResult" && m.toolCallId), ["fresh-probe"]);
		assert.doesNotMatch(histories[1]!, /failed-probe/, "the failed call is omitted only from temporary Retry history");

		assert.equal((await turn(engine, chat.id, { type: "text", text: "go on" }, factory)).status, 200);
		assert.deepEqual(selections, [false, false, true]);
		assert.equal(delivered.length, 1, "later turns do not replay either saved call");
		assertPreserved(recovered, chatStore.getChat(chat.id)!.messages);
	});

	for (const kind of ["prober", "teacher", "practice"] as const) {
		it(`uses the same retained-history retry boundary for the ${kind}`, async () => {
			const { engine, contexts } = scripted([() => fauxAssistantMessage("Recovered response.")]);
			const chat = createConfiguredChat(`Test: ${kind} retry`, kind === "practice" ? "practice" : undefined);
			const before: LhMessage[] = [newUserMessage("hello")];
			if (kind === "teacher") {
				before.push({ ...fauxAssistantMessage([fauxToolCall("probe_done", {}, { id: "probe-1" })], { stopReason: "toolUse" }), id: "probe-response" });
				before.push({ id: "probe-result", role: "toolResult", toolCallId: "probe-1", toolName: "probe_done", content: [], details: { ok: true }, isError: false, timestamp: 1 });
			}
			before.push(failed("failed-response", "Partial reply."));
			chatStore.saveMessages(chat.id, before);
			const factory: AgentFactory = (opts) => {
				assert.equal(opts.teaching, kind === "teacher");
				assert.ok(opts.messages?.every((m) => m.role !== "assistant" || m.stopReason !== "error"));
				if (kind === "practice") return createPracticeAgent({ chatId: chat.id, chatStore }, { ...opts, engine });
				if (kind === "prober") return createProberAgent({ chatId: chat.id, chatStore, jobStore, deliver: () => {}, spawn: () => {} }, { ...opts, engine });
				return createTeacherAgent(undefined, { ...opts, engine });
			};
			assert.equal((await turn(engine, chat.id, { type: "retry" }, factory)).status, 200);
			assertPreserved(before, chatStore.getChat(chat.id)!.messages);
			assert.equal(chatStore.getChat(chat.id)!.messages.length, before.length + 1);
			assert.deepEqual(contexts.at(-1), kind === "teacher" ? ["user", "assistant", "toolResult"] : ["user"]);
		});
	}

	it("treats an explicit Retry of an automatic main-agent response as foreground", async () => {
		const { engine } = scripted([() => fauxAssistantMessage("Explicitly requested response.")]);
		const chat = createConfiguredChat("Test: foreground manual retry");
		const before = [newUserMessage("hello"), newHandoffMessage(chat.id), failed("automatic-failure")];
		chatStore.saveMessages(chat.id, before);
		assert.equal(reconstructRequestCause(before), "background");
		let built = false;
		const factory: AgentFactory = (opts) => {
			built = true;
			assert.equal(opts.callPurpose?.background, false);
			return createTeacherAgent(undefined, { ...opts, engine });
		};
		assert.equal((await turn(engine, chat.id, { type: "retry" }, factory)).status, 200);
		assert.ok(built);
		assertPreserved(before, chatStore.getChat(chat.id)!.messages);
	});
});

describe("retained generations and Pi's native provider filtering", () => {
	for (const stopReason of ["error", "aborted"] as const) {
		it(`does not fabricate results for ${stopReason} partial tool calls on later requests`, () => {
			const faux = createFauxCore({});
			const partial: LhMessage = {
				...fauxAssistantMessage([fauxToolCall("save_note", {}, { id: "partial-call" })], { stopReason }), id: "partial",
			};
			const recovered: LhMessage = { ...fauxAssistantMessage("Recovered."), id: "recovered" };
			const messages = [newUserMessage("hello"), partial, recovered, newUserMessage("next question")];
			const before = JSON.parse(JSON.stringify(messages));
			const converted = toLlmMessages(asAgentMessages(messages));
			assert.ok(converted.some((m) => m.role === "assistant" && m.stopReason === stopReason), "the app still leaves failed-generation filtering to Pi");
			assert.equal(converted.filter((m) => m.role === "toolResult").length, 0, "no orphan synthetic result for an unexecuted partial call");
			const providerHistory = transformMessages(converted, faux.getModel());
			assert.deepEqual(providerHistory.map((m) => m.role), ["user", "assistant", "user"]);
			assert.doesNotMatch(JSON.stringify(providerHistory), /partial-call/);
			assert.deepEqual(messages, before, "model conversion never changes the saved attempts");
		});
	}

	it("keeps an actual tool-cancellation result and its completed calling message", () => {
		const faux = createFauxCore({});
		const call: LhMessage = {
			...fauxAssistantMessage([fauxToolCall("save_note", {}, { id: "completed-call" })], { stopReason: "toolUse" }), id: "caller",
		};
		const cancellation: LhMessage = {
			id: "cancelled-result", role: "toolResult", toolCallId: "completed-call", toolName: "save_note",
			content: [{ type: "text", text: "Tool execution was aborted." }], isError: true, timestamp: 1,
		};
		const messages = [newUserMessage("hello"), call, cancellation, newUserMessage("continue")];
		const providerHistory = transformMessages(toLlmMessages(asAgentMessages(messages)), faux.getModel());
		assert.deepEqual(providerHistory.map((m) => m.role), ["user", "assistant", "toolResult", "user"]);
		const result = providerHistory.find((m) => m.role === "toolResult");
		assert.ok(result?.role === "toolResult");
		assert.equal(result.toolCallId, "completed-call");
		assert.equal(result.isError, true);
		assert.deepEqual(result.content, cancellation.content);
	});

	it("still repairs an unanswered call from a completed generation", () => {
		const faux = createFauxCore({});
		const question: LhMessage = {
			...fauxAssistantMessage([fauxToolCall("quiz", QUIZ_INPUT, { id: "unanswered-question" })], { stopReason: "toolUse" }), id: "question",
		};
		const messages = [newUserMessage("hello"), question, newUserMessage("move on")];
		const before = JSON.parse(JSON.stringify(messages));
		const providerHistory = transformMessages(toLlmMessages(asAgentMessages(messages)), faux.getModel());
		assert.deepEqual(providerHistory.map((m) => m.role), ["user", "assistant", "toolResult", "user"]);
		const result = providerHistory.find((m) => m.role === "toolResult");
		assert.ok(result?.role === "toolResult");
		assert.equal(result.toolCallId, "unanswered-question");
		assert.deepEqual(result.content, [{ type: "text", text: INTERRUPTED_TEXT }]);
		assert.deepEqual(messages, before, "the repair is temporary, never persisted");
	});
});

describe("Retry refusal and revalidation", () => {
	it("rejects an invalid Retry before provider gates, turn claims or writes", async () => {
		const chat = chatStore.createChat("Test: retry refused before subscription refresh");
		chatStore.saveSettings(chat.id, { model: { provider: "chatgpt", id: "not-a-fixture-model" } });
		const before = chatStore.getChat(chat.id)!;
		rememberTurnFailure(chat.id, "Existing settlement notice");
		const events: string[] = [];
		const unsubscribe = subscribe((event) => { if ("chatId" in event && event.chatId === chat.id) events.push(event.type); });
		try {
			const res = await handleChatRequest(post(chat.id, { type: "retry" }), () => { throw new Error("must not construct an agent"); });
			assert.equal(res.status, 400, "invalid retry wins even with an unavailable subscription model");
			assert.match(await res.text(), /requires a failed turn/);
			assert.deepEqual(chatStore.getChat(chat.id), before);
			assert.equal(turnFailure(chat.id), "Existing settlement notice", "beginTurn did not clear recovery state");
			assert.equal(isTurnRunning(chat.id), false);
			assert.deepEqual(events, []);
		} finally {
			unsubscribe();
			clearTurnFailure(chat.id);
		}
	});

	it("rejects Retry after later compaction without removing the error or its boundary", async () => {
		const { engine, contexts } = scripted([]);
		const chat = createConfiguredChat("Test: compacted failure");
		const failure = failed("partial", "Partial explanation.");
		const marker = compaction(failure.id);
		const before = [newUserMessage("hello"), failure, marker];
		chatStore.saveMessages(chat.id, before);
		const snapshot = chatStore.getChat(chat.id)!;
		const res = await turn(engine, chat.id, { type: "retry" });
		assert.equal(res.status, 400);
		const body = await res.json() as { error: string };
		assert.equal(body.error, "fetch failed\n\nThis response cannot be retried after compaction. Send a new message to continue.");
		assert.deepEqual(chatStore.getChat(chat.id), snapshot);
		assert.equal(contexts.length, 0);
		assert.equal(new SessionModel({ chatId: chat.id, initialMessages: before }).getState().error?.message, "fetch failed");
		assert.equal(endsInFailedTurn(before), false);
	});

	for (const later of ["compaction", "learner-input"] as const) {
		it(`revalidates against ${later} landing on the post-compaction reread`, async () => {
			const { engine, contexts } = scripted([]);
			const chat = createConfiguredChat(`Test: retry race with ${later}`);
			const before = [newUserMessage("hello"), failed("failed-response")];
			chatStore.saveMessages(chat.id, before);
			const appended = later === "compaction" ? compaction("failed-response") : newUserMessage("A newer input");
			const read = chatStore.getChat;
			let reads = 0;
			// Simulate another writer landing during the awaited gate. Do not
			// change or invoke the compaction implementation to exercise Retry.
			const reader = mock.method(chatStore, "getChat", (id: string) => {
				if (id === chat.id && ++reads === 2) chatStore.saveMessages(id, [...before, appended]);
				return read(id);
			});
			const events: string[] = [];
			const unsubscribe = subscribe((event) => { if ("chatId" in event && event.chatId === chat.id) events.push(event.type); });
			try {
				const res = await turn(engine, chat.id, { type: "retry" });
				assert.equal(res.status, 400);
				if (later === "compaction") assert.match(await res.text(), /fetch failed.*cannot be retried after compaction/);
				assert.deepEqual(read(chat.id)!.messages, [...before, appended]);
				assert.equal(contexts.length, 0);
				assert.equal(isTurnRunning(chat.id), false);
				assert.deepEqual(events, [], "no turn was claimed after final validation refused");
			} finally {
				reader.mock.restore();
				unsubscribe();
			}
		});
	}

	it("a sibling's successful retry makes a later stale Retry refuse without changing history", async () => {
		const { engine, contexts } = scripted([networkFailure, () => fauxAssistantMessage("Recovered.")]);
		const chat = createConfiguredChat("Test: stale sibling Retry");
		await turn(engine, chat.id, { type: "text", text: "hello" });
		await turn(engine, chat.id, { type: "retry" });
		const before = chatStore.getChat(chat.id)!;
		assert.equal((await turn(engine, chat.id, { type: "retry" })).status, 400);
		assert.deepEqual(chatStore.getChat(chat.id), before);
		assert.equal(contexts.length, 2);
	});
});

describe("the Retry button's client path", () => {
	it("keeps the original model error plus the explanation when compaction wins the click race", async () => {
		const messages = [newUserMessage("hello"), failed("failed-response")];
		const compacted = [...messages, compaction("failed-response")];
		const explanation = "This response cannot be retried after compaction. Send a new message to continue.";
		const refused = `fetch failed\n\n${explanation}`;
		const m = new SessionModel({
			chatId: "chat_x", initialMessages: messages,
			fetch: async (_url, init) => {
				assert.equal(init?.method, "POST");
				assert.deepEqual(JSON.parse(String(init?.body)).input, { type: "retry" });
				m.adoptRecord(compacted);
				return Response.json({ error: refused }, { status: 400 });
			},
		});
		await m.send({ type: "retry" });
		assert.equal(m.getState().status, "error");
		assert.equal(m.getState().error!.message, refused, "the banner keeps both messages as readable text, without JSON syntax");
		assert.deepEqual(m.getState().nativeMessages, compacted);
		assert.equal(endsInFailedTurn(m.getState().nativeMessages), false);
	});

	for (const { status, body, expected } of [
		{ status: 400, body: '{"error":"retry input requires a failed turn to retry"}', expected: "retry input requires a failed turn to retry" },
		{ status: 400, body: "Plain refusal", expected: "Plain refusal" },
		{ status: 400, body: '{"reason":"not an error envelope"}', expected: '{"reason":"not an error envelope"}' },
		{ status: 503, body: '{"error":"model gate","code":"models_not_configured"}', expected: '{"error":"model gate","code":"models_not_configured"}' },
	]) {
		it(`preserves the appropriate Retry refusal format for ${status}: ${body}`, async () => {
			const m = new SessionModel({
				chatId: "chat_x", initialMessages: [newUserMessage("hello"), failed("failed-response")],
				fetch: async () => new Response(body, { status }),
			});
			await m.send({ type: "retry" });
			assert.equal(m.getState().error?.message, expected);
		});
	}

	it("after a dropped request, Retry posts straight from the error status", async () => {
		const failedTurn = [newUserMessage("hello"), failed("a1")];
		const posted: string[] = [];
		let online = false;
		const fetch = (async (_url: string, init?: RequestInit) => {
			if (!online) throw new TypeError("Failed to fetch");
			if (init?.method === "POST") posted.push(String(init.body));
			return new Response("{}", { status: 500 });
		}) as typeof globalThis.fetch;
		const m = new SessionModel({ chatId: "chat_x", initialMessages: failedTurn, fetch });
		await m.send({ type: "retry" });
		assert.equal(m.getState().status, "error");
		online = true;
		await m.send({ type: "retry" });
		assert.equal(posted.length, 1, "send() recovers from error without stop()");
		assert.deepEqual(JSON.parse(posted[0]!).input, { type: "retry" });
		assert.deepEqual(m.getState().nativeMessages, failedTurn, "there is no optimistic learner message or deletion");
	});
});

describe("Retry eligibility and temporary omissions (pure)", () => {
	it("parses Retry without appending input", () => {
		const input = parseChatInput({ type: "retry" });
		assert.deepEqual(input, { type: "retry" });
		assert.deepEqual(inputAppends({ messages: [newUserMessage("hi"), failed("a1")] }, input), []);
	});

	it("omits consecutive failures back to their input without mutating the record", () => {
		const messages = [newUserMessage("hi"), failed("a1"), failed("a2")];
		const before = JSON.parse(JSON.stringify(messages));
		assert.deepEqual([...retryDrops(messages)].sort(), ["a1", "a2"]);
		assert.deepEqual(messages, before);
	});

	it("looks past plan blocks, but compaction after the latest failure blocks Retry", () => {
		const user = newUserMessage("hi");
		const failure = failed("a1");
		const block = newPlanBlockMessage("plan-1", {});
		const marker = compaction(user.id);
		assert.deepEqual([...retryDrops([user, failure, block])], ["a1"]);
		assert.equal(endsInFailedTurn([user, block]), false);
		for (const messages of [[user, failure, marker], [user, failure, marker, block], [user, failure, block, marker]]) {
			assert.equal(endsInFailedTurn(messages), false);
			assert.equal(failedResponseAtEnd(messages)?.id, failure.id, "only the Retry button disappears, not the banner");
			assert.throws(() => retryDrops(messages), /fetch failed[\s\S]*cannot be retried after compaction/);
		}
		assert.deepEqual([...retryDrops([user, failed("old"), marker, failed("new")])], ["new"], "a failure after compaction can retry its already-compacted starting state");
	});

	it("excludes aborts, healthy responses, missing input and assistant-only predecessors", () => {
		const user = newUserMessage("hi");
		const aborted = { ...failed("aborted"), stopReason: "aborted" } as LhMessage;
		const healthy = { ...fauxAssistantMessage("Done"), id: "healthy" } as LhMessage;
		for (const messages of [[user], [failed("a1")], [user, aborted], [user, healthy], [healthy, failed("a1")]]) {
			assert.equal(endsInFailedTurn(messages), false);
			assert.throws(() => retryDrops(messages), ChatInputError);
		}
		assert.equal(failedResponseAtEnd([user, failed("old"), aborted]), undefined);
	});
});
