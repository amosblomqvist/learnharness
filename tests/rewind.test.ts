import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { after, afterEach, describe, it, mock } from "node:test";
import { buildAbortSteer, buildSubagentSteer, type PlanTree, type SessionFindings } from "../src/core/contracts.ts";
import { coverageSlots } from "../src/core/coverage.ts";
import { mergeFindings } from "../src/core/graph.ts";
import { newUserSteer, type LhMessage } from "../src/core/native-messages.ts";
import { isJobLive, registerJobAbort, unregisterJobAbort } from "../src/agent/subagents/aborts.ts";

// Install isolation before importing any storage/configuration composition.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-rewind-"));
process.env.LH_DATA_DIR = path.join(directory, "data");
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { stores } = await import("../src/server/stores.ts");
const { rewindChat, rewindLimits } = await import("../src/server/rewind.ts");
const { beginTurn, endTurn, isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { registerTurn, unregisterTurn } = await import("../src/server/turn-runs.ts");
const {
	deliverJobResult, discardChatDeliveries, registerLiveAgent, steerLiveChat, unregisterLiveAgent,
} = await import("../src/server/jobs.ts");

const { subscribe } = await import("../src/core/events.ts");

const chats: string[] = [];
const controllers: string[] = [];
const result = { brief: "Fixture research result", sources: [] };
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ─── fixtures ────────────────────────────────────────────────────────────────

const treeOne: PlanTree = { nodes: [{ id: "a", title: "A" }], edges: [], version: 1 };
const treeTwo: PlanTree = { nodes: [{ id: "a", title: "A" }, { id: "b", title: "B" }], edges: [{ from: "a", to: "b" }], version: 2 };

let clock = 1;
const user = (id: string, text: string): LhMessage => ({ id, role: "user", content: text, timestamp: clock++ }) as never;
const assistant = (id: string, text: string, calls: Array<{ id: string; name: string }> = []): LhMessage => ({
	id, role: "assistant",
	content: [{ type: "text", text }, ...calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: {} }))],
	api: "openai-completions", provider: "faux", model: "faux",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop", timestamp: clock++,
}) as never;
const planResult = (id: string, callId: string, tree: PlanTree): LhMessage => ({
	id, role: "toolResult", toolCallId: callId, toolName: "plan_init",
	content: [{ type: "text", text: "ok" }], details: { ok: true, tree }, isError: false, timestamp: clock++,
}) as never;

function agent() {
	const handed: unknown[] = [];
	return { handed, value: { steer: (message: unknown) => handed.push(message) } as unknown as Parameters<typeof registerLiveAgent>[1] };
}

function fold(chatId: string, coveredIds: string[], findings: SessionFindings): void {
	const slots = coverageSlots(stores.chatStore.getChat(chatId)!.messages);
	const foldedAt = new Date().toISOString();
	mergeFindings(chatId, findings, { links: [] }, { chatStore: stores.chatStore, graphStore: stores.graphStore }, {
		foldedAt,
		coverage: slots
			.filter((slot) => coveredIds.includes(slot.message.id) && slot.tokens > 0)
			.map((slot) => ({ chatId, fp: slot.fp, tokens: slot.tokens, foldedAt })),
	});
}

/** u1 a1(plan-1 → T1, job-call-1) | u2 a2(plan-2 → T2, job-call-2, job-call-3): the learner edits u2. */
const transcript = (): LhMessage[] => [
	user("u1", "teach me"),
	assistant("a1", "First lesson", [{ id: "plan-1", name: "plan_init" }, { id: "job-call-1", name: "research" }]),
	planResult("r1", "plan-1", treeOne),
	user("u2", "edit me"),
	assistant("a2", "Second lesson", [{ id: "plan-2", name: "plan_init" }, { id: "job-call-2", name: "research" }, { id: "job-call-3", name: "research" }]),
	planResult("r2", "plan-2", treeTwo),
];

function newChat(messages: LhMessage[]) {
	const chat = stores.chatStore.createChat("Rewind fixture");
	chats.push(chat.id);
	stores.chatStore.saveMessages(chat.id, messages);
	return chat;
}

const nodeStatements = () => stores.graphStore.readNodes().map((node) => node.statement);

/** The full scenario: graph runs for a1 and a2, a kept job, a LIVE job and a
 *  finished-but-undelivered job from the tail, plus a learner steer parked
 *  for the chat. */
async function scenario() {
	const chat = newChat(transcript());
	stores.chatStore.saveTree(chat.id, treeTwo);
	fold(chat.id, ["a1"], { propositions: [{ id: "p1", name: "Kept", statement: `${chat.id} kept`, aliases: [], messageId: "a1" }], chains: [] });
	await delay(5);
	fold(chat.id, ["a2"], { propositions: [{ id: "p2", name: "Cut", statement: `${chat.id} cut`, aliases: [], messageId: "a2" }], chains: [] });

	const keptJob = stores.jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "job-call-1" });
	const liveJob = stores.jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "job-call-2" });
	const controller = new AbortController();
	registerJobAbort(liveJob.id, controller);
	controllers.push(liveJob.id);
	const doneJob = stores.jobStore.updateJob(
		stores.jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "job-call-3" }).id,
		{ status: "done", result, activity: "finished", delivery: { kind: "result", status: "pending" } },
	)!;

	// A turn that has since ended: its job result and a learner steer stay
	// owed to the chat's next run.
	assert(beginTurn(chat.id));
	const first = agent();
	registerLiveAgent(chat.id, first.value);
	void deliverJobResult(buildSubagentSteer(doneJob, result)).catch(() => undefined);
	assert(steerLiveChat(chat.id, newUserSteer("late words", "steer_late")));
	unregisterLiveAgent(chat.id);
	endTurn(chat.id);
	return { chat, keptJob, liveJob, doneJob, controller };
}

afterEach(() => {
	rewindLimits.settleTimeoutMs = 10_000;
	(globalThis as { __lhCompaction?: unknown }).__lhCompaction = undefined;
	(globalThis as { __lhExtractionRuns?: unknown }).__lhExtractionRuns = undefined;
	for (const id of controllers.splice(0)) unregisterJobAbort(id);
	for (const id of chats.splice(0)) {
		unregisterTurn(id); unregisterLiveAgent(id); endTurn(id); discardChatDeliveries(id);
		stores.jobStore.deleteJobsForChat(id); stores.chatStore.deleteChat(id);
	}
});
after(() => fs.rmSync(directory, { recursive: true, force: true }));

// ─── the service ─────────────────────────────────────────────────────────────

describe("rewindChat (editing the last sent message)", () => {
	it("refuses what is not the chat's last user message, and says which one is", async () => {
		assert.deepEqual(await rewindChat("chat_missing_rewind", "u2"), { ok: false, status: 404, code: "not_found", error: "No such session" });
		const chat = newChat(transcript());
		const unknown = await rewindChat(chat.id, "nope");
		assert.ok(!unknown.ok && unknown.status === 404 && unknown.code === "message_not_found");
		for (const id of ["u1", "a2"]) {
			const refused = await rewindChat(chat.id, id);
			assert.ok(!refused.ok && refused.status === 409 && refused.code === "not_last_user_message", `${id} is refused`);
			if (!refused.ok && refused.code === "not_last_user_message") assert.equal(refused.lastUserMessageId, "u2");
		}
		assert.equal(stores.chatStore.getChat(chat.id)!.messages.length, 6, "a refusal changes nothing");
		assert.equal(isTurnRunning(chat.id), false, "a refusal never claims the turn slot");
	});

	it("an idle chat: the tail, its graph, its plan tree, its jobs and its parked steers all go; what came before stays", async () => {
		const { chat, keptJob, liveJob, doneJob, controller } = await scenario();
		const keptStatement = `${chat.id} kept`;
		const keptLineBefore = JSON.stringify(stores.graphStore.readNodes().filter((n) => n.statement === keptStatement));

		const outcome = await rewindChat(chat.id, "u2");
		assert.ok(outcome.ok);
		if (!outcome.ok) return;
		assert.equal(outcome.text, "edit me", "the text goes back to the composer");
		assert.equal(outcome.removedMessages, 3);
		assert.equal(outcome.stats.nodesRemoved, 1);
		assert.equal(outcome.jobsRemoved, 2);

		const record = stores.chatStore.getChat(chat.id)!;
		assert.deepEqual(record.messages.map((m) => m.id), ["u1", "a1", "r1"], "1 2 3 — the edited message and everything after it is gone");
		assert.deepEqual(record.tree, treeOne, "the plan tree is the one the kept messages imply");
		assert.ok(!nodeStatements().includes(`${chat.id} cut`), "the tail's graph node died");
		assert.equal(JSON.stringify(stores.graphStore.readNodes().filter((n) => n.statement === keptStatement)), keptLineBefore, "earlier graph is byte-identical");

		assert.ok(stores.jobStore.getJob(keptJob.id), "the earlier job stays");
		assert.equal(stores.jobStore.getJob(liveJob.id), null);
		assert.equal(stores.jobStore.getJob(doneJob.id), null);
		assert.equal(controller.signal.aborted, true, "the live job is killed");
		assert.equal(isJobLive(liveJob.id), false);

		// Nothing owed from the tail rides the chat's next run.
		const next = agent();
		registerLiveAgent(chat.id, next.value);
		assert.deepEqual(next.handed, [], "no parked steer, no queued job result");
		assert.equal(isTurnRunning(chat.id), false, "the turn slot is released");
	});

	it("control: without a rewind the same parked steer and queued result do ride the next run", async () => {
		const { chat } = await scenario();
		const next = agent();
		registerLiveAgent(chat.id, next.value);
		assert.equal(next.handed.length, 2, "the job result and the learner steer");
	});

	/** A kept job (its tool call is in a kept message) whose delivery marker sits at `markerAt`
	 *  in u1 a1 | u2 a2: 0 = before the edited message u2, 1 = inside the tail. */
	function keptJobWithMarker(kind: "result" | "abort", markerAt: 0 | 1) {
		const chat = newChat([]);
		const created = stores.jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "jc1" });
		const job = stores.jobStore.updateJob(created.id, kind === "result"
			? { status: "done", result, activity: "finished", delivery: { kind, status: "delivered" } }
			: { status: "error", error: "Aborted by learner", activity: "aborted", delivery: { kind, status: "delivered" } })!;
		const steer = (kind === "result" ? buildSubagentSteer(job, result) : buildAbortSteer(job)) as unknown as LhMessage;
		const head = [user("u1", "teach me"), assistant("a1", "First lesson", [{ id: "jc1", name: "research" }])];
		const tail = [user("u2", "edit me"), assistant("a2", "Second lesson")];
		stores.chatStore.saveMessages(chat.id, markerAt === 0 ? [...head, steer, ...tail] : [...head, tail[0]!, steer, tail[1]!]);
		return { chat, job, steer };
	}

	for (const kind of ["result", "abort"] as const) {
		it(`a kept job whose ${kind} was delivered INSIDE the tail owes that delivery again`, async () => {
			const { chat, job, steer } = keptJobWithMarker(kind, 1);
			const outcome = await rewindChat(chat.id, "u2");
			assert.ok(outcome.ok);
			assert.deepEqual(stores.chatStore.getChat(chat.id)!.messages.map((m) => m.id), ["u1", "a1"]);
			assert.deepEqual(stores.jobStore.getJob(job.id)!.delivery, { kind, status: "pending" }, "the marker went with the tail, so the job owes it again");
			const next = agent();
			registerLiveAgent(chat.id, next.value);
			assert.deepEqual((next.handed as Array<{ id: string }>).map((m) => m.id), [steer.id], "and it rides the next run");
		});

		it(`control: a kept job whose ${kind} was delivered BEFORE the edited message stays delivered`, async () => {
			const { chat, job } = keptJobWithMarker(kind, 0);
			const outcome = await rewindChat(chat.id, "u2");
			assert.ok(outcome.ok);
			assert.equal(stores.jobStore.getJob(job.id)!.delivery?.status, "delivered");
			const next = agent();
			registerLiveAgent(chat.id, next.value);
			assert.deepEqual(next.handed, [], "nothing is owed");
		});
	}

	it("view-less messages share one fingerprint per role: a stray row under it never dates the cut", async () => {
		const chat = newChat(transcript());
		fold(chat.id, ["a1"], { propositions: [{ id: "p1", name: "Kept", statement: `${chat.id} kept guard`, aliases: [], messageId: "a1" }], chains: [] });
		// u1 and u2 are both user messages with no view: same fingerprint. A row
		// under it (never written by the pipeline) must not become the cut instant.
		const userFp = coverageSlots(stores.chatStore.getChat(chat.id)!.messages).find((slot) => slot.message.id === "u1")!.fp;
		stores.graphStore.appendCoverage({ chatId: chat.id, fp: userFp, tokens: 1, foldedAt: "2000-01-01T00:00:00.000Z" });

		const outcome = await rewindChat(chat.id, "u2");
		assert.ok(outcome.ok);
		assert.ok(nodeStatements().includes(`${chat.id} kept guard`), "the earlier run was not rolled back");
	});

	it("a tree-less transcript clears the tree instead of keeping the rewound one", async () => {
		const chat = newChat([
			user("u1", "teach me"), assistant("a1", "First lesson"),
			user("u2", "edit me"), assistant("a2", "Second lesson", [{ id: "plan-2", name: "plan_init" }]), planResult("r2", "plan-2", treeTwo),
		]);
		stores.chatStore.saveTree(chat.id, treeTwo);
		const outcome = await rewindChat(chat.id, "u2");
		assert.ok(outcome.ok);
		const record = stores.chatStore.getChat(chat.id)!;
		assert.deepEqual(record.messages.map((m) => m.id), ["u1", "a1"]);
		assert.equal("tree" in record, false, "no plan_init survives, so no tree");
	});

	it("a running turn is aborted and settled first; its persisted partial reply goes with the tail", async () => {
		const chat = newChat([user("u1", "teach me"), assistant("a1", "First lesson"), user("u2", "edit me")]);
		let aborts = 0;
		const handle = {
			subscribe: () => new ReadableStream(),
			abort() {
				aborts++;
				setTimeout(() => { // the turn's settle seam: persist the partial, then release
					stores.chatStore.saveMessages(chat.id, [...stores.chatStore.getChat(chat.id)!.messages, assistant("partial", "Half an ans")]);
					unregisterTurn(chat.id);
					endTurn(chat.id);
				}, 20);
			},
		} as unknown as Parameters<typeof registerTurn>[1];
		assert(beginTurn(chat.id));
		registerTurn(chat.id, handle);

		const outcome = await rewindChat(chat.id, "u2");
		assert.ok(outcome.ok);
		assert.equal(aborts, 1);
		assert.deepEqual(stores.chatStore.getChat(chat.id)!.messages.map((m) => m.id), ["u1", "a1"], "the partial reply is gone too");
		assert.equal(isTurnRunning(chat.id), false);
	});

	it("a turn that never settles is a retryable 503 and leaves the record alone", async () => {
		const chat = newChat([user("u1", "teach me"), user("u2", "edit me")]);
		rewindLimits.settleTimeoutMs = 60;
		assert(beginTurn(chat.id));
		registerTurn(chat.id, { subscribe: () => new ReadableStream(), abort: () => undefined } as unknown as Parameters<typeof registerTurn>[1]);
		const outcome = await rewindChat(chat.id, "u2");
		assert.ok(!outcome.ok && outcome.status === 503 && outcome.code === "turn_winding_down");
		assert.equal(stores.chatStore.getChat(chat.id)!.messages.length, 2);
	});

	it("a compaction in flight is a 409 that refuses BEFORE aborting: the streaming turn is untouched", async () => {
		const chat = newChat([user("u1", "teach me"), user("u2", "edit me")]);
		(globalThis as { __lhCompaction?: unknown }).__lhCompaction = { inFlight: new Map([[chat.id, Promise.resolve()]]) };
		let aborts = 0;
		assert(beginTurn(chat.id));
		registerTurn(chat.id, { subscribe: () => new ReadableStream(), abort: () => { aborts++; } } as unknown as Parameters<typeof registerTurn>[1]);

		const outcome = await rewindChat(chat.id, "u2");
		assert.ok(!outcome.ok && outcome.status === 409 && outcome.code === "compaction_running");
		assert.equal(aborts, 0, "the learner's streaming reply is not cut short by a refused rewind");
		assert.equal(stores.chatStore.getChat(chat.id)!.messages.length, 2);
		assert.equal(isTurnRunning(chat.id), true, "the running turn still owns its slot");
	});

	it("a compaction that starts after the settle is a 409, and the claimed turn slot is released", async () => {
		const chat = newChat([user("u1", "teach me"), user("u2", "edit me")]);
		assert(beginTurn(chat.id));
		registerTurn(chat.id, {
			subscribe: () => new ReadableStream(),
			abort() {
				setTimeout(() => { // the finished turn kicks a compaction as it settles
					(globalThis as { __lhCompaction?: unknown }).__lhCompaction = { inFlight: new Map([[chat.id, Promise.resolve()]]) };
					unregisterTurn(chat.id);
					endTurn(chat.id);
				}, 10);
			},
		} as unknown as Parameters<typeof registerTurn>[1]);

		const outcome = await rewindChat(chat.id, "u2");
		assert.ok(!outcome.ok && outcome.status === 409 && outcome.code === "compaction_running");
		assert.equal(stores.chatStore.getChat(chat.id)!.messages.length, 2, "nothing was rewound");
		assert.equal(isTurnRunning(chat.id), false, "the slot claimed for the rewind is released");
	});

	it("a running extraction is cancelled and awaited before the ledgers are rewritten", async () => {
		const { chat } = await scenario();
		const controller = new AbortController();
		const running = new Map<string, unknown>([["extraction-run", { chatId: chat.id, kind: "chat", phase: "extracting", startedAt: 1, usage: {}, controller }]]);
		(globalThis as { __lhExtractionRuns?: unknown }).__lhExtractionRuns = { running, inFlight: new Set(), lastStartedAt: 0 };
		let cutNodeSeenByExtraction = false;
		controller.signal.addEventListener("abort", () => {
			setTimeout(() => { // the pipeline unwinds a beat later; the rewind must still be waiting
				cutNodeSeenByExtraction = nodeStatements().includes(`${chat.id} cut`);
				running.delete("extraction-run");
			}, 30);
		});

		const outcome = await rewindChat(chat.id, "u2");
		(globalThis as { __lhExtractionRuns?: unknown }).__lhExtractionRuns = undefined;
		assert.ok(outcome.ok);
		assert.equal(controller.signal.aborted, true);
		assert.equal(cutNodeSeenByExtraction, true, "the ledgers were still untouched while the extraction wound down");
		assert.ok(!nodeStatements().includes(`${chat.id} cut`), "and rewritten only after");
	});
});

describe("JobStore.deleteJob", () => {
	it("removes the record and announces it; an unknown id is false and silent", () => {
		const chat = newChat([user("u1", "hi")]);
		const job = stores.jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-x" });
		const events: string[] = [];
		const unsubscribe = subscribe((event) => { if (event.type === "jobs-changed") events.push(event.chatId ?? ""); });
		try {
			assert.equal(stores.jobStore.deleteJob("job_missing"), false);
			assert.deepEqual(events, [], "nothing died, nothing announced");
			assert.equal(stores.jobStore.deleteJob(job.id), true);
			assert.deepEqual(events, [chat.id]);
			assert.equal(stores.jobStore.getJob(job.id), null);
			assert.equal(stores.jobStore.deleteJob(job.id), false, "idempotent");
		} finally {
			unsubscribe();
		}
	});

	it("a runner finishing after its job is gone resurrects nothing", () => {
		const chat = newChat([user("u1", "hi")]);
		const job = stores.jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-y" });
		assert.equal(stores.jobStore.deleteJob(job.id), true);
		// What an aborted runner still does on its way out: a usage merge-patch.
		assert.equal(stores.jobStore.updateJob(job.id, { usage: { model: "faux:faux", inputTokens: 1, outputTokens: 1, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined, steps: 1 } }), null);
		assert.equal(stores.jobStore.getJob(job.id), null);
		assert.deepEqual(stores.jobStore.listJobs(chat.id), []);
	});

	it("a failure other than 'already gone' throws instead of reading as deleted", () => {
		const chat = newChat([user("u1", "hi")]);
		const job = stores.jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-z" });
		const unlink = mock.method(fs, "unlinkSync", () => { throw Object.assign(new Error("file is locked"), { code: "EBUSY" }); });
		syncBuiltinESMExports();
		try {
			assert.throws(() => stores.jobStore.deleteJob(job.id), /file is locked/);
		} finally {
			unlink.mock.restore();
			syncBuiltinESMExports();
		}
		assert.ok(stores.jobStore.getJob(job.id), "the record is still there");
	});
});
