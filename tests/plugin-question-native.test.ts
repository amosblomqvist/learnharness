import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { LhMessage } from "../src/core/native-messages.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-native-question-"));
process.env.LH_DATA_DIR = path.join(root, "data");
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Unexpected network in isolated native-question tests"); };
after(() => { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); });
const { preparePluginQuestionType, readPluginQuestionSnapshot } = await import("../src/core/plugin-questions.ts");
const { createProberAgent } = await import("../src/agent/teacher-agent.ts");
const { runPiTurn } = await import("../src/server/pi/ui-stream.ts");
const { newUserMessage, pendingPluginQuestionOf, toLlmMessages } = await import("../src/core/native-messages.ts");
const { preparePluginQuestionAnswer, preparePluginQuestionDismissal, pluginQuestionCompatibilityAppends, pluginQuestionAvailabilityOf } = await import("../src/server/plugin-questions.ts");
const { assertPluginQuestionInputAllowed } = await import("../src/core/input-events.ts");
const { projectView } = await import("../src/core/view.ts");
const { SubscriptionRequestCycle } = await import("../src/agent/subscription-request-cycle.ts");
const { persistTurn } = await import("../src/server/turn-service.ts");

const definition = preparePluginQuestionType({
	id: "code", label: "Code answer", contractVersion: 1, showThinking: true,
	questionSchema: Type.Object({ privateReference: Type.String() }),
	answerSchema: Type.Union([Type.String(), Type.Boolean(), Type.Number(), Type.Null(), Type.Array(Type.String())]),
	probe: { toolName: "plugin_code", description: "Pose a code question." },
});
const contribution = { pluginId: "fixture", definition, variant: "probe" as const, signal: new AbortController().signal, requireActive() {} };
function readEvents(text: string): any[] {
	return text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
}
async function nativePose(mixed = false, sameId = false, admission?: "admitted" | "denied") {
	const faux = createFauxCore({});
	faux.setResponses([
		fauxAssistantMessage([
			...(mixed ? [fauxToolCall("plugin_code", { question: " ", payload: { privateReference: "SECRET" } }, { id: sameId ? "call" : "bad" }),
				fauxToolCall("ordinary", {}, { id: "ordinary" })] : []),
			fauxToolCall("plugin_code", { question: "Write a value.\n", payload: { privateReference: "SECRET" } }, { id: "call" }),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("Must not run over an unanswered successful pose."),
	]);
	const user = newUserMessage("Start");
	const requestCycle = admission ? new SubscriptionRequestCycle({ initialMessages: [user], foregroundOwed: true, purpose: { background: false }, scopeCurrent: () => true, restoreAutomatic() {} }) : undefined;
	const agent = createProberAgent({ chatId: "fixture" } as any, {
		chatId: "fixture", messages: [user], requestCycle, engine: { model: faux.getModel(), streamFn: (model, context, options) => {
			if (requestCycle) {
				const scope = { accountId: "fixture", epoch: 1, authorityRevision: 1, selectedModelId: "fixture" };
				requestCycle.captured(scope);
				if (admission === "admitted") requestCycle.beforeDispatch(scope);
				else requestCycle.noDispatch("all");
			}
			return faux.streamSimple(model, context, options);
		} },
		pluginContributions: () => ({ instructions: [], tools: mixed ? [{ name: "ordinary", label: "ordinary", description: "Ordinary", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "Question posed" }], details: null }) }] : [], questionTypes: [contribution] }),
	});
	let canonical: LhMessage[] = [];
	const handle = runPiTurn({ agent, requestCycle, usedToolCallIds: new Set(["call"]), onFinish(messages) { canonical = messages as LhMessage[]; } });
	const wire = readEvents(await new Response(handle.subscribe()).text());
	return { faux, agent, canonical, wire, user, handle };
}

test("validated native pose binds normalized immutable input, exact remapped occurrence and hides every temporary ack carrier", async () => {
	const { faux, agent, canonical, wire } = await nativePose();
	assert.equal(faux.state.callCount, 1);
	const snapshot = pendingPluginQuestionOf(canonical)!;
	assert(snapshot);
	assert.equal(snapshot.occurrence.toolCallId, "call~2");
	assert.equal(snapshot.input.question, "Write a value.\n");
	assert(Object.isFrozen(snapshot.input));
	assert(Object.isFrozen(snapshot));
	assert(Object.isFrozen(snapshot.occurrence));
	assert(Object.isFrozen(snapshot.questionSchema));
	assert(readPluginQuestionSnapshot(snapshot));
	assert.equal(canonical.filter(message => message.role === "toolResult").length, 0);
	assert(agent.state.messages.some(message => message.role === "toolResult"), "the native-only temporary ack still terminates the engine");
	assert(!wire.some(event => event.type === "tool_execution_end" && event.toolCallId === "call~2"));
	for (const event of wire) {
		if (["message_start", "message_update", "message_end"].includes(event.type) && event.message?.role === "toolResult") assert.fail("ack message leaked");
		if (event.type === "turn_end") assert.equal(event.toolResults.length, 0);
		if (event.type === "agent_end") assert(!event.messages.some((message: any) => message.role === "toolResult"));
		if (["message_start", "message_update", "message_end"].includes(event.type) && event.message?.role === "assistant") {
			event.message.content.forEach((block: any, index: number) => {
				if (block.type === "toolCall" && block.name === "plugin_code") {
					assert.equal(event.message.lhQuestions[index].typeId, "code");
					assert.equal(event.message.lhQuestions[index].questionId, undefined, "live annotations grant visibility, not authority");
				}
			});
		}
	}
	assert(!JSON.stringify(toLlmMessages(canonical)).includes("lhQuestions"));
});

test("a successful pose stops a mixed batch despite a failed sibling; ordinary results and failed attempts persist", async () => {
	const { faux, canonical, wire } = await nativePose(true);
	assert.equal(faux.state.callCount, 1);
	const assistant = canonical.find(message => message.role === "assistant")! as any;
	assert.equal(assistant.lhQuestions[0].questionId, undefined);
	assert.equal(assistant.lhQuestions[2].questionId, pendingPluginQuestionOf(canonical)!.questionId);
	assert(canonical.some(message => message.role === "toolResult" && message.toolCallId === "bad" && message.isError));
	assert(canonical.some(message => message.role === "toolResult" && message.toolCallId === "ordinary"));
	assert(wire.some(event => event.type === "tool_execution_end" && event.toolCallId === "ordinary"));
	const record = { id: "fixture", messages: [canonical[0]!] };
	const store = { getChat: () => record, saveMessages: (_id: string, messages: LhMessage[]) => { record.messages = messages; } };
	persistTurn(store as any, "fixture", 1, canonical, false);
	assert(record.messages.some(message => message.role === "toolResult" && message.toolCallId === "bad"));
	assert(pendingPluginQuestionOf(record.messages));
	const failed = projectView(canonical).flatMap(message => message.parts).find(part => part.pluginQuestion?.status === "attempt")!;
	assert(failed, "failed native authoring remains classified before generic tool rendering");
	assert.equal(failed.errorText, undefined);
	assert.equal(failed.input, undefined, "the view never provides authored private payload to the generic raw trace");
});

test("native validated-call object binding distinguishes identical IDs within one message and replay remains visibility-only", async () => {
	const { canonical, wire, handle } = await nativePose(true, true);
	const snapshot = pendingPluginQuestionOf(canonical)!;
	assert.equal(snapshot.occurrence.contentIndex, 2, "the failed first occurrence cannot claim the later success");
	assert.equal(snapshot.occurrence.toolCallId, "call~2");
	const replay = readEvents(await new Response(handle.subscribe()).text());
	assert.deepEqual(replay, wire);
	for (const event of replay) {
		if (event.message?.lhQuestions) for (const annotation of Object.values(event.message.lhQuestions) as any[]) assert.equal(annotation.questionId, undefined);
		if (event.type === "turn_end") assert.equal(event.toolResults.length, 2, "only attested ack removed, including when failed sibling shares its ID");
	}
});

test("subscription admission precedes question decoration and settlement; denied frames never establish wire or canonical authority", async () => {
	const admitted = await nativePose(false, false, "admitted");
	assert(pendingPluginQuestionOf(admitted.canonical));
	assert(admitted.wire.some(event => event.message?.lhQuestions));
	const denied = await nativePose(false, false, "denied");
	assert.equal(pendingPluginQuestionOf(denied.canonical), undefined);
	assert(!denied.wire.some(event => event.message?.lhQuestions || event.messages?.some((message: any) => message.lhQuestions)));
});

test("saved contract validation accepts false/zero/null/empty verbatim values and binds results to exact occurrence", async () => {
	const { canonical } = await nativePose();
	const snapshot = pendingPluginQuestionOf(canonical)!;
	let newlyAddedRefinements = 0;
	const available = () => ({ status: "available" as const, definition: { ...definition, validateAnswer() { newlyAddedRefinements++; return ["must not run"]; } }, signal: contribution.signal, requireActive() {} });
	for (const value of [false, 0, null, "", [], "  code\n"]) {
		const result = preparePluginQuestionAnswer({ id: "fixture", messages: canonical }, { type: "plugin-question-answer", questionId: snapshot.questionId, occurrence: snapshot.occurrence, answer: value, thinking: "" }, available)[0]! as any;
		assert.deepEqual(result.details.answer, value);
		assert.equal(result.details.thinking, "");
		assert.equal(result.details.readingThinking, undefined);
		assert.deepEqual(result.lhQuestionOccurrence, snapshot.occurrence);
		assert.equal(pendingPluginQuestionOf([...canonical, result]), undefined);
		assert.throws(() => preparePluginQuestionAnswer({ id: "fixture", messages: [...canonical, result] }, { type: "plugin-question-answer", questionId: snapshot.questionId, occurrence: snapshot.occurrence, answer: value }, available));
	}
	assert.equal(newlyAddedRefinements, 0);
	assert.throws(() => preparePluginQuestionAnswer({ id: "fixture", messages: canonical }, { type: "plugin-question-answer", questionId: snapshot.questionId, occurrence: { ...snapshot.occurrence, messageId: "old-duplicate" }, answer: false }, available));
	assert.throws(() => preparePluginQuestionAnswer({ id: "fixture", messages: canonical }, { type: "plugin-question-answer", questionId: snapshot.questionId, occurrence: snapshot.occurrence, answer: Number.NaN }, available));
	assert.throws(() => preparePluginQuestionAnswer({ id: "fixture", messages: canonical }, { type: "plugin-question-answer", questionId: snapshot.questionId, occurrence: snapshot.occurrence, answer: false, readingThinking: "injected" }, available));
});

test("new protocol blocks legacy bypasses; missing/undeclared versions keep pending, explicit incompatibility and dismissal are honest silent cancellations", async () => {
	const { canonical } = await nativePose();
	const snapshot = pendingPluginQuestionOf(canonical)!;
	for (const type of ["text", "continue", "retry", "retry-question", "answer", "dismiss", "dismiss-problem", "steers"])
		assert.throws(() => assertPluginQuestionInputAllowed(canonical, { type }));
	assert.deepEqual(pluginQuestionCompatibilityAppends({ messages: canonical }, () => ({ status: "unavailable" })), []);
	const cancelled = pluginQuestionCompatibilityAppends({ messages: canonical }, () => ({ status: "incompatible" }));
	assert.equal((cancelled[0] as any).details.kind, "plugin-question-cancelled");
	assert.equal((cancelled[0] as any).details.reason, "incompatible");
	assert.equal(pendingPluginQuestionOf([...canonical, ...cancelled]), undefined);
	const dismissed = preparePluginQuestionDismissal({ messages: canonical }, { type: "dismiss-plugin-question", questionId: snapshot.questionId, occurrence: snapshot.occurrence });
	assert.equal((dismissed[0] as any).details.reason, "dismissed");
	assert.equal((dismissed[0] as any).details.answer, undefined);
});

test("unreadable explicit dismissal binds actual occurrence, quiet cancellation requires embedded binding, and forged metadata cannot resolve", async () => {
	const { canonical } = await nativePose();
	const snapshot = pendingPluginQuestionOf(canonical)!;
	const source = canonical.find(message => message.role === "assistant")!;
	const withAnnotation = (annotation: unknown): LhMessage[] => canonical.map(message => message === source ? { ...message, lhQuestions: annotation } as LhMessage : message);
	const malformed = withAnnotation(null);
	assert.deepEqual(pluginQuestionCompatibilityAppends({ messages: malformed }, () => ({ status: "unavailable" })), [], "malformed maps never authorize a guessed quiet target");
	const explicit = preparePluginQuestionDismissal({ messages: malformed }, { type: "dismiss-plugin-question", occurrence: snapshot.occurrence });
	assert.equal((explicit[0] as any).details.questionId, undefined);
	assert.equal((explicit[0] as any).details.reason, "dismissed");
	assert.doesNotThrow(() => assertPluginQuestionInputAllowed([...malformed, ...explicit], { type: "text" }));
	const unknown = withAnnotation({ "0": { ...snapshot, protocolVersion: 99, questionId: undefined } });
	const quiet = pluginQuestionCompatibilityAppends({ messages: unknown }, () => ({ status: "unavailable" }));
	assert.equal((quiet[0] as any).details.reason, "unreadable-protocol");
	assert.equal((quiet[0] as any).details.questionId, undefined);
	const forged = { ...explicit[0], details: {}, lhQuestionOccurrence: snapshot.occurrence } as LhMessage;
	assert.throws(() => assertPluginQuestionInputAllowed([...malformed, forged], { type: "text" }));
	assert.equal(preparePluginQuestionDismissal({ messages: [...malformed, forged] }, { type: "dismiss-plugin-question", occurrence: snapshot.occurrence }).length, 1);
});

test("saved required refinement absence remains unavailable; GET readiness uses the saved rule only", async () => {
	const { canonical } = await nativePose();
	const old = pendingPluginQuestionOf(canonical)!;
	const changed = canonical.map(message => message.role === "assistant" ? { ...message, lhQuestions: { "0": { ...old, requiresAnswerRefinement: true } } } as LhMessage : message);
	const available = () => ({ status: "available" as const, definition, signal: contribution.signal, requireActive() {} });
	assert.equal(pluginQuestionAvailabilityOf({ messages: canonical }, available)?.status, "available");
	assert.equal(pluginQuestionAvailabilityOf({ messages: changed }, available)?.status, "unavailable");
	assert.equal(pluginQuestionAvailabilityOf({ messages: canonical })?.status, "unavailable");
	assert.throws(() => preparePluginQuestionAnswer({ id: "fixture", messages: changed }, { type: "plugin-question-answer", questionId: old.questionId, occurrence: old.occurrence, answer: "" }, available), /unavailable/);
});

test("chat-handler saves the genuine native answer before teacher construction, rejects duplicate input, and manual dismissal starts no turn", async () => {
	const { canonical } = await nativePose();
	const snapshot = pendingPluginQuestionOf(canonical)!;
	const { stores } = await import("../src/server/stores.ts");
	const { handleChatInput } = await import("../src/server/chat-handler.ts");
	const { runningTurn } = await import("../src/server/turn-runs.ts");
	const { isTurnRunning, beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
	const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
	const dismiss = await import("../app/api/chats/[id]/dismiss/route.ts");
	const recordRoute = await import("../app/api/chats/[id]/route.ts");
	process.env.OPENROUTER_API_KEY = "isolated-test-fixture-only";
	const global = globalThis as typeof globalThis & { __lhPlugins?: unknown };
	const previous = global.__lhPlugins;
	let resolutionStatus: "available" | "unavailable" | "incompatible" = "available";
	global.__lhPlugins = { host: { resolveQuestionType: () => resolutionStatus === "available" ? { status: "available", definition, signal: contribution.signal, requireActive() {} } : { status: resolutionStatus } }, ready: Promise.resolve() };
	try {
		const chat = stores.chatStore.createChat("Isolated native question lifecycle");
		stores.chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		stores.chatStore.saveMessages(chat.id, canonical);
		const availableDto = await (await recordRoute.GET(new Request("http://fixture/chat"), { params: Promise.resolve({ id: chat.id }) })).json();
		assert.deepEqual(availableDto.pluginQuestionAvailability, { questionId: snapshot.questionId, status: "available" });
		assert.equal((stores.chatStore.getChat(chat.id) as any).pluginQuestionAvailability, undefined, "readiness is response-only, never stored");
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage("Teacher review, without a grading hook.")]);
		let constructed = 0;
		const input = { type: "plugin-question-answer" as const, questionId: snapshot.questionId, occurrence: snapshot.occurrence, answer: false, thinking: "" };
		const response = await handleChatInput(chat.id, input, options => {
			constructed++;
			const durable = stores.chatStore.getChat(chat.id)!.messages.at(-1)! as any;
			assert.equal(durable.details.kind, "plugin-question");
			assert.equal(durable.details.answer, false);
			assert.deepEqual(durable.lhQuestionOccurrence, snapshot.occurrence);
			return createTeacherAgent(undefined, { ...options, engine: { model: faux.getModel(), streamFn: faux.streamSimple } });
		});
		assert.equal(response.status, 200, await response.text());
		const live = runningTurn(chat.id);
		if (live) await new Response(live.subscribe()).text();
		assert.equal((await handleChatInput(chat.id, input)).status, 400);
		assert.equal(constructed, 1);
		assert.equal(faux.state.callCount, 1);
		assert.equal(stores.chatStore.getChat(chat.id)!.messages.filter(message => message.role === "toolResult" && (message.details as any)?.kind === "plugin-question").length, 1);
		const dismissedChat = stores.chatStore.createChat("Isolated silent dismissal");
		stores.chatStore.saveMessages(dismissedChat.id, canonical);
		const result = await dismiss.POST(new Request("http://fixture/dismiss", { method: "POST", body: JSON.stringify({ input: { type: "dismiss-plugin-question", questionId: snapshot.questionId, occurrence: snapshot.occurrence } }) }), { params: Promise.resolve({ id: dismissedChat.id }) });
		assert.equal(result.status, 200);
		assert.equal(isTurnRunning(dismissedChat.id), false);
		assert.equal((stores.chatStore.getChat(dismissedChat.id)!.messages.at(-1) as any).details.kind, "plugin-question-cancelled");
		const compatChat = stores.chatStore.createChat("Isolated compatibility boundary");
		stores.chatStore.saveMessages(compatChat.id, canonical);
		resolutionStatus = "unavailable";
		const unavailableDto = await (await recordRoute.GET(new Request("http://fixture/chat"), { params: Promise.resolve({ id: compatChat.id }) })).json();
		assert.deepEqual(unavailableDto.pluginQuestionAvailability, { questionId: snapshot.questionId, status: "unavailable" });
		assert(pendingPluginQuestionOf(stores.chatStore.getChat(compatChat.id)!.messages));
		resolutionStatus = "incompatible";
		assert(beginTurn(compatChat.id));
		await recordRoute.GET(new Request("http://fixture/chat"), { params: Promise.resolve({ id: compatChat.id }) });
		assert(pendingPluginQuestionOf(stores.chatStore.getChat(compatChat.id)!.messages), "compatibility reads cannot race an active turn's host write");
		endTurn(compatChat.id);
		await recordRoute.GET(new Request("http://fixture/chat"), { params: Promise.resolve({ id: compatChat.id }) });
		assert.equal(pendingPluginQuestionOf(stores.chatStore.getChat(compatChat.id)!.messages), undefined);
		assert.equal((stores.chatStore.getChat(compatChat.id)!.messages.at(-1) as any).details.reason, "incompatible");
		assert.equal(isTurnRunning(compatChat.id), false, "compatibility cancellation never runs the teacher");
	} finally { global.__lhPlugins = previous; }
});
