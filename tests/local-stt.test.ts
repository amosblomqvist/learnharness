/**
 * Unit tests — local dictation (src/server/local-stt.ts + the client's
 * engine choice in components/dictation.tsx).
 *
 * The helper itself (Swift + CoreML) is not run here: a fake child process
 * speaks its stdio protocol, so these pin the server's side of the
 * contract — framing, availability, FIFO results, boot failures, crash
 * recovery — and the client's keyed-wins / keyless-falls-back rule.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createLocalStt, frameRequest, parseHelperLine } from "../src/server/local-stt.ts";
import { DICTATION_KEYLESS, joinPcm, resolveEngine } from "../components/dictation.tsx";

/** A scripted stand-in for lh-parakeet-stt: decodes request frames from
 *  stdin and answers through `reply` (default: echo the byte count). */
function fakeHelper(opts: { boot?: "ready" | "fail"; reply?: (pcm: Buffer) => string } = {}) {
	const spawned: Array<{ kill: () => void; requests: Buffer[] }> = [];
	const spawn = () => {
		const proc = new EventEmitter() as ChildProcessWithoutNullStreams;
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		Object.assign(proc, { stdin, stdout, stderr });
		const requests: Buffer[] = [];
		let pending = Buffer.alloc(0);
		stdin.on("data", (chunk: Buffer) => {
			pending = Buffer.concat([pending, chunk]);
			while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
				const n = pending.readUInt32LE(0);
				const pcm = pending.subarray(4, 4 + n);
				pending = pending.subarray(4 + n);
				requests.push(pcm);
				stdout.write((opts.reply ?? ((p) => JSON.stringify({ type: "result", text: `${p.length} bytes` })))(pcm) + "\n");
			}
		});
		const kill = () => setImmediate(() => proc.emit("exit", null, "SIGTERM"));
		Object.assign(proc, { kill });
		setImmediate(() => {
			if (opts.boot === "fail") {
				stdout.write(JSON.stringify({ type: "error", message: "Parakeet failed to load: no network" }) + "\n");
				setImmediate(() => proc.emit("exit", 1, null));
			} else {
				stdout.write("some library log line\n"); // non-protocol noise is ignored
				stdout.write(JSON.stringify({ type: "ready", model: "v2", downloaded: false }) + "\n");
			}
		});
		spawned.push({ kill, requests });
		return proc;
	};
	return { spawn, spawned };
}

function engine(helper: ReturnType<typeof fakeHelper>, over: Partial<Parameters<typeof createLocalStt>[0]> = {}) {
	return createLocalStt({
		bin: "/fake/lh-parakeet-stt",
		platform: "darwin",
		arch: "arm64",
		exists: () => true,
		spawn: helper.spawn,
		idleMs: 60_000,
		...over,
	});
}

describe("local dictation — protocol helpers", () => {
	it("frames a request as u32-LE length + PCM", () => {
		const frame = frameRequest(new Uint8Array([1, 2, 3]));
		assert.equal(frame.readUInt32LE(0), 3);
		assert.deepEqual([...frame.subarray(4)], [1, 2, 3]);
	});

	it("parses protocol lines and ignores everything else", () => {
		assert.deepEqual(parseHelperLine('{"type":"ready","model":"v3","downloaded":true}'), { type: "ready", model: "v3" });
		assert.deepEqual(parseHelperLine('{"type":"result","text":"hi"}'), { type: "result", text: "hi" });
		assert.deepEqual(parseHelperLine('{"type":"error","message":"x"}'), { type: "error", message: "x" });
		assert.equal(parseHelperLine("[FluidAudio] loading encoder"), null);
		assert.equal(parseHelperLine('{"type":"result"}'), null);
	});

	it("joins captured frames into one upload body, in order, byte-exact", () => {
		// The worklet posts Int16Array frames; values past ±127 prove bytes
		// are copied, not element values truncated to Uint8.
		const frames = [new Int16Array([1000, -2000]), new Int16Array([32767])];
		assert.deepEqual([...new Int16Array(joinPcm(frames).buffer)], [1000, -2000, 32767]);
		// Plain ArrayBuffers (the declared type) join the same way.
		assert.deepEqual([...new Int16Array(joinPcm([new Int16Array([-5]).buffer]).buffer)], [-5]);
	});
});

describe("local dictation — the engine", () => {
	it("is available only on Apple Silicon macOS with the helper present", () => {
		const h = fakeHelper();
		assert.equal(engine(h).status().available, true);
		assert.equal(engine(h, { platform: "linux" }).status().available, false);
		assert.equal(engine(h, { arch: "x64" }).status().available, false);
		assert.equal(engine(h, { exists: () => false }).status().available, false);
	});

	it("warm() spawns once; transcriptions resolve FIFO from one helper", async () => {
		const h = fakeHelper();
		const e = engine(h);
		e.warm();
		e.warm();
		const [a, b] = await Promise.all([e.transcribe(new Uint8Array(4)), e.transcribe(new Uint8Array(10))]);
		assert.equal(a, "4 bytes");
		assert.equal(b, "10 bytes");
		assert.equal(h.spawned.length, 1);
		assert.equal(e.status().state, "ready");
		assert.equal(e.status().model, "v2");
	});

	it("a per-request error rejects that request only", async () => {
		const h = fakeHelper({ reply: () => JSON.stringify({ type: "error", message: "decode failed" }) });
		const e = engine(h);
		await assert.rejects(e.transcribe(new Uint8Array(2)), /decode failed/);
		assert.equal(e.status().state, "ready");
	});

	it("a boot failure surfaces the helper's own message, then the next call respawns", async () => {
		const h = fakeHelper({ boot: "fail" });
		const e = engine(h);
		await assert.rejects(e.transcribe(new Uint8Array(2)), /no network/);
		assert.equal(e.status().state, "stopped");
		assert.match(e.status().error ?? "", /no network/);
		await assert.rejects(e.transcribe(new Uint8Array(2)));
		assert.equal(h.spawned.length, 2);
	});

	it("after the helper exits (idle kill / crash), the next run respawns it", async () => {
		const h = fakeHelper();
		const e = engine(h);
		assert.equal(await e.transcribe(new Uint8Array(2)), "2 bytes");
		e.stop();
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(e.status().state, "stopped");
		assert.equal(await e.transcribe(new Uint8Array(6)), "6 bytes");
		assert.equal(h.spawned.length, 2);
	});

	it("refuses (without spawning) where it is unavailable", async () => {
		const h = fakeHelper();
		const e = engine(h, { platform: "win32" });
		e.warm();
		await assert.rejects(e.transcribe(new Uint8Array(2)), /unavailable/);
		assert.equal(h.spawned.length, 0);
	});
});

describe("dictation engine choice", () => {
	const keyless = async (): Promise<string> => {
		throw new Error(DICTATION_KEYLESS);
	};

	it("a Deepgram key keeps winning — the local probe is never consulted", async () => {
		let probed = false;
		const choice = await resolveEngine(
			async () => "tok",
			async () => {
				probed = true;
				return true;
			},
		);
		assert.deepEqual(choice, { kind: "deepgram", token: "tok" });
		assert.equal(probed, false);
	});

	it("keyless + local available → local", async () => {
		assert.deepEqual(await resolveEngine(keyless, async () => true), { kind: "local" });
	});

	it("keyless + no local engine (or a failed probe) → the keyless error stands", async () => {
		await assert.rejects(resolveEngine(keyless, async () => false), { message: DICTATION_KEYLESS });
		await assert.rejects(
			resolveEngine(keyless, async () => {
				throw new Error("offline");
			}),
			{ message: DICTATION_KEYLESS },
		);
	});

	it("a non-keyless Deepgram failure is reported as-is, not masked by local", async () => {
		await assert.rejects(
			resolveEngine(
				async () => {
					throw new Error("Deepgram token grant failed (403)");
				},
				async () => true,
			),
			/403/,
		);
	});
});
