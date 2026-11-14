import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AssistantMessage, Model, StreamFunction } from "@earendil-works/pi-ai";

// Isolate all disk/auth/recovery state BEFORE any application import. The
// transport below is synthetic: no server, provider, credential, or network use.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-settings-admission-"));
process.env.HOME = path.join(directory, "home");
process.env.LH_DATA_DIR = path.join(directory, "data");
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
process.env.LH_IGNORE_ENV_KEYS = "1";
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.LH_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const settingsFile = path.join(process.env.LH_DATA_DIR, "settings.json");
const initial = {
	version: 1,
	agent: { workerRequestConcurrency: 1, tools: { research: false }, graphTools: { enabled: false } },
	general: { autoUpdate: false },
	futureSection: { preserved: true },
};
fs.writeFileSync(settingsFile, JSON.stringify(initial));
const { PUT } = await import("../app/api/settings/[section]/route.ts");
const { effectiveSettings } = await import("../src/server/stores.ts");
const { configureWorkerRequestAdmission, workerRequestStream } = await import("../src/agent/worker-request-admission.ts");
const { AssistantMessageEventStream } = await import("@earendil-works/pi-ai/utils/event-stream");
const { normalizeContext } = await import("@earendil-works/pi-ai");
after(() => fs.rmSync(directory, { recursive: true, force: true }));

const model: Model<"openai-completions"> = {
	api: "openai-completions", provider: "fixture", id: "fixture", name: "Fixture",
	baseUrl: "http://invalid.fixture", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function message(): AssistantMessage {
	return {
		role: "assistant", api: model.api, provider: model.provider, model: model.id,
		content: [], stopReason: "stop", timestamp: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}
async function put(body: unknown) {
	return PUT(new Request("http://localhost/api/settings/agent", {
		method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
	}), { params: Promise.resolve({ section: "agent" }) });
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("durable agent PUT refreshes live admission; increases drain, decreases wait, unset restores 8", async () => {
	const sources: InstanceType<typeof AssistantMessageEventStream>[] = [];
	const transport: StreamFunction = () => {
		const source = new AssistantMessageEventStream();
		sources.push(source);
		return source;
	};
	const stream = workerRequestStream(transport);
	const requests = Array.from({ length: 3 }, () => stream(model, normalizeContext({ messages: [] })));
	await turn();
	assert.equal(sources.length, 1, "composition root reads the persisted limit, not a second default pool");
	assert.equal(effectiveSettings().agent.workerRequestConcurrency, 1);
	for (const workerRequestConcurrency of [0, -1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1]) {
		assert.equal((await put({ ...initial.agent, workerRequestConcurrency })).status, 400);
		assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf-8")), initial);
	}
	assert.equal(sources.length, 1, "rejected writes never admit queued work");

	// An I/O failure must not refresh admission before the setting is durable.
	let limitReads = 0;
	configureWorkerRequestAdmission(() => { limitReads++; return effectiveSettings().agent.workerRequestConcurrency; });
	const readsBeforeFailure = limitReads;
	const originalRename = fs.renameSync;
	fs.renameSync = (from, to) => {
		if (to === settingsFile) throw new Error("fixture settings write failure");
		return originalRename(from, to);
	};
	try {
		await assert.rejects(put({ ...initial.agent, workerRequestConcurrency: 3 }), /fixture settings write failure/);
		assert.equal(limitReads, readsBeforeFailure, "failed durable write never refreshes the policy");
		assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf-8")), initial);
		assert.equal(sources.length, 1);
	} finally {
		fs.renameSync = originalRename;
		configureWorkerRequestAdmission(() => effectiveSettings().agent.workerRequestConcurrency);
	}

	assert.equal((await put({ ...initial.agent, workerRequestConcurrency: 2 })).status, 200);
	await turn();
	assert.equal(sources.length, 2, "increase drains immediately without waiting for active completion");
	const stored = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
	assert.deepEqual(stored, { ...initial, agent: { ...initial.agent, workerRequestConcurrency: 2 } });

	assert.equal((await put(initial.agent)).status, 200);
	sources[0]!.end(message());
	await requests[0]!.result();
	await turn();
	assert.equal(sources.length, 2, "decrease lets active requests finish and admits none while at the limit");
	sources[1]!.end(message());
	await requests[1]!.result();
	await turn();
	assert.equal(sources.length, 3, "queued request starts once active falls below the decreased limit");
	sources[2]!.end(message());
	await requests[2]!.result();

	const { workerRequestConcurrency: _drop, ...siblings } = initial.agent;
	assert.equal((await put(siblings)).status, 200);
	assert.equal(effectiveSettings().agent.workerRequestConcurrency, 8);
	assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf-8")).agent, siblings);
	const resetRequests = Array.from({ length: 9 }, () => stream(model, normalizeContext({ messages: [] })));
	await turn();
	assert.equal(sources.length, 11, "unset restores eight simultaneous requests, leaving the ninth queued");
	for (const source of sources.slice(3)) source.end(message());
	await Promise.all(resetRequests.slice(0, 8).map((request) => request.result()));
	await turn();
	assert.equal(sources.length, 12);
	sources[11]!.end(message());
	await resetRequests[8]!.result();
});
