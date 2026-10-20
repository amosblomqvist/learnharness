/**
 * Issue #8 repair B — role-model image capability at the REAL seams.
 *
 * The bug: `agent.models.visualMaker.model` accepted a text-only model at
 * write time (the vision-slot gate was slot-only) and the role resolver then
 * built an executable engine from that override. A write-time-only fix would
 * still leave pre-existing invalid records (and their recovered jobs) able to
 * run — so this file pins BOTH halves against production code paths:
 *
 *  WRITE  — the actual Next route handler (`PUT /api/settings/[section]`)
 *           with a real Request/Response, real settings store on an isolated
 *           LH_DATA_DIR: refused writes return 400 and leave settings.json
 *           byte-identical; accepted writes persist; the original schema
 *           still rejects unknown roles (pdfReader is not writable).
 *
 *  RUN    — child processes (one scenario per process: module singletons,
 *           the stale-sweep throttle, and the settings record are one-per-
 *           process facts) enter through `recoverStaleJobs()` and
 *           `handleChatRequest()` with the REAL chat-handler composition:
 *           its module-level `jobRunner`, `setJobRespawn`/`setTurnRunner`
 *           wiring, the settings-resolved role engine seam, the job runner's
 *           refusal convention, and the delivery/wake bookkeeping. Only the
 *           network is replaced (a fetch stub that records and answers —
 *           never a real request) and only the wake turn runner is inert.
 *
 * Isolation (parent AND children): fresh HOME / TMPDIR / XDG_CACHE_HOME /
 * LH_DATA_DIR / LH_AUTH_FILE, an explicit env allowlist for children (no
 * provider keys, no proxy or DSH variables), and no external network. The
 * child mode is selected by LH_ROLE_CAPABILITY_MODE so this one file can be
 * its own fixture without adding a product/test file.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { after, describe, it } from "node:test";

const CHILD_MODE = process.env.LH_ROLE_CAPABILITY_MODE ?? "";

/** The isolated env every scenario runs under — children get an allowlist. */
interface Isolation {
	root: string;
	home: string;
	tmp: string;
	cache: string;
	data: string;
	auth: string;
}

function isolationFor(label: string): Isolation {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `lh-role-capability-${label}-`));
	const out: Isolation = {
		root,
		home: path.join(root, "home"),
		tmp: path.join(root, "tmp"),
		cache: path.join(root, "cache"),
		data: path.join(root, "data"),
		auth: path.join(root, "auth.json"),
	};
	for (const dir of [out.home, out.tmp, out.cache, out.data]) fs.mkdirSync(dir, { recursive: true });
	return out;
}

if (CHILD_MODE) {
	// ── child scenario: real production composition, one scenario per process
	await runChildScenario(CHILD_MODE);
	process.exit(0);
}

// ── parent test process: isolate BEFORE any config-loading import ───────────

const ROOT = isolationFor("suite");
process.env.HOME = ROOT.home;
process.env.TMPDIR = ROOT.tmp;
process.env.XDG_CACHE_HOME = ROOT.cache;
process.env.LH_DATA_DIR = ROOT.data;
process.env.LH_AUTH_FILE = ROOT.auth;
// Next augments NODE_ENV as readonly; the assignment is intentional here.
Object.assign(process.env, { NODE_ENV: "test" });
// The suite is structural (catalog capabilities), never a live account: drop
// every inherited key/token/proxy/DSH variable so a developer shell cannot
// change what is resolved. Only the isolation seams survive.
for (const key of Object.keys(process.env)) {
	if (key === "LH_DATA_DIR" || key === "LH_AUTH_FILE") continue;
	if (key.startsWith("LH_") || key.startsWith("DSH_")) delete process.env[key];
	if (/(_API_KEY|_TOKEN|_AUTH|_SECRET)$/.test(key)) delete process.env[key];
	if (/^(http|https|all)_proxy$/i.test(key)) delete process.env[key];
}

/** No code in the parent process may make a network request. */
let fetchCalls = 0;
globalThis.fetch = (async (input: unknown) => {
	fetchCalls += 1;
	throw new Error(`ROLE_CAPABILITY_NO_NETWORK: ${String(input)}`);
}) as typeof fetch;

const { PUT } = await import("../app/api/settings/[section]/route.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { SETTINGS_FILE } = await import("../config.ts");
const { BACKGROUND_MODEL_ROLES } = await import("../src/core/settings.ts");

const LUNA = { provider: "openai-codex", id: "gpt-6-luna" };
const SPARK = { provider: "openai-codex", id: "gpt-5.3-codex-spark" };
const IMAGE_API_KEY = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };
const TEXT_API_KEY = { provider: "zai", id: "glm-4.7" };

async function putSection(section: string, body: unknown): Promise<Response> {
	return PUT(
		new Request(`http://test/api/settings/${section}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ section }) },
	);
}

function rawRecord(): string {
	return fs.readFileSync(SETTINGS_FILE, "utf-8");
}

describe("the agent-section write gate (real route + real settings store)", () => {
	it("rejects a text-only visualMaker override with 400 and never persists it", async () => {
		writeSettings({ version: 1, general: { autoUpdate: false }, models: { strong: { model: LUNA } } });
		const before = rawRecord();
		const res = await putSection("agent", { models: { visualMaker: { model: SPARK } }, tools: { demo: false } });
		assert.equal(res.status, 400);
		const body = (await res.json()) as { error?: string };
		assert.match(body.error ?? "", /gpt-5\.3-codex-spark/);
		assert.match(body.error ?? "", /text only/);
		assert.match(body.error ?? "", /image-capable/);
		assert.equal(rawRecord(), before, "the refused write must not touch settings.json");
		assert.deepEqual(readSettings(), JSON.parse(before));
	});

	it("accepts an image-capable visualMaker override and persists it (other sections untouched)", async () => {
		writeSettings({ version: 1, general: { autoUpdate: false }, models: { strong: { model: LUNA } } });
		const res = await putSection("agent", { models: { visualMaker: { model: IMAGE_API_KEY } } });
		assert.equal(res.status, 200);
		const record = readSettings();
		assert.deepEqual(record?.agent?.models?.visualMaker?.model, IMAGE_API_KEY);
		// Replace-one-section discipline: the models + general sections survive.
		assert.deepEqual(record?.models?.strong?.model, LUNA);
		assert.equal(record?.general?.autoUpdate, false);
	});

	it("keeps text-only models valid for NON-image background roles (structural, no global ban)", async () => {
		writeSettings({ version: 1, models: { strong: { model: LUNA } } });
		const res = await putSection("agent", { models: { researcher: { model: SPARK }, extractor: { model: SPARK } } });
		assert.equal(res.status, 200);
		const record = readSettings();
		assert.deepEqual(record?.agent?.models?.researcher?.model, SPARK);
		assert.deepEqual(record?.agent?.models?.extractor?.model, SPARK);
	});

	it("the original schema still rejects pdfReader (not a writable background role)", async () => {
		writeSettings({ version: 1, models: { strong: { model: LUNA } } });
		const before = rawRecord();
		const res = await putSection("agent", { models: { pdfReader: { model: IMAGE_API_KEY } } });
		assert.equal(res.status, 400);
		const body = (await res.json()) as { error?: string };
		assert.match(body.error ?? "", /unknown role "pdfReader"/);
		for (const role of BACKGROUND_MODEL_ROLES) assert.ok((body.error ?? "").includes(role), `supported list names ${role}`);
		assert.equal(rawRecord(), before, "the schema refusal must not persist a pdfReader override");
	});

	it("control: the vision slot still refuses a text-only model", async () => {
		writeSettings({ version: 1, models: { strong: { model: LUNA } } });
		const res = await putSection("models", { vision: { model: SPARK } });
		assert.equal(res.status, 400);
		const body = (await res.json()) as { error?: string };
		assert.match(body.error ?? "", /vision slot needs an image-capable model/);
	});
});

// ── child scenarios: the REAL composition (recovery + dispatch) ─────────────

interface FetchCall {
	url: string;
	method: string;
	role: "prober" | "visualMaker" | "pdfReader" | "unexpected";
}

interface JobEvidence {
	id: string;
	kind: string;
	status: string;
	error: string | null;
	activity: string | null;
	subscriptionGeneration: string | null;
	result: unknown;
}

interface Evidence {
	mode: string;
	endpoint: string;
	fetches: FetchCall[];
	roles: Record<string, number>;
	jobs: JobEvidence[];
	generation?: string;
	ackStatus?: number;
	ackBody?: string;
	turnBody?: string;
}

interface ChildResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	evidence: Evidence[];
	stdout: string;
	stderr: string;
}

const TSX = fileURLToPath(import.meta.resolve("tsx"));
const CHILD_SCRIPT = fileURLToPath(new URL("./role-model-capabilities.test.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** One child process per scenario, explicit env allowlist (no inherited
 *  provider keys / proxies / DSH variables), isolated paths per scenario. */
function runScenario(mode: string): Promise<ChildResult> {
	const iso = isolationFor(mode);
	const child = spawn(process.execPath, ["--import", TSX, CHILD_SCRIPT], {
		cwd: REPO_ROOT,
		env: {
			PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
			LANG: process.env.LANG ?? "C.UTF-8",
			LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
			TZ: process.env.TZ ?? "Asia/Shanghai",
			HOME: iso.home,
			TMPDIR: iso.tmp,
			XDG_CACHE_HOME: iso.cache,
			LH_DATA_DIR: iso.data,
			LH_AUTH_FILE: iso.auth,
			NODE_ENV: "test",
			NEXT_TELEMETRY_DISABLED: "1",
			NO_PROXY: "localhost,127.0.0.1,::1",
			LH_ROLE_CAPABILITY_MODE: mode,
			// Carries the external network guard when the evidence runner sets it.
			...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const evidence: Evidence[] = [];
	let stdout = "";
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	readline.createInterface({ input: child.stdout }).on("line", (line) => {
		stdout += `${line}\n`;
		if (line.startsWith("EVIDENCE ")) evidence.push(JSON.parse(line.slice("EVIDENCE ".length)) as Evidence);
	});
	return new Promise<ChildResult>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal, evidence, stdout, stderr }));
	});
}

async function scenario(mode: string): Promise<Evidence> {
	const result = await runScenario(mode);
	const report = `--- child ${mode} exit=${result.code} signal=${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
	assert.equal(result.code, 0, `scenario ${mode} failed\n${report}`);
	assert.equal(result.evidence.length, 1, `scenario ${mode} printed no single evidence line\n${report}`);
	return result.evidence[0]!;
}

describe("recovery: a pre-existing text-only image role is refused, not executed", () => {
	it("visualMaker override: recoverStaleJobs settles the job as a visible refusal with zero requests", { timeout: 60_000 }, async () => {
		const evidence = await scenario("recover-visual");
		assert.deepEqual(evidence.fetches, [], "the refused role must not send ANY model request");
		const job = evidence.jobs[0]!;
		assert.equal(job.kind, "visual");
		assert.equal(job.status, "error", `job did not converge to the refusal: ${JSON.stringify(job)}`);
		assert.match(job.error ?? "", /No model configured — set up your models first/);
		assert.match(job.error ?? "", /missing: vision/);
		const result = job.result as { svg?: string; notes?: string };
		assert.equal(result.svg, "", "no figure may be produced by a refused role");
		assert.match(result.notes ?? "", /FAILED/);
	});

	it("pdfReader via the vision slot: the same refusal, still zero requests", { timeout: 60_000 }, async () => {
		const evidence = await scenario("recover-pdf");
		assert.deepEqual(evidence.fetches, [], "the refused role must not send ANY model request");
		const job = evidence.jobs[0]!;
		assert.equal(job.kind, "pdf");
		assert.equal(job.status, "error");
		assert.match(job.error ?? "", /missing: vision/);
		const result = job.result as { notes?: string; brief?: string };
		assert.match(result.notes ?? result.brief ?? "", /FAILED|PDF failed/);
	});
});

describe("dispatch: a real turn emitting `visual` lands on the same refusal", () => {
	it("the prober runs, the visual job is refused before its model call", { timeout: 60_000 }, async () => {
		const evidence = await scenario("dispatch-visual");
		assert.equal(evidence.ackStatus, 200, `chat request refused: ${evidence.ackBody}`);
		assert.ok(evidence.turnBody, "the prober turn produced no stream body");
		assert.equal(evidence.roles.prober, 2, `expected two prober model steps: ${JSON.stringify(evidence.fetches)}`);
		assert.equal(evidence.roles.visualMaker ?? 0, 0, "the refused visual role made a model request");
		assert.equal(evidence.fetches.filter((call) => call.role === "unexpected").length, 0);
		const job = evidence.jobs[0]!;
		assert.equal(job.kind, "visual");
		assert.equal(job.status, "error", `dispatched job did not converge: ${JSON.stringify(job)}`);
		assert.match(job.error ?? "", /missing: vision/);
		assert.equal(job.subscriptionGeneration, evidence.generation, "the dispatched job kept its provenance");
	});
});

// ── child scenario implementation (runs only in the spawned process) ────────

async function runChildScenario(mode: string): Promise<void> {
	assert.ok(process.env.LH_DATA_DIR && process.env.LH_AUTH_FILE, "isolation paths are required");
	assert.equal(process.env.NODE_ENV, "test");

	const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
	const VISUAL_MARKER = "You are a visual maker";
	const PDF_MARKER = "You are a PDF reading specialist";
	const CODEX = { provider: "openai-codex", id: "gpt-6-luna" };
	const SPARK = { provider: "openai-codex", id: "gpt-5.3-codex-spark" };

	const print = (value: unknown) => console.log(`EVIDENCE ${JSON.stringify(value)}`);

	// ── transport stub: records every call, answers synthetically (never real)
	const jwt = (account: string) =>
		`e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
	const grant = (account: string) => ({
		type: "oauth" as const,
		access: jwt(account),
		refresh: `refresh-${account}`,
		expires: Date.now() + 3600_000,
		accountId: account,
	});
	const sse = (payloads: unknown[]) =>
		new Response(`${payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join("")}data: [DONE]\n\n`, {
			headers: { "content-type": "text/event-stream" },
		});
	const usage = { input_tokens: 11, output_tokens: 5, total_tokens: 16, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
	const textResponse = (responseId: string, messageId: string, text: string) => {
		const item = { id: messageId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] };
		return sse([
			{ type: "response.created", response: { id: responseId, status: "in_progress", output: [] } },
			{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
			{ type: "response.output_text.delta", output_index: 0, item_id: messageId, content_index: 0, delta: text },
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { id: responseId, status: "completed", output: [item], usage } },
		]);
	};
	const callResponse = (name: string, argumentsText: string) => {
		const callId = `call-${name}`;
		const responseId = `resp-${name}`;
		const call = { id: `fc-${callId}`, type: "function_call", status: "completed", call_id: callId, name, arguments: argumentsText };
		return sse([
			{ type: "response.created", response: { id: responseId, status: "in_progress", output: [] } },
			{ type: "response.output_item.added", output_index: 0, item: { ...call, status: "in_progress", arguments: "" } },
			{ type: "response.function_call_arguments.delta", output_index: 0, item_id: `fc-${callId}`, delta: argumentsText },
			{ type: "response.function_call_arguments.done", output_index: 0, item_id: `fc-${callId}`, arguments: argumentsText },
			{ type: "response.output_item.done", output_index: 0, item: call },
			{ type: "response.completed", response: { id: responseId, status: "completed", output: [call], usage } },
		]);
	};
	const bodyOf = async (init: RequestInit | undefined): Promise<string> => {
		const headers = new Headers(init?.headers);
		const bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
		const encoding = headers.get("content-encoding");
		if (encoding === "gzip") return gunzipSync(bytes).toString("utf8");
		if (encoding === "zstd") return zstdDecompressSync(bytes).toString("utf8");
		return bytes.toString("utf8");
	};

	const fetches: FetchCall[] = [];
	const roles: Record<string, number> = { prober: 0, visualMaker: 0, pdfReader: 0 };
	let proberCalls = 0;
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		if (url !== CODEX_ENDPOINT) {
			fetches.push({ url, method, role: "unexpected" });
			throw new Error(`unexpected fetch ${method} ${url}`);
		}
		const body = await bodyOf(init);
		const role: FetchCall["role"] = body.includes(VISUAL_MARKER)
			? "visualMaker"
			: body.includes(PDF_MARKER)
				? "pdfReader"
				: "prober";
		fetches.push({ url, method, role });
		roles[role] = (roles[role] ?? 0) + 1;
		if (role === "prober") {
			proberCalls += 1;
			// Step 1 dispatches a visual job; step 2 finishes the turn.
			return proberCalls === 1
				? callResponse("visual", JSON.stringify({ brief: "A unit circle with labelled axes and one highlighted angle." }))
				: textResponse("resp-prober-2", "msg-prober-2", "Teaching continues after the dispatch.");
		}
		// A text-only model that (wrongly) ran would still get an answer here:
		// the regression's point is that NO request is made at all.
		return textResponse(`resp-${role}`, `msg-${role}`, "done");
	};

	// ── the production composition (imported AFTER env + network stub) ─────
	const { handleChatRequest } = await import("../src/server/chat-handler.ts");
	const { recoverStaleJobs, setTurnRunner } = await import("../src/server/jobs.ts");
	const { chatStore } = await import("../src/store/chats.ts");
	const { jobStore } = await import("../src/store/jobs.ts");
	const { writeSettings } = await import("../src/store/settings.ts");
	const { createSubscriptionStore } = await import("../src/store/subscription-credentials.ts");
	const { PATHS } = await import("../config.ts");
	const { runningTurn } = await import("../src/server/turn-runs.ts");
	type JobRecord = import("../src/core/contracts.ts").JobRecord;

	// The job composition is the surface under test; a real wake teacher turn
	// would stack a second composition on top of it.
	setTurnRunner(async () => 200);

	const seedSubscriptionStore = async () => {
		const store = createSubscriptionStore(path.resolve(PATHS.data, "subscription"));
		await store.transaction(async (tx) => {
			await tx.save({ ...tx.state, credential: grant("account-current") });
		});
		const generation = (await store.getSnapshot()).generation;
		assert.ok(generation, "the seeded subscription store has a generation");
		return generation;
	};

	const toolMessages = (toolCallId: string, name: string, args: unknown): unknown[] => [
		{ id: "u1", role: "user", content: "please draw this", timestamp: 1 },
		{
			id: "a1",
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
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
			toolName: name,
			content: [{ type: "text", text: "Dispatched." }],
			details: "Dispatched.",
			isError: false,
			timestamp: 1,
		},
	];

	/** A minimal but VALID one-page PDF (correct xref offsets): the reader's
	 *  upfront pdfjs probe must pass so a pre-fix run actually reaches the
	 *  engine call — the regression measures the gate, not a broken fixture. */
	const minimalPdf = (): string => {
		const objects = [
			"<< /Type /Catalog /Pages 2 0 R >>",
			"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
		];
		let out = "%PDF-1.4\n";
		const offsets: number[] = [];
		for (const [index, body] of objects.entries()) {
			offsets.push(Buffer.byteLength(out));
			out += `${index + 1} 0 obj\n${body}\nendobj\n`;
		}
		const xref = Buffer.byteLength(out);
		out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
		for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
		out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
		return out;
	};

	const seedChat = (title: string, messages: unknown[]) => {
		const chat = chatStore.createChat(title);
		chatStore.saveSettings(chat.id, { model: CODEX });
		chatStore.saveMessages(chat.id, messages as never);
		return chat;
	};

	const seedJob = (chatId: string, kind: "visual" | "pdf", toolCallId: string, generation?: string): JobRecord =>
		jobStore.createJob({ kind, chatId, toolCallId, ...(generation ? { subscriptionGeneration: generation } : {}) });

	const waitForSettled = async (jobId: string, timeoutMs = 30_000): Promise<JobRecord> => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const job = jobStore.getJob(jobId);
			if (job && job.status !== "running") return job;
			if (Date.now() > deadline) throw new Error(`job ${jobId} never settled: ${JSON.stringify(job)}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};

	const jobEvidence = (job: JobRecord): JobEvidence => ({
		id: job.id,
		kind: job.kind,
		status: job.status,
		error: job.error ?? null,
		activity: job.activity ?? null,
		subscriptionGeneration: job.subscriptionGeneration ?? null,
		result: job.result ?? null,
	});

	if (mode === "recover-visual" || mode === "recover-pdf") {
		// A pre-existing record written by the PRE-FIX path: the text-only
		// model is on disk (an override for visual; the vision slot for pdf),
		// with a live subscription generation so the ONLY thing that can stop
		// execution is the capability gate itself.
		const generation = await seedSubscriptionStore();
		if (mode === "recover-visual") {
			writeSettings({
				version: 1,
				models: { strong: { model: CODEX }, vision: { model: CODEX } },
				agent: { models: { visualMaker: { model: SPARK } } },
			});
			const chat = seedChat(
				"legacy: text-only visualMaker override",
				toolMessages("call-visual", "visual", { brief: "A unit circle with labelled axes." }),
			);
			const job = seedJob(chat.id, "visual", "call-visual", generation);
			recoverStaleJobs();
			const settled = await waitForSettled(job.id);
			print({ mode, endpoint: CODEX_ENDPOINT, fetches, roles, generation, jobs: [jobEvidence(settled)] });
			return;
		}
		writeSettings({
			version: 1,
			models: { strong: { model: CODEX }, vision: { model: SPARK } },
		});
		const pdfPath = path.join(PATHS.data, "legacy-lesson.pdf");
		fs.writeFileSync(pdfPath, minimalPdf());
		const chat = seedChat(
			"legacy: text-only vision slot feeding pdfReader",
			toolMessages("call-pdf", "pdf", { path: pdfPath, question: "What does the document show?" }),
		);
		const job = seedJob(chat.id, "pdf", "call-pdf", generation);
		recoverStaleJobs();
		const settled = await waitForSettled(job.id);
		print({ mode, endpoint: CODEX_ENDPOINT, fetches, roles, generation, jobs: [jobEvidence(settled)] });
		return;
	}

	if (mode === "dispatch-visual") {
		const generation = await seedSubscriptionStore();
		// Image-capable slots/tools exist, so the prober CAN dispatch `visual`;
		// the legacy override is what pins the role to a text-only model.
		writeSettings({
			version: 1,
			models: { strong: { model: CODEX }, vision: { model: CODEX } },
			agent: { models: { visualMaker: { model: SPARK } } },
		});
		const chat = chatStore.createChat("legacy: dispatch against a text-only visualMaker");
		chatStore.saveSettings(chat.id, { model: CODEX });
		// Already past the probe: the TEACHER owns the `visual` dispatch tool
		// (the prober's job subset is research + pdf).
		chatStore.saveMessages(chat.id, [
			{ id: "u0", role: "user", content: "teach me the unit circle", timestamp: 1 },
			{
				id: "a0",
				role: "assistant",
				content: [{ type: "toolCall", id: "call-probe-done", name: "probe_done", arguments: { assessment: "ready" } }],
				api: "openai-completions",
				provider: "openai-codex",
				model: "gpt-6-luna",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
				timestamp: 1,
			},
			{
				id: "r0",
				role: "toolResult",
				toolCallId: "call-probe-done",
				toolName: "probe_done",
				content: [{ type: "text", text: "Probe complete." }],
				details: "Probe complete.",
				isError: false,
				timestamp: 1,
			},
		] as never);
		const ack = await handleChatRequest(
			new Request("http://test/api/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId: chat.id, input: { type: "text", text: "draw the unit circle" } }),
			}),
		);
		const ackStatus = ack.status;
		const ackBody = ackStatus === 200 ? "" : await ack.text();
		const handle = runningTurn(chat.id);
		const turnBody = handle ? await new Response(handle.subscribe()).text() : "";
		let job: JobRecord | undefined;
		const deadline = Date.now() + 30_000;
		while (!job) {
			job = jobStore.listJobs(chat.id).find((candidate) => candidate.kind === "visual");
			if (job) break;
			if (Date.now() > deadline) throw new Error(`dispatch never created a visual job (ack ${ackStatus} ${ackBody})`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const settled = await waitForSettled(job.id);
		print({
			mode,
			endpoint: CODEX_ENDPOINT,
			fetches,
			roles,
			generation,
			ackStatus,
			ackBody,
			turnBody,
			jobs: [jobEvidence(settled)],
		});
		return;
	}

	throw new Error(`unknown mode: ${mode}`);
}

// The parent's temp root is per-suite; children own their own.
after(() => {
	fs.rmSync(ROOT.root, { recursive: true, force: true });
});
