/**
 * Unit tests — Apple on-device dictation: the main-process helper bridge
 * (electron/apple-speech.cjs) and the renderer's pure engine rules
 * (components/apple-speech.ts). The Swift helper itself needs macOS 26;
 * here a fake child process speaks its JSON-lines protocol.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { appleModelReady, appleRowStatus, chooseEngine, type AppleSpeechStatus } from "../components/apple-speech.ts";

const require = createRequire(import.meta.url);
const { createAppleSpeech, appleSpeechControl, hostSupported, jsonLines } = require("../electron/apple-speech.cjs");

type FakeChild = EventEmitter & {
	args: string[];
	stdout: EventEmitter;
	stderr: EventEmitter;
	stdin: EventEmitter & { writable: boolean; written: Buffer[]; ended: boolean; write: (b: Buffer) => void; end: () => void };
	killed: string | null;
	kill: (signal: string) => void;
	say: (value: unknown) => void;
	exit: (code: number | null, signal?: string | null) => void;
};

function fakeSpawner() {
	const children: FakeChild[] = [];
	const spawnImpl = (_path: string, args: string[]) => {
		const child = new EventEmitter() as FakeChild;
		child.args = args;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		const stdin = new EventEmitter() as FakeChild["stdin"];
		stdin.writable = true;
		stdin.written = [];
		stdin.ended = false;
		stdin.write = (b) => void stdin.written.push(b);
		stdin.end = () => {
			stdin.ended = true;
			stdin.writable = false;
		};
		child.stdin = stdin;
		child.killed = null;
		child.kill = (signal) => {
			child.killed = signal;
			child.exit(null, signal);
		};
		child.say = (value) => child.stdout.emit("data", Buffer.from(JSON.stringify(value) + "\n"));
		child.exit = (code, signal = null) => child.emit("close", code, signal);
		children.push(child);
		return child;
	};
	const kid = (i: number): FakeChild => {
		const child = children[i];
		assert.ok(child, `child ${i} was spawned`);
		return child;
	};
	return { children, kid, spawnImpl };
}

const mac = { helperPath: "/h", platform: "darwin", arch: "arm64", systemVersion: "26.1.0", exists: () => true };

describe("apple-speech host gate", () => {
	it("needs macOS 26 or later on Apple silicon, with the helper present", () => {
		assert.equal(hostSupported(mac), true);
		assert.equal(hostSupported({ ...mac, systemVersion: "27.0.0" }), true); // a minimum, not an exact match
		assert.equal(hostSupported({ ...mac, systemVersion: "15.6.1" }), false);
		assert.equal(hostSupported({ ...mac, arch: "x64" }), false);
		assert.equal(hostSupported({ ...mac, platform: "linux" }), false);
		assert.equal(hostSupported({ ...mac, exists: () => false }), false);
	});

	it("reports unavailable without spawning on unsupported hosts", async () => {
		const { children, kid, spawnImpl } = fakeSpawner();
		const speech = createAppleSpeech({ ...mac, systemVersion: "15.0", spawnImpl });
		assert.deepEqual(await speech.status(), { available: false });
		assert.equal(children.length, 0);
	});
});

describe("apple-speech JSON lines", () => {
	it("joins split chunks and drops malformed lines", () => {
		const values: unknown[] = [];
		const feed = jsonLines((v: unknown) => values.push(v));
		feed(Buffer.from('{"a":1}\n{"b"'));
		feed(Buffer.from(':2}\nnot json\n\n'));
		assert.deepEqual(values, [{ a: 1 }, { b: 2 }]);
	});
});

describe("apple-speech helper bridge", () => {
	it("status maps the helper's line", async () => {
		const { children, kid, spawnImpl } = fakeSpawner();
		const speech = createAppleSpeech({ ...mac, spawnImpl });
		const pending = speech.status();
		kid(0).say({ available: true, locale: "en-US", language: "English (United States)", model: "installed", reserved: true });
		kid(0).exit(0);
		assert.deepEqual(await pending, { available: true, locale: "en-US", language: "English (United States)", model: "installed", reserved: true });
		assert.deepEqual(kid(0).args, ["status"]);
	});

	it("install broadcasts progress, joins a second call, and reports downloading in status", async () => {
		const { children, kid, spawnImpl } = fakeSpawner();
		const events: unknown[] = [];
		const speech = createAppleSpeech({ ...mac, spawnImpl, broadcast: (e: unknown) => events.push(e) });
		const first = speech.install();
		assert.equal(speech.install(), first); // one download at a time
		kid(0).say({ type: "progress", fraction: 0.4 });
		const status = speech.status();
		kid(1).say({ available: true, locale: "en-US", language: "English", model: "supported", reserved: true });
		kid(1).exit(0);
		assert.equal((await status).model, "downloading");
		kid(0).say({ type: "done" });
		kid(0).exit(0);
		await first;
		assert.deepEqual(events, [{ type: "progress", fraction: 0 }, { type: "progress", fraction: 0.4 }, { type: "done" }]);
	});

	it("install surfaces the helper's error", async () => {
		const { children, kid, spawnImpl } = fakeSpawner();
		const events: unknown[] = [];
		const speech = createAppleSpeech({ ...mac, spawnImpl, broadcast: (e: unknown) => events.push(e) });
		const pending = speech.install();
		kid(0).say({ type: "error", message: "offline" });
		kid(0).exit(1);
		await assert.rejects(pending, /offline/);
		assert.deepEqual(events.at(-1), { type: "error", message: "offline" });
	});

	it("a session streams audio to stdin, relays finals, and stop closes stdin", () => {
		const { children, kid, spawnImpl } = fakeSpawner();
		const sent: unknown[] = [];
		const speech = createAppleSpeech({ ...mac, spawnImpl });
		const id = speech.start((e: unknown) => sent.push(e));
		const child = kid(0);
		assert.deepEqual(child.args, ["transcribe"]);
		child.say({ type: "ready" });
		speech.audio(id, new Uint8Array([1, 2, 3, 4]));
		speech.audio(id + 1, new Uint8Array([9])); // a stale session's frames are dropped
		assert.deepEqual(Buffer.concat(child.stdin.written), Buffer.from([1, 2, 3, 4]));
		child.say({ type: "final", text: "hello world" });
		speech.stop(id);
		assert.equal(child.stdin.ended, true);
		child.say({ type: "end" });
		child.exit(0);
		assert.deepEqual(sent, [
			{ session: id, type: "ready" },
			{ session: id, type: "final", text: "hello world" },
			{ session: id, type: "end" },
		]);
	});

	it("cancel kills the helper silently; a crash reports an error", () => {
		const { children, kid, spawnImpl } = fakeSpawner();
		const sent: Array<{ type: string }> = [];
		const push = (e: { type: string }) => void sent.push(e);
		const speech = createAppleSpeech({ ...mac, spawnImpl });
		const first = speech.start(push);
		speech.cancel(first);
		assert.equal(kid(0).killed, "SIGKILL");
		assert.equal(sent.length, 0);
		speech.start(push);
		kid(1).stderr.emit("data", Buffer.from("boom"));
		kid(1).exit(3);
		assert.equal(sent.at(-1)?.type, "error");
	});

	it("a new session replaces the live one", () => {
		const { children, kid, spawnImpl } = fakeSpawner();
		const speech = createAppleSpeech({ ...mac, spawnImpl });
		speech.start(() => {});
		speech.start(() => {});
		assert.equal(kid(0).killed, "SIGKILL");
		assert.equal(kid(1).killed, null);
	});

	it("control rejects unknown operations", async () => {
		await assert.rejects(appleSpeechControl({ op: "nope" }, {}, () => {}), /Unsupported/);
	});
});

describe("dictation engine choice", () => {
	const ready: AppleSpeechStatus = { available: true, locale: "en-US", language: "English", model: "installed", reserved: true };

	it("a Deepgram key wins; keyless falls back to Apple when usable", () => {
		assert.equal(chooseEngine(true, ready), "deepgram");
		assert.equal(chooseEngine(false, ready), "apple");
		assert.equal(chooseEngine(false, { ...ready, model: "supported" }), "apple"); // the download prompt follows
		assert.equal(chooseEngine(false, { ...ready, model: "unsupported" }), "keyless");
		assert.equal(chooseEngine(false, { available: false }), "keyless");
		assert.equal(chooseEngine(false, null), "keyless");
	});

	it("the model is ready when it is on the Mac, reserved by this app or not", () => {
		assert.equal(appleModelReady(ready), true);
		assert.equal(appleModelReady({ ...ready, reserved: false }), true); // macOS keeps a released model until it purges it
		assert.equal(appleModelReady({ ...ready, model: "supported" }), false);
	});

	it("the Settings status line", () => {
		assert.equal(appleRowStatus(ready), "installed");
		assert.equal(appleRowStatus({ ...ready, reserved: false }), "installed");
		assert.equal(appleRowStatus({ ...ready, model: "supported" }), "not installed");
		assert.equal(appleRowStatus({ ...ready, model: "downloading", progress: 0.42 }), "downloading 42%");
	});
});
