import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { PluginTaskRecord } from "../src/core/plugin-workers.ts";
import { createPluginTaskRecordStore, readPluginTaskRecord, recoverPluginTaskRecords } from "../src/store/plugin-task-records.ts";
function fixture(t: TestContext) {
	const directory = mkdtempSync(join(tmpdir(), "lh-task-records-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}
function record(extra: Partial<PluginTaskRecord> = {}): PluginTaskRecord {
	return { version: 1, id: "task_one", definitionId: "worker", requestId: "request_one", input: { source: "trusted" }, prompt: "Explicit instructions", model: { provider: "fixture", id: "offline" }, purpose: "background", maxTurns: 3,
		createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z", status: "queued", turns: 0, messages: [{ role: "user", content: "Explicit instructions", timestamp: 1 }], ...extra };
}
const success = (result: unknown = false) => record({ status: "succeeded", result, completedAt: "2026-10-31T00:01:00.000Z" });

test("store is lazy on missing reads and atomically round-trips independent native records", t => {
	const root = fixture(t); const directory = join(root, "data", "tasks"); const store = createPluginTaskRecordStore(directory);
	assert.equal(store.get("missing"), null); assert.deepEqual(store.list(), []); assert(!existsSync(join(root, "data")));
	const value = success({ final: 0 }); store.save(value);
	assert.deepEqual(store.get(value.id), value); assert.deepEqual(store.list(), [value]);
	assert.deepEqual(readdirSync(directory), ["task_one.json"]);
	if (process.platform !== "win32") assert.equal(statSync(join(directory, "task_one.json")).mode & 0o777, 0o600);
	(store.get(value.id)!.result as { final: number }).final = 999;
	assert.deepEqual(store.get(value.id)?.result, { final: 0 });
	assert(!existsSync(join(root, "chats")));
});

test("all falsy JSON results persist, while absent success and non-JSON data cannot be coerced", t => {
	const store = createPluginTaskRecordStore(fixture(t));
	for (const value of [false, 0, "", null]) { store.save(success(value)); assert.equal(store.get("task_one")?.result, value); }
	for (const value of [undefined, Infinity, NaN, () => {}, BigInt(3), new Date()]) assert.throws(() => store.save({ ...success(), result: value }));
	assert.equal(store.get("task_one")?.result, null);
});

test("corrupt JSON, unsupported versions and malformed known fields never disappear from get/list", t => {
	const directory = fixture(t); const store = createPluginTaskRecordStore(directory); const file = join(directory, "task_one.json");
	for (const value of ["{", JSON.stringify(record({ version: 2 } as never)), JSON.stringify(record({ id: "different" })), JSON.stringify(record({ purpose: "other" } as never)), JSON.stringify(record({ messages: [] })), JSON.stringify(record({ status: "succeeded" })), JSON.stringify(record({ options: { apiKey: "not allowed" } } as never)), JSON.stringify(record({ status: "failed", error: { code: "bogus", message: "x" } } as never))]) {
		writeFileSync(file, value); assert.throws(() => store.get("task_one"), /Corrupt|unsupported/); assert.throws(() => store.list(), /Corrupt|unsupported/);
	}
	for (const id of ["../escape", "with.dot", "", "a".repeat(129)]) {
		assert.throws(() => store.get(id), /Invalid/); assert.throws(() => store.save(record({ id })), /Invalid/);
	}
});

test("invalid save and failed rename preserve the previous file and remove temporary artifacts", t => {
	const directory = fixture(t); const store = createPluginTaskRecordStore(directory); store.save(record());
	const before = readFileSync(join(directory, "task_one.json"), "utf8");
	assert.throws(() => store.save(record({ turns: -1 }))); assert.equal(readFileSync(join(directory, "task_one.json"), "utf8"), before);
	mkdirSync(join(directory, "blocked.json"));
	assert.throws(() => store.save(record({ id: "blocked" })));
	assert(!readdirSync(directory).some(name => name.endsWith(".tmp")));
	assert.equal(readFileSync(join(directory, "task_one.json"), "utf8"), before);
});

test("strict get/list refuse task files that are directories or symlinks", t => {
	const directory = fixture(t); const store = createPluginTaskRecordStore(directory);
	mkdirSync(join(directory, "folder.json")); assert.throws(() => store.get("folder"), /Unsafe/); assert.throws(() => store.list(), /Unsafe/);
	rmSync(join(directory, "folder.json"), { recursive: true });
	const outside = join(directory, "outside.txt"); writeFileSync(outside, JSON.stringify(record())); symlinkSync(outside, join(directory, "task_one.json"));
	assert.throws(() => store.get("task_one"), /Unsafe/); assert.throws(() => store.list(), /Unsafe/);
});

test("recovery reads disabled plugin canonical outcomes by task or acceptance id without activating or mutating", t => {
	const root = fixture(t); const directory = join(root, "fixture-plugin", "data", "tasks"); const store = createPluginTaskRecordStore(directory); store.save(success(0));
	writeFileSync(join(root, "fixture-plugin", "backend.cjs"), "throw new Error('must never activate');");
	const before = readFileSync(join(directory, "task_one.json"), "utf8");
	assert.deepEqual(readPluginTaskRecord(root, "fixture-plugin", "task_one"), success(0));
	assert.deepEqual(readPluginTaskRecord(root, "fixture-plugin", undefined, "request_one"), success(0));
	assert.deepEqual(readPluginTaskRecord(root, "fixture-plugin", "task_one", "request_one"), success(0));
	assert.throws(() => readPluginTaskRecord(root, "fixture-plugin", "task_one", "different"), /mismatch/);
	assert.equal(readPluginTaskRecord(root, "fixture-plugin", "missing"), null);
	assert.equal(readPluginTaskRecord(root, "fixture-plugin", undefined, "missing"), null);
	assert.equal(readFileSync(join(directory, "task_one.json"), "utf8"), before);
	store.save(record({ id: "duplicate" })); assert.throws(() => readPluginTaskRecord(root, "fixture-plugin", undefined, "request_one"), /Duplicate/);
});

test("opaque Unicode/punctuation request ids are lookup keys only, never paths", t => {
	const root = fixture(t); const directory = join(root, "fixture-plugin", "data", "tasks"); const requestId = '../学習:chunk:["1",2]';
	createPluginTaskRecordStore(directory).save({ ...success(), requestId });
	assert.equal(readPluginTaskRecord(root, "fixture-plugin", undefined, requestId)?.id, "task_one");
	assert.deepEqual(readdirSync(directory), ["task_one.json"]);
	assert(!existsSync(join(root, "学習:chunk:[\"1\",2]")));
});

test("recovery missing paths return null without mkdir; unsafe ids and corrupt records throw", t => {
	const root = fixture(t); const absent = join(root, "absent");
	assert.equal(readPluginTaskRecord(absent, "fixture-plugin", "task_one"), null); assert(!existsSync(absent));
	assert.equal(readPluginTaskRecord(root, "fixture-plugin", undefined, "request_one"), null); assert.deepEqual(readdirSync(root), []);
	for (const plugin of ["../escape", "MixedCase", "with.dot", ""]) assert.throws(() => readPluginTaskRecord(root, plugin, "task_one"), /plugin id/);
	assert.throws(() => readPluginTaskRecord(root, "fixture-plugin", "../escape"), /task id/);
	assert.throws(() => readPluginTaskRecord(root, "fixture-plugin", undefined, ""), /request id/);
	assert.throws(() => readPluginTaskRecord(root, "fixture-plugin"), /required/);
	const directory = join(root, "fixture-plugin", "data", "tasks"); mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, "task_one.json"), "broken");
	assert.throws(() => readPluginTaskRecord(root, "fixture-plugin", "task_one"), /Corrupt/);
	assert.throws(() => readPluginTaskRecord(root, "fixture-plugin", undefined, "request_one"), /Corrupt/);
});

test("bootstrap recovery includes disabled packages, interrupts all unfinished records, preserves successes and isolates errors", t => {
	const root = fixture(t);
	const good = join(root, "disabled-plugin", "data", "tasks"); const store = createPluginTaskRecordStore(good);
	store.save(record()); store.save(record({ id: "running", requestId: "running", status: "running" })); store.save({ ...success(0), id: "success", requestId: "success" });
	const successBefore = readFileSync(join(good, "success.json"), "utf8");
	const bad = join(root, "bad-plugin", "data", "tasks"); mkdirSync(bad, { recursive: true }); writeFileSync(join(bad, "broken.json"), "corrupt");
	const absent = join(root, "empty-plugin"); mkdirSync(absent); writeFileSync(join(root, "plugins-state.json"), JSON.stringify({ enabled: { "disabled-plugin": false } }));
	const errors = recoverPluginTaskRecords(root);
	assert.deepEqual(Object.keys(errors), ["bad-plugin"]); assert.match(errors["bad-plugin"]!, /Corrupt/);
	assert.equal(store.get("task_one")?.status, "interrupted"); assert.equal(store.get("running")?.status, "interrupted");
	assert.equal(readPluginTaskRecord(root, "disabled-plugin", "task_one")?.error?.code, "interrupted");
	assert.equal(readFileSync(join(good, "success.json"), "utf8"), successBefore);
	assert.deepEqual(readdirSync(absent), []);
	const interruptedBefore = readFileSync(join(good, "task_one.json"), "utf8"); recoverPluginTaskRecords(root);
	assert.equal(readFileSync(join(good, "task_one.json"), "utf8"), interruptedBefore);
});

test("bootstrap missing root stays missing, and unsafe package paths are per-package errors", t => {
	const base = fixture(t); const missing = join(base, "missing"); assert.deepEqual(recoverPluginTaskRecords(missing), {}); assert(!existsSync(missing));
	const root = join(base, "root"); mkdirSync(root); symlinkSync(base, join(root, "unsafe-plugin")); mkdirSync(join(root, "Invalid_ID"));
	const errors = recoverPluginTaskRecords(root); assert.match(errors["unsafe-plugin"]!, /Unsafe/); assert.match(errors.Invalid_ID!, /Invalid plugin id/);
	const rootLink = join(base, "link"); symlinkSync(root, rootLink); assert.throws(() => recoverPluginTaskRecords(rootLink), /Unsafe/);
});

test("recovery refuses symlinks at every root/plugin/data/tasks component and at the task file", t => {
	for (const component of ["root", "plugin", "data", "tasks", "file"]) {
		const base = fixture(t); const root = join(base, "plugins"); const directory = join(root, "fixture-plugin", "data", "tasks");
		createPluginTaskRecordStore(directory).save(success());
		const target = component === "root" ? root : component === "plugin" ? join(root, "fixture-plugin") : component === "data" ? join(root, "fixture-plugin", "data") : component === "tasks" ? directory : join(directory, "task_one.json");
		const moved = join(base, "moved"); renameSync(target, moved); symlinkSync(moved, target);
		assert.throws(() => readPluginTaskRecord(root, "fixture-plugin", "task_one"), /Unsafe/);
	}
});
