import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { createCanvas } from "@napi-rs/canvas";
import { Type } from "typebox";
import type { PluginQuestionSnapshot } from "../src/core/plugin-questions.ts";
import * as photon from "@silvia-odwyer/photon-node";
import { createFauxCore, createProvider, fauxAssistantMessage, fauxToolCall, type ImageContent, type StreamFunction } from "@earendil-works/pi-ai";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { LhMessage } from "../src/core/native-messages.ts";

// Completely isolated synthetic learner data and offline provider only.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-submission-native-"));
process.env.LH_DATA_DIR = path.join(root, "data");
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Unexpected network in native submission tests"); };
after(() => { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); });
const { prepareSubmissionImages, prepareSubmissionImageChannels } = await import("../src/server/submission-images.ts");
const { prepareAndSteerChat, registerLiveAgent, unregisterLiveAgent, discardChatDeliveries } = await import("../src/server/jobs.ts");
const { stores } = await import("../src/server/stores.ts");
const { piModels, piEngineForSpec, configureProviderSource } = await import("../src/agent/models.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { createTeacherAgent, createPracticeAgent, createProberAgent } = await import("../src/agent/teacher-agent.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { dismissedAnswer } = await import("../src/core/question-core.ts");
const { toLlmMessages } = await import("../src/core/native-messages.ts");
const { preparePluginQuestionAnswer } = await import("../src/server/plugin-questions.ts");
const { preparePluginQuestionType, clonePluginQuestionJson } = await import("../src/core/plugin-questions.ts");
const faux = createFauxCore({});
const provider = "native-submission-fixture";
const model = { ...faux.getModel(), provider, id: "vision", input: ["text", "image"] as ("text" | "image")[], inputLimits: { images: { resize: { maxWidth: 2, maxHeight: 2, maxBytes: 2048 } } } };
const textModel = { ...model, id: "text", input: ["text"] as ("text" | "image")[] };
let contexts: unknown[] = [];
const stream: StreamFunction = (m, context, options) => { contexts.push(structuredClone(context)); return faux.streamSimple(m, context, options); };
function registerModels() {
	piModels().setProvider(createProvider({ id: provider, models: [model, textModel], auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } }));
}
registerModels();
stores.settingsStore.writeSettings({ version: 1, graph: { enabled: false }, models: { strong: { model: { provider, id: model.id } } } });
function image(width = 8, height = 4): ImageContent {
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d"); ctx.fillStyle = "#11bb66"; ctx.fillRect(0, 0, width, height);
	return { type: "image", mimeType: "image/png", data: canvas.toBuffer("image/png").toString("base64") };
}
function dimensions(value: Readonly<ImageContent>) {
	const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(value.data, "base64"));
	try { return [decoded.get_width(), decoded.get_height()]; } finally { decoded.free(); }
}
// Observe the real image worker boundary, not timing or a replacement processor.
// The mutation happens after capture and before its async processing returns.
async function duringProcessing<T>(mutate: () => void, run: () => Promise<T>): Promise<T> {
	const original = Worker.prototype.postMessage;
	let observed = false;
	Worker.prototype.postMessage = function (this: Worker, ...args: Parameters<typeof original>) {
		Worker.prototype.postMessage = original;
		observed = true;
		const result = original.apply(this, args);
		mutate();
		return result;
	};
	try { const result = await run(); assert(observed, "must exercise real asynchronous image processing"); return result; }
	finally { Worker.prototype.postMessage = original; }
}
function builtinPose(id = "pose", two = false): LhMessage {
	return { ...fauxAssistantMessage([
		fauxToolCall("ask_user_question", { question: "Explain", mode: "text" }, { id: "call" }),
		...(two ? [fauxToolCall("ask_user_question", { question: "Sibling", mode: "text" }, { id: "sibling" })] : []),
	], { stopReason: "toolUse" }), id } as LhMessage;
}
const occurrence = { messageId: "pose", contentIndex: 0, toolCallId: "call", toolName: "ask_user_question" };
function answerInput() {
	return { type: "answer" as const, toolCallId: "call", occurrence, answer: { ...dismissedAnswer("ask", "Explain"), dismissed: false, dontKnow: false, text: "", images: { answer: [image()], thinking: [image()], readingThinking: [image()] } } };
}
async function drain(chatId: string, response: Response) {
	await response.text();
	const live = runningTurn(chatId); if (live) await new Response(live.subscribe()).text();
}

test("strict admission verifies declared bytes and decodes images, rather than accepting paths or processor omissions", async () => {
	for (const invalid of [
		"drawing.png", { ...image(), data: "data:image/png;base64,AAAA" }, { ...image(), data: "%%%" },
		{ ...image(), mimeType: "image/jpeg" }, { ...image(), mimeType: "image/svg+xml" },
		{ type: "image", mimeType: "image/png", data: Buffer.from("not an image").toString("base64") },
		{ type: "image", mimeType: "image/gif", data: Buffer.from("GIF89a").toString("base64") },
	]) await assert.rejects(prepareSubmissionImages([invalid as ImageContent], { model }));
	const canvas = createCanvas(1, 1);
	for (const [mimeType, bytes] of [["image/jpeg", canvas.toBuffer("image/jpeg")], ["image/webp", canvas.toBuffer("image/webp")], ["image/gif", Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")]] as const) {
		const prepared = await prepareSubmissionImages([{ type: "image", mimeType, data: bytes.toString("base64") }], { model });
		assert.deepEqual(dimensions(prepared![0]!), [1, 1]);
	}
	const prepared = await prepareSubmissionImages([image()], { model });
	assert.deepEqual(dimensions(prepared![0]!), [2, 1]);
	assert.equal(prepared!.length, 1);
	assert.deepEqual(await prepareSubmissionImageChannels({ answer: [], thinking: [image()] }, { model }), { thinking: prepared });
	assert.equal(await prepareSubmissionImageChannels({ answer: [] }, { model }), undefined);
	await assert.rejects(prepareSubmissionImages([image()], { model: textModel }), /does not support images/);
	assert.equal(await prepareSubmissionImages(undefined, { model: textModel }), undefined, "historical images are not re-admitted");
});

test("image preparation reuses the processor defaults when the actual engine has no resize override", async () => {
	const noOverride = { ...model, inputLimits: undefined };
	const [prepared] = (await prepareSubmissionImages([image(2101, 2)], { model: noOverride }))!;
	assert.deepEqual(dimensions(prepared!), [2000, 2]);
	assert(prepared!.data.length < 4.5 * 1024 * 1024);
});

test("new turn admission uses the actual Strong conversation engine for prober, teacher and practice and persists normalized native bytes", async () => {
	for (const kind of ["prober", "teacher", "practice"] as const) {
		const chat = stores.chatStore.createChat(`Synthetic ${kind}`, kind === "practice" ? "practice" : undefined);
		const original = image(); contexts = [];
		faux.setResponses([fauxAssistantMessage("Offline response")]);
		const response = await handleChatInput(chat.id, { type: "text", text: "", images: [original] }, options => {
			assert.equal(options.engine?.model.id, "vision");
			assert.deepEqual(options.engine?.model.inputLimits?.images?.resize, model.inputLimits.images.resize);
			const checked = { ...options, engine: { ...options.engine!, streamFn: stream } };
			return kind === "practice" ? createPracticeAgent({ chatId: chat.id, chatStore: stores.chatStore, graphNodes: () => [] } as never, checked) : kind === "teacher" ? createTeacherAgent(undefined, checked) : createProberAgent({ chatId: chat.id } as never, checked);
		});
		assert.equal(response.status, 200); const wire = await response.clone().text(); await drain(chat.id, response);
		assert(!wire.includes('"type":"error"'), wire);
		const accepted = stores.chatStore.getChat(chat.id)!.messages[0]!;
		assert.equal(accepted.role, "user");
		const acceptedImage = (accepted.content as ImageContent[])[0]!;
		assert.notEqual(acceptedImage.data, original.data);
		assert.deepEqual(dimensions(acceptedImage), [2, 1]);
		assert(JSON.stringify(contexts).includes(acceptedImage.data), "normalized native bytes must actually reach the model");
		assert(!JSON.stringify(accepted.content).includes("[Image"), "processor hints never become learner text");
	}
});

test("text-only effective model refuses fresh images without persistence or agent construction", async () => {
	const chat = stores.chatStore.createChat("Synthetic unsupported model");
	stores.chatStore.saveSettings(chat.id, { model: { provider, id: "text" } });
	const response = await handleChatInput(chat.id, { type: "text", text: "", images: [image()] }, () => { throw new Error("must not construct"); });
	assert.equal(response.status, 400); assert.match(await response.text(), /does not support images/);
	assert.equal(stores.chatStore.getChat(chat.id)!.messages.length, 0);
	assert.equal(isTurnRunning(chat.id), false);
});

test("save-only parallel answers normalize all channels before persistence without starting a model", async () => {
	const chat = stores.chatStore.createChat("Synthetic sibling questions");
	stores.chatStore.saveMessages(chat.id, [builtinPose("pose", true)]);
	const response = await handleChatInput(chat.id, answerInput(), () => { throw new Error("save-only must not construct"); });
	assert.equal(response.status, 200, await response.clone().text()); await response.text();
	assert.equal(isTurnRunning(chat.id), false);
	const saved = stores.chatStore.getChat(chat.id)!.messages.at(-1)! as any;
	assert.equal(saved.role, "toolResult");
	for (const channel of ["answer", "thinking", "readingThinking"]) assert.deepEqual(dimensions(saved.details.images[channel][0]), [2, 1]);
	assert.equal(saved.content.filter((block: any) => block.type === "image").length, 3);
	const projected = toLlmMessages([saved])[0]!;
	assert(Array.isArray(projected.content));
	assert.equal(projected.content.filter(block => block.type === "image").length, 3);
});

for (const change of ["model", "resize", "catalog-removal", "occurrence"] as const) test(`async ${change} change refuses before save-only acceptance with a non-busy stale response`, async () => {
	const chat = stores.chatStore.createChat(`Synthetic stale ${change}`);
	stores.chatStore.saveMessages(chat.id, [builtinPose("pose", true)]);
	const response = await duringProcessing(() => {
		if (change === "model") stores.chatStore.saveSettings(chat.id, { model: { provider, id: "text" } });
		if (change === "resize") { model.inputLimits.images.resize.maxWidth = 1; registerModels(); }
		if (change === "catalog-removal") piModels().deleteProvider(provider);
		if (change === "occurrence") stores.chatStore.saveMessages(chat.id, [builtinPose("replacement", true)]);
	}, () => handleChatInput(chat.id, answerInput(), () => { throw new Error("stale input must not construct"); }));
	assert.equal(response.status, 412); assert.equal((await response.json()).code, "submission-stale");
	assert.equal(isTurnRunning(chat.id), false);
	assert.equal(stores.chatStore.getChat(chat.id)!.messages.length, 1);
	model.inputLimits.images.resize.maxWidth = 2; registerModels();
});

test("async model changes refuse new-turn admission before its claim or write", async () => {
	const chat = stores.chatStore.createChat("Synthetic stale new turn");
	const response = await duringProcessing(() => stores.chatStore.saveSettings(chat.id, { model: { provider, id: "text" } }), () => handleChatInput(chat.id, { type: "text", text: "", images: [image()] }, () => { throw new Error("must not construct stale run"); }));
	assert.equal(response.status, 412);
	assert.equal(stores.chatStore.getChat(chat.id)!.messages.length, 0);
	assert.equal(isTurnRunning(chat.id), false);
});

test("practice thinking checks the original active problem after image processing, not only its reused call ID", async () => {
	const chat = stores.chatStore.createChat("Synthetic stale problem", "practice");
	const pose = { ...fauxAssistantMessage([fauxToolCall("problem", { statement: "Synthetic problem" }, { id: "call" })], { stopReason: "toolUse" }), id: "pose" } as LhMessage;
	const ack = { id: "ack", role: "toolResult", toolCallId: "call", toolName: "problem", content: [{ type: "text", text: "Problem posed" }], isError: false, timestamp: 1 } as LhMessage;
	stores.chatStore.saveMessages(chat.id, [pose, ack]);
	const response = await duringProcessing(() => stores.chatStore.saveMessages(chat.id, [{ ...pose, id: "replacement" }, ack]), () => handleChatInput(chat.id, { type: "thinking", problemCallId: "call", text: "", images: [image()], occurrence: { ...occurrence, toolName: "problem" } }, () => { throw new Error("must not construct"); }));
	assert.equal(response.status, 412); assert.equal(stores.chatStore.getChat(chat.id)!.messages.length, 2);
});

for (const change of ["settings", "replacement", "model", "resize", "settled"] as const) test(`busy steer uses captured private live agent and handles ${change} during processing`, async () => {
	const chat = stores.chatStore.createChat(`Synthetic busy ${change}`);
	stores.chatStore.saveSettings(chat.id, { model: { provider, id: "text" } });
	const received: LhMessage[] = [];
	const agent = { state: { model }, steer: (message: LhMessage) => received.push(message) } as unknown as Agent;
	registerLiveAgent(chat.id, agent);
	try {
		const result = await duringProcessing(() => {
			if (change === "settings") stores.chatStore.saveSettings(chat.id, { model: { provider, id: "vision" } });
			if (change === "replacement") registerLiveAgent(chat.id, { state: { model }, steer() { throw new Error("must not retarget"); } } as unknown as Agent);
			if (change === "model") agent.state.model = textModel;
			if (change === "resize") model.inputLimits.images.resize.maxWidth = 1;
			if (change === "settled") unregisterLiveAgent(chat.id);
		}, () => prepareAndSteerChat(chat.id, { type: "steer", id: "steer-fixture", text: "", images: [image()] }));
		assert.equal(result, change === "settings" ? "accepted" : change === "settled" ? "settled" : "stale");
		assert.equal(received.length, change === "settings" ? 1 : 0);
		if (received.length) assert.deepEqual(dimensions((received[0]!.content as ImageContent[])[0]!), [2, 1]);
		assert.equal(stores.chatStore.getChat(chat.id)!.messages.length, 0, "accepted busy steering retains existing memory-only queue tradeoff");
	} finally { unregisterLiveAgent(chat.id); discardChatDeliveries(chat.id); model.inputLimits.images.resize.maxWidth = 2; }
});

test("plugin answer images stay outside arbitrary answer JSON and retain native validation/refinement/applicability", async () => {
	let refinements = 0;
	const definition = preparePluginQuestionType({ id: "code", label: "Code", contractVersion: 1, showThinking: true,
		questionSchema: Type.Object({}), answerSchema: Type.Boolean(),
		validateAnswer() { refinements++; return []; },
		teach: { toolName: "plugin_code", description: "Synthetic question" },
	});
	const snapshot: PluginQuestionSnapshot = {
		protocolVersion: 1, pluginId: "fixture", typeId: "code", label: "Code", variant: "teach", questionId: "question-1", contractVersion: 1,
		occurrence: { ...occurrence, toolName: "plugin_code" },
		input: { question: "Synthetic?", payload: {}, type: "check", nodeId: "node" }, questionSchema: { type: "object" }, answerSchema: { type: "boolean" },
		showThinking: true, requiresAnswerRefinement: true,
	};
	const record = (question: PluginQuestionSnapshot) => {
		const input = clonePluginQuestionJson(question.input);
		assert(input !== null && typeof input === "object" && !Array.isArray(input));
		return { id: "fixture", messages: [{ ...fauxAssistantMessage([fauxToolCall("plugin_code", input, { id: "call" })], { stopReason: "toolUse" }), id: "pose", lhQuestions: { "0": question } } as LhMessage] };
	};
	const resolve = () => ({ status: "available" as const, definition, signal: new AbortController().signal, requireActive() {} });
	const images = await prepareSubmissionImageChannels({ answer: [image()], thinking: [image()], readingThinking: [image()] }, { model });
	const input = { type: "plugin-question-answer" as const, questionId: snapshot.questionId, occurrence: snapshot.occurrence, answer: false, images };
	const [saved] = preparePluginQuestionAnswer(record(snapshot), input, resolve);
	assert.equal((saved as any).details.answer, false, "no mandatory schema keys added to JSON");
	assert.equal(refinements, 1);
	assert.equal((saved as any).content.filter((block: any) => block.type === "image").length, 3);
	assert(!(saved as any).content[0].text.includes(images!.answer![0]!.data), "native bytes must not be duplicated in compact answer text");
	assert.throws(() => preparePluginQuestionAnswer(record(snapshot), { ...input, answer: "wrong type" }, resolve));
	const limited: PluginQuestionSnapshot = { ...snapshot, variant: "probe", showThinking: false, input: { question: "Synthetic?", payload: {} } };
	assert.throws(() => preparePluginQuestionAnswer(record(limited), { ...input, images: { thinking: [image()] } }, resolve), /not applicable/);
	assert.throws(() => preparePluginQuestionAnswer(record(limited), { ...input, images: { readingThinking: [image()] } }, resolve), /not applicable/);
	const [empty] = preparePluginQuestionAnswer(record(limited), { ...input, images: { answer: [], thinking: [], readingThinking: [] } }, resolve);
	assert.equal((empty as any).details.images, undefined);
	assert.equal(Object.hasOwn((empty as any).details, "thinking"), false);
	assert.equal(Object.hasOwn((empty as any).details, "readingThinking"), false);
});

test("steer HTTP route distinguishes stale replacements from the ordinary settled fallback", async () => {
	const { POST } = await import("../app/api/chats/[id]/steer/route.ts");
	for (const settled of [false, true]) {
		const chat = stores.chatStore.createChat("Synthetic steer route race");
		registerLiveAgent(chat.id, { state: { model }, steer() { throw new Error("must not hand off"); } } as unknown as Agent);
		try {
			const response = await duringProcessing(() => {
				if (settled) unregisterLiveAgent(chat.id);
				else registerLiveAgent(chat.id, { state: { model }, steer() { throw new Error("must not retarget"); } } as unknown as Agent);
			}, () => POST(new Request("http://fixture/steer", { method: "POST", body: JSON.stringify({ input: { type: "steer", id: "steer-route", text: "", images: [image()] } }) }), { params: Promise.resolve({ id: chat.id }) }));
			assert.equal(response.status, settled ? 409 : 412);
			if (!settled) assert.equal((await response.json()).code, "submission-stale");
		} finally { unregisterLiveAgent(chat.id); discardChatDeliveries(chat.id); }
	}
});

test("custom endpoint admission uses the existing effective-engine forced image policy, not sparse catalog input flags", async () => {
	const entry = createProvider({ id: provider, models: [textModel], auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } });
	configureProviderSource({ isCustom: id => id === provider, sync: models => models.setProvider(entry) });
	const engine = piEngineForSpec({ provider, id: "text" });
	assert(engine.model.input.includes("image"));
	assert.deepEqual(dimensions((await prepareSubmissionImages([image()], engine))![0]!), [2, 1]);
});
