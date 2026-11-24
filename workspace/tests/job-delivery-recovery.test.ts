import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Agent } from "@earendil-works/pi-agent-core";
import { after, afterEach, test } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import { buildSubagentSteer, type JobKind, type SteerMessage } from "../src/core/contracts.ts";

// Install isolation before importing any storage/configuration composition.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-job-delivery-"));
process.env.LH_DATA_DIR = path.join(directory, "data");
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { stores } = await import("../src/server/stores.ts");
const { jobTools } = await import("../src/agent/tools/jobs.ts");
const { createJobRunner, researchModelOverride } = await import("../src/agent/subagents/runner.ts");
const { isJobLive } = await import("../src/agent/subagents/aborts.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const {
	deliverJobResult, discardChatDeliveries, noteSteersDurable, recoverStaleJobs,
	registerLiveAgent, unregisterLiveAgent, settleSteers, setTurnRunner,
} = await import("../src/server/jobs.ts");
const { activityFeed } = await import("../src/server/observability.ts");
const { deleteChatSession } = await import("../src/server/chats.ts");
const chats: string[] = [];
const result = { brief: "Fixture research result", sources: [] };
const question = {
	id: "question-message", role: "assistant", content: [{ type: "toolCall", id: "question-call", name: "quiz", arguments: {} }],
	api: "openai-completions", provider: "faux", model: "faux", timestamp: 1,
} as unknown as LhMessage;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean): Promise<void> {
	const end = Date.now() + 8000;
	while (!predicate()) { assert(Date.now() < end, "fixture condition timed out"); await delay(10); }
}
function sweep(): void {
	const global = globalThis as { __lhWakePipeline?: { lastSweepAt: number } };
	if (global.__lhWakePipeline) global.__lhWakePipeline.lastSweepAt = 0;
	recoverStaleJobs();
}
function chat(blocked = false) {
	const value = stores.chatStore.createChat("Isolated delivery fixture");
	chats.push(value.id);
	if (blocked) stores.chatStore.saveMessages(value.id, [question]);
	return value;
}
function pending(chatId: string) {
	const value = stores.jobStore.createJob({ kind: "research", chatId, toolCallId: "fixture-call" });
	const job = stores.jobStore.updateJob(value.id, {
		status: "done", result, activity: "finished", delivery: { kind: "result", status: "pending" },
	})!;
	return { job, steer: buildSubagentSteer(job, result) };
}
function agent() {
	const handed: SteerMessage[] = [];
	return { handed, value: { steer: (marker: SteerMessage) => handed.push(marker) } as unknown as Parameters<typeof registerLiveAgent>[1] };
}
function persist(chatId: string, steers: readonly LhMessage[]): void {
	stores.chatStore.saveMessages(chatId, [...stores.chatStore.getChat(chatId)!.messages, ...steers]);
	noteSteersDurable(chatId, steers);
}
afterEach(() => {
	researchModelOverride.current = undefined;
	for (const id of chats.splice(0)) {
		unregisterLiveAgent(id); endTurn(id); discardChatDeliveries(id);
		stores.jobStore.deleteJobsForChat(id); stores.chatStore.deleteChat(id);
	}
	setTurnRunner(async () => 500);
});
after(() => fs.rmSync(directory, { recursive: true, force: true }));

for (const [kind, input] of Object.entries({
	research: { question: "Saved research question", context: "Saved context" },
	demo: { title: "Fixture", brief: "Saved demo brief" },
	visual: { brief: "Saved figure brief" },
	pdf: { path: "fixture.pdf", question: "Saved PDF question" },
})) test(`${kind}: dispatch saves input before spawn and does not overwrite it on repeated dispatch`, async () => {
	const owner = chat();
	let spawns = 0;
	const tools = jobTools({ chatId: owner.id, jobStore: stores.jobStore, spawn: (job) => {
		spawns++;
		assert.deepEqual(stores.jobStore.getJob(job.id)!.input, input);
	} });
	await tools[kind]!.execute!("fixture-dispatch", input);
	await tools[kind]!.execute!("fixture-dispatch", input);
	assert.equal(spawns, 1);
	assert.equal(stores.jobStore.listJobs(owner.id)[0]!.kind, kind as JobKind);
});

test("saved question survives absent transcript; runner ends while delivery is still pending", async () => {
	const owner = chat(true);
	const input = { question: "The dispatch turn was never saved", context: "Fixture context" };
	const job = stores.jobStore.createJob({ kind: "research", chatId: owner.id, toolCallId: "lost-turn", input });
	const faux = createFauxCore({});
	let seen = "";
	faux.setResponses([(context) => { seen = JSON.stringify(context.messages); return fauxAssistantMessage("Fixture brief"); }]);
	researchModelOverride.current = { model: faux.getModel(), streamFn: faux.streamSimple };
	let delivery: Promise<void> | undefined;
	const runner = createJobRunner({ ...stores, deliver: (steer) => { delivery = deliverJobResult(steer); return delivery; } });
	await runner.runJob(job.id);
	assert(seen.includes(input.question)); assert(seen.includes(input.context));
	assert.equal(isJobLive(job.id), false, "worker registration no longer spans delivery");
	assert.equal(stores.jobStore.getJob(job.id)!.status, "done");
	assert.equal(stores.jobStore.getJob(job.id)!.delivery?.status, "pending");
	assert(!activityFeed().jobs.some((item) => item.id === job.id), "no running background-agent row");
	const next = agent(); assert(beginTurn(owner.id)); registerLiveAgent(owner.id, next.value);
	assert.equal(next.handed.length, 1);
	persist(owner.id, next.handed); unregisterLiveAgent(owner.id); settleSteers(owner.id, next.handed); endTurn(owner.id);
	await delivery;
});

test("missing or blank research question records an honest failure without invoking a model", async () => {
	for (const input of [undefined, { question: "   " }]) {
		const owner = chat();
		const job = stores.jobStore.createJob({ kind: "research", chatId: owner.id, toolCallId: "missing-question", input });
		const faux = createFauxCore({}); let calls = 0;
		faux.setResponses([() => { calls++; return fauxAssistantMessage("must not run"); }]);
		researchModelOverride.current = { model: faux.getModel(), streamFn: faux.streamSimple };
		const steers: SteerMessage[] = [];
		await createJobRunner({ ...stores, deliver: async (steer) => { steers.push(steer); } }).runJob(job.id);
		assert.equal(calls, 0);
		assert.equal(stores.jobStore.getJob(job.id)!.error, "research question unavailable");
		assert.equal(stores.jobStore.getJob(job.id)!.status, "error");
		assert.match(steers[0]!.content, /^Research failed: the research question is unavailable\./);
		assert.equal(stores.jobStore.getJob(job.id)!.delivery?.status, "pending");
	}
});

test("repeated recovery behind a question yields one handed and one durable marker", async () => {
	const owner = chat(true); const { job, steer } = pending(owner.id);
	let wakes = 0; setTurnRunner(async () => { wakes++; return 500; });
	sweep(); sweep(); sweep();
	const first = deliverJobResult(steer);
	assert.strictEqual(deliverJobResult(steer), first, "duplicate callers share one logical delivery");
	const next = agent(); assert(beginTurn(owner.id)); registerLiveAgent(owner.id, next.value);
	assert.deepEqual(next.handed.map((message) => message.id), [steer.id]);
	persist(owner.id, next.handed); unregisterLiveAgent(owner.id); settleSteers(owner.id, next.handed); endTurn(owner.id);
	await first;
	assert.equal(wakes, 0);
	assert.equal(stores.chatStore.getChat(owner.id)!.messages.filter((message) => message.id === steer.id).length, 1);
	assert.equal(stores.jobStore.getJob(job.id)!.delivery?.status, "delivered");
});

for (const refused of [409, 403]) test(`duplicate during a ${refused} wake retains one logical owner`, async () => {
	const owner = chat(); const { steer } = pending(owner.id);
	let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
	let attempts = 0;
	setTurnRunner(async (id, input) => {
		assert.equal(input.type, "steers"); if (input.type !== "steers") return 500;
		assert.equal(input.steers.length, 1);
		attempts++;
		if (attempts === 1) { await gate; return refused; }
		persist(id, input.steers); return 200;
	});
	const first = deliverJobResult(steer);
	await until(() => attempts === 1);
	assert.strictEqual(deliverJobResult(steer), first, "wake cargo is still in the registry");
	release();
	if (refused === 403) {
		await delay(30);
		const next = agent(); assert(beginTurn(owner.id)); registerLiveAgent(owner.id, next.value);
		assert.equal(next.handed.length, 1);
		persist(owner.id, next.handed); unregisterLiveAgent(owner.id); settleSteers(owner.id, next.handed); endTurn(owner.id);
	}
	await first;
	assert.equal(stores.chatStore.getChat(owner.id)!.messages.filter((message) => message.id === steer.id).length, 1);
});

test("failed start stays quiet across sweeps, then joins a learner run", async () => {
	const owner = chat(); const { job, steer } = pending(owner.id);
	let attempts = 0; setTurnRunner(async () => { attempts++; return 503; });
	const delivery = deliverJobResult(steer); await until(() => attempts === 1); await delay(30);
	sweep(); sweep(); await delay(900);
	assert.equal(attempts, 1);
	assert.equal(stores.jobStore.getJob(job.id)!.status, "done");
	assert.equal(stores.jobStore.getJob(job.id)!.error, undefined);
	assert.equal(stores.jobStore.getJob(job.id)!.delivery?.status, "pending");
	const next = agent(); assert(beginTurn(owner.id)); registerLiveAgent(owner.id, next.value);
	assert.equal(next.handed.length, 1);
	persist(owner.id, next.handed); unregisterLiveAgent(owner.id); settleSteers(owner.id, next.handed); endTurn(owner.id);
	await delivery;
});

test("HTTP acceptance without a saved marker is not delivery completion or a retry trigger", async () => {
	const owner = chat(); const { job, steer } = pending(owner.id);
	let attempts = 0;
	const accepted = agent();
	setTurnRunner(async () => {
		attempts++; assert(beginTurn(owner.id));
		registerLiveAgent(owner.id, accepted.value, false, new Set([steer.id]));
		return 200;
	});
	const delivery = deliverJobResult(steer); await until(() => attempts === 1); await delay(30);
	assert.equal(stores.jobStore.getJob(job.id)!.delivery?.status, "pending");
	unregisterLiveAgent(owner.id); endTurn(owner.id); settleSteers(owner.id, [], true, accepted.value);
	sweep(); await delay(900); assert.equal(attempts, 1);
	const next = agent(); assert(beginTurn(owner.id)); registerLiveAgent(owner.id, next.value);
	assert.equal(next.handed.length, 1);
	persist(owner.id, next.handed); unregisterLiveAgent(owner.id); endTurn(owner.id); await delivery;
});

test("a racing foreground settlement cannot release an outstanding staged wake", async () => {
	const owner = chat(); const { steer } = pending(owner.id);
	let started = false;
	let release!: () => void;
	const startup = new Promise<void>((resolve) => { release = resolve; });
	let modelCopies = 0;
	let nativeCopies = 0;
	setTurnRunner(async (id, input) => {
		assert.equal(input.type, "steers"); if (input.type !== "steers") return 500;
		started = true;
		// Subscription wake startup can await catalog refresh before claiming
		// the session. Its cargo is not yet a durable input prefix.
		await startup;
		const faux = createFauxCore({});
		faux.setResponses([(context) => {
			modelCopies = JSON.stringify(context.messages).split(result.brief).length - 1;
			return fauxAssistantMessage("Fixture wake response");
		}]);
		const wake = new Agent({ initialState: { model: faux.getModel(), messages: input.steers }, convertToLlm: toLlmMessages, streamFn: faux.streamSimple });
		assert(beginTurn(id));
		registerLiveAgent(id, wake, false, new Set(input.steers.map((message) => message.id)));
		await wake.continue();
		nativeCopies = wake.state.messages.filter((message) => (message as LhMessage).id === steer.id).length;
		persist(id, wake.state.messages.filter((message) => message.role !== "system") as LhMessage[]);
		unregisterLiveAgent(id); endTurn(id); settleSteers(id, stores.chatStore.getChat(id)!.messages, false, wake);
		return 200;
	});
	const delivery = deliverJobResult(steer);
	await until(() => started);
	const foreground = agent(); assert(beginTurn(owner.id)); registerLiveAgent(owner.id, foreground.value);
	assert.equal(foreground.handed.length, 0, "outstanding wake owns the marker");
	unregisterLiveAgent(owner.id); endTurn(owner.id); settleSteers(owner.id, [], false, foreground.value);
	release(); await delivery;
	assert.equal(modelCopies, 1, "one result in the model's initial context");
	assert.equal(nativeCopies, 1, "no self-steering of staged wake cargo");
	assert.equal(stores.chatStore.getChat(owner.id)!.messages.filter((message) => message.id === steer.id).length, 1);
});

test("canonical save wins even if delivery bookkeeping fails; no marker replay", async () => {
	const owner = chat(true); const { job, steer } = pending(owner.id);
	const delivery = deliverJobResult(steer);
	const update = stores.jobStore.updateJob;
	stores.jobStore.updateJob = (id, patch) => {
		if (id === job.id && patch.delivery?.status === "delivered") throw new Error("fixture acknowledgement write failure");
		return update(id, patch);
	};
	try { persist(owner.id, [steer]); await delivery; }
	finally { stores.jobStore.updateJob = update; }
	let wakes = 0; setTurnRunner(async () => { wakes++; return 500; });
	sweep();
	assert.equal(stores.jobStore.getJob(job.id)!.delivery?.status, "delivered");
	assert.equal(wakes, 0);
	const next = agent(); assert(beginTurn(owner.id)); registerLiveAgent(owner.id, next.value);
	assert.equal(next.handed.length, 0); unregisterLiveAgent(owner.id); endTurn(owner.id);
});

test("old running results become finished pending work; old terminal records are untouched", () => {
	const owner = chat(true);
	const old = stores.jobStore.createJob({ kind: "research", chatId: owner.id, toolCallId: "legacy-pending" });
	stores.jobStore.updateJob(old.id, { result });
	const terminal = stores.jobStore.createJob({ kind: "research", chatId: owner.id, toolCallId: "legacy-terminal" });
	stores.jobStore.updateJob(terminal.id, { status: "done", result });
	sweep();
	assert.equal(stores.jobStore.getJob(old.id)!.status, "done");
	assert.equal(stores.jobStore.getJob(old.id)!.delivery?.status, "pending");
	assert.equal(stores.jobStore.getJob(terminal.id)!.delivery, undefined);
	const next = agent(); assert(beginTurn(owner.id)); registerLiveAgent(owner.id, next.value);
	assert.deepEqual(next.handed.map((message) => message.id), [`steer_${old.id}`]);
	unregisterLiveAgent(owner.id); endTurn(owner.id);
});

test("fresh process restores a pending delivery on registration without a jobs poll", () => {
	const owner = chat(true); const { job, steer } = pending(owner.id);
	const script = `
		const { stores } = await import('./src/server/stores.ts');
		const { registerLiveAgent, noteSteersDurable, unregisterLiveAgent } = await import('./src/server/jobs.ts');
		const { beginTurn, endTurn } = await import('./src/server/turn-liveness.ts');
		const handed = []; beginTurn(${JSON.stringify(owner.id)});
		registerLiveAgent(${JSON.stringify(owner.id)}, { steer: marker => handed.push(marker) });
		const record = stores.chatStore.getChat(${JSON.stringify(owner.id)});
		stores.chatStore.saveMessages(record.id, [...record.messages, ...handed]);
		noteSteersDurable(record.id, handed); unregisterLiveAgent(record.id); endTurn(record.id);
		console.log(JSON.stringify(handed.map(marker => marker.id)));
	`;
	const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
		cwd: process.cwd(), encoding: "utf8", timeout: 15000,
		env: { PATH: process.env.PATH, HOME: path.join(directory, "home"), NODE_ENV: "test", LH_DATA_DIR: process.env.LH_DATA_DIR, LH_AUTH_FILE: process.env.LH_AUTH_FILE },
	});
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), [steer.id]);
	assert.equal(stores.jobStore.getJob(job.id)!.delivery?.status, "delivered");
	assert.equal(stores.chatStore.getChat(owner.id)!.messages.filter((message) => message.id === steer.id).length, 1);
});

test("deleting legacy completed work needs no preceding recovery poll", async () => {
	const owner = chat(true);
	const old = stores.jobStore.createJob({ kind: "research", chatId: owner.id, toolCallId: "legacy-delete" });
	stores.jobStore.updateJob(old.id, { result });
	const outcome = await deleteChatSession(owner.id, "preserve-graph");
	assert(outcome.ok);
	assert.equal(stores.jobStore.getJob(old.id), null);
	assert.equal(stores.chatStore.getChat(owner.id), null);
});

test("deletion still refuses a computing worker or a live turn", async () => {
	const owner = chat();
	const computing = stores.jobStore.createJob({ kind: "research", chatId: owner.id, toolCallId: "computing-delete" });
	const blocked = await deleteChatSession(owner.id, "preserve-graph");
	assert(!blocked.ok && blocked.code === "jobs_running");
	stores.jobStore.updateJob(computing.id, { status: "done" });
	assert(beginTurn(owner.id));
	const live = await deleteChatSession(owner.id, "preserve-graph");
	assert(!live.ok && live.code === "turn_in_flight");
	endTurn(owner.id);
});

test("deleting a session discards its pending deliveries without starting a turn", async () => {
	const owner = chat(true); const { job, steer } = pending(owner.id);
	let wakes = 0; setTurnRunner(async () => { wakes++; return 500; });
	const delivery = deliverJobResult(steer);
	const outcome = await deleteChatSession(owner.id, "preserve-graph");
	assert(outcome.ok);
	await delivery; await delay(450);
	assert.equal(stores.jobStore.getJob(job.id), null);
	assert.equal(stores.chatStore.getChat(owner.id), null);
	assert.equal(wakes, 0);
});
