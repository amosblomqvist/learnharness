/**
 * Host work registry and exclusive hold (src/core/host-hold.ts), its write
 * gates (store backstop in src/store/atomic-write.ts, request gate in
 * src/server/host-hold.ts), the torn-tail-safe JSONL append and the data
 * format stamp (src/store/data-format.ts).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lh-host-hold-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lh-host-hold-outside-"));
process.env.LH_DATA_DIR = dataRoot;
after(() => {
	fs.rmSync(dataRoot, { recursive: true, force: true });
	fs.rmSync(outside, { recursive: true, force: true });
});

const hold = await import("../src/core/host-hold.ts");
const { subscribe } = await import("../src/core/events.ts");
const { appendLineSafe, assertDataWritable, writeFileAtomicSync } = await import("../src/store/atomic-write.ts");
const { holdRequestRefusal } = await import("../src/server/host-hold.ts");
const { stampDataFormat } = await import("../src/store/data-format.ts");
const { CURRENT_DATA_FORMATS, newerDataFormats, parseDataFormats } = await import("../src/core/data-format.ts");

beforeEach(() => hold.resetHostHoldForTests());
afterEach(() => hold.resetHostHoldForTests());

describe("work registry and hold", () => {
	it("grants the hold only while idle", () => {
		const work = hold.beginWork("turn", "chat-1");
		assert.equal(hold.isHostIdle(), false);
		assert.equal(hold.acquireHold({ owner: "github-sync", reason: "Syncing" }), null);
		work.end();
		assert.equal(hold.isHostIdle(), true);
		const held = hold.acquireHold({ owner: "github-sync", reason: "Syncing" });
		assert.ok(held);
		assert.deepEqual(hold.activeHold() && { owner: hold.activeHold()!.owner, reason: hold.activeHold()!.reason }, { owner: "github-sync", reason: "Syncing" });
		held.release();
		assert.equal(hold.activeHold(), null);
	});

	it("refuses new work and a second hold while held, and work resumes after release", () => {
		const held = hold.acquireHold({ owner: "github-sync", reason: "GitHub Sync is syncing" })!;
		assert.throws(() => hold.beginWork("job", "j1"), (error: unknown) => {
			assert.ok(hold.isHostHoldError(error));
			assert.equal((error as InstanceType<typeof hold.HostHoldError>).status, 503);
			assert.match((error as Error).message, /GitHub Sync is syncing/);
			return true;
		});
		assert.equal(hold.acquireHold({ owner: "other", reason: "x" }), null);
		held.release();
		held.release(); // idempotent
		hold.beginWork("job", "j1").end();
	});

	it("announces hold changes on the event bus", () => {
		const seen: boolean[] = [];
		const off = subscribe((event) => { if (event.type === "hold-changed") seen.push(event.active); });
		const held = hold.acquireHold({ owner: "p", reason: "r" })!;
		held.release();
		off();
		assert.deepEqual(seen, [true, false]);
	});

	it("cancel aborts the hold's signal and releases it", () => {
		const held = hold.acquireHold({ owner: "p", reason: "r" })!;
		assert.equal(hold.cancelHold(), true);
		assert.equal(held.signal.aborted, true);
		assert.equal(hold.activeHold(), null);
		assert.equal(hold.cancelHold(), false);
	});

	it("deactivating the owner aborts and releases only its own hold", () => {
		const held = hold.acquireHold({ owner: "a", reason: "r" })!;
		hold.releaseHoldsOf("b");
		assert.ok(hold.activeHold());
		hold.releaseHoldsOf("a");
		assert.equal(held.signal.aborted, true);
		assert.equal(hold.activeHold(), null);
	});

	it("a forced hold with writes open refuses work but allows writes until blockWrites", () => {
		const running = hold.beginWork("side-chat", "c");
		const forced = hold.acquireHold({ owner: "host", reason: "Syncing before quit", force: true, writesAllowed: true })!;
		assert.ok(forced);
		assert.throws(() => hold.beginWork("turn", "c2"), hold.HostHoldError);
		hold.assertNoHold(); // writes still open: aborted work saves its partial result
		forced.blockWrites();
		assert.throws(() => hold.assertNoHold(), hold.HostHoldError);
		running.end();
	});

	it("abortAllWork calls each abort path and waits until the registry is empty", async () => {
		const aborted: string[] = [];
		const a = hold.beginWork("turn", "a", () => { aborted.push("a"); setTimeout(() => a.end(), 5); });
		const b = hold.beginWork("compaction", "b"); // no abort path: waited for
		setTimeout(() => b.end(), 20);
		await hold.abortAllWork();
		assert.deepEqual(aborted, ["a"]);
		assert.equal(hold.isHostIdle(), true);
	});

	it("abortAllWork stops waiting when its signal aborts", async () => {
		const stuck = hold.beginWork("compaction", "stuck");
		await hold.abortAllWork(AbortSignal.timeout(20));
		assert.equal(hold.isHostIdle(), false);
		stuck.end();
	});

	it("lists running work oldest first", () => {
		const a = hold.beginWork("turn", "a");
		const b = hold.beginWork("job", "b");
		assert.deepEqual(hold.runningWork().map((w) => w.label), ["a", "b"]);
		a.end(); a.end(); b.end();
		assert.deepEqual(hold.runningWork(), []);
	});
});

describe("idle edge", () => {
	it("fires once after the last work ends and the debounce passes, never on hold release", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let idle = 0;
		const off = hold.onHostIdle(() => { idle++; });
		const a = hold.beginWork("turn", "a");
		const b = hold.beginWork("extraction", "a");
		a.end();
		t.mock.timers.tick(hold.IDLE_DEBOUNCE_MS);
		assert.equal(idle, 0, "still busy");
		b.end();
		t.mock.timers.tick(hold.IDLE_DEBOUNCE_MS - 1);
		assert.equal(idle, 0, "debounced");
		t.mock.timers.tick(1);
		assert.equal(idle, 1);
		// A hold taken and released (e.g. the plugin's own push) is not an idle edge.
		hold.acquireHold({ owner: "p", reason: "r" })!.release();
		t.mock.timers.tick(hold.IDLE_DEBOUNCE_MS * 2);
		assert.equal(idle, 1);
		off();
	});

	it("work that starts within the debounce cancels the idle notification", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let idle = 0;
		hold.onHostIdle(() => { idle++; });
		hold.beginWork("turn", "a").end();
		t.mock.timers.tick(hold.IDLE_DEBOUNCE_MS - 10);
		const next = hold.beginWork("job", "j");
		t.mock.timers.tick(hold.IDLE_DEBOUNCE_MS);
		assert.equal(idle, 0);
		next.end();
		t.mock.timers.tick(hold.IDLE_DEBOUNCE_MS);
		assert.equal(idle, 1);
	});
});

describe("store backstop", () => {
	it("refuses writes inside the data folder while held; outside paths are never gated", () => {
		const inside = path.join(dataRoot, "chats", "a.json");
		fs.mkdirSync(path.dirname(inside), { recursive: true });
		const held = hold.acquireHold({ owner: "p", reason: "Syncing" })!;
		assert.throws(() => writeFileAtomicSync(inside, "{}"), hold.HostHoldError);
		assert.throws(() => appendLineSafe(path.join(dataRoot, "graph.jsonl"), "{}"), hold.HostHoldError);
		assert.equal(fs.existsSync(inside), false);
		writeFileAtomicSync(path.join(outside, "auth.json"), "{}"); // e.g. auth.json
		assertDataWritable(path.join(dataRoot, "..", path.basename(outside), "x"));
		held.release();
		writeFileAtomicSync(inside, "{}");
		assert.equal(fs.readFileSync(inside, "utf8"), "{}");
	});
});

describe("appendLineSafe", () => {
	it("appends one line per call", () => {
		const file = path.join(outside, "plain.jsonl");
		appendLineSafe(file, '{"a":1}');
		appendLineSafe(file, '{"a":2}');
		assert.equal(fs.readFileSync(file, "utf8"), '{"a":1}\n{"a":2}\n');
	});

	it("a torn tail (no trailing newline) costs only the torn line, never the next record", () => {
		const file = path.join(outside, "torn.jsonl");
		fs.writeFileSync(file, '{"a":1}\n{"a":2,"tor');
		appendLineSafe(file, '{"a":3}');
		const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
		const parsed = lines.flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
		assert.deepEqual(parsed, [{ a: 1 }, { a: 3 }]);
	});

	it("keeps the requested mode for new files", { skip: process.platform === "win32" && "POSIX modes" }, () => {
		const file = path.join(outside, "private.jsonl");
		appendLineSafe(file, "{}", { mode: 0o600 });
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	});
});

describe("request gate", () => {
	it("passes everything without a hold", () => {
		assert.equal(holdRequestRefusal("POST", "/api/chat"), null);
	});

	it("refuses requests that may write, but not reads, the holder's calls or cancel", () => {
		hold.acquireHold({ owner: "github-sync", reason: "GitHub Sync is syncing" });
		const refusal = holdRequestRefusal("POST", "/api/chat");
		assert.ok(refusal);
		assert.match(refusal.error, /GitHub Sync is syncing/);
		assert.deepEqual(refusal.hold, { owner: "github-sync", reason: "GitHub Sync is syncing" });
		assert.ok(holdRequestRefusal("PUT", "/api/settings/general"));
		assert.ok(holdRequestRefusal("DELETE", "/api/chats/x"));
		assert.ok(holdRequestRefusal("POST", "/api/plugins/other/call"));
		assert.equal(holdRequestRefusal("GET", "/api/chats"), null);
		assert.equal(holdRequestRefusal("HEAD", "/api/chats"), null);
		assert.equal(holdRequestRefusal("POST", "/api/plugins/github-sync/call"), null);
		assert.equal(holdRequestRefusal("POST", "/api/hold/cancel/"), null);
	});
});

describe("data format stamp", () => {
	const file = () => path.join(dataRoot, "data-format.json");
	beforeEach(() => fs.rmSync(file(), { force: true }));

	it("writes the current formats when missing, then leaves an identical stamp alone", () => {
		assert.equal(stampDataFormat(file()), "written");
		assert.deepEqual(JSON.parse(fs.readFileSync(file(), "utf8")), { ...CURRENT_DATA_FORMATS });
		const before = fs.statSync(file()).mtimeMs;
		assert.equal(stampDataFormat(file()), "current");
		assert.equal(fs.statSync(file()).mtimeMs, before);
	});

	it("upgrades an older stamp", () => {
		fs.writeFileSync(file(), JSON.stringify({ chat: 1, graph: CURRENT_DATA_FORMATS.graph, settings: CURRENT_DATA_FORMATS.settings }));
		assert.equal(stampDataFormat(file()), "written");
		assert.deepEqual(JSON.parse(fs.readFileSync(file(), "utf8")), { ...CURRENT_DATA_FORMATS });
	});

	it("never downgrades a stamp written by a newer build", () => {
		const newer = JSON.stringify({ ...CURRENT_DATA_FORMATS, graph: CURRENT_DATA_FORMATS.graph + 1 });
		fs.writeFileSync(file(), newer);
		assert.equal(stampDataFormat(file()), "newer");
		assert.equal(fs.readFileSync(file(), "utf8"), newer);
	});

	it("replaces an unreadable stamp", () => {
		fs.writeFileSync(file(), "{not json");
		assert.equal(stampDataFormat(file()), "written");
	});

	it("compares only known, valid keys", () => {
		assert.deepEqual(parseDataFormats({ chat: 3, graph: "2", settings: -1, extra: 9 }), { chat: 3 });
		assert.deepEqual(newerDataFormats({ chat: CURRENT_DATA_FORMATS.chat + 1, graph: 0 }), ["chat"]);
		assert.deepEqual(newerDataFormats({}), []);
	});
});
