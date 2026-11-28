import assert from "node:assert/strict";
import type { ChildProcess, ForkOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createLocalTranscriber, LOCAL_STT_CRASHED, transcriberEnv } from "../src/server/local-stt/runtime.ts";

const require = createRequire(import.meta.url);
const { splitAtQuietPoints, pcm16ToFloat32 } = require("../src/server/local-stt/split.cjs") as {
	splitAtQuietPoints: (samples: Float32Array, rate: number, maxSeconds?: number) => Array<[number, number]>;
	pcm16ToFloat32: (pcm: Uint8Array) => Float32Array;
};

test("short clips stay whole; long clips cut at the quietest point inside each window", () => {
	const rate = 100;
	assert.deepEqual(splitAtQuietPoints(new Float32Array(0), rate, 10), []);
	assert.deepEqual(splitAtQuietPoints(new Float32Array(500), rate, 10), [[0, 500]]);
	// 25 s of loud audio with one quiet gap at 8.5 s: the first cut lands in it.
	const samples = new Float32Array(2500).fill(0.5);
	samples.fill(0, 850, 860);
	const ranges = splitAtQuietPoints(samples, rate, 10);
	assert.equal(ranges[0]![0], 0);
	assert.ok(ranges[0]![1] >= 850 && ranges[0]![1] <= 860, `cut at ${ranges[0]![1]}`);
	for (const [start, end] of ranges) assert.ok(end - start <= 1000);
	for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i]![0], ranges[i - 1]![1]);
	assert.equal(ranges.at(-1)![1], 2500);
});

test("16-bit PCM converts to floats and ignores a trailing odd byte", () => {
	const pcm = new Uint8Array([0x00, 0x80, 0xff, 0x7f, 0x00, 0x00, 0x01]);
	assert.deepEqual([...pcm16ToFloat32(pcm)], [-1, 32767 / 32768, 0]);
});

test("the child gets no keys or desktop secrets", () => {
	const env = transcriberEnv({
		PATH: "/bin", ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production",
		DEEPGRAM_API_KEY: "secret", LH_DESKTOP_API_SECRET: "secret", OPENAI_API_KEY: "secret",
	});
	assert.deepEqual(env, { PATH: "/bin", ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production" });
});

class FakeChild extends EventEmitter {
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	stderr = new EventEmitter();
	sent: Array<{ id: number; dir: string; pcm: Uint8Array }> = [];
	send(message: { id: number; dir: string; pcm: Uint8Array }, callback?: (error: Error | null) => void) {
		this.sent.push(message);
		callback?.(null);
		return true;
	}
	kill() {
		this.exit(null, "SIGTERM");
		return true;
	}
	exit(code: number | null, signal: NodeJS.Signals | null = null) {
		if (this.exitCode !== null || this.signalCode !== null) return;
		this.exitCode = code;
		this.signalCode = signal;
		this.emit("exit", code, signal);
	}
	reply(text: string) {
		this.emit("message", { id: this.sent.at(-1)!.id, text });
	}
}

function harness(idleMs = 60_000) {
	const children: FakeChild[] = [];
	const forks: ForkOptions[] = [];
	const transcriber = createLocalTranscriber({
		workerPath: "/worker.cjs",
		idleMs,
		forkImpl: (_path, _args, options) => {
			forks.push(options);
			const child = new FakeChild();
			children.push(child);
			return child as unknown as ChildProcess;
		},
	});
	return { transcriber, children, forks };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("one child serves clips in order with IPC and no inherited exec flags", async () => {
	const { transcriber, children, forks } = harness();
	const first = transcriber.transcribe("/model", new Uint8Array([1, 0]));
	const second = transcriber.transcribe("/model", new Uint8Array([2, 0]));
	await tick();
	assert.equal(children.length, 1);
	assert.deepEqual(forks[0]!.execArgv, []);
	assert.equal(forks[0]!.serialization, "advanced");
	assert.equal(children[0]!.sent.length, 1, "the second clip waits for the first");
	children[0]!.reply("one");
	assert.equal(await first, "one");
	await tick();
	assert.equal(children[0]!.sent.length, 2);
	children[0]!.reply("two");
	assert.equal(await second, "two");
});

test("a crash fails the clip in flight and the next clip starts a fresh child", async () => {
	const { transcriber, children } = harness();
	const clip = transcriber.transcribe("/model", new Uint8Array([1, 0]));
	await tick();
	children[0]!.stderr.emit("data", Buffer.from("onnxruntime: out of memory\n"));
	children[0]!.exit(null, "SIGSEGV");
	await assert.rejects(clip, (error: Error) => error.message.startsWith(LOCAL_STT_CRASHED) && /SIGSEGV/.test(error.message) && /out of memory/.test(error.message));
	const next = transcriber.transcribe("/model", new Uint8Array([1, 0]));
	await tick();
	assert.equal(children.length, 2);
	children[1]!.reply("back");
	assert.equal(await next, "back");
});

test("a worker error reply rejects only that clip", async () => {
	const { transcriber, children } = harness();
	const clip = transcriber.transcribe("/model", new Uint8Array([1, 0]));
	await tick();
	children[0]!.emit("message", { id: children[0]!.sent[0]!.id, error: "bad model" });
	await assert.rejects(clip, /bad model/);
	assert.equal(children[0]!.exitCode, null);
});

test("the child stops after the idle period and on stop()", async () => {
	const { transcriber, children } = harness(20);
	const clip = transcriber.transcribe("/model", new Uint8Array([1, 0]));
	await tick();
	children[0]!.reply("x");
	await clip;
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(children[0]!.signalCode, "SIGTERM");

	const again = transcriber.transcribe("/model", new Uint8Array([1, 0]));
	await tick();
	children[1]!.reply("y");
	await again;
	await transcriber.stop();
	assert.equal(children[1]!.signalCode, "SIGTERM");
	await transcriber.stop(); // nothing running: resolves
});

test("the real worker loads the native addon and reports a missing model as an error", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-no-model-"));
	const transcriber = createLocalTranscriber({ workerPath: path.resolve("src/server/local-stt/worker.cjs") });
	try {
		// Silence never loads the recognizer: an empty transcript, not an error.
		assert.equal(await transcriber.transcribe(dir, new Uint8Array(32_000)), "");
		// Audible input does: sherpa-onnx refuses the missing files.
		const tone = new Int16Array(16_000);
		for (let i = 0; i < tone.length; i++) tone[i] = Math.round(Math.sin(i / 8) * 8000);
		await assert.rejects(transcriber.transcribe(dir, new Uint8Array(tone.buffer)), (error: Error) => !error.message.startsWith(LOCAL_STT_CRASHED));
	} finally {
		await transcriber.stop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// Opt-in: LH_LOCAL_STT_MODEL_DIR points at a downloaded Parakeet v3 directory
// and LH_LOCAL_STT_WAV at a 16 kHz mono 16-bit WAV with English speech.
test("real model transcription", { skip: !process.env.LH_LOCAL_STT_MODEL_DIR || !process.env.LH_LOCAL_STT_WAV }, async () => {
	const wav = fs.readFileSync(process.env.LH_LOCAL_STT_WAV!);
	let at = 12;
	let pcm: Uint8Array | null = null;
	while (at < wav.length && !pcm) {
		const size = wav.readUInt32LE(at + 4);
		if (wav.toString("ascii", at, at + 4) === "data") pcm = new Uint8Array(wav.buffer, wav.byteOffset + at + 8, size);
		at += 8 + size + (size % 2);
	}
	const transcriber = createLocalTranscriber({ workerPath: path.resolve("src/server/local-stt/worker.cjs") });
	try {
		const text = await transcriber.transcribe(process.env.LH_LOCAL_STT_MODEL_DIR!, pcm!);
		assert.match(text, /\w{3,}/);
	} finally {
		await transcriber.stop();
	}
});
