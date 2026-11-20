/** Offline request-boundary integration. Storage/auth roots are installed before
 * composition imports; every transcript, PDF and provider response is synthetic. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Type } from "typebox";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, normalizeContext, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { GraphStore } from "../src/core/ports.ts";
import type { HeadlessApi } from "../src/agent/subagents/headless.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-worker-admission-integration-"));
const originalEnv = process.env;
const originalFetch = globalThis.fetch;
fs.mkdirSync(path.join(scratch, "home"));
fs.writeFileSync(path.join(scratch, "auth.json"), "{}");
process.env = {
	...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}),
	...(originalEnv.NODE_OPTIONS ? { NODE_OPTIONS: originalEnv.NODE_OPTIONS } : {}),
	NODE_ENV: "test", HOME: path.join(scratch, "home"),
	LH_DATA_DIR: path.join(scratch, "data"), LH_AUTH_FILE: path.join(scratch, "auth.json"),
};
globalThis.fetch = async () => { throw new Error("CLOSED: unexpected network request"); };
const { configureWorkerRequestAdmission } = await import("../src/agent/worker-request-admission.ts");
const { runSubagent } = await import("../src/agent/subagents/pi-run.ts");
const { runVisualMaker } = await import("../src/agent/subagents/visual-maker.ts");
const { runPdfReaderAgent } = await import("../src/agent/subagents/pdf-reader.ts");
const { createTeacherAgent, createProberAgent, createPracticeAgent } = await import("../src/agent/teacher-agent.ts");
const { kickCompaction, awaitCompaction } = await import("../src/server/compaction.ts");
const { activeCompactionOf, newUserMessage } = await import("../src/core/index.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { createPluginWorkerService } = await import("../src/agent/plugin-workers.ts");
const { createPluginTaskRecordStore } = await import("../src/store/plugin-task-records.ts");
const { createExtractionPipeline, extractionStatuses, abortExtraction } = await import("../src/agent/subagents/extraction.ts");
after(() => {
	configureWorkerRequestAdmission(() => 8);
	process.env = originalEnv;
	globalThis.fetch = originalFetch;
	fs.rmSync(scratch, { recursive: true, force: true });
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}
const tick = () => new Promise<void>((done) => setImmediate(done));
async function until(predicate: () => boolean) {
	const deadline = Date.now() + 3_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "synthetic pipeline reached its expected barrier");
		await tick();
	}
}
async function flush() { for (let i = 0; i < 5; i++) await tick(); }
function scripted(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}
const answer = () => fauxAssistantMessage("Synthetic answer.");
const run = (engine: PiEngine, extra = {}) => runSubagent([], {
	engine, systemPrompt: "Synthetic worker.", prompt: "Work.", maxTurns: 1, ...extra,
});
const headless: HeadlessApi = {
	available: () => true, unavailableReason: () => null,
	renderSvg: async () => { throw new Error("unexpected render"); },
	renderPdfPages: async () => { throw new Error("unexpected render"); },
	runDemo: async () => { throw new Error("unexpected browser"); },
};

function memoryLedgers(): GraphStore {
	const nodes: ReturnType<GraphStore["readNodes"]> = [];
	const chains: ReturnType<GraphStore["readChains"]> = [];
	const coverage: ReturnType<GraphStore["readCoverage"]> = [];
	const checkpoints: ReturnType<GraphStore["readCheckpoints"]> = [];
	const sources = new Map<string, ReturnType<GraphStore["readSources"]>[number]>();
	let positions: ReturnType<GraphStore["readPositions"]> = {};
	return {
		appendNode: (value) => { nodes.push(value); }, readNodes: () => structuredClone(nodes),
		appendChain: (value) => { chains.push(value); }, readChains: () => structuredClone(chains),
		appendCoverage: (value) => { coverage.push(value); }, readCoverage: () => structuredClone(coverage),
		appendCheckpoint: (value) => { checkpoints.push(value); }, readCheckpoints: () => structuredClone(checkpoints),
		upsertSource: (value) => { sources.set(value.id, { ...value, extractions: sources.get(value.id)?.extractions ?? [] }); },
		readSources: () => structuredClone([...sources.values()]),
		deleteSources: (ids) => [...ids].reduce((n, id) => n + Number(sources.delete(id)), 0),
		appendSourceUsage: (id, value) => { const source = sources.get(id); if (source) source.extractions!.push(value); },
		readPositions: () => structuredClone(positions), writePositions: (value) => { positions = structuredClone(value); },
		rewriteLedgers: () => { throw new Error("unexpected destructive write"); },
	};
}
function teachingChat(label: string) {
	const chat = chatStore.createChat(label);
	chatStore.saveMessages(chat.id, [{
		id: "teach", role: "assistant", content: [{ type: "text", text: `${label} is a synthetic teaching passage.` }],
		api: "openai-completions", provider: "faux", model: "synthetic", stopReason: "stop", timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	}]);
	return chat.id;
}
function submit(name: string, value: unknown, onCall?: () => void, gate?: Promise<void>): PiEngine {
	return scripted([async () => {
		onCall?.();
		await gate;
		return fauxAssistantMessage([fauxToolCall(name, value as never)], { stopReason: "toolUse" });
	}]);
}

test("actual audit lock: cancelling middle B cannot let C audit while A still holds audit+merge", { timeout: 8_000 }, async () => {
	configureWorkerRequestAdmission(() => 8); // admission must not mask lock overlap
	const graphStore = memoryLedgers();
	const a = teachingChat("Alpha"), b = teachingChat("Beta"), c = teachingChat("Gamma");
	const gate = deferred();
	let cCalled = false, cSawAlpha = false, bCalled = false;
	const pipeline = (id: string, label: string, auditor: PiEngine) => createExtractionPipeline({
		chatStore, graphStore,
		extractor: submit("submit_findings", { propositions: [{ id, name: label, statement: `${label} claim.`, aliases: [], messageId: "teach" }], chains: [] }),
		auditor,
	});
	const runs: Promise<unknown>[] = [];
	try {
		runs.push(pipeline("pa", "Alpha", submit("submit_review", { links: [] }, undefined, gate.promise)).runExtraction(a));
		await until(() => extractionStatuses().some((row) => row.chatId === a && row.phase === "auditing"));
		const runB = pipeline("pb", "Beta", submit("submit_review", { links: [] }, () => { bCalled = true; })).runExtraction(b);
		runs.push(runB);
		await until(() => extractionStatuses().some((row) => row.chatId === b && row.phase === "waiting"));
		assert.equal(abortExtraction(b), true);
		assert.deepEqual(await runB, { nodes: 0, chains: 0 });
		runs.push(pipeline("pc", "Gamma", submit("submit_review", { links: [] }, () => {
			cCalled = true;
			cSawAlpha = graphStore.readNodes().some((node) => node.name === "Alpha");
		})).runExtraction(c));
		await until(() => extractionStatuses().some((row) => row.chatId === c && row.phase === "waiting") || cCalled);
		await flush();
		assert.equal(cCalled, false, "C must wait for A even though its immediate predecessor B cancelled");
		assert.equal(bCalled, false);
		gate.resolve();
		await Promise.all(runs);
		assert.equal(cSawAlpha, true, "C explores the graph after A's merge, not just after A's request");
		assert.equal(graphStore.readCoverage().some((row) => row.chatId === b), false);
		assert.equal(extractionStatuses().length, 0);
	} finally {
		gate.resolve();
		await Promise.allSettled(runs);
	}
});

test("shared injected engine: each request releases before tools, and continuations reacquire without nested permits", { timeout: 8_000 }, async () => {
	configureWorkerRequestAdmission(() => 1);
	const toolEntered = deferred(), toolGate = deferred();
	let usage = 0, calls = 0;
	const engine = scripted([
		fauxAssistantMessage([fauxToolCall("pause", {})], { stopReason: "toolUse" }), answer(), answer(),
	]);
	const original = engine.streamFn;
	engine.streamFn = (...args) => { calls++; return original(...args); };
	const sharedStream = engine.streamFn;
	const first = runSubagent([{
		name: "pause", label: "pause", description: "Synthetic tool barrier", parameters: Type.Object({}),
		execute: async () => { toolEntered.resolve(); await toolGate.promise; return { content: [{ type: "text", text: "done" }], details: null }; },
	}], { engine, role: "researcher", systemPrompt: "Synthetic worker", prompt: "Work", maxTurns: 2, onUsage: () => { usage++; } });
	try {
		await toolEntered.promise;
		// No role: the explicit-engine path used by ctx.workers tasks.
		assert.equal((await run(engine, { onUsage: () => { usage++; } })).text, "Synthetic answer.");
		assert.equal(calls, 2, "a running tool does not retain a worker model permit");
		assert.equal(engine.streamFn, sharedStream, "shared engine is not mutated or globally classified");
	} finally { toolGate.resolve(); await first; }
	assert.equal(calls, 3, "the first worker's next model request reacquired the same pool");
	assert.equal(usage, 3, "money channel still sees one admitted step per request");
});

test("raw PDF + visual loops share request admission with the native worker runner", { timeout: 8_000 }, async () => {
	configureWorkerRequestAdmission(() => 1);
	const gate = deferred(), entered = deferred();
	let active = 0, peak = 0, visualCalls = 0, nativeCalls = 0, pdfUsage = 0, visualUsage = 0;
	const observed = (onCall: () => void, hold?: Promise<void>) => scripted([async () => {
		onCall(); active++; peak = Math.max(peak, active);
		try { await hold; return answer(); } finally { active--; }
	}]);
	const pdf = runPdfReaderAgent({ path: path.join(import.meta.dirname, "fixtures/sample-3page.pdf"), question: "Synthetic?" }, {
		engine: observed(() => entered.resolve(), gate.promise), headless, maxIterations: 1, onUsage: () => { pdfUsage++; },
	});
	const work: Promise<unknown>[] = [pdf];
	try {
		await entered.promise;
		work.push(runVisualMaker({ brief: "Synthetic" }, { engine: observed(() => { visualCalls++; }), headless, maxIterations: 1, onUsage: () => { visualUsage++; } }));
		work.push(run(observed(() => { nativeCalls++; })));
		await flush();
		assert.equal(visualCalls, 0, "queued visual request never invokes transport");
		assert.equal(nativeCalls, 0, "queued native request never invokes transport");
		gate.resolve();
		await Promise.all(work);
		assert.equal(peak, 1);
		assert.equal(visualCalls, 1);
		assert.equal(nativeCalls, 1);
		assert.equal(pdfUsage, 1);
		assert.equal(visualUsage, 1);
	} finally { gate.resolve(); await Promise.allSettled(work); }
});

test("chat and notes extraction share the configured request limit, not the old fixed-three extraction gate", { timeout: 8_000 }, async () => {
	configureWorkerRequestAdmission(() => 4);
	const graphStore = memoryLedgers(), gate = deferred();
	let extractCalls = 0;
	const pipeline = (label: string, notes: boolean) => createExtractionPipeline({
		chatStore, graphStore,
		extractor: submit("submit_findings", { propositions: [{ id: "p1", name: label, statement: `${label} claim.`, aliases: [], ...(notes ? {} : { messageId: "teach" }) }], chains: [] }, () => { extractCalls++; }, gate.promise),
		auditor: submit("submit_review", { links: [] }),
	});
	const work = [
		pipeline("Chat one", false).runExtraction(teachingChat("Chat one")),
		pipeline("Chat two", false).runExtraction(teachingChat("Chat two")),
		pipeline("Notes one", true).importNotes({ filePath: "/synthetic/one.md", text: "Notes one is synthetic." }),
		pipeline("Notes two", true).importNotes({ filePath: "/synthetic/two.md", text: "Notes two is synthetic." }),
	];
	let extraCalls = 0, billed = 0;
	const controller = new AbortController();
	let extra: Promise<unknown> | undefined;
	try {
		await until(() => extractCalls === 4);
		extra = assert.rejects(run(submit("unused", {}, () => { extraCalls++; }), {
			abortSignal: controller.signal, onUsage: () => { billed++; },
		}), { name: "AbortError" });
		await flush();
		assert.equal(extraCalls, 0, "all four extraction requests occupy the same worker pool");
		controller.abort(); await extra;
		assert.equal(billed, 0, "queued cancellation never becomes a billed model step");
		gate.resolve();
		await Promise.all(work);
		assert.equal(graphStore.readNodes().length, 4, "both front doors still audit and merge normally");
	} finally {
		controller.abort(); gate.resolve();
		await Promise.allSettled([...work, ...(extra ? [extra] : [])]);
	}
});

test("auditor model requests share admission with other workers, independently of the audit consistency lock", { timeout: 8_000 }, async () => {
	configureWorkerRequestAdmission(() => 1);
	const graphStore = memoryLedgers(), gate = deferred(), entered = deferred();
	let called = false;
	const pipeline = createExtractionPipeline({
		chatStore, graphStore,
		extractor: submit("submit_findings", { propositions: [{ id: "p1", name: "Audit", statement: "Audit claim.", aliases: [], messageId: "teach" }], chains: [] }),
		auditor: submit("submit_review", { links: [] }, entered.resolve, gate.promise),
	});
	const extraction = pipeline.runExtraction(teachingChat("Audit"));
	let sibling: Promise<unknown> | undefined;
	try {
		await entered.promise;
		sibling = run(scripted([() => { called = true; return answer(); }]));
		await flush();
		assert.equal(called, false, "auditor model traffic uses the same pool as other workers");
		gate.resolve();
		await Promise.all([extraction, sibling]);
		assert.equal(called, true);
		assert.equal(graphStore.readNodes().length, 1);
	} finally { gate.resolve(); await Promise.allSettled([extraction, ...(sibling ? [sibling] : [])]); }
});

test("actual ctx.workers service admits user-purpose tasks and never dispatches cancelled queued transport", { timeout: 8_000 }, async () => {
	configureWorkerRequestAdmission(() => 1);
	const gate = deferred(), entered = deferred();
	const worker = run(scripted([async () => { entered.resolve(); await gate.promise; return answer(); }]));
	let calls = 0, usage = 0;
	const service = createPluginWorkerService({
		store: createPluginTaskRecordStore(path.join(scratch, "plugin-tasks")),
		engineFor: () => submit("submit_result", { result: "answer" }, () => { calls++; }),
		onUsage: () => { usage++; },
	});
	service.register({ id: "synthetic", instructions: "Return a synthetic result.", resultSchema: Type.String() });
	try {
		await entered.promise;
		const options = { requestId: "queued-user", input: null, prompt: "Synthetic worker", model: { provider: "faux", id: "test" }, purpose: "user" as const, maxTurns: 1 };
		const queued = service.start("synthetic", options);
		await until(() => service.get(queued.id).status === "running");
		await flush();
		assert.equal(calls, 0, "worker classification is the execution boundary, not purpose=background");
		service.cancel(queued.id);
		assert.equal((await service.wait(queued.id)).status, "cancelled");
		assert.equal(calls, 0);
		assert.equal(usage, 0);
		gate.resolve(); await worker;
		const next = service.start("synthetic", { ...options, requestId: "next-user" });
		assert.equal((await service.wait(next.id)).status, "succeeded");
		assert.equal(calls, 1, "the same task runner dispatches after the shared pool clears");
		assert.equal(usage, 1);
	} finally { gate.resolve(); await worker; await service.dispose(); }
});

test("same injected engine stays ungated for direct teacher/prober/practice, raw inference and production compaction", { timeout: 8_000 }, async () => {
	configureWorkerRequestAdmission(() => 1);
	const gate = deferred(), entered = deferred();
	let calls = 0;
	const engine = scripted([async () => { entered.resolve(); await gate.promise; return answer(); }, answer(), answer(), answer(), answer(), answer()]);
	const original = engine.streamFn;
	engine.streamFn = (...args) => { calls++; return original(...args); };
	const sharedStream = engine.streamFn;
	const worker = run(engine);
	try {
		await entered.promise;
		await createTeacherAgent(undefined, { engine, tools: {} }).prompt("Synthetic lesson");
		await createProberAgent({} as never, { engine, tools: {} }).prompt("Synthetic probe");
		await createPracticeAgent({} as never, { engine, tools: {} }).prompt("Synthetic practice");
		await engine.streamFn(engine.model, normalizeContext({ messages: [newUserMessage("Raw standalone inference")] })).result();
		const chat = chatStore.createChat("Synthetic compaction");
		chatStore.saveMessages(chat.id, [newUserMessage("x".repeat(100_000)), newUserMessage("y".repeat(100_000)), newUserMessage("z".repeat(100_000)), newUserMessage("recent")]);
		// The production settle-kick exercises the real summarizer even in tests
		// (ensureCompacted intentionally skips non-injected summaries in test mode).
		kickCompaction(() => ({ chatStore, engine, modelId: "faux:synthetic", kind: "teach", thresholdTokens: 1_000, systemPromptTokens: 0 }), chat.id);
		await awaitCompaction(chat.id);
		const record = chatStore.getChat(chat.id)!;
		assert.ok(activeCompactionOf(record.messages), "production summarizer bypasses a fully occupied worker pool");
		assert.equal(record.turns?.length, 1, "compaction's usage persists through the existing money channel");
		assert.equal(calls, 6, "excluded requests dispatch while the admitted worker remains held");
		assert.equal(engine.streamFn, sharedStream);
	} finally { gate.resolve(); await worker; }
});
