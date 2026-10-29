/**
 * Job infrastructure tests — deterministic, zero network:
 *
 *   1. job store CRUD (create → get → update → list → dedup by toolCallId)
 *   2. steer helpers (pure, contracts.ts): buildSubagentSteer shape per kind,
 *      isSubagentFailure, steerDelivered
 *   3. dispatch (async protocol §2): drive handleChatRequest with a scripted
 *      mock teacher that emits a research tool call → the tool part resolves
 *      IMMEDIATELY with the fire-and-forget ack (the teacher's turn
 *      CONTINUES — no turn break at the call), a job record exists, and the
 *      test runner (fake deliver) produces the steer
 *   4. runner completion: a fake researcher model (web_search call → final
 *      text brief, globalThis.fetch stubbed) → the job stores the result,
 *      the steer carries the brief + sources, the fake deliver flips the
 *      job done
 *   5. runner failure: a model that throws → the failure steer still fires
 *      (the teacher learns the outcome) and the job lands error
 *   6. the wake pipeline (src/server/jobs.ts): server-side steer delivery —
 *      happy path (fires the injected turn runner, flips the job), pending-
 *      quiz deferral, 409 retry, idempotent redelivery
 *
 * Cleanup follows tests/chat-flow.test.ts: created chat/job files removed in
 * finally blocks / the after() hook.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import {
	accumulateJobUsage,
	buildAbortSteer,
	buildSubagentSteer,
	isSubagentFailure,
	steerDelivered,
	type DemoResult,
	type JobUsage,
	type PdfResult,
	type ResearchResult,
	type SubagentArtifactData,
	type SteerMessage,
	type VisualResult,
	buildProbeHandoffSteer,
} from "../src/core/contracts.ts";
import { composeInstructions, createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { createTeacherTools } from "../src/agent/tools.ts";
import { webTools } from "../src/agent/tools/web.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import {
	abortJob,
	deliverJobResult,
	noteSteersDurable,
	discardChatDeliveries,
	reconcileUserSteers,
	recoverStaleJobs,
	registerLiveAgent,
	setJobRespawn,
	setTurnRunner as setRawTurnRunner,
	type TurnRunner,
	settleSteers,
	steerLiveChat,
	unregisterLiveAgent,
} from "../src/server/jobs.ts";
import { isJobLive, registerJobAbort, unregisterJobAbort } from "../src/agent/subagents/aborts.ts";
import { beginTurn, endTurn, isTurnRunning } from "../src/server/turn-liveness.ts";
import { persistTurn } from "../src/server/turn-service.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { createJobRunner, pdfModelOverride, researchModelOverride } from "../src/agent/subagents/runner.ts";
import { providerKeyMissing, type ModelSlotName } from "../src/core/settings.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { SearchProvider } from "../src/core/search.ts";
import { PATHS } from "../config.ts";
import { projectView as projectNative } from "../src/core/view.ts";
import { subscribe } from "../src/core/events.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { SteerInput, TurnInput } from "../src/core/input-events.ts";

const JOBS_DIR = path.join(PATHS.data, "jobs");

const createdChats: string[] = [];

// The key-presence turn gate (provider-key interlude, 2026-09-25): scripted
// turns pin openrouter per chat — the gate reads env-first truth, so the
// key must be present in the test process like any real setup.
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";
const createdJobs: string[] = [];

function trackChat(id: string) {
	createdChats.push(id);
}

/** Wave B native fixture: user text + an assistant tool call + its ack —
 *  the record is agent history; the runner's transcript scan (input
 *  resolution) reads it through the projection. */
function nativeToolMessages(text: string, tool: string, toolCallId: string, input: unknown): LhMessage[] {
	return [
		{ id: "u1", role: "user", content: text, timestamp: 1 } as never,
		{
			id: "a1",
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: tool, arguments: input as never }],
			api: "openai-completions",
			provider: "openrouter",
			model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			stopReason: "toolUse",
			timestamp: 1,
		} as never,
		{
			id: "r1",
			role: "toolResult",
			toolCallId,
			toolName: tool,
			content: [{ type: "text", text: "Dispatched." }],
			details: "Dispatched.",
			isError: false,
			timestamp: 1,
		} as never,
	];
}

function trackJob(id: string) {
	createdJobs.push(id);
}

/* THE HERMETICITY FENCE (owner round 7, 2026-10-05): the jobs seams are
 * MODULE-GLOBAL (setJobRespawn / setTurnRunner / the abort registry) and
 * the sweep scans EVERY job in the store. An async test that times out
 * under full-suite load leaves a "running" record and a late wake behind
 * — and that stray state then poisons the NEXT test (a foreign respawn
 * lands in its counter; a foreign orphan in its sweep). Under isolation
 * nothing ever times out, which is why the file passes alone and flaked
 * in the full run. The fence makes every test's start state identical:
 * all tracked jobs settled, aborts unregistered, seams inert. */
afterEach(() => {
	for (const id of createdJobs) {
		try {
			const job = jobStore.getJob(id);
			if (job && job.status === "running") {
				jobStore.updateJob(id, { status: "done", activity: "settled (fence)" });
			}
			if (job?.delivery?.status === "pending") jobStore.updateJob(id, { delivery: { ...job.delivery, status: "delivered" } });
			unregisterJobAbort(id);
		} catch {
			/* already gone */
		}
	}
	for (const chatId of createdChats) discardChatDeliveries(chatId);
	// Late wakes from a prior test must be inert: a no-op respawn can't
	// increment anyone's counter, a no-op runner can't spawn real work.
	setJobRespawn(() => {});
	setTurnRunner(async () => 200);
});

after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
	for (const id of createdJobs) {
		try {
			fs.unlinkSync(path.join(JOBS_DIR, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
	researchModelOverride.current = undefined;
});

/** A scripted pi engine (faux provider): the response queue replaces the
 *  old doStream/doGenerate turn counters. tokenSize is set so every test
 *  string streams as ONE delta — the SSE-body assertions ("Back with the
 *  brief.") read contiguous text. */
function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** A scripted response factory whose model call never resolves until its
 *  abort signal fires (a cancelled provider request); an already-aborted
 *  signal resolves at once — the faux stream then ends the message aborted. */
function abortableFactory(): FauxResponseStep {
	const factory = (_context: unknown, options: { signal?: AbortSignal } | undefined) =>
		new Promise<AssistantMessage>((resolve) => {
			const sig = options?.signal;
			if (sig?.aborted) {
				resolve(fauxAssistantMessage("late"));
				return;
			}
			sig?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
		});
	return factory as unknown as FauxResponseStep;
}

async function drain(res: Response): Promise<string> {
	if (res.status !== 200) {
		assert.fail(`expected 200, got ${res.status}: ${await res.text()}`);
	}
	return res.text();
}

/** CONNECTION DIET B (owner, 2026-10-10): the POST acks and closes; drain
 *  the turn's wire through the reattach stream instead. */
async function drainTurn(req: Request, factory: Parameters<typeof handleChatRequest>[1]): Promise<string> {
	const cloned = req.clone();
	const ack = await handleChatRequest(req, factory);
	if (ack.status !== 200) {
		assert.fail(`expected 200 ack, got ${ack.status}: ${await ack.text()}`);
	}
	const { chatId } = (await cloned.json()) as { chatId: string };
	const handle = runningTurn(chatId);
	if (!handle) return ""; // the turn settled inside the handler — completion already happened
	return new Response(handle.subscribe()).text();
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		// Wave B: the input-events contract — one explicit event, never a
		// client transcript.
		body: JSON.stringify({ chatId, input }),
	});
}

/* 30s budget (owner round, 2026-10-05): under the FULL suite's parallel
 * load the event loop starves and an 8s wall-clock budget expired before
 * healthy conditions were ever observed — and a timed-out delivery leaked
 * a late wake into the NEXT test (the respawn hook is module-global),
 * poisoning even synchronous neighbors. waitFor returns the instant the
 * condition holds, so the generous budget costs nothing when healthy. */
function waitFor(cond: () => boolean, timeoutMs = 30_000, what = "condition"): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
			setTimeout(tick, 25);
		};
		tick();
	});
}

// ─── 1. job store CRUD ───────────────────────────────────────────────────────

describe("job store", () => {
	it("create → get → update → list round-trips", () => {
		const job = jobStore.createJob({ kind: "research", chatId: "chat_storetest", toolCallId: "call-store" });
		trackJob(job.id);

		assert.match(job.id, /^job_/);
		assert.equal(job.status, "running");
		assert.equal(job.activity, "starting");

		const loaded = jobStore.getJob(job.id)!;
		assert.equal(loaded.toolCallId, "call-store");
		assert.equal(loaded.kind, "research");

		const updated = jobStore.updateJob(job.id, { activity: 'web_search: "test"', status: "done", result: { brief: "b" } })!;
		assert.equal(updated.activity, 'web_search: "test"');
		assert.equal(updated.status, "done");
		assert.ok(updated.updatedAt >= job.updatedAt);
		// immutable identity fields survive a patch
		assert.equal(updated.toolCallId, "call-store");
		assert.equal(jobStore.getJob(updated.id)!.toolCallId, "call-store");

		const listed = jobStore.listJobs("chat_storetest");
		assert.ok(listed.some((j) => j.id === job.id));
		assert.equal(jobStore.listJobs("chat_other").some((j) => j.id === job.id), false, "jobs are scoped to their chat");

		const byTool = jobStore.findJobByToolCallId("chat_storetest", "call-store");
		assert.equal(byTool?.id, job.id);
		assert.equal(jobStore.findJobByToolCallId("chat_storetest", "call-missing"), null);
	});

	// ── push-architecture S4 (2026-10-02): every WRITE announces on the
	// events channel (notify-after-write); reads stay silent ──
	it("every mutation emits jobs-changed {chatId}; reads emit nothing", () => {
		const got: { chatId?: string }[] = [];
		const off = subscribe((e) => {
			if (e.type === "jobs-changed") got.push({ chatId: e.chatId });
		});
		const job = jobStore.createJob({ kind: "research", chatId: "chat_storeemit", toolCallId: "call-emit" });
		trackJob(job.id);
		assert.deepEqual(got, [{ chatId: "chat_storeemit" }], "createJob announces after the write");
		got.length = 0;

		jobStore.updateJob(job.id, { activity: "still working" });
		assert.deepEqual(got, [{ chatId: "chat_storeemit" }], "updateJob announces on EVERY write — progress lines included");
		got.length = 0;

		jobStore.updateJob("job_missing", { activity: "noop" });
		assert.deepEqual(got, [], "a missing id wrote nothing — silent");

		jobStore.listJobs("chat_storeemit");
		jobStore.getJob(job.id);
		assert.deepEqual(got, [], "reads are silent");

		jobStore.deleteJobsForChat("chat_storeemit");
		assert.deepEqual(got, [{ chatId: "chat_storeemit" }], "a real delete announces");
		got.length = 0;
		jobStore.deleteJobsForChat("chat_storeemit");
		assert.deepEqual(got, [], "a zero-file delete wrote nothing — silent");
		off();
	});
});

// ─── 2. steer helpers (pure) ─────────────────────────────────────────────────

describe("steer helpers (contracts.ts)", () => {
	const research: ResearchResult = { brief: "BRIEF", sources: [{ title: "s", url: "https://x.test" }] };
	const demo: DemoResult = { title: "T", html: "<html></html>", tested: true, notes: "ok" };
	const visual: VisualResult = { svg: "<svg/>", notes: "ok" };

	it("buildSubagentSteer: a native marker — brief on the model-facing content, artifact payload in details", () => {
		const job = { id: "job_x", kind: "research" as const, toolCallId: "call-x" };
		const steer = buildSubagentSteer(job, research);
		assert.equal(steer.id, "steer_job_x", "deterministic id per job — idempotent delivery");
		// Wave B: steers are LhMarkerMessage customs — role "custom", the
		// model reads `content`, the UI reads `details` (never model-visible).
		assert.equal(steer.role, "custom");
		assert.equal(steer.customType, "subagent-steer");
		assert.equal(steer.display, true);
		assert.ok(steer.content.includes("BRIEF"), "the model-facing text carries the brief");
		const data = steer.details as { jobId: string; kind: string; toolCallId: string; result: ResearchResult };
		assert.equal(data.jobId, "job_x");
		assert.equal(data.kind, "research");
		assert.equal(data.toolCallId, "call-x");
		assert.deepEqual(data.result, research);
	});

	it("accumulateJobUsage: sums per model call; fields NO call reported stay undefined (absent is not zero)", () => {
		let total: JobUsage | undefined = undefined;
		total = accumulateJobUsage(total, "z-ai/glm-5.3-flash", {
			inputTokens: 10,
			outputTokens: 5,
			inputTokenDetails: { cacheReadTokens: 4 },
		});
		assert.deepEqual(total, {
			model: "z-ai/glm-5.3-flash",
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 4,
			cacheWriteTokens: undefined,
			reasoningTokens: undefined,
			cacheWrite1hTokens: undefined,
			calls: [{ inputTokens: 10, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: undefined, cacheWrite1hTokens: undefined, reasoningTokens: undefined }],
			steps: 1,
			lastStep: {
				cacheWrite1hTokens: undefined,
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: 4,
				cacheWriteTokens: undefined,
				reasoningTokens: undefined,
			},
		}, "lastStep is the most recent call's accounting, not cumulative");
		// a later call that reports nothing new keeps reported fields summing
		// (unreported contributes 0) and bumps the billing step count.
		total = accumulateJobUsage(total, "z-ai/glm-5.3-flash", { inputTokens: 20, outputTokens: 0 });
		assert.equal(total.inputTokens, 30);
		assert.equal(total.outputTokens, 5);
		assert.equal(total.cacheReadTokens, 4, "unreported after reported contributes 0");
		assert.equal(total.cacheWriteTokens, undefined, "never reported stays absent — never zero");
		assert.equal(total.reasoningTokens, undefined);
		assert.equal(total.steps, 2, "one step per model call, reported or not");
		assert.equal(total.calls?.length, 2);
		assert.deepEqual(total.lastStep, {
			cacheWrite1hTokens: undefined,
			inputTokens: 20,
			outputTokens: 0,
			cacheReadTokens: undefined,
			cacheWriteTokens: undefined,
			reasoningTokens: undefined,
		}, "lastStep always mirrors the LATEST call, never the sums");
	});

	it("buildAbortSteer: a subagent-abort marker — teacher-facing text on content, the abort payload in details", () => {
		const steer = buildAbortSteer({ id: "job_c", kind: "demo", toolCallId: "call-c" });
		assert.equal(steer.id, "steer_job_c", "same id space — steerDelivered treats either as delivered");
		assert.equal(steer.role, "custom");
		assert.equal(steer.customType, "subagent-abort");
		assert.ok(/aborted/.test(steer.content), "the teacher-facing text names the abort");
		// The marker's customType is the message type: the UI renders the
		// abort badge off the projection (demos.test.tsx pins the card).
		assert.deepEqual(steer.details, { jobId: "job_c", kind: "demo", toolCallId: "call-c", aborted: true });
	});

	it("isSubagentFailure: failure shapes only (empty html/svg, failure brief)", () => {
		assert.equal(isSubagentFailure("research", research), false);
		assert.equal(isSubagentFailure("research", { brief: "Research failed: x", sources: [] }), true);
		// a brief with sources is a success even if the text mentions failure
		assert.equal(isSubagentFailure("research", { brief: "Research failed: x", sources: [{ title: "s", url: "https://x" }] }), false);
		assert.equal(isSubagentFailure("demo", demo), false);
		assert.equal(isSubagentFailure("demo", { ...demo, html: "" }), true);
		assert.equal(isSubagentFailure("visual", visual), false);
		assert.equal(isSubagentFailure("visual", { ...visual, svg: "" }), true);
	});

	it("steerDelivered: matches on the deterministic steer id (any steer kind)", () => {
		const steer = buildSubagentSteer({ id: "job_y", kind: "demo", toolCallId: "c" }, demo);
		assert.equal(steer.id, "steer_job_y");
		assert.equal(steerDelivered([], steer.id), false);
		assert.equal(steerDelivered([steer], steer.id), true);
		assert.equal(steerDelivered([steer], "steer_job_z"), false);
		// the probe handoff shares the id-space contract
		const handoff = buildProbeHandoffSteer("chat_q");
		assert.equal(handoff.id, "steer_probe_chat_q");
		assert.equal(steerDelivered([handoff], handoff.id), true);
		assert.equal(steerDelivered([steer], handoff.id), false);
	});

	it("failure steers tell the teacher how to recover (research/demo/visual wording)", () => {
		const failResearch = buildSubagentSteer({ id: "j1", kind: "research", toolCallId: "c" }, { brief: "Research failed: API down", sources: [] });
		const failDemo = buildSubagentSteer({ id: "j2", kind: "demo", toolCallId: "c" }, { title: "T", html: "", tested: true, notes: "FAILED: boom" });
		const failVisual = buildSubagentSteer({ id: "j3", kind: "visual", toolCallId: "c" }, { svg: "", notes: "FAILED: boom" });
		for (const steer of [failResearch, failDemo, failVisual]) {
			assert.ok(!steer.content.includes("rendered in the lesson"), "failure text never claims the artifact landed");
		}
		assert.ok(failResearch.content.includes("flag the uncertainty"));
	});

	it("pdf steers (sources v0): brief + page citations on success, PDF failed: shape on failure, abort wording per kind", () => {
		const pdf: PdfResult = { path: "/tmp/doc.pdf", question: "q?", brief: "The formula is on p. 2.", pagesRead: [2], pagesConsulted: [1, 2] };
		const ok = buildSubagentSteer({ id: "jp", kind: "pdf", toolCallId: "cp" }, pdf);
		assert.ok(ok.content.includes("page citations"), "the teacher is told to cite pages");
		assert.ok(ok.content.includes("The formula is on p. 2."));
		assert.equal((ok.details as { kind: string }).kind, "pdf");
		assert.deepEqual((ok.details as { result: unknown }).result, pdf);
		// failure shape mirrors research
		assert.equal(isSubagentFailure("pdf", pdf), false);
		assert.equal(isSubagentFailure("pdf", { ...pdf, brief: "PDF failed: unreadable" }), true);
		const fail = buildSubagentSteer({ id: "jf", kind: "pdf", toolCallId: "cf" }, { ...pdf, brief: "PDF failed: unreadable" });
		assert.ok(fail.content.includes("flag the gap"));
		// abort wording names the PDF job
		const aborted = buildAbortSteer({ id: "ja", kind: "pdf", toolCallId: "ca" });
		assert.ok(aborted.content.includes("PDF reading job"));
	});
});

// ─── fake deliver (the wake pipeline's stand-in for runner tests) ───────────

/**
 * A fake deliver seam: capture the steer and mimic the pipeline's final
 * status flip (done/error by isSubagentFailure) so the job record reads
 * exactly as it will in production after the wake turn completes.
 */
function fakeDeliver() {
	const steers: SteerMessage[] = [];
	return {
		steers,
		deliver: async (steer: SteerMessage) => {
			steers.push(steer);
			const job = jobStore.getJob((steer.details as { jobId: string }).jobId)!;
			chatStore.saveMessages(job.chatId, [...chatStore.getChat(job.chatId)!.messages, steer]);
			noteSteersDurable(job.chatId, [steer]);
		},
	};
}

/** Fake wakes model canonical input acceptance, not just HTTP acknowledgement. */
function setTurnRunner(run: TurnRunner): void {
	setRawTurnRunner(async (chatId, input) => {
		const status = await run(chatId, input);
		if (status === 200 && input.type === "steers") {
			const record = chatStore.getChat(chatId);
			if (record) chatStore.saveMessages(chatId, [...record.messages, ...input.steers.filter((s) => !steerDelivered(record.messages, s.id))]);
		}
		return status;
	});
}

// ─── 3. dispatch: the tool call acks mid-turn and spawns ─────────────────────

const RESEARCH_INPUT = {
	question: "What is the latest stable sigma.js version?",
	context: "Choosing a graph rendering library for the lesson.",
};

/** A teacher that calls research (text → call), then plain text thereafter. */
function researchCallingTeacher(): PiEngine {
	return fauxEngine([
		fauxAssistantMessage(
			[fauxText("Let me check the current state of the library."), fauxToolCall("research", RESEARCH_INPUT, { id: "call-r1" })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxText("Back with the brief.")]),
	]);
}

describe("dispatch (async protocol §2)", () => {
	it("the research call resolves immediately with an ack; the turn continues and the runner steers", async () => {
		const chat = chatStore.createChat("Test: research dispatch");
		trackChat(chat.id);
		// BYOK turn gate (owner, 2026-09-22): the scripted chat needs a
		// conversation model — the per-chat pin, exactly like the setup flow.
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });

		const delivery = fakeDeliver();
		const search = stubSearch();
		const testRunner = createJobRunner({ chatStore, jobStore, deliver: delivery.deliver, searchProvider: () => search });
		const engine = researchCallingTeacher();
		const tools = createTeacherTools({
			chatId: chat.id,
			chatStore,
			jobStore,
			spawn: (job, input) => void testRunner.runJob(job.id, input),
		});
		// The handler hands the factory the native build options — the
		// record IS the agent state (Wave B: no adapter conversion).
		const agent: Parameters<typeof handleChatRequest>[1] = (opts) =>
			createTeacherAgent(undefined, { engine, tools, messages: opts.messages });

		researchModelOverride.current = researcherModel();
		const body = await drainTurn(post(chat.id, { type: "text", text: "teach me graph rendering" }), agent);

		// The teacher's SAME turn carried on past the tool call.
		assert.ok(body.includes("Back with the brief."), "the turn continued after the dispatch");

		const saved = projectNative(chatStore.getChat(chat.id)!.messages);
		const part = saved[1]!.parts.find((p) => p.type === "tool-research");
		assert.ok(part && part.type === "tool-research", "research tool part persisted");
		assert.equal(part.state, "output-available", "the part resolved at dispatch time (not held pending)");
		assert.equal(typeof (part as { output?: unknown }).output, "string", "the output is the ack, not the result");
		assert.match(String((part as { output?: unknown }).output), /fire-and-forget/);

		// The job record exists and the background runner completed it.
		const job = jobStore.findJobByToolCallId(chat.id, "call-r1");
		assert.ok(job, "dispatch created a job record");
		trackJob(job!.id);
		await waitFor(() => jobStore.getJob(job!.id)!.status !== "running", 8000, "research job completion");

		const done = jobStore.getJob(job!.id)!;
		assert.equal(done.status, "done");
		assert.equal(done.activity, "finished");

		// The steer carries the brief on its model-facing content; the
		// artifact payload rides details for the (UI) renderer.
		assert.equal(delivery.steers.length, 1, "exactly one steer — one job, one result");
		const steer = delivery.steers[0]!;
		assert.equal((steer.details as { jobId: string }).jobId, job!.id);
		assert.ok(steer.content.includes("sigma.js v3 is current"), "steer text carries the brief");

		// Search threading (2026-09-20): the researcher's web_search ran on
		// the INJECTED port — the stub saw the scripted query, no network.
		assert.deepEqual(search.queries, ["sigma.js latest version (5)"]);
		researchModelOverride.current = undefined;
	});
});

// ─── the researcher loop with a fake model + stubbed fetch ──────────────────

const BRIEF = `## Summary
sigma.js v3 is current.

## Findings
1. **v3 is the latest major.** [sigma.js docs](https://www.sigmajs.org/docs)

## Sources
- sigma.js docs (https://www.sigmajs.org/docs)`;

/** The researcher loop's scripted engine. Turn 1: a web_search tool call;
 *  turn 2: the final text brief. */
function researcherModel(): PiEngine {
	return fauxEngine([
		fauxAssistantMessage([fauxToolCall("web_search", { query: "sigma.js latest version" }, { id: "ws1" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxText(BRIEF)]),
	]);
}

/** A recording stub provider (search port wave, 2026-09-20): the runner's
 *  injected search seam — no network, queries captured for assertions. */
function stubSearch(): SearchProvider & { queries: string[] } {
	const queries: string[] = [];
	return {
		id: "tavily",
		async search(query: string, count: number) {
			queries.push(`${query} (${count})`);
			return [{ title: "sigma.js", url: "https://www.sigmajs.org/", snippet: "v3 released" }];
		},
		queries,
	};
}

describe("research runner (async protocol §3)", () => {
	it("runJob completes the job: result + sources on the job, brief on the steer, activity recorded", async () => {
		const chat = chatStore.createChat("Test: runner completion");
		trackChat(chat.id);

		// A dispatched research part in the stored chat (the input is also
		// what the runner falls back to on a crash-recovery re-spawn).
		chatStore.saveMessages(chat.id, nativeToolMessages("which sigma version?", "research", "call-run1", RESEARCH_INPUT));

		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-run1" });
		trackJob(job.id);

		const delivery = fakeDeliver();
		const search = stubSearch();
		const runner = createJobRunner({ chatStore, jobStore, deliver: delivery.deliver, searchProvider: () => search });
		researchModelOverride.current = researcherModel();
		try {
			await runner.runJob(job.id);
		} finally {
			researchModelOverride.current = undefined;
		}

		// The job is done, with the activity line from the tool call.
		const done = jobStore.getJob(job.id)!;
		assert.equal(done.status, "done");
		assert.equal(done.activity, "finished", "delivery does not own the worker status");
		const result = done.result as ResearchResult;
		assert.equal(result.brief, BRIEF);
		assert.ok(result.sources.length > 0, "sources parsed from the brief");
		assert.equal(result.sources[0]!.url, "https://www.sigmajs.org/docs");

				// The activity trail: the last recorded activity is the deliver
		// flip; the search line fired before it. The search itself ran on
		// the INJECTED port — the stub saw the query (no network):
		assert.deepEqual(search.queries, ["sigma.js latest version (5)"]);
	});

	it("a keyless fetch-only researcher still completes and delivers a sourced job result", async () => {
		const url = "https://example.com/supplied-source";
		const brief = `## Summary\nVerified supplied source. [Source](${url})\n\n## Sources\n- Source (${url})`;
		const input = { question: `Verify ${url}` };
		const chat = chatStore.createChat("Test: keyless fetch-only research");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, nativeToolMessages("verify supplied URL", "research", "call-keyless", input));
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-keyless" });
		trackJob(job.id);
		const delivery = fakeDeliver();
		const runner = createJobRunner({ chatStore, jobStore, deliver: delivery.deliver, searchProvider: () => null });
		const fetched: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (source) => {
			fetched.push(String(source));
			assert.equal(String(source), url);
			return new Response("Synthetic verified source content", { headers: { "content-type": "text/plain" } });
		}) as typeof fetch;
		researchModelOverride.current = fauxEngine([
			fauxAssistantMessage([fauxToolCall("web_fetch", { url }, { id: "keyless-fetch" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText(brief)]),
		]);
		try {
			await runner.runJob(job.id);
		} finally {
			researchModelOverride.current = undefined;
			globalThis.fetch = realFetch;
		}
		assert.deepEqual(fetched, [url]);
		const done = jobStore.getJob(job.id)!;
		assert.equal(done.status, "done");
		assert.equal((done.result as ResearchResult).brief, brief);
		assert.ok((done.result as ResearchResult).sources.some((s) => s.url === url));
		assert.equal(delivery.steers.length, 1);
		assert.equal(isSubagentFailure("research", done.result as ResearchResult), false);
	});

	it("a failing runner still steers (the teacher learns the outcome) and the job lands error", async () => {
		const chat = chatStore.createChat("Test: runner failure");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, nativeToolMessages("hi", "research", "call-err1", RESEARCH_INPUT));

		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-err1" });
		trackJob(job.id);

		const delivery = fakeDeliver();
		const runner = createJobRunner({ chatStore, jobStore, deliver: delivery.deliver });
		researchModelOverride.current = fauxEngine([
			() => {
				throw new Error("model exploded");
			},
		]);
		try {
			await runner.runJob(job.id);
		} finally {
			researchModelOverride.current = undefined;
		}

		const errored = jobStore.getJob(job.id)!;
		assert.equal(errored.status, "error");
		assert.match(errored.error ?? "", /model exploded/);

		const steer = delivery.steers[0]!;
		assert.ok(steer, "failure still delivers a steer");
		assert.ok(steer.content.includes("Research failed: model exploded"), "failure brief on the steer text");
		assert.deepEqual(((steer.details as { result: ResearchResult }).result).sources, []);
	});

	it("runJob resolves the input from the transcript when dispatch-time input is absent (crash recovery)", async () => {
		const chat = chatStore.createChat("Test: transcript input fallback");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, nativeToolMessages("go", "research", "call-fb1", RESEARCH_INPUT));
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-fb1" });
		trackJob(job.id);

		const delivery = fakeDeliver();
		const runner = createJobRunner({
			chatStore,
			jobStore,
			deliver: delivery.deliver,
			searchProvider: () => stubSearch(),
		});
		researchModelOverride.current = researcherModel();
		try {
			// no input passed — as a recovery re-spawn would call it
			await runner.runJob(job.id);
		} finally {
			researchModelOverride.current = undefined;
		}

		const done = jobStore.getJob(job.id)!;
		assert.equal(done.status, "done", "the researcher ran from the transcript-resolved input");
		assert.equal((done.result as ResearchResult).brief, BRIEF);
	});
});

// ─── the researcher agent construction (model resolution seam) ──────────────


describe("pdf runner (sources v0)", () => {
	const PDF_FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");
	const PDF_INPUT = { path: PDF_FIXTURE, question: "What is the integral of x dx?" };
	const relativePath = path.join("Course notes", "sample document.pdf");
	let home: string;
	const originalHome = process.env.HOME;
	const originalUserProfile = process.env.USERPROFILE;

	before(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pdf-job-home-"));
		const target = path.join(home, relativePath);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.copyFileSync(PDF_FIXTURE, target);
		process.env.HOME = home;
		process.env.USERPROFILE = home;
	});

	after(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		fs.rmSync(home, { recursive: true, force: true });
	});

	/** A pdf-reader that triages, extracts pages 1-2, then briefs. */
	function pdfReaderModel(): PiEngine {
		return fauxEngine([
			fauxAssistantMessage([fauxToolCall("pdf_info", {}, { id: "i1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "1-2" }, { id: "e1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The integral rule appears on page 1 (p. 1): x dx integrates to x^2/2.")]),
		]);
	}

	it("runJob completes a pdf job: brief + pagesConsulted land on the record, citation steer delivered", async () => {
		const chat = chatStore.createChat("Test: pdf runner");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, nativeToolMessages("read this pdf", "pdf", "call-pdf1", PDF_INPUT));

		const job = jobStore.createJob({ kind: "pdf", chatId: chat.id, toolCallId: "call-pdf1" });
		trackJob(job.id);

		const delivery = fakeDeliver();
		const runner = createJobRunner({ chatStore, jobStore, deliver: delivery.deliver });
		pdfModelOverride.current = pdfReaderModel();
		try {
			await runner.runJob(job.id);
		} finally {
			pdfModelOverride.current = undefined;
		}

		const done = jobStore.getJob(job.id)!;
		assert.equal(done.status, "done");
		assert.equal(done.activity, "finished");
		const result = done.result as PdfResult;
		assert.equal(result.path, PDF_FIXTURE);
		assert.match(result.brief, /integral rule/);
		assert.deepEqual(result.pagesRead, [1, 2], "extracted pages are READ pages");
		assert.deepEqual(result.pagesConsulted, [1, 2]);

		assert.equal(delivery.steers.length, 1, "one job, one steer");
		const steer = delivery.steers[0]!;
		assert.equal((steer.details as { kind: string }).kind, "pdf");
		assert.ok(steer.content.includes("integral rule"), "steer text carries the brief");
	});

	for (const mode of ["dispatch", "recovery"] as const) {
		it(`resolves a home-relative PDF from ${mode} input without rewriting history`, async () => {
			const chat = chatStore.createChat(`Test: relative PDF ${mode}`);
			trackChat(chat.id);
			const toolCallId = `call-pdf-relative-${mode}`;
			const input = { ...PDF_INPUT, path: relativePath };
			const messages = nativeToolMessages("read this pdf", "pdf", toolCallId, input);
			const before = structuredClone(messages);
			chatStore.saveMessages(chat.id, messages);
			const job = jobStore.createJob({ kind: "pdf", chatId: chat.id, toolCallId });
			trackJob(job.id);
			const delivery = fakeDeliver();
			const runner = createJobRunner({ chatStore, jobStore, deliver: delivery.deliver });
			pdfModelOverride.current = pdfReaderModel();
			try {
				await runner.runJob(job.id, mode === "dispatch" ? input : undefined);
			} finally {
				pdfModelOverride.current = undefined;
			}

			// Worker completion is not the delivery barrier: wait for canonical
			// acceptance before asserting the history prefix and appended result.
			await waitFor(() => jobStore.getJob(job.id)?.delivery?.status === "delivered", 8000, "canonical PDF delivery acknowledgement");
			const done = jobStore.getJob(job.id)!;
			assert.equal(done.status, "done");
			assert.deepEqual(done.delivery, { kind: "result", status: "delivered" });
			const result = done.result as PdfResult;
			assert.equal(result.path, path.join(home, relativePath));
			assert.match(result.brief, /integral rule/);
			assert.deepEqual(result.pagesRead, [1, 2]);
			assert.deepEqual(result.pagesConsulted, [1, 2]);
			assert.equal(delivery.steers.length, 1);
			assert.equal(input.path, relativePath, "dispatch input remains relative");
			const persisted = chatStore.getChat(chat.id)!.messages;
			assert.deepEqual(persisted.slice(0, before.length), before, "original history and tool-call arguments remain as supplied");
			const steer = delivery.steers[0]!;
			assert.equal(steer.id, `steer_${job.id}`);
			assert.equal(steer.role, "custom");
			assert.equal(steer.customType, "subagent-steer");
			const details = steer.details as { jobId: string; kind: string; toolCallId: string; result: PdfResult };
			assert.equal(details.jobId, job.id);
			assert.equal(details.kind, "pdf");
			assert.equal(details.toolCallId, toolCallId);
			assert.deepEqual(details.result, result, "the canonical steer carries the resolved PDF result");
			assert.deepEqual(persisted.slice(before.length), [steer], "exactly one captured result is appended after the unchanged history");
		});
	}

	it("an unreadable source: the job lands error with the PDF failed: brief and the steer flags the gap", async () => {
		const chat = chatStore.createChat("Test: pdf runner failure");
		trackChat(chat.id);
		const badPath = path.join(import.meta.dirname, "fixtures", "not-a-pdf.txt");
		const job = jobStore.createJob({ kind: "pdf", chatId: chat.id, toolCallId: "call-pdf2" });
		trackJob(job.id);

		const delivery = fakeDeliver();
		const runner = createJobRunner({ chatStore, jobStore, deliver: delivery.deliver });
		pdfModelOverride.current = pdfReaderModel();
		try {
			await runner.runJob(job.id, { path: badPath, question: "anything" });
		} finally {
			pdfModelOverride.current = undefined;
		}

		const done = jobStore.getJob(job.id)!;
		assert.equal(done.status, "error", "the failure brief is a subagent failure");
		const result = done.result as PdfResult;
		assert.match(result.brief, /^PDF failed:/);
		assert.deepEqual(result.pagesRead, []);
		assert.deepEqual(result.pagesConsulted, []);

		const steer = delivery.steers[0]!;
		assert.ok(steer.content.includes("flag the gap"), "the teacher learns to flag the gap");
	});
});

describe("researcher agent", () => {
	it("runs with the web tool set (no network touched)", () => {
		// The researcher is a runSubagent call over the webTools registry —
		// the tool set is what the loop sees.
		assert.ok(webTools.web_search, "web_search available");
		assert.ok(webTools.web_fetch, "web_fetch available");
		assert.equal(Object.keys(webTools).length, 2, "ONLY the web tools — no question/plan tools");
		// reset any accidental global override
		researchModelOverride.current = undefined;
	});

	it("the pdf-reader declares exactly the four skill tools (sources v0)", async () => {
		const { createPdfTools } = await import("../src/agent/subagents/pdf-reader.ts");
		const tools = createPdfTools(path.join(import.meta.dirname, "fixtures", "sample-3page.pdf"));
		assert.deepEqual(Object.keys(tools).sort(), ["pdf_extract", "pdf_info", "pdf_render", "pdf_search"]);
		// reset any accidental global override
		pdfModelOverride.current = undefined;
	});
});

// ─── 6. the wake pipeline (server-side steer delivery) ────────────────────────

/**
 * Pipeline tests drive deliverJobResult with an injected fake turn runner
 * (setTurnRunner) — the real wiring (chat-handler's handleChatRequest
 * adapter) never fires here, so no teacher model is touched.
 *
 * Timing: the pump polls at 400ms with a 1.5s grace after the gates open —
 * each happy-path test takes ~2s; waitFor tolerates it.
 */
describe("wake pipeline (src/server/jobs.ts)", () => {
	/** A chat with a finished job ready for delivery. */
	function setup(kind: "research" | "demo" = "research"): { chatId: string; jobId: string; steer: SteerMessage } {
		const chat = chatStore.createChat("Test: wake pipeline");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, [{ id: "u1", role: "user", content: "hello", timestamp: 1 } as never]);

		const job = jobStore.createJob({ kind, chatId: chat.id, toolCallId: `call-${jobStore.listJobs(chat.id).length}` });
		trackJob(job.id);
		const result: ResearchResult = { brief: "Done: it works.", sources: [{ title: "s", url: "https://x.test" }] };
		jobStore.updateJob(job.id, { result, status: "done", activity: "finished", delivery: { kind: "result", status: "pending" } });
		const steer = buildSubagentSteer(job, result);
		return { chatId: chat.id, jobId: job.id, steer };
	}

	it("delivers a PROBE HANDOFF steer the same way — the teacher's wake turn", async () => {
		const chat = chatStore.createChat("Test: probe handoff wake");
		trackChat(chat.id);
		// The concluded probe: a persisted probe_done call + result (the
		// native seam the chat-handler's construction branch keys on) and no
		// open question.
		chatStore.saveMessages(chat.id, nativeToolMessages("teach me calc", "probe_done", "call-pd", { ok: true }));
		const handoff = buildProbeHandoffSteer(chat.id);
		let seen: { chatId: string; steers: SteerMessage[] } | undefined;
		setTurnRunner(async (cid, input) => {
			seen = { chatId: cid, steers: (input as SteerInput).steers as SteerMessage[] };
			return 200;
		});

		await deliverJobResult(handoff);
		await waitFor(() => seen !== undefined, 8000, "handoff wake fired");
		const firedHandoff = seen!;
		assert.equal(firedHandoff.chatId, chat.id);
		assert.equal(firedHandoff.steers.length, 1);
		assert.equal(firedHandoff.steers[0]!.id, `steer_probe_${chat.id}`, "the handoff IS the wake turn's input");
	});

	it("a redelivered handoff dedupes via the transcript (idempotent by steer id)", async () => {
		const chat = chatStore.createChat("Test: handoff idempotent");
		trackChat(chat.id);
		const handoff = buildProbeHandoffSteer(chat.id);
		// The transcript already carries the steer (a previous wake completed).
		chatStore.saveMessages(chat.id, [handoff as never]);
		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});

		await deliverJobResult(handoff);
		assert.equal(fired, 0, "already delivered — the pump resolves without firing a wake");
	});

	it("delivers: fires the turn runner with the record + steer, then flips the job done", async () => {
		const { chatId, jobId, steer } = setup();
		let seen: { chatId: string; steers: SteerMessage[] } | undefined;
		setTurnRunner(async (cid, input) => {
			seen = { chatId: cid, steers: (input as SteerInput).steers as SteerMessage[] };
			return 200;
		});

		await deliverJobResult(steer);
		await waitFor(() => jobStore.getJob(jobId)!.status !== "running", 8000, "job flip after delivery");

		assert.equal(jobStore.getJob(jobId)!.status, "done");
		assert.equal(jobStore.getJob(jobId)!.delivery?.status, "delivered");
		assert.ok(seen, "the turn runner fired");
		assert.equal(seen.chatId, chatId);
		assert.equal(seen.steers.length, 1);
		assert.equal(seen.steers[0]!.id, steer.id, "the steer IS the wake turn's input");
	});

	it("waits while a question part is pending, and fires once it clears", async () => {
		const { chatId, jobId, steer } = setup();
		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});

		// A dangling question call blocks the wake (the model would reject an
		// unanswered tool call — fork 1: the record ends at the call).
		chatStore.saveMessages(chatId, [
			{ id: "u1", role: "user", content: "hello", timestamp: 1 } as never,
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "quiz-call", name: "quiz", arguments: { question: "q", choices: ["a", "b"] } as never }],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
				timestamp: 1,
			} as never,
		]);

		// The delivery promise floats while the quiz blocks — awaiting it now
		// would deadlock the test (the pump defers until the gate opens).
		const delivery = deliverJobResult(steer);

		await delay(1200);
		assert.equal(fired, 0, "no wake while the quiz is pending");
		assert.equal(jobStore.getJob(jobId)!.status, "done", "worker is finished while delivery waits");
		assert.equal(jobStore.getJob(jobId)!.delivery?.status, "pending");

		// The learner answers: the real tool result clears the dangling call.
		const record = chatStore.getChat(chatId)!;
		chatStore.saveMessages(chatId, [
			...record.messages,
			{
				id: "r1",
				role: "toolResult",
				toolCallId: "quiz-call",
				toolName: "quiz",
				content: [{ type: "text", text: "answered" }],
				details: { answer: "a", correct: true, explanation: "" },
				isError: false,
				timestamp: 1,
			} as never,
		]);

		await waitFor(() => fired > 0, 8000, "wake after the quiz answer");
		await delivery; // now it resolves — the steer was delivered
		await waitFor(() => jobStore.getJob(jobId)!.status !== "running", 8000, "job flip after the deferred wake");
		assert.equal(jobStore.getJob(jobId)!.status, "done");
	});

	it("the dismissal pause holds deliveries — no wake until the user's next turn settles (A2)", async () => {
		const { chatId, jobId, steer } = setup();
		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});

		// The record ends in a DISMISSAL (owner design 2026-10-03): the
		// question was skipped via the silent route — no dangling call (the
		// quiz gate would pass), so ONLY the dismissal pause holds the wake.
		chatStore.saveMessages(chatId, [
			{ id: "u1", role: "user", content: "hello", timestamp: 1 } as never,
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "quiz-call", name: "quiz", arguments: { question: "q" } as never }],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
				timestamp: 1,
			} as never,
			{
				id: "r1",
				role: "toolResult",
				toolCallId: "quiz-call",
				toolName: "quiz",
				content: [{ type: "text", text: "skipped" }],
				details: { kind: "quiz", questionText: "q", dontKnow: false, answers: [], dismissed: true, answeredAt: "t" },
				isError: false,
				timestamp: 1,
			} as never,
		]);

		const delivery = deliverJobResult(steer);

		await delay(1200);
		assert.equal(fired, 0, "no wake while the session sits dismissal-paused");
		assert.equal(jobStore.getJob(jobId)!.delivery?.status, "pending", "the delivery holds (queued, not lost)");

		// The user's next message is the wake — its turn settles, and the
		// settlement re-pump lands the held delivery right after it.
		const record = chatStore.getChat(chatId)!;
		const afterUser = [...record.messages, { id: "u2", role: "user", content: "moving on", timestamp: 2 } as never];
		chatStore.saveMessages(chatId, afterUser);
		settleSteers(chatId, afterUser);

		await waitFor(() => fired > 0, 8000, "wake after the pause lifts");
		await delivery;
		await waitFor(() => jobStore.getJob(jobId)!.status !== "running", 8000, "job flip after the held wake");
		assert.equal(jobStore.getJob(jobId)!.status, "done");
	});

	it("retries with backoff on a 409 (a client turn raced in) and delivers on the retry", async () => {
		const { jobId, steer } = setup();
		let calls = 0;
		setTurnRunner(async () => {
			calls++;
			return calls === 1 ? 409 : 200;
		});

		await deliverJobResult(steer);
		assert.ok(calls >= 2, "409 was retried");
		await waitFor(() => jobStore.getJob(jobId)!.status !== "running", 8000, "job flip after the retry");
		assert.equal(jobStore.getJob(jobId)!.status, "done");
	});

	it("is idempotent: a steer already in the transcript flips the job without firing a turn", async () => {
		const { chatId, jobId, steer } = setup();
		// Simulate the crash window: the wake completed but the flip didn't.
		const record = chatStore.getChat(chatId)!;
		chatStore.saveMessages(chatId, [...record.messages, steer] as never);

		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});

		await deliverJobResult(steer);
		assert.equal(fired, 0, "no duplicate wake for an already-delivered steer");
		assert.equal(jobStore.getJob(jobId)!.status, "done", "the job still flips — recovery completes");
	});

// ─── continuation coalescing (the delivery-starvation fix) ───────────────────

describe("Wave C: live steering handoff + settlement reconciliation", () => {
	/** A minimal stand-in for pi's Agent — the pump touches only steer(). */
	function fakeAgent(): { handed: SteerMessage[]; agent: unknown } {
		const handed: SteerMessage[] = [];
		return { handed, agent: { steer: (m: SteerMessage) => handed.push(m) } };
	}

	it("hands queued markers to the LIVE run (pi steering queue) — no wake fires, the registry waits", async () => {
		const { chatId, jobId, steer } = setup();
		const { handed, agent } = fakeAgent();
		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});

		// A live turn is streaming (turn registry + live agent registered).
		assert.ok(beginTurn(chatId));
		registerLiveAgent(chatId, agent as never);

		const delivery = deliverJobResult(steer); // floats — resolves at settlement
		await waitFor(() => handed.length === 1, 8000, "marker handed to the live agent");
		await delay(1200);
		assert.equal(fired, 0, "no wake while the run is live");
		assert.equal(jobStore.getJob(jobId)!.status, "done", "worker finished before delivery");
		assert.equal(jobStore.getJob(jobId)!.delivery?.status, "pending");

		// Settlement: the run persisted the injected marker.
		unregisterLiveAgent(chatId);
		settleSteers(chatId, [steer as never]);
		await delivery;
		assert.equal(jobStore.getJob(jobId)!.status, "done", "delivery resolves at settlement");
		assert.equal(fired, 0, "never needed a wake");
		endTurn(chatId);
	});

	it("a handed marker the run never injected (stopper exit / missed poll) strands at settlement — the idle wake delivers it", async () => {
		const { chatId, jobId, steer } = setup();
		const { handed, agent } = fakeAgent();
		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});

		assert.ok(beginTurn(chatId));
		registerLiveAgent(chatId, agent as never);

		const delivery = deliverJobResult(steer);
		await waitFor(() => handed.length === 1, 8000, "handed");
		// The run settles WITHOUT the marker (question stopper exited before
		// the follow-up poll) — reconcile against the persisted truth.
		unregisterLiveAgent(chatId);
		settleSteers(chatId, []);
		endTurn(chatId);

		// The marker returned to pending — the pump's idle wake delivers it.
		await delivery;
		assert.equal(fired, 1, "the stranded marker rode the idle wake");
		assert.equal(jobStore.getJob(jobId)!.status, "done");
	});

	it("a probe-handoff NEVER rides a live run — it waits the turn out and wakes", async () => {
		const chat = chatStore.createChat("Test: handoff never live");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, nativeToolMessages("teach me calc", "probe_done", "call-pd", { ok: true }));
		const handoff = buildProbeHandoffSteer(chat.id);
		const { handed, agent } = fakeAgent();
		const fired: SteerMessage[][] = [];
		setTurnRunner(async (_cid, input) => {
			fired.push((input as SteerInput).steers as SteerMessage[]);
			return 200;
		});

		assert.ok(beginTurn(chat.id));
		registerLiveAgent(chat.id, agent as never);

		const delivery = deliverJobResult(handoff);
		await delay(1200);
		assert.equal(handed.length, 0, "the handoff was NOT handed to the live agent");
		assert.equal(fired.length, 0, "no wake while the prober's turn streams");

		// The prober's turn settles — now the handoff wakes the TEACHER.
		unregisterLiveAgent(chat.id);
		settleSteers(chat.id, []);
		endTurn(chat.id);
		await delivery;
		assert.equal(fired.length, 1);
		assert.equal(fired[0]![0]!.id, handoff.id, "the handoff rode the wake");
	});

	it("registerLiveAgent immediately steers pending markers into the NEW run (the parked-behind-quiz path)", async () => {
		const { chatId, jobId, steer } = setup();
		const { handed, agent } = fakeAgent();
		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});

		// A dangling question has the pump parked in waitForIdle: the
		// marker is pending but no live run exists to take it.
		chatStore.saveMessages(chatId, [
			...nativeToolMessages("teach me", "probe_done", "call-q", { ok: true }),
			{
				id: "a-q",
				role: "assistant",
				content: [{ type: "toolCall", id: "quiz-call", name: "quiz", arguments: { question: "q", choices: ["a", "b"] } as never }],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
				timestamp: 1,
			} as never,
		]);
		const delivery = deliverJobResult(steer);
		await delay(300); // let the pump park behind the dangling question
		assert.equal(handed.length, 0, "nothing to hand to — no live agent");

		// The learner answers: the handler registers the answer run's agent
		// BEFORE runPiTurn, so the marker is steered into it synchronously —
		// it rides the run's START steering poll (first LLM call).
		assert.ok(beginTurn(chatId));
		registerLiveAgent(chatId, agent as never);
		assert.equal(handed.length, 1, "registration itself steered the marker in");
		assert.equal(handed[0]!.id, steer.id);

		// The answer run persisted the marker — the parked pump's wake
		// re-check resolves it without ever firing a turn.
		unregisterLiveAgent(chatId);
		settleSteers(chatId, [steer as never]);
		endTurn(chatId);
		await delivery;
		assert.equal(fired, 0, "the parked wake never fired — the run delivered");
		assert.equal(jobStore.getJob(jobId)!.status, "done");
	});

	it("only a durable marker acknowledges delivery, independently of worker completion", () => {
		const { chatId, jobId, steer } = setup();
		assert.equal(jobStore.getJob(jobId)!.status, "done");
		assert.equal(jobStore.getJob(jobId)!.delivery?.status, "pending");
		chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, steer]);
		noteSteersDurable(chatId, [steer]);
		noteSteersDurable(chatId, [steer]);
		assert.equal(jobStore.getJob(jobId)!.delivery?.status, "delivered");
		assert.equal(jobStore.getJob(jobId)!.activity, "finished");
	});

	it("the idle wake carries EVERY pending marker in ONE turn", async () => {
		const { chatId, steer } = setup();
		const job2 = jobStore.createJob({ kind: "research", chatId, toolCallId: "call-2" });
		trackJob(job2.id);
		const result: ResearchResult = { brief: "Second result.", sources: [] };
		jobStore.updateJob(job2.id, { result });
		const steer2 = buildSubagentSteer(job2, result);

		const fired: SteerMessage[][] = [];
		setTurnRunner(async (_cid, input) => {
			fired.push((input as SteerInput).steers as SteerMessage[]);
			return 200;
		});

		await Promise.all([deliverJobResult(steer), deliverJobResult(steer2)]);
		assert.equal(fired.length, 1, "one wake for the whole queue");
		assert.equal(fired[0]!.length, 2, "both markers ride the same turn");
		const ids = fired[0]!.map((s) => s.id).sort();
		assert.deepEqual(ids, [steer.id, steer2.id].sort());
	});
});


	it("a failed start stays pending without changing the worker outcome", async () => {
		const { chatId, jobId, steer } = setup();
		let attempts = 0;
		setTurnRunner(async () => { attempts++; return 500; });
		const delivery = deliverJobResult(steer);
		await waitFor(() => attempts === 1, 8000, "failed start attempted");
		await delay(1000);
		assert.equal(attempts, 1, "no automatic retry loop");
		assert.equal(jobStore.getJob(jobId)!.status, "done");
		assert.equal(jobStore.getJob(jobId)!.error, undefined);
		assert.equal(jobStore.getJob(jobId)!.delivery?.status, "pending");
		const handed: SteerMessage[] = [];
		assert.ok(beginTurn(chatId));
		registerLiveAgent(chatId, { steer: (m: SteerMessage) => handed.push(m) } as never);
		assert.deepEqual(handed.map((m) => m.id), [steer.id]);
		unregisterLiveAgent(chatId);
		settleSteers(chatId, [steer]);
		endTurn(chatId);
		await delivery;
	});
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── persist id hygiene (the duplicate-empty-key bug) ────────────────────────

describe("persistTurn (native history, Wave B)", () => {
	it("stamps EMPTY ids (pi minted no id) at the canonical write and preserves existing ones", () => {
		const chat = chatStore.createChat("Test: persist stamps ids");
		trackChat(chat.id);
		const stamped = persistTurn(chatStore, chat.id, 0, [
			{ id: "", role: "user", content: "wake turn", timestamp: 1 } as never,
			{
				id: "msg_kept",
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
				timestamp: 1,
			} as never,
		], false);
		assert.notEqual(stamped[0]!.id, "", "empty id replaced");
		assert.match(stamped[0]!.id, /^msg_/);
		assert.equal(stamped[1]!.id, "msg_kept", "server-authored id untouched");
		const record = chatStore.getChat(chat.id)!;
		assert.equal(record.messages.length, 2, "both messages persisted");
		assert.ok(record.messages.every((m) => m.id && m.id.length > 0), "no empty ids survive persist");
	});

	it("baseCount slices the turn's own messages (the agent's state is append-only across turns)", () => {
		const chat = chatStore.createChat("Test: persist slices the turn tail");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, [
			{ id: "base_1", role: "user", content: "first", timestamp: 1 } as never,
		]);
		// The agent's state at onFinish: the base record + the turn's OWN new
		// messages (Wave B: onFinish receives the full native history — the
		// slice keeps persist append-only).
		const state = [
			{ id: "base_1", role: "user", content: "first", timestamp: 1 } as never,
			{
				id: "",
				role: "assistant",
				content: [{ type: "text", text: "wake turn" }],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
				timestamp: 1,
			} as never,
		];
		const stamped = persistTurn(chatStore, chat.id, 1, state, false);
		assert.equal(stamped.length, 1, "only the turn's new tail persists");
		const record = chatStore.getChat(chat.id)!;
		assert.equal(record.messages.length, 2, "the base record is untouched — append-only");
		assert.match(record.messages[1]!.id, /^msg_/);
	});

	it("drops clean question placeholders, keeps errored ones (fork 1: the record ends at the unanswered call)", () => {
		const chat = chatStore.createChat("Test: persist placeholder filtering");
		trackChat(chat.id);
		const stamped = persistTurn(chatStore, chat.id, 0, [
			{
				id: "",
				role: "assistant",
				content: [{ type: "toolCall", id: "q1", name: "quiz", arguments: { question: "q?" } as never }],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
				timestamp: 1,
			} as never,
			// The loop's synthetic "question posed" result — never a fact.
			{
				id: "",
				role: "toolResult",
				toolCallId: "q1",
				toolName: "quiz",
				content: [{ type: "text", text: "question posed" }],
				details: "question posed",
				isError: false,
				timestamp: 1,
			} as never,
			// An ERRORED authoring call DOES persist — the model's retry context.
			{
				id: "",
				role: "toolResult",
				toolCallId: "q1",
				toolName: "quiz",
				content: [{ type: "text", text: "bad options" }],
				details: "bad options",
				isError: true,
				timestamp: 1,
			} as never,
		], false);
		assert.equal(stamped.length, 2, "the clean placeholder is filtered, the errored result stays");
		const record = chatStore.getChat(chat.id)!;
		assert.equal(record.messages.length, 2);
		assert.equal((record.messages[1] as { isError: boolean }).isError, true);
	});
});

// ─── prompt composition hygiene (the README leak) ─────────────────────────────

describe("prompt composition", () => {
	it("loads ONLY numeric-prefix fragments — README.md never enters the system prompt", () => {
		const instructions = composeInstructions("teacher");
		assert.ok(!instructions.includes("Prompt fragments"), "README content must not leak");
		assert.ok(!instructions.includes("Rules for adding a fragment"), "README content must not leak (rules)");
		// every numeric fragment DOES compose, verbatim, after the base prompt
		const base = fs.readFileSync("src/agent/system-prompt.md", "utf-8").trim();
		assert.ok(instructions.startsWith(base), "base prompt first");
		for (const f of fs.readdirSync("src/agent/prompts").filter((f) => /^\d+-[\w.-]+\.md$/.test(f)).sort()) {
			const body = fs.readFileSync(`src/agent/prompts/${f}`, "utf-8").trim();
			assert.ok(instructions.includes(body), `fragment ${f} must compose verbatim`);
		}
	});

	it("the question principles compose into the teacher prompt; the probe's quick-measurement revision landed", () => {
		const teacher = composeInstructions("teacher");
		// the T2a doctrine fragment (user-locked wording 2026-09-15): verbatim presence
		for (const pin of [
			"Answerable by reasoning from the session",
			"Never just reciting your words back",
			"Prefer problems that apply the knowledge",
			"Catch confusion early, and make it nameable",
		]) {
			assert.ok(teacher.includes(pin), `teacher prompt lost the principle: ${pin}`);
		}
		// it loads in sorted fragment order: right after 20-teaching, before 30-jobs
		assert.ok(
			teacher.indexOf("Question principles") > teacher.indexOf("# Teach — one step at a time"),
			"principles sit after the teaching loop",
		);
		// the prober's doctrine: the "no rush" framing is gone, quick measurement in
		const prober = composeInstructions("prober");
		assert.ok(!prober.includes("There is no rush"), "the old no-rush framing is retired");
		assert.ok(
			prober.includes("every wasted question is resolution the final map doesn't get"),
			"the efficiency-is-resolution directive is in",
		);
		assert.ok(!prober.includes("Question principles"), "the teach-phase fragment never composes into the prober");
	});

	it("the predict-check cycle composes into the teacher; the craft chunk reaches BOTH agents (owner 2026-10-03)", () => {
		const teacher = composeInstructions("teacher");
		// the cycle doctrine (28-predictions.md) — teacher-only
		assert.ok(teacher.includes("predict → teach → check"), "the cycle line is in");
		assert.ok(teacher.includes('The prediction (`type: "predict"`)'), "the prediction role section is in");
		assert.ok(teacher.includes("Skip the prediction"), "the skip rule is in");
		assert.ok(teacher.includes('The check (`type: "check"`)'), "the check role section is in");
		// the craft + thinking channels (shared/20-question-tools.md) — BOTH agents
		const prober = composeInstructions("prober");
		for (const [name, prompt] of [
			["teacher", teacher],
			["prober", prober],
		] as const) {
			assert.ok(prompt.includes("asymmetry"), `${name} carries the option craft (moved out of tool descriptions)`);
			assert.ok(prompt.includes("TRANSCRIBED SPEECH"), `${name} reads dictated thinking leniently`);
			assert.ok(prompt.includes("thinkingWhileReading"), `${name} knows the reading channel`);
		}
		// the cycle is teach-phase doctrine — it never composes into the prober
		assert.ok(!prober.includes("predict → teach → check"), "the teaching cycle stays out of the prober");
	});

	it("the sources-v0 prompt lines compose: read/pdf doctrine in the teacher, the read line in the prober", () => {
		const teacher = composeInstructions("teacher");
		assert.ok(teacher.includes("Learner source files"), "the teacher carries the source-files section");
		assert.ok(teacher.includes("brief with page citations"), "the pdf brief's citation duty is stated");
		const prober = composeInstructions("prober");
		assert.ok(prober.includes("the `read` tool can inspect it directly"), "the prober knows it can read learner files");
	});

	it("the sources-v1 shared fragment composes into BOTH agents (find/ls/grep doctrine)", () => {
		for (const kind of ["teacher", "prober"] as const) {
			const instructions = composeInstructions(kind);
			assert.ok(instructions.includes("## Learner files"), `${kind} carries the shared learner-files fragment`);
			assert.ok(instructions.includes("find it yourself with `find`"), `${kind} knows to locate files itself`);
			assert.ok(instructions.includes("home directory"), `${kind} knows the home-anchored path rule`);
		}
		// the agent's OWN fragments compose before the shared appendix
		// (the reorder's order rule, 2026-09-27: job and method lead)
		const teacher = composeInstructions("teacher");
		assert.ok(
			teacher.indexOf("## Learner source files") < teacher.indexOf("## Learner files"),
			"the teacher's own 40-jobs section precedes the shared learner-files fragment",
		);
	});

	it("guards prompt size — no fragment can silently balloon (the README-leak class)", () => {
		// The wave-1 leak: README.md (815 bytes / ~200 tokens) rode into every
		// teacher turn until the numeric-prefix filter stopped it. This guard
		// catches the sibling failure mode — an accidental dump pasted into a
		// fragment. Thresholds: largest real fragment is 40-demos.md at ~3.2k
		// chars; 8k is generous headroom. Composed total ≤ 60k chars.
		for (const f of fs.readdirSync("src/agent/prompts").filter((f) => /^\d+-[\w.-]+\.md$/.test(f))) {
			const body = fs.readFileSync(`src/agent/prompts/${f}`, "utf-8").trim();
			assert.ok(body.length <= 8_000, `fragment ${f} is ${body.length} chars — over the 8k guard`);
		}
		assert.ok(composeInstructions("teacher").length <= 60_000, "composed system prompt over the 60k guard");
	});
});

// ─── abort (2026-09 semantics: real kill, cancelled status, teacher told) ───

describe("abort (src/server/jobs.ts abortJob)", () => {
	/** A hanging model whose call never resolves until its abort signal
	 *  fires — the real-kill path: the in-flight call itself is killed. */
	function hangingModel(): PiEngine {
		return fauxEngine([abortableFactory()]);
	}

	/** One step (billed) then a hang — proves usage-so-far survives the kill. */
	function oneStepThenHangModel(): PiEngine {
		return fauxEngine([
			fauxAssistantMessage([fauxToolCall("web_search", { query: "anything" }, { id: "ws1" })], {
				stopReason: "toolUse",
			}),
			abortableFactory(),
		]);
	}

	function newChatWithResearchJob(label: string, toolCallId: string): { chatId: string; jobId: string } {
		const chat = chatStore.createChat(`Test: ${label}`);
		trackChat(chat.id);
		// Native fixture — the record is agent history (Wave B).
		chatStore.saveMessages(chat.id, [
			{ id: "u1", role: "user", content: "hi", timestamp: 1 } as never,
			{
				id: "a1",
				role: "assistant",
				content: [
					{ type: "text", text: "Checking." },
					{ type: "toolCall", id: toolCallId, name: "research", arguments: RESEARCH_INPUT as never },
				],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
				timestamp: 1,
			} as never,
			{
				id: "r1",
				role: "toolResult",
				toolCallId,
				toolName: "research",
				content: [{ type: "text", text: "Dispatched." }],
				details: "Dispatched.",
				isError: false,
				timestamp: 1,
			} as never,
		]);
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId });
		trackJob(job.id);
		return { chatId: chat.id, jobId: job.id };
	}

	it("kills the running loop: error \"Aborted by learner\" immediately, loop unwinds silently, teacher gets the abort steer", async () => {
		const { jobId } = newChatWithResearchJob("abort running job", "call-abort1");
		const fired: SteerMessage[] = [];
		setTurnRunner(async (_cid, input) => {
			fired.push(...((input as SteerInput).steers as SteerMessage[]));
			return 200;
		});
		researchModelOverride.current = hangingModel();
		const runner = createJobRunner({
			chatStore,
			jobStore,
			deliver: async () => {
				throw new Error("a cancelled job must never deliver a result steer");
			},
		});
		try {
			const settled = runner.runJob(jobId, RESEARCH_INPUT);
			await waitFor(() => jobStore.getJob(jobId)!.activity === "researching", 8000, "loop started");

			const outcome = abortJob(jobId);
			assert.ok(outcome.ok);
			const killed = jobStore.getJob(jobId)!;
			assert.equal(killed.status, "error", "flipped synchronously — the poll sees it at once");
			assert.equal(killed.error, "Aborted by learner", "abort reads as an error with a reason, not a failure");
			assert.equal(killed.activity, "aborted");

			await settled; // unwinds — no hang
			assert.equal(jobStore.getJob(jobId)!.status, "error", "the runner never overwrites the flip");
			assert.equal(jobStore.getJob(jobId)!.error, "Aborted by learner");
			assert.equal(jobStore.getJob(jobId)!.result, undefined, "no result on an aborted job");

			await waitFor(() => fired.length > 0, 8000, "abort wake fired");
			const last = fired[0]!;
			assert.equal((last.details as { aborted: boolean }).aborted, true);
			assert.equal(last.id, `steer_${jobId}`);
			assert.equal(last.customType, "subagent-abort", "the abort marker — no artifact");
			// aborted is terminal: the wake completing must not flip it
			assert.equal(jobStore.getJob(jobId)!.status, "error", "terminal after the wake");
		} finally {
			researchModelOverride.current = undefined;
		}
	});

	it("the usage folded so far survives the kill (money channel outlives the abort)", async () => {
		const { jobId } = newChatWithResearchJob("abort keeps usage", "call-abort2");
		setTurnRunner(async () => 200);
		researchModelOverride.current = oneStepThenHangModel();
		const runner = createJobRunner({ chatStore, jobStore, deliver: async () => {}, searchProvider: () => stubSearch() });
		try {
			const settled = runner.runJob(jobId, RESEARCH_INPUT);
			await waitFor(() => (jobStore.getJob(jobId)!.usage?.steps ?? 0) === 1, 8000, "first step folded");
			abortJob(jobId);
			await settled;
			const job = jobStore.getJob(jobId)!;
			assert.equal(job.status, "error");
		assert.equal(job.error, "Aborted by learner");
			assert.equal(job.usage!.steps, 1, "usage-so-far persisted by the runner's finally");
			// model slots wave: the stamp is the ENGINE's actual model,
			// provider-qualified — the scripted faux engine here.
			assert.equal(job.usage!.model, "faux:faux-1");
			// faux estimates tokens from the prompt/response text — the
			// pinned fact is that the ONE completed step's spend survived.
			assert.ok(job.usage!.inputTokens! > 0, "input tokens billed");
			assert.ok(job.usage!.outputTokens! > 0, "output tokens billed");
		} finally {
			researchModelOverride.current = undefined;
		}
	});

	it("a finished worker with a queued result is no longer abortable", async () => {
		const chat = chatStore.createChat("Test: abort delivering job");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, [{ id: "u1", role: "user", content: "hello", timestamp: 1 } as never]);
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-abort3" });
		trackJob(job.id);
		const result: ResearchResult = { brief: "Done: it works.", sources: [{ title: "s", url: "https://x.test" }] };
		jobStore.updateJob(job.id, { result, status: "done", activity: "finished", delivery: { kind: "result", status: "pending" } });

		// Block the pump's idle gates so the result steer sits QUEUED, not in flight.
		assert.ok(beginTurn(chat.id));
		const fired: SteerMessage[] = [];
		setTurnRunner(async (_cid, input) => {
			fired.push(...((input as SteerInput).steers as SteerMessage[]));
			return 200;
		});
		void deliverJobResult(buildSubagentSteer(job, result)).catch(() => {
			/* dropped by the abort below */
		});
		assert.equal(jobStore.getJob(job.id)!.delivery?.status, "pending");

		const outcome = abortJob(job.id);
		assert.deepEqual(outcome, { ok: false, reason: "not_running" });
		assert.equal(jobStore.getJob(job.id)!.status, "done");
		assert.equal(jobStore.getJob(job.id)!.error, undefined);

		endTurn(chat.id); // gates open — whatever is left in the queue fires
		await waitFor(() => fired.length > 0, 8000, "wake fired");
		assert.equal(fired.length, 1, "exactly one result delivery");
		assert.equal(fired[0]!.customType, "subagent-steer");
		assert.equal(jobStore.getJob(job.id)!.status, "done");
	});

	it("outcome reasons: not_found for unknown, not_running for settled jobs", () => {
		assert.deepEqual(abortJob("job_does_not_exist"), { ok: false, reason: "not_found" });
		const chat = chatStore.createChat("Test: abort settled job");
		trackChat(chat.id);
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-abort4" });
		trackJob(job.id);
		jobStore.updateJob(job.id, { status: "done", activity: "delivered" });
		assert.deepEqual(abortJob(job.id), { ok: false, reason: "not_running" });
	});
});

// ─── 7. crash recovery, LIVENESS-GATED (observability-accuracy wave, 2026-09-19) ──
//
// The sweep (recoverStaleJobs) keys on the abort registry (subagents/aborts.ts
// isJobLive), not record age: a "running" record with a live registration
// belongs to a loop executing in THIS process (hung or slow — never re-run
// beside itself); without one it is a process-death orphan and recovers at
// once. The old 15-minute STALE_JOB_MS heuristic is gone — these tests prove
// immediacy by running the sweep on FRESH records.

describe("stale-job recovery sweep (liveness-gated)", () => {
	/** Reset the sweep's 30s throttle — tests fire it directly, repeatedly. */
	function resetSweepThrottle(): void {
		const g = globalThis as { __lhWakePipeline?: { lastSweepAt: number } };
		if (g.__lhWakePipeline) g.__lhWakePipeline.lastSweepAt = 0;
	}

	/** A FRESH "running" record (no loop registration): the orphan shape.
	 *  Freshness is the point — the old code needed 15 minutes of age. */
	function orphanJob(withResult?: ResearchResult): { chatId: string; jobId: string } {
		const chat = chatStore.createChat("Test: stale sweep");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, [{ id: "u1", role: "user", content: "hello", timestamp: 1 } as never]);
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: `call-sweep-${createdJobs.length}` });
		trackJob(job.id);
		if (withResult) jobStore.updateJob(job.id, { result: withResult, activity: "delivering result" });
		return { chatId: chat.id, jobId: job.id };
	}

	it("a running record with a LIVE loop registration is never recovered — however old (the double-run guard)", () => {
		const { jobId } = orphanJob();
		// Backdate the record well past every plausible in-flight run: age
		// alone must NOT trigger recovery anymore.
		jobStore.updateJob(jobId, { updatedAt: new Date(Date.now() - 30 * 60_000).toISOString() });
		registerJobAbort(jobId, new AbortController()); // a loop is executing
		// JURISDICTIONAL (owner round 8, 2026-10-05): the sweep scans the
		// SHARED jobs dir — under the full suite, OTHER FILES' processes
		// legitimately leave running records this sweep may respawn. Only
		// THIS test's job is this test's business: collect ids, assert ours
		// never respawns (the counter form saw foreign respawns as failures).
		const respawnedIds: string[] = [];
		setJobRespawn((id) => {
			respawnedIds.push(id);
		});
		resetSweepThrottle();
		recoverStaleJobs();
		assert.ok(!respawnedIds.includes(jobId), "a live loop is provably executing — no respawn beside it");
		assert.equal(jobStore.getJob(jobId)!.activity, "starting", "the record is untouched");
		// Hermetic teardown: settle + unregister so later sweeps in THIS suite
		// never see this fixture as a fresh orphan.
		jobStore.updateJob(jobId, { status: "done", activity: "settled (test)" });
		unregisterJobAbort(jobId);
	});

	it("a running record WITHOUT a registration is an orphan: the loop is re-spawned immediately (no age wait)", () => {
		const { jobId } = orphanJob();
		// JURISDICTIONAL (see above): foreign respawns may interleave under
		// the full suite — ours must be among them, at once.
		const respawnedIds: string[] = [];
		setJobRespawn((id) => {
			respawnedIds.push(id);
		});
		resetSweepThrottle();
		recoverStaleJobs();
		assert.ok(respawnedIds.includes(jobId), "the orphan's loop is re-spawned at once");
		assert.equal(jobStore.getJob(jobId)!.activity, "recovering: re-running");
		// Hermetic teardown (see above) — the respawned loop is the TEST's
		// fake seam, nothing real runs.
		jobStore.updateJob(jobId, { status: "done", activity: "settled (test)" });
	});

	it("an orphan WITH a stored result is re-delivered: the wake fires and the job flips done", async () => {
		const { jobId } = orphanJob({ brief: "Done: it works.", sources: [] });
		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});
		resetSweepThrottle();
		recoverStaleJobs();
		await waitFor(() => fired > 0, 8000, "recovery wake fired");
		await waitFor(() => jobStore.getJob(jobId)!.status !== "running", 8000, "orphan settled after re-delivery");
		assert.equal(jobStore.getJob(jobId)!.status, "done");
	});
});

// ─── BYOK: the unresolvable-engine refusal (owner, 2026-09-22) ──────────────

describe("BYOK job refusal (no factory floor)", () => {
	it("runJob with NO resolvable engine lands the job as error — the envelope wording, no phantom run", async () => {
		const chat = chatStore.createChat("Test: unconfigured spawn");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, nativeToolMessages("hi", "research", "call-nc1", RESEARCH_INPUT));

		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-nc1" });
		trackJob(job.id);

		const delivery = fakeDeliver();
		// NO test override, NO engineFor: the chain (override → slot → floor)
		// comes up empty — the runner must refuse honestly, not fall back.
		const runner = createJobRunner({ chatStore, jobStore, deliver: delivery.deliver });
		await runner.runJob(job.id);

		const done = jobStore.getJob(job.id)!;
		// The refusal lands through the SAME convention as every other
		// failed job (BYOK review fix, Teacher stream 2026-09-22): the kind's
		// failure result steers the teacher — a dispatched job is never
		// stranded waiting for a result that will never come — and
		// finalizeJob flips the record to error after the delivery.
		assert.equal(done.status, "error", "the job lands error, never a phantom run");
		assert.match(done.error ?? "", /No model configured/);
		assert.match(done.error ?? "", /missing: cheap/);
		assert.equal(delivery.steers.length, 1, "the refusal STEERED — the teacher is not stranded");
		assert.ok(
			delivery.steers[0]!.content.includes("Research failed: No model configured"),
			"the steer carries the kind's failure shape",
		);
		const result = done.result as ResearchResult;
		assert.equal(result.sources.length, 0, "the failure result matches the research convention");
	});
});

// ─── provider-key: the key-presence job refusal (owner, 2026-09-25) ─────────

describe("provider-key job refusal (key-presence interlude)", () => {
	it("an engine whose provider key is gone refuses the spawn — envelope wording, no phantom run", async () => {
		const chat = chatStore.createChat("Test: keyless spawn");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, nativeToolMessages("hi", "research", "call-km1", RESEARCH_INPUT));

		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-km1" });
		trackJob(job.id);

		const delivery = fakeDeliver();
		// The chain RESOLVES (an engine exists) — the KEY is what's missing.
		// The injected check is the server seam's stand-in: it sees the
		// engine's provider + the kind's slot tier, exactly as wired.
		const engine = fauxEngine([]);
		const seen: Array<[string, ModelSlotName]> = [];
		const runner = createJobRunner({
			chatStore,
			jobStore,
			deliver: delivery.deliver,
			engineFor: () => engine,
			providerKeyMissing: (provider, tier) => {
				seen.push([provider, tier]);
				return providerKeyMissing(provider, [tier]);
			},
		});
		await runner.runJob(job.id);

		// The refusal lands through the SAME convention as every failed job:
		// honest record, kind failure shape steered, terminal flip after.
		const done = jobStore.getJob(job.id)!;
		assert.equal(done.status, "error", "the job lands error, never a phantom run");
		assert.equal(done.error, providerKeyMissing(engine.model.provider, ["cheap"]).error, "the envelope's error line verbatim");
		assert.deepEqual(seen, [[engine.model.provider, "cheap"]], "the check saw the engine's provider + the researcher's tier");
		assert.equal(delivery.steers.length, 1, "the refusal STEERED — the teacher is not stranded");
		assert.ok(
			delivery.steers[0]!.content.includes(`Research failed: No ${engine.model.provider} key is set`),
			"the steer carries the kind's failure shape",
		);
		const result = done.result as ResearchResult;
		assert.equal(result.sources.length, 0, "the failure result matches the research convention");
	});
});

// ─── composer steering (owner arc 2026-10-03): the user-steer registry ──────

describe("composer steering: steerLiveChat + the deliver-or-requeue lifecycle", () => {
	/** A minimal stand-in for pi's Agent — only steer() is touched. */
	function fakeAgent(): { handed: unknown[]; agent: unknown } {
		const handed: unknown[] = [];
		return { handed, agent: { steer: (m: unknown) => handed.push(m) } };
	}

	it("no live turn → false, nothing parked (the client falls back to a plain send)", () => {
		const chatId = chatStore.createChat("steer: idle").id;
		const msg = { id: "steer_x1", role: "user", content: "hold on", timestamp: 1 };
		assert.equal(steerLiveChat(chatId, msg as never), false);
		const { handed, agent } = fakeAgent();
		registerLiveAgent(chatId, agent as never); // a later run hands NOTHING
		assert.equal(handed.length, 0, "nothing was parked by the refused steer");
		unregisterLiveAgent(chatId);
	});

	it("live agent → steered AND parked (the stranding safety net)", () => {
		const chatId = chatStore.createChat("steer: live").id;
		const msg = { id: "steer_x2", role: "user", content: "also cover Venus", timestamp: 1 };
		const { handed, agent } = fakeAgent();
		registerLiveAgent(chatId, agent as never);
		assert.equal(steerLiveChat(chatId, msg as never), true);
		assert.equal(handed.length, 1, "handed to the live agent's steering queue");
		// Re-registering the SAME agent never re-hands (double-handoff guard).
		registerLiveAgent(chatId, agent as never);
		assert.equal(handed.length, 1);
		unregisterLiveAgent(chatId);
	});

	it("settlement reconciliation: delivered ids drop, stranded ones ride the NEXT run", () => {
		const chatId = chatStore.createChat("steer: reconcile").id;
		const delivered = { id: "steer_d1", role: "user", content: "delivered", timestamp: 1 };
		const stranded = { id: "steer_s1", role: "user", content: "stranded behind a question", timestamp: 2 };
		const { handed, agent } = fakeAgent();
		registerLiveAgent(chatId, agent as never);
		assert.equal(steerLiveChat(chatId, delivered as never), true);
		assert.equal(steerLiveChat(chatId, stranded as never), true);

		// Settlement: the run persisted ONLY the delivered one (the stranded
		// copy died with the agent — question termination / abort).
		unregisterLiveAgent(chatId);
		reconcileUserSteers(chatId, [delivered] as never);

		// The chat's next run (the answer turn) picks up the stranded steer.
		const next = fakeAgent();
		registerLiveAgent(chatId, next.agent as never);
		assert.equal(next.handed.length, 1, "exactly the stranded steer rides the next run");
		assert.deepEqual((next.handed[0] as { id: string }).id, "steer_s1");
		unregisterLiveAgent(chatId);
		reconcileUserSteers(chatId, [stranded, delivered] as never); // cleanup
	});
});
