// Session/record kinds — stage B (owner principles P1–P5 confirmed
// 2026-11-17; raw-transcript refinement of P3 the same day).
//
// The test-only fixture plugin (tests/fixtures/session-kinds-plugin) is the
// verification vehicle: it registers a session kind extracting into its own
// record kind, a session kind extracting into the native graph, and a
// session-kind-scoped instruction. Everything runs offline against an
// isolated data directory and the SDK's in-process faux model.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { PluginBackendContext, PluginRecordBatch } from "../src/core/plugins.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-session-kinds-"));
const data = path.join(root, "data");
process.env.LH_DATA_DIR = data;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
process.env.OPENROUTER_API_KEY = "isolated-presence-only";
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("Unexpected external network"); };
const PLUGIN = "kinds-fixture", LESSON = "kinds-fixture:lesson", GRAPH_LESSON = "kinds-fixture:graph-lesson", NOTEBOOK = "kinds-fixture:notebook";
// The fixture is stored without its dist/ level (dist/ is gitignored repo-wide).
fs.cpSync(path.resolve("tests/fixtures/session-kinds-plugin"), path.join(data, "plugins", PLUGIN, "dist"), { recursive: true });

const { getPluginHost, pluginDataRoots } = await import("../src/server/plugins.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { stores } = await import("../src/server/stores.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { createProberAgent, createTeacherAgent, composeInstructions, composeSessionKindInstructions } = await import("../src/agent/teacher-agent.ts");
const { resolveChatRecord, pluginRecordCoverageFiles } = await import("../src/server/record-kinds.ts");
const { runRecordExtraction } = await import("../src/server/record-extraction.ts");
const { resolveChatSessionKind } = await import("../src/server/session-kinds.ts");
const { sessionCoverage, deleteChatSession } = await import("../src/server/chats.ts");
const { sideChats } = await import("../src/server/side-chat.ts");
const { rawCoverageSlots, coverageSlots } = await import("../src/core/coverage.ts");
const { preparePluginRecordKind, preparePluginSessionKind } = await import("../src/core/plugin-session-kinds.ts");
const { newUserMessage } = await import("../src/core/native-messages.ts");
const { POST: createChatRoute } = await import("../app/api/chats/route.ts");
const { GET: getChatRoute } = await import("../app/api/chats/[id]/route.ts");

const host = await getPluginHost();
await host.setEnabled(PLUGIN, true);
const ctx = await host.call(PLUGIN, "context") as PluginBackendContext;
type Control = { fail: boolean; gate: ((batch: PluginRecordBatch) => Promise<void>) | null };
const notebook = async () => await host.call(PLUGIN, "notebook") as Array<{ batchId: string; chatId: string; sessionKindId: string; recordKindId: string; messages: { id: string; role: string }[] }>;
after(async () => { await host.dispose(); globalThis.fetch = realFetch; fs.rmSync(root, { recursive: true, force: true }); });

const assistant = (id: string, text: string) => ({ ...fauxAssistantMessage(text), id }) as unknown as LhMessage;
const user = (id: string, text: string) => ({ ...newUserMessage(text), id }) as LhMessage;
/** A plugin-kind chat with enough raw transcript to cross a 500-token budget. */
function lessonChat(title: string, kind = LESSON, size = 900) {
	const chat = chatStore.createChat(title, kind as `${string}:${string}`);
	chatStore.saveMessages(chat.id, [user(`${chat.id}-u1`, "teach me ".repeat(size / 9)), assistant(`${chat.id}-a1`, "lesson text ".repeat(size / 12)), user(`${chat.id}-u2`, "more please ".repeat(size / 12)), assistant(`${chat.id}-a2`, "x ".repeat(size / 2))]);
	return chatStore.getChat(chat.id)!;
}
async function withPluginDisabled<T>(run: () => Promise<T>): Promise<T> {
	await host.setEnabled(PLUGIN, false);
	try { return await run(); } finally { await host.setEnabled(PLUGIN, true); }
}
const freshContext = async () => await host.call(PLUGIN, "context") as PluginBackendContext;
const freshControl = async () => await host.call(PLUGIN, "control") as Control;

describe("P1 — registration at activation", () => {
	it("validates definitions, namespaces ids, rejects duplicates, and lists live summaries", async () => {
		assert.throws(() => preparePluginSessionKind(PLUGIN, { id: "Bad Id", label: "x", record: "graph", prompts: { prober: "a", teacher: "b" } }), /id/);
		assert.throws(() => preparePluginSessionKind(PLUGIN, { id: "ok", label: "x", record: "vocab", prompts: { prober: "a", teacher: "b" } }), /record/);
		assert.throws(() => preparePluginSessionKind(PLUGIN, { id: "ok", label: "x", record: "graph", prompts: { prober: "a", teacher: " " } }), /prompts/);
		assert.throws(() => preparePluginSessionKind(PLUGIN, { id: "ok", label: "x", record: "graph", prompts: { prober: "a", teacher: "b" }, tools: { teacher: { quiz: "no" as never } } }), /tools/);
		assert.throws(() => preparePluginRecordKind(PLUGIN, { id: "ok", label: "x", chunkTokens: 499, extract() {} }), /500/);
		assert.throws(() => preparePluginRecordKind(PLUGIN, { id: "ok", label: "x" } as never), /extract/);
		assert.equal(preparePluginRecordKind(PLUGIN, { id: "ok", label: "x", extract() {} }).chunkTokens, 4096, "default chunk budget");
		assert.equal(preparePluginSessionKind(PLUGIN, { id: "ok", label: "x", record: "other-plugin:vocab", prompts: { prober: "a", teacher: "b" } }).id, `${PLUGIN}:ok`);
		const live = await freshContext();
		assert.throws(() => live.registerSessionKind({ id: "lesson", label: "dup", record: "graph", prompts: { prober: "a", teacher: "b" } }), /Duplicate/);
		assert.throws(() => live.registerRecordKind({ id: "notebook", label: "dup", extract() {} }), /Duplicate/);
		assert.throws(() => live.registerInstructions({ agents: ["teacher"], sessionKinds: ["Lesson"] as never, text: "x" }), /sessionKinds/);
		const info = host.list().find((plugin) => plugin.id === PLUGIN)!;
		assert.deepEqual(info.sessionKinds, [{ id: LESSON, label: "Fixture lesson" }, { id: GRAPH_LESSON, label: "Fixture graph lesson" }]);
		assert.deepEqual(info.recordKinds, [{ id: NOTEBOOK, label: "Fixture notebook" }]);
		const off = live.registerSessionKind({ id: "temporary", label: "Temp", record: "graph", prompts: { prober: "a", teacher: "b" } });
		assert.equal(host.resolveSessionKind(`${PLUGIN}:temporary`).status, "available");
		off(); off();
		assert.equal(host.resolveSessionKind(`${PLUGIN}:temporary`).status, "unavailable", "unregister is idempotent and immediate");
	});

	it("a disabled plugin's kinds resolve unavailable and vanish from the listing", async () => {
		await withPluginDisabled(async () => {
			assert.equal(host.resolveSessionKind(LESSON).status, "unavailable");
			assert.equal(host.resolveRecordKind(NOTEBOOK).status, "unavailable");
			assert.equal(host.list().find((plugin) => plugin.id === PLUGIN)!.sessionKinds, undefined);
		});
		assert.equal(host.resolveSessionKind(LESSON).status, "available");
	});

	it("POST /api/chats accepts an active plugin kind and refuses unknown or inactive ones", async () => {
		const post = (kind: unknown) => createChatRoute(new Request("http://fixture/api/chats", { method: "POST", body: JSON.stringify({ title: "Kinds", kind }) }));
		const created = await post(LESSON);
		assert.equal(created.status, 200);
		const { id } = await created.json() as { id: string };
		assert.equal(chatStore.getChat(id)!.kind, LESSON, "the exact namespaced id persists");
		assert.equal((await post("kinds-fixture:missing")).status, 400);
		assert.equal((await post("lesson")).status, 400, "bare names are reserved for native kinds");
		await withPluginDisabled(async () => assert.equal((await post(LESSON)).status, 400));
		const teach = await post("teach");
		assert.equal(chatStore.getChat((await teach.json() as { id: string }).id)!.kind, undefined, "teach stays absent");
	});
});

describe("P2 — the session kind replaces only its phase text and narrows native tools", () => {
	const engine = () => { const faux = createFauxCore({}); return { model: faux.getModel(), streamFn: faux.streamSimple }; };
	const kind = () => {
		const resolved = host.resolveSessionKind(LESSON);
		assert.equal(resolved.status, "available");
		if (resolved.status !== "available") throw Error("unavailable");
		return { id: resolved.definition.id, prompts: resolved.definition.prompts, tools: resolved.definition.tools };
	};

	it("composes shared base → kind phase text → shared appendix, with no native phase fragments", () => {
		const teacherPrompt = composeSessionKindInstructions("teacher", "KIND TEXT");
		const native = composeInstructions("teacher").split("\n\n---\n\n");
		const composed = teacherPrompt.split("\n\n---\n\n");
		assert.equal(composed[0], native[0], "the shared base leads");
		assert.equal(composed[1], "KIND TEXT");
		assert.deepEqual(composed.slice(2), native.slice(native.length - (composed.length - 2)), "the shared appendix closes");
		assert.ok(composed.length < native.length, "the native teacher fragments are replaced");
	});

	it("builds prober and teacher agents with the kind's prompts, delta and kind-scoped contributions", () => {
		const contributions = host.agentContributions.bind(host);
		const opts = { engine: engine(), chatId: "chat-kind", pluginContributions: contributions, sessionKind: kind(), toolToggles: {} };
		const prober = createProberAgent({ chatId: "chat-kind", chatStore } as never, opts);
		assert.ok(prober.state.systemPrompt.includes("FIXTURE PROBER PHASE"));
		assert.ok(prober.state.systemPrompt.includes("FIXTURE LESSON-ONLY APPENDIX"));
		const proberTools = prober.state.tools.map((tool) => tool.name);
		assert.ok(!proberTools.includes("research"), "the delta removes research");
		assert.ok(proberTools.includes("probe_done"), "probe_done is forced even when the delta says false");
		const teacher = createTeacherAgent({ chatId: "chat-kind", chatStore, jobStore: stores.jobStore, spawn: () => {}, searchAvailable: () => true } as never, opts);
		assert.ok(teacher.state.systemPrompt.includes("FIXTURE TEACHER PHASE"));
		const teacherTools = teacher.state.tools.map((tool) => tool.name);
		assert.ok(!teacherTools.includes("demo"), "the delta removes demo");
		assert.ok(teacherTools.includes("plan_init"), "plan_init is forced");
		// The same plugin's kind-scoped instruction stays out of native teaching.
		const nativeTeacher = createTeacherAgent({ chatId: "chat-native", chatStore, jobStore: stores.jobStore, spawn: () => {}, searchAvailable: () => true } as never, { ...opts, sessionKind: undefined });
		assert.ok(!nativeTeacher.state.systemPrompt.includes("FIXTURE LESSON-ONLY APPENDIX"));
		assert.ok(!nativeTeacher.state.systemPrompt.includes("FIXTURE TEACHER PHASE"));
		assert.ok(nativeTeacher.state.tools.some((tool) => tool.name === "demo"));
	});

	it("the turn pipeline hands the agent factory the resolved kind", { timeout: 10000 }, async () => {
		const chat = chatStore.createChat("Kind turn", LESSON);
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage("Hello from the kind.")]);
		let seen: unknown;
		const response = await handleChatRequest(new Request("http://fixture/api/chat", { method: "POST", body: JSON.stringify({ chatId: chat.id, input: { type: "text", text: "Hi" } }) }), (options) => {
			seen = options.sessionKind;
			return createProberAgent({ chatId: chat.id, chatStore } as never, { ...options, engine: { model: faux.getModel(), streamFn: faux.streamSimple } });
		});
		assert.equal(response.status, 200, await response.clone().text());
		const turn = runningTurn(chat.id);
		if (turn) await new Response(turn.subscribe()).text();
		assert.deepEqual(seen, kind());
	});
});

describe("P3 — host-chunked raw batches; coverage = what the extractor saw", () => {
	it("raw slots cover every saved message and re-open on content change", () => {
		const chat = lessonChat("Raw slots");
		const raw = rawCoverageSlots(chat.messages);
		assert.equal(raw.length, chat.messages.length, "every message, user turns included");
		const proseTokens = coverageSlots(chat.messages).reduce((n, slot) => n + slot.tokens, 0);
		assert.ok(proseTokens < raw.reduce((n, slot) => n + slot.tokens, 0), "the graph's teacher-prose view is narrower");
		assert.ok(raw.every((slot) => slot.tokens > 0), "every raw message is visible");
		const edited = chat.messages.map((message, i) => i === 0 ? user(message.id, "changed") : message);
		assert.notEqual(rawCoverageSlots(edited)[0]!.fp, raw[0]!.fp);
		assert.equal(rawCoverageSlots(edited)[1]!.fp, raw[1]!.fp);
	});

	it("trigger waits for the budget; a run delivers deterministic raw batches and writes host coverage", async () => {
		const small = lessonChat("Below budget", LESSON, 90);
		let target = await resolveChatRecord(small.kind);
		assert.equal(target.status, "plugin");
		if (target.status !== "plugin") return;
		assert.deepEqual(await runRecordExtraction({ chatStore }, small.id, target, "trigger"), { status: "below-threshold" });
		const chat = lessonChat("Extract me");
		target = (await resolveChatRecord(chat.kind)) as typeof target;
		const outcome = await runRecordExtraction({ chatStore }, chat.id, target, "trigger");
		assert.equal(outcome.status, "done");
		const rows = (await notebook()).filter((row) => row.chatId === chat.id);
		assert.ok(rows.length >= 1);
		assert.deepEqual(rows.flatMap((row) => row.messages.map((message) => message.id)), chat.messages.map((message) => message.id), "raw, ordered, unfiltered");
		assert.ok(rows.every((row) => row.sessionKindId === LESSON && row.recordKindId === NOTEBOOK));
		const ledger = path.join(ctx.dataDirectory, "records", "notebook", "coverage.jsonl");
		assert.equal(fs.readFileSync(ledger, "utf8").trim().split("\n").filter((line) => line.includes(chat.id)).length, chat.messages.length);
		assert.deepEqual(await runRecordExtraction({ chatStore }, chat.id, target, "manual"), { status: "nothing" });
		const cov = (await sessionCoverage(chat.id))!;
		assert.equal(cov.uncoveredCount, 0);
		assert.deepEqual(cov.record, { id: NOTEBOOK, label: "Fixture notebook", chunkTokens: 500, available: true });
	});

	it("a rejected extract leaves the batch uncovered and redelivers the same batchId", async () => {
		const chat = lessonChat("Fails once");
		const target = await resolveChatRecord(chat.kind);
		if (target.status !== "plugin") throw Error("expected plugin record");
		const live = await freshControl();
		const delivered: string[] = [];
		live.gate = async (batch) => { delivered.push(batch.batchId); };
		live.fail = true;
		try {
			const failed = await runRecordExtraction({ chatStore }, chat.id, target, "manual");
			assert.equal(failed.status, "failed");
			assert.equal((await sessionCoverage(chat.id))!.coveredCount, 0);
			live.fail = false;
			assert.equal((await runRecordExtraction({ chatStore }, chat.id, target, "manual")).status, "done");
			assert.equal(delivered[0], delivered[1], "redelivery repeats the batchId");
		} finally { live.fail = false; live.gate = null; }
	});

	it("disabling the plugin mid-extract aborts the batch and writes no coverage", async () => {
		const chat = lessonChat("Disabled mid-run");
		const target = await resolveChatRecord(chat.kind);
		if (target.status !== "plugin") throw Error("expected plugin record");
		const control = await freshControl();
		let signal!: AbortSignal;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		control.gate = (batch) => { signal = batch.signal; entered(); return new Promise<void>((resolve) => batch.signal.addEventListener("abort", () => resolve(), { once: true })); };
		const run = runRecordExtraction({ chatStore }, chat.id, target, "manual");
		await started;
		await host.setEnabled(PLUGIN, false);
		const outcome = await run;
		await host.setEnabled(PLUGIN, true);
		const live = await freshControl();
		live.gate = null;
		assert.equal(signal.aborted, true);
		assert.equal(outcome.status, "aborted");
		assert.equal((await sessionCoverage(chat.id))!.coveredCount, 0, "nothing marked covered");
	});

	it("batches of one record kind run one at a time across chats", async () => {
		const a = lessonChat("Serial A"), b = lessonChat("Serial B");
		const target = await resolveChatRecord(a.kind);
		if (target.status !== "plugin") throw Error("expected plugin record");
		const live = await freshControl();
		let active = 0, peak = 0;
		live.gate = async () => { active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 15)); active--; };
		try {
			const [ra, rb] = await Promise.all([runRecordExtraction({ chatStore }, a.id, target, "manual"), runRecordExtraction({ chatStore }, b.id, target, "manual")]);
			assert.equal(ra.status, "done"); assert.equal(rb.status, "done");
			assert.equal(peak, 1);
		} finally { live.gate = null; }
	});

	it("a kind naming the graph keeps the native teacher-prose ledger", async () => {
		const chat = lessonChat("Graph lesson", GRAPH_LESSON);
		const target = await resolveChatRecord(chat.kind);
		assert.equal(target.status, "graph");
		assert.equal(target.status === "graph" && target.coverage, stores.coverage);
		const cov = (await sessionCoverage(chat.id))!;
		assert.equal(cov.totalMessages, coverageSlots(chat.messages).length);
	});
});

describe("P5 — unavailable kinds open read-only and refuse model work honestly", () => {
	it("turns and side questions refuse with 409 before any effect; GET reports availability", async () => {
		const chat = lessonChat("Read-only");
		const before = JSON.stringify(chatStore.getChat(chat.id));
		await withPluginDisabled(async () => {
			assert.equal((await resolveChatSessionKind(chat.kind)).status, "unavailable");
			let built = 0;
			const response = await handleChatRequest(new Request("http://fixture/api/chat", { method: "POST", body: JSON.stringify({ chatId: chat.id, input: { type: "text", text: "Hi" } }) }), () => { built++; throw Error("no agent may be built"); });
			assert.equal(response.status, 409);
			const body = await response.json() as { code: string; pluginId: string; pluginName: string };
			assert.equal(body.code, "session-kind-unavailable");
			assert.equal(body.pluginId, PLUGIN);
			assert.equal(body.pluginName, "Session kinds fixture");
			assert.equal(built, 0);
			assert.equal(JSON.stringify(chatStore.getChat(chat.id)), before, "no record effect");
			const side = await sideChats.ask(chat.id, { anchor: { messageId: chat.messages[1]!.id, partId: "p", blockIndex: 0, blockText: "x" }, text: "why?" } as never);
			assert.equal(side.status, 409);
			assert.equal(JSON.stringify(chatStore.getChat(chat.id)), before, "no side thread created");
			const get = await getChatRoute(new Request(`http://fixture/api/chats/${chat.id}`), { params: Promise.resolve({ id: chat.id }) });
			const view = await get.json() as { sessionKind: unknown; coverage: { record: unknown } };
			assert.deepEqual(view.sessionKind, { id: LESSON, available: false, pluginId: PLUGIN, pluginName: "Session kinds fixture" });
			assert.deepEqual(view.coverage.record, { id: null, label: null, chunkTokens: null, available: false });
		});
	});

	it("deletion stays model-free and purges the chat's rows from plugin record ledgers, even while disabled", async () => {
		const chat = lessonChat("Delete me");
		const target = await resolveChatRecord(chat.kind);
		if (target.status !== "plugin") throw Error("expected plugin record");
		assert.equal((await runRecordExtraction({ chatStore }, chat.id, target, "manual")).status, "done");
		const files = pluginRecordCoverageFiles(pluginDataRoots);
		assert.ok(files.includes(path.join(ctx.dataDirectory, "records", "notebook", "coverage.jsonl")));
		await withPluginDisabled(async () => {
			const outcome = await deleteChatSession(chat.id, "preserve-graph");
			assert.equal(outcome.ok, true);
		});
		for (const file of files) assert.ok(!fs.readFileSync(file, "utf8").includes(chat.id));
		assert.equal(chatStore.getChat(chat.id), null);
	});
});
