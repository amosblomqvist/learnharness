/**
 * Issue #8 composition fixture — ONE scenario per process.
 *
 * The scenario set cannot share a process: the settings record is one file
 * per data dir, the stale-job sweep throttles to one sweep per process, and
 * the composition singletons (jobRunner / wake wiring) initialise at import
 * time. The parent test (tests/subscription-composition.test.ts) spawns this
 * fixture with an isolated LH_DATA_DIR / LH_AUTH_FILE and asserts on the one
 * `EVIDENCE {...}` line printed here.
 *
 * What is REAL in this process: the chat-handler composition root (its
 * module-level jobRunner and the setJobRespawn / setTurnRunner wiring), the
 * job runner, the subscription service + engine, the pi SDK transport, the
 * chat/job/settings stores, and the recoverStaleJobs sweep (or, for the
 * "dispatch" mode, handleChatRequest's real agent + tool construction).
 * What is replaced: the network. globalThis.fetch allows exactly the known
 * Codex endpoint and throws on every other URL.
 *
 * Only the WAKE turn runner is replaced (async () => 200): no scenario here
 * asserts wake delivery, and a real wake would build a teacher turn on top of
 * the surface under test.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

if (!process.env.LH_DATA_DIR || !process.env.LH_AUTH_FILE) {
	throw new Error("Isolation paths are required (LH_DATA_DIR / LH_AUTH_FILE)");
}
// The parent test owns the environment (immutable from here): NODE_ENV=test
// keeps listJobs from sweeping on its own and lets hand-driven turns run.
assert.equal(process.env.NODE_ENV, "test", "the parent test must spawn this fixture with NODE_ENV=test");

const mode = process.argv[2] ?? "";
const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const RESEARCH_MARKER = "You are a research specialist";
const BRIEF = "## Summary\nSigma.js v3 is the current stable release for the lesson.";
const PROBER_TEXT = "Teacher continues after the dispatch.";

const print = (value: unknown) => console.log(`EVIDENCE ${JSON.stringify(value)}`);

// ─── transport stubs (SSE shapes verified against the real pi codex parser) ──

const jwt = (account: string) =>
	`e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
const grant = (account: string) => ({
	type: "oauth" as const,
	access: jwt(account),
	refresh: `refresh-${account}`,
	expires: Date.now() + 3600_000,
	accountId: account,
});

function sse(payloads: unknown[]): Response {
	const frames = payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("");
	return new Response(`${frames}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

const usage = { input_tokens: 11, output_tokens: 5, total_tokens: 16, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };

function textResponse(responseId: string, messageId: string, text: string): Response {
	const item = { id: messageId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] };
	return sse([
		{ type: "response.created", response: { id: responseId, status: "in_progress", output: [] } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
		{ type: "response.output_text.delta", output_index: 0, item_id: messageId, content_index: 0, delta: text },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: responseId, status: "completed", output: [item], usage } },
	]);
}

function researchCallResponse(responseId: string, callId: string, argumentsText: string): Response {
	const call = { id: `fc-${callId}`, type: "function_call", status: "completed", call_id: callId, name: "research", arguments: argumentsText };
	return sse([
		{ type: "response.created", response: { id: responseId, status: "in_progress", output: [] } },
		{ type: "response.output_item.added", output_index: 0, item: { ...call, status: "in_progress", arguments: "" } },
		{ type: "response.function_call_arguments.delta", output_index: 0, item_id: `fc-${callId}`, delta: argumentsText },
		{ type: "response.function_call_arguments.done", output_index: 0, item_id: `fc-${callId}`, arguments: argumentsText },
		{ type: "response.output_item.done", output_index: 0, item: call },
		{ type: "response.completed", response: { id: responseId, status: "completed", output: [call], usage } },
	]);
}

/** The decoded request body (the codex transport may compress it). */
async function bodyOf(init: RequestInit | undefined): Promise<string> {
	const headers = new Headers(init?.headers);
	const bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
	const encoding = headers.get("content-encoding");
	if (encoding === "gzip") return gunzipSync(bytes).toString("utf8");
	if (encoding === "zstd") return zstdDecompressSync(bytes).toString("utf8");
	return bytes.toString("utf8");
}

interface FetchCall {
	url: string;
	method: string;
	role: "researcher" | "prober" | "unexpected";
}
const fetches: FetchCall[] = [];
const roleCalls = { researcher: 0, prober: 0 };

globalThis.fetch = async (input, init) => {
	const url = String(input);
	const method = init?.method ?? "GET";
	if (url !== ENDPOINT) {
		// Unexpected URL: record it, then refuse. Never a real request.
		fetches.push({ url, method, role: "unexpected" });
		throw new Error(`unexpected fetch ${method} ${url}`);
	}
	const body = await bodyOf(init);
	const role = body.includes(RESEARCH_MARKER) ? "researcher" : "prober";
	fetches.push({ url, method, role });
	roleCalls[role] += 1;
	if (role === "researcher") return textResponse(`resp-researcher-${roleCalls.researcher}`, `msg-researcher-${roleCalls.researcher}`, BRIEF);
	// The prober's first call dispatches research; the second continues teaching.
	return roleCalls.prober === 1
		? researchCallResponse("resp-prober-1", "call-dispatch", JSON.stringify(RESEARCH_INPUT))
		: textResponse(`resp-prober-${roleCalls.prober}`, `msg-prober-${roleCalls.prober}`, PROBER_TEXT);
};

// ─── the production composition (imported AFTER env isolation) ──────────────

// The composition root: importing it wires the module-level jobRunner into
// setJobRespawn and the real turn runner into setTurnRunner.
const { handleChatRequest } = await import("../../src/server/chat-handler.ts");
const { recoverStaleJobs, setTurnRunner } = await import("../../src/server/jobs.ts");
const { chatStore } = await import("../../src/store/chats.ts");
const { jobStore } = await import("../../src/store/jobs.ts");
const { writeSettings } = await import("../../src/store/settings.ts");
const { createSubscriptionStore } = await import("../../src/store/subscription-credentials.ts");
const { PATHS } = await import("../../config.ts");
const { runningTurn } = await import("../../src/server/turn-runs.ts");
type JobRecord = import("../../src/core/contracts.ts").JobRecord;

// This fixture asserts the JOB composition; a real wake teacher turn is out
// of scope (and would stack a second surface on top of it).
setTurnRunner(async () => 200);

const CODEX = { provider: "openai-codex", id: "gpt-6-luna" };
const OPENROUTER = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };
const RESEARCH_INPUT = {
	question: "What is the latest stable sigma.js version?",
	context: "Choosing a graph rendering library for the lesson.",
};

function writeModels(roles: Record<string, { provider: string; id: string }>, strong = CODEX): void {
	writeSettings({
		version: 1,
		models: { strong: { model: strong } },
		agent: { models: Object.fromEntries(Object.entries(roles).map(([role, model]) => [role, { model }])) },
	});
}

/** The native fixture the runner's crash-recovery input scan reads. */
function nativeToolMessages(toolCallId: string): unknown[] {
	return [
		{ id: "u1", role: "user", content: "which sigma version?", timestamp: 1 },
		{
			id: "a1",
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "research", arguments: RESEARCH_INPUT }],
			api: "openai-completions",
			provider: "openai-codex",
			model: "gpt-6-luna",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			stopReason: "toolUse",
			timestamp: 1,
		},
		{
			id: "r1",
			role: "toolResult",
			toolCallId,
			toolName: "research",
			content: [{ type: "text", text: "Dispatched." }],
			details: "Dispatched.",
			isError: false,
			timestamp: 1,
		},
	];
}

function seedChat(title: string, toolCallId: string) {
	const chat = chatStore.createChat(title);
	chatStore.saveSettings(chat.id, { model: CODEX });
	chatStore.saveMessages(chat.id, nativeToolMessages(toolCallId) as never);
	return chat;
}

function seedJob(chatId: string, toolCallId: string, generation?: string): JobRecord {
	return jobStore.createJob({
		kind: "research",
		chatId,
		toolCallId,
		...(generation ? { subscriptionGeneration: generation } : {}),
	});
}

async function waitForSettled(jobId: string, timeoutMs = 20_000): Promise<JobRecord> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const job = jobStore.getJob(jobId);
		if (job && job.status !== "running") return job;
		if (Date.now() > deadline) throw new Error(`job ${jobId} never settled: ${JSON.stringify(job)}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function jobEvidence(job: JobRecord) {
	return {
		id: job.id,
		kind: job.kind,
		status: job.status,
		error: job.error ?? null,
		activity: job.activity ?? null,
		subscriptionGeneration: job.subscriptionGeneration ?? null,
		resultBrief: (job.result as { brief?: string } | undefined)?.brief ?? null,
	};
}

async function seedSubscriptionStore() {
	const store = createSubscriptionStore(path.resolve(PATHS.data, "subscription"));
	await store.transaction(async (tx) => {
		await tx.save({ ...tx.state, credential: grant("account-current") });
	});
	const generation = (await store.getSnapshot()).generation;
	assert.ok(generation, "the seeded subscription store has a generation");
	return { store, generation };
}

async function main(): Promise<void> {
	if (mode === "recover-run") {
		const { generation } = await seedSubscriptionStore();
		writeModels({ researcher: CODEX });
		const chat = seedChat("composition: recovered subscription research", "call-run");
		const job = seedJob(chat.id, "call-run", generation);
		recoverStaleJobs();
		const settled = await waitForSettled(job.id);
		print({ mode, endpoint: ENDPOINT, generation, fetches, roles: roleCalls, jobs: [jobEvidence(settled)] });
		return;
	}

	if (mode === "recover-refuse") {
		const { store, generation } = await seedSubscriptionStore();
		const staleGeneration = generation;
		// The learner reconnected: the stored account is a NEW generation.
		await store.transaction(async (tx) => {
			await tx.save({ version: 1, generation: randomUUID(), credential: grant("account-new") });
		});
		const currentGeneration = (await store.getSnapshot()).generation;
		writeModels({ researcher: CODEX });
		const staleChat = seedChat("composition: recovered job from the old account", "call-stale");
		const staleJob = seedJob(staleChat.id, "call-stale", staleGeneration);
		const unstampedChat = seedChat("composition: recovered job with no provenance", "call-unstamped");
		const unstampedJob = seedJob(unstampedChat.id, "call-unstamped");
		recoverStaleJobs();
		const [stale, unstamped] = await Promise.all([waitForSettled(staleJob.id), waitForSettled(unstampedJob.id)]);
		print({
			mode,
			endpoint: ENDPOINT,
			staleGeneration,
			currentGeneration,
			fetches,
			roles: roleCalls,
			jobs: [jobEvidence(stale), jobEvidence(unstamped)],
		});
		return;
	}

	if (mode === "apikey") {
		await seedSubscriptionStore();
		writeModels({ researcher: OPENROUTER });
		const chat = seedChat("composition: api-key research", "call-apikey");
		const job = seedJob(chat.id, "call-apikey");
		recoverStaleJobs();
		const settled = await waitForSettled(job.id);
		print({ mode, endpoint: ENDPOINT, fetches, roles: roleCalls, jobs: [jobEvidence(settled)] });
		return;
	}

	if (mode === "dispatch") {
		const { generation } = await seedSubscriptionStore();
		writeModels({ researcher: CODEX });
		const chat = chatStore.createChat("composition: dispatch");
		chatStore.saveSettings(chat.id, { model: CODEX });
		chatStore.saveMessages(chat.id, [{ id: "u1", role: "user", content: "teach me sigma.js", timestamp: 1 }] as never);
		const request = () =>
			new Request("http://test/api/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId: chat.id, input: { type: "text", text: "teach me sigma.js" } }),
			});
		const ack = await handleChatRequest(request());
		const ackStatus = ack.status;
		const ackBody = ackStatus === 200 ? "" : await ack.text();
		const handle = runningTurn(chat.id);
		const turnBody = handle ? await new Response(handle.subscribe()).text() : "";
		// The dispatch is fire-and-forget: the job settles after the turn.
		let job: JobRecord | undefined;
		const deadline = Date.now() + 20_000;
		while (!job) {
			job = jobStore.listJobs(chat.id).find((candidate) => candidate.kind === "research");
			if (job) break;
			if (Date.now() > deadline) throw new Error(`dispatch never created a research job (ack ${ackStatus} ${ackBody})`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const settled = await waitForSettled(job.id);
		print({
			mode,
			endpoint: ENDPOINT,
			generation,
			ackStatus,
			ackBody,
			turnBody,
			fetches,
			roles: roleCalls,
			jobs: [jobEvidence(settled)],
		});
		return;
	}

	throw new Error(`unknown mode: ${mode}`);
}

await main();
