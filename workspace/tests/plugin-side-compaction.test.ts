/** Actual route + production compaction gate, using only registered offline
 * Pi providers. Plugin processing must never run to estimate its own result. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Type } from "typebox";
import { createFauxCore, createProvider, fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { ChatInput } from "../src/core/input-events.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-plugin-side-compaction-"));
process.env.LH_DATA_DIR = path.join(root, "data");
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const fetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("Unexpected network in offline compaction route regression"); };
after(() => { globalThis.fetch = fetch; fs.rmSync(root, { recursive: true, force: true }); });
const { chatStore } = await import("../src/store/chats.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { piModels } = await import("../src/agent/models.ts");
const { createProberAgent, createPracticeAgent, composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { runPiTurn } = await import("../src/server/pi/ui-stream.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { compactionInFlight, projectedContextTokens } = await import("../src/server/compaction.ts");
const { preparePluginQuestionType } = await import("../src/core/plugin-questions.ts");
const { preparePluginProblemType } = await import("../src/core/plugin-problems.ts");
const { newUserMessage, pendingPluginQuestionOf, activeProblemOf, activeProblemOccurrenceOf } = await import("../src/core/native-messages.ts");
const { sideConversationEntries } = await import("../src/core/side-chat.ts");

for (const practice of [false, true]) test(`${practice ? "plugin practice submission" : "plugin question answer"}: raw side cargo triggers preflight compaction before once-only processing`, { timeout: 15000 }, async () => {
	const environmentVariables = process.env as Record<string, string | undefined>;
	const environment = environmentVariables.NODE_ENV;
	const global = globalThis as typeof globalThis & { __lhPlugins?: unknown };
	const previousHost = global.__lhPlugins;
	let processed = 0;
	const chat = chatStore.createChat("Offline plugin side compaction", practice ? "practice" : undefined);
	const processOnce = async () => {
		processed++;
		assert.equal(isTurnRunning(chat.id), true, "normal turn claim precedes processing");
		assert.equal(chatStore.getChat(chat.id)!.messages.filter(m => m.role === "custom" && m.customType === "compaction").length, 1, "preflight already compacted without executing this callback");
		return { observed: true };
	};
	const definition = preparePluginQuestionType({ id: "code", label: "Code", contractVersion: 1, showThinking: true,
		questionSchema: Type.Object({ privateReference: Type.String() }), answerSchema: Type.String(),
		probe: { toolName: "plugin_preflight_question", description: "Pose an offline question" }, gradeAnswer: processOnce });
	const problemDefinition = preparePluginProblemType({ id: "code", label: "Code", contractVersion: 1,
		problemSchema: Type.Object({}), submissionSchema: Type.String(), tool: { toolName: "plugin_preflight_problem", description: "Pose an offline problem" }, processSubmission: processOnce });
	const activation = new AbortController();
	const available = { status: "available" as const, signal: activation.signal, requireActive() {} };
	global.__lhPlugins = { host: {
		resolveQuestionType: () => ({ ...available, definition }), resolveProblemType: () => ({ ...available, definition: problemDefinition }),
	}, ready: Promise.resolve() };
	try {
		const prefix: LhMessage[] = [newUserMessage("SAVED_HISTORY_PUBLIC ".repeat(6000)), { ...fauxAssistantMessage("Saved earlier lesson."), id: "earlier_lesson" }, newUserMessage("CURRENT_RETAINED ".repeat(5000))];
		chatStore.saveMessages(chat.id, prefix);
		const pose = createFauxCore({});
		pose.setResponses([fauxAssistantMessage([fauxToolCall(practice ? problemDefinition.tool.toolName : definition.probe!.toolName,
			practice ? { statement: "Implement f", mode: "composition", modelSolution: "Committed solution", payload: {} } : { question: "Write a value", payload: { privateReference: "PRIVATE_REFERENCE" } }, { id: "pose_call" })], { stopReason: "toolUse" }), fauxAssistantMessage("Work on this problem.")]);
		const contribution = { pluginId: "offline", signal: activation.signal, requireActive() {} };
		const options = { chatId: chat.id, messages: prefix, engine: { model: pose.getModel(), streamFn: pose.streamSimple },
			pluginContributions: () => ({ instructions: [], tools: [], ...(practice ? { problemTypes: [{ ...contribution, definition: problemDefinition }] } : { questionTypes: [{ ...contribution, definition, variant: "probe" as const }] }) }) };
		const agent = practice ? createPracticeAgent({ chatId: chat.id, chatStore }, options) : createProberAgent({ chatId: chat.id } as never, options);
		let canonical: LhMessage[] = [];
		const turn = runPiTurn({ agent, onFinish(messages) { canonical = messages as LhMessage[]; } });
		await new Response(turn.subscribe()).text();
		// Remove FauxCore's synthetic usage anchors, not any authority/input.
		canonical = canonical.map((m, index) => ({ ...m, id: m.id ?? `saved_pose_${index}`, ...(m.role === "assistant" ? { usage: fauxAssistantMessage("").usage } : {}) }));
		chatStore.saveMessages(chat.id, canonical);
		canonical = chatStore.getChat(chat.id)!.messages;
		const question = pendingPluginQuestionOf(canonical), problem = activeProblemOf(canonical)?.pluginProblem;
		if (practice) assert.ok(problem); else assert.ok(question);
		const input: ChatInput = practice ? { type: "plugin-problem-submission", problemId: problem!.problemId, occurrence: activeProblemOccurrenceOf(canonical)!, submission: "code", thinking: "Host Thinking" }
			: { type: "plugin-question-answer", questionId: question!.questionId, occurrence: question!.occurrence, answer: "code", thinking: "Host Thinking" };
		const at = "2026-11-05T00:00:00Z";
		chatStore.updateSideChats(chat.id, () => [{ id: "side_pending", anchor: { messageId: "earlier_lesson", partId: "earlier_lesson-t0", blockIndex: 0, blockText: "Saved earlier lesson." }, open: true, createdAt: at,
			messages: [{ id: "side_raw", role: "assistant", text: "NEW_SIDE_CARGO ".repeat(8000), at }] }]);
		const saved = chatStore.getChat(chat.id)!;
		const promptTokens = Math.ceil(composeInstructions(practice ? "practice" : "teacher").length / 4);
		assert.ok(projectedContextTokens(canonical, promptTokens) < 80000, "saved history alone does not trigger compaction");
		assert.ok(projectedContextTokens([...canonical, ...sideConversationEntries(saved)], promptTokens) > 80000, "only new raw side cargo crosses the trigger");
		const modelFaux = createFauxCore({});
		const model = { ...modelFaux.getModel(), provider: "offline-side-compaction", id: "route" };
		const contexts: TranscriptContext[] = [];
		modelFaux.setResponses([context => {
			assert.equal(processed, 0, "compaction must not grade/process to estimate a result");
			assert.match(JSON.stringify(context.messages), /SAVED_HISTORY_PUBLIC/);
			assert.doesNotMatch(JSON.stringify(context.messages), /NEW_SIDE_CARGO|Host Thinking|observed/);
			return fauxAssistantMessage("Earlier lesson summary.");
		}, context => {
			assert.equal(processed, 1);
			assert.match(JSON.stringify(context.messages), /NEW_SIDE_CARGO/);
			return fauxAssistantMessage("Review after the accepted submission.");
		}]);
		piModels().setProvider(createProvider({ id: model.provider, models: [model], auth: { apiKey: { name: "offline", resolve: async () => ({ auth: {} }) } },
			api: { stream: (m, context, opts) => { contexts.push(structuredClone(context)); return modelFaux.streamSimple(m, context, opts); }, streamSimple: (m, context, opts) => { contexts.push(structuredClone(context)); return modelFaux.streamSimple(m, context, opts); } } }));
		writeSettings({ graph: { enabled: false }, compaction: { thresholdTokens: 80000 }, models: { strong: { model: { provider: model.provider, id: model.id } } } });
		chatStore.saveSettings(chat.id, { model: { provider: model.provider, id: model.id } });
		environmentVariables.NODE_ENV = "production"; // exercise the real gate, not its test-mode fast path
		const response = await handleChatInput(chat.id, input, opts => practice ? createPracticeAgent({ chatId: chat.id, chatStore }, opts) : createProberAgent({ chatId: chat.id } as never, opts));
		assert.equal(response.status, 200, await response.clone().text());
		const live = runningTurn(chat.id); if (live) await new Response(live.subscribe()).text();
		await response.text();
		assert.equal(processed, 1);
		assert.equal(contexts.length, 2, "one real compaction request and one continuation, both offline");
		// Assertions inside SDK/plugin callbacks can become saved error outcomes;
		// also assert their observations and successful settlement outside them.
		assert.match(JSON.stringify(contexts[0]!.messages), /SAVED_HISTORY_PUBLIC/);
		assert.doesNotMatch(JSON.stringify(contexts[0]!.messages), /NEW_SIDE_CARGO|Host Thinking|observed/);
		assert.match(JSON.stringify(contexts[1]!.messages), /NEW_SIDE_CARGO/);
		const final = chatStore.getChat(chat.id)!;
		const accepted = final.messages.find(m => practice ? m.role === "custom" && m.customType === "plugin-problem-submission" : m.role === "toolResult" && m.toolCallId === question!.occurrence.toolCallId);
		const outcome = (accepted as { details?: { processing?: unknown; grading?: unknown } } | undefined)?.details;
		assert.deepEqual(practice ? outcome?.processing : outcome?.grading, { result: { observed: true } });
		const last = final.messages.at(-1);
		assert.ok(last?.role === "assistant");
		assert.equal(last.stopReason, "stop");
		assert.deepEqual(final.messages.slice(0, canonical.length), canonical, "compaction never edits saved history");
		assert.equal(final.messages.filter(m => m.role === "custom" && m.customType === "side-question").length, 1);
		assert.equal(sideConversationEntries(final).length, 0, "raw cargo published exactly once after admission");
		if (!practice) {
			const resultIndex = final.messages.findIndex(m => m.role === "toolResult" && m.toolCallId === question!.occurrence.toolCallId);
			const sideIndex = final.messages.findIndex(m => m.role === "custom" && m.customType === "side-question");
			assert.ok(resultIndex >= 0 && resultIndex < sideIndex, "genuine tool result precedes delivered side updates");
		}
	} finally {
		await compactionInFlight(chat.id);
		if (environment === undefined) delete environmentVariables.NODE_ENV; else environmentVariables.NODE_ENV = environment;
		global.__lhPlugins = previousHost;
	}
});
