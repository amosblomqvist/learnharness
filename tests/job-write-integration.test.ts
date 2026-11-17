import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-job-write-integration-"));
process.env.LH_DATA_DIR = path.join(root, "data");
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
const { jobStore } = await import("../src/store/jobs.ts");
const { subscribe } = await import("../src/core/events.ts");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const plugin = { pluginId: "example", toolName: "task", workerId: "worker", requestId: "request" };
function heldWindows(t: TestContext) {
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { value: "win32" });
	t.after(() => Object.defineProperty(process, "platform", platform));
	const rename = t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("held"), { code: "EPERM" }); });
	const warning = t.mock.method(console, "warn", () => {});
	return { rename, warning, restorePlatform: () => Object.defineProperty(process, "platform", platform) };
}

test("native job creation and updates retain the modeled Windows in-place compatibility fallback", t => {
	const { rename, warning } = heldWindows(t);
	const events: string[] = [];
	const unsubscribe = subscribe(event => { if (event.type === "jobs-changed") events.push(event.chatId!); });
	t.after(unsubscribe);
	const job = jobStore.createJob({ kind: "research", chatId: "native", toolCallId: "native-call" });
	assert.equal(jobStore.getJob(job.id)?.status, "running");
	jobStore.updateJob(job.id, { status: "done", activity: "done" });
	assert.equal(jobStore.getJob(job.id)?.status, "done");
	assert.ok(rename.mock.callCount() > 2, "held-file renames are retried before fallback");
	assert.equal(warning.mock.callCount(), 2);
	assert.deepEqual(events, ["native", "native"], "only landed writes announce");
});

test("plugin and plugin-linked native jobs fail atomically after Windows retries, never announce or truncate", t => {
	for (const [kind, metadata] of [["plugin", undefined], ["plugin", plugin], ["research", plugin]] as const) {
		const job = jobStore.createJob({ kind, chatId: "strict", toolCallId: `call-${kind}-${!!metadata}`, ...(metadata ? { plugin: metadata } : {}) });
		const file = path.join(root, "data", "jobs", `${job.id}.json`);
		const before = fs.readFileSync(file, "utf-8");
		const held = heldWindows(t);
		let events = 0;
		const unsubscribe = subscribe(event => { if (event.type === "jobs-changed") events++; });
		assert.throws(() => jobStore.updateJob(job.id, { status: "done" }), { code: "EPERM" });
		assert.throws(() => jobStore.createJob({ kind, chatId: "strict-new", toolCallId: "new", ...(metadata ? { plugin: metadata } : {}) }), { code: "EPERM" });
		unsubscribe();
		assert.ok(held.rename.mock.callCount() > 2);
		assert.equal(held.warning.mock.callCount(), 0);
		assert.equal(fs.readFileSync(file, "utf-8"), before);
		assert.equal(jobStore.listJobs("strict-new").length, 0);
		assert.equal(events, 0);
		assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => name.includes(".tmp-")), []);
		t.mock.restoreAll();
		held.restorePlatform();
	}
});
