/**
 * Issue #8 — the PRODUCTION job-runner composition (regression).
 *
 * The bug this file pins down lived in the composition, not in the runner:
 * src/server/chat-handler.ts built its module-level `createJobRunner` with a
 * plain `providerKeyPresent` gate and WITHOUT the subscription scope /
 * preflight the extraction pipeline already passed. Consequence: every Codex
 * sub-agent job was refused as "missing API key", and a recovered job had no
 * generation provenance to be refused against.
 *
 * These tests never import the composition themselves — each scenario runs in
 * its own child process (tests/fixtures/subscription-composition-child.ts)
 * with an isolated LH_DATA_DIR / LH_AUTH_FILE, so module-level singletons and
 * the settings record cannot leak between scenarios. The child enters through
 * real production seams only:
 *   - "dispatch":     handleChatRequest → real prober agent → the research
 *                     tool's ctx.dispatch → the module-level jobRunner.
 *   - "recover-run" / "recover-refuse": real recoverStaleJobs (whose production
 *                     respawn is `jobRunner.runJob(jobId)` with no input).
 *   - "apikey":       the same recovery seam on a non-subscription researcher.
 * Only the network is replaced (exactly the known Codex endpoint) and only the
 * WAKE turn runner is inert; the job runner, subscription engine and SDK are
 * the real ones.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const root = mkdtempSync(path.join(os.tmpdir(), "lh-subscription-composition-"));
const tsx = fileURLToPath(import.meta.resolve("tsx"));
const childScript = fileURLToPath(new URL("./fixtures/subscription-composition-child.ts", import.meta.url));

interface FetchCall {
	url: string;
	method: string;
	role: "researcher" | "prober" | "unexpected";
}

interface JobEvidence {
	id: string;
	kind: string;
	status: string;
	error: string | null;
	activity: string | null;
	subscriptionGeneration: string | null;
	resultBrief: string | null;
}

interface Evidence {
	mode: string;
	endpoint: string;
	fetches: FetchCall[];
	roles: { researcher: number; prober: number };
	jobs: JobEvidence[];
	generation?: string;
	staleGeneration?: string;
	currentGeneration?: string;
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

/** One scenario per process; returns the collected evidence and process tail. */
function runScenario(mode: string): Promise<ChildResult> {
	const dataDir = path.join(root, `data-${mode}`);
	const child = spawn(process.execPath, ["--import", tsx, childScript, mode], {
		cwd: fileURLToPath(new URL("..", import.meta.url)),
		env: {
			...process.env,
			LH_DATA_DIR: dataDir,
			LH_AUTH_FILE: path.join(root, `auth-${mode}.json`),
			NODE_ENV: "test",
			// The research tool drops from the registry without a search key;
			// the child's fetch stub never sends a search request.
			TAVILY_API_KEY: "test-tavily-key",
			OPENROUTER_API_KEY: "test-openrouter-key",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const evidence: Evidence[] = [];
	let stdout = "";
	let stderr = "";
	child.stderr.on("data", (chunk) => {
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
	return one(result.evidence, "evidence line");
}

/** Exactly one item (the evidence contract is one scenario, one job/request). */
function one<T>(items: T[], label: string): T {
	const [first, ...rest] = items;
	assert.ok(first, `expected ${label}: ${JSON.stringify(items)}`);
	assert.equal(rest.length, 0, `expected exactly one ${label}: ${JSON.stringify(items)}`);
	return first;
}

const researcherCalls = (evidence: Evidence) => evidence.fetches.filter((call) => call.role === "researcher");
const MISSING_KEY = /(missing an? API Key|API Key)/i;

test("dispatch: a Codex research job from a real chat turn reaches the subscription endpoint and completes", { timeout: 60_000 }, async () => {
	const evidence = await scenario("dispatch");
	assert.equal(evidence.ackStatus, 200, `chat request was refused: ${evidence.ackBody}`);
	assert.equal(evidence.ackBody, "");
	assert.ok(evidence.turnBody, "the turn produced no stream body");
	// The prober turn itself rides the subscription engine (two model steps),
	// then the dispatched researcher job sends its own request.
	assert.equal(evidence.roles.prober, 2, `expected two prober steps: ${JSON.stringify(evidence.fetches)}`);
	const sent = one(researcherCalls(evidence), "researcher request");
	assert.equal(sent.url, CODEX_ENDPOINT);
	assert.equal(sent.method, "POST");
	assert.equal(evidence.fetches.filter((call) => call.role === "unexpected").length, 0);
	const job = one(evidence.jobs, "job");
	assert.equal(job.kind, "research");
	assert.equal(job.status, "done", `job did not complete: ${job.error}`);
	assert.equal(job.error, null, `job was refused: ${job.error}`);
	assert.match(job.resultBrief ?? "", /Sigma\.js v3/);
	// The dispatch stamps provenance under the turn's subscription generation.
	assert.ok(job.subscriptionGeneration, "the job record carries no generation provenance");
	assert.equal(job.subscriptionGeneration, evidence.generation);
});

test("recovery: a running subscription job re-sends through the module-level jobRunner", { timeout: 60_000 }, async () => {
	const evidence = await scenario("recover-run");
	const sent = one(researcherCalls(evidence), "researcher request");
	assert.equal(sent.url, CODEX_ENDPOINT);
	assert.equal(sent.method, "POST");
	assert.equal(evidence.fetches.filter((call) => call.role === "unexpected").length, 0);
	const job = one(evidence.jobs, "job");
	assert.equal(job.status, "done", `job did not complete: ${job.error}`);
	assert.equal(job.error, null, `job was refused: ${job.error}`);
	assert.match(job.resultBrief ?? "", /Sigma\.js v3/);
	assert.equal(job.subscriptionGeneration, evidence.generation);
});

test("recovery: an old-generation or unevidenced job is refused before any request, never replayed on the new account", { timeout: 60_000 }, async () => {
	const evidence = await scenario("recover-refuse");
	assert.notEqual(evidence.staleGeneration, evidence.currentGeneration, "the fixture must rotate the account");
	assert.equal(evidence.fetches.length, 0, `a refused job still made requests: ${JSON.stringify(evidence.fetches)}`);
	const stale = evidence.jobs.find((job) => job.subscriptionGeneration === evidence.staleGeneration);
	const unstamped = evidence.jobs.find((job) => job.subscriptionGeneration === null);
	assert.ok(stale, "the old-generation job did not settle");
	assert.ok(unstamped, "the unevidenced job did not settle");
	assert.equal(stale.status, "error");
	assert.match(stale.error ?? "", /subscription source is unavailable \(subscription_needs_login\)/);
	assert.equal(unstamped.status, "error");
	assert.match(unstamped.error ?? "", /Sign in to this instance's Codex subscription/);
	for (const job of [stale, unstamped]) assert.doesNotMatch(job.error ?? "", MISSING_KEY);
});

test("non-subscription: an API-key researcher job is untouched by the subscription gate", { timeout: 60_000 }, async () => {
	const evidence = await scenario("apikey");
	const sent = one(evidence.fetches, "provider request");
	assert.equal(sent.role, "unexpected");
	assert.match(sent.url, /openrouter\.ai/);
	const job = one(evidence.jobs, "job");
	// The attempt is what matters: the job got as far as the provider and only
	// then failed (the stub refuses the unknown URL; the SDK reports it as a
	// transport failure). No subscription or key gate may intercept it first.
	assert.equal(job.status, "error");
	assert.ok(job.error, "the failed provider request left no error");
	assert.doesNotMatch(job.error ?? "", /subscription source is unavailable/);
	assert.doesNotMatch(job.error ?? "", /subscription_needs_login/);
	assert.doesNotMatch(job.error ?? "", MISSING_KEY);
});
