/**
 * Unit tests — local dictation (issue #15, PR #50): the method selection rules (src/core/dictation.ts),
 * the curated download filter and the pause segmenter
 * (components/local-dictation.ts).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
	LOCAL_DICTATION_MODELS,
	ORT_WEB_VERSION,
	formatModelSize,
	formatWer,
	localMethodId,
	localModelOf,
	localRunSpec,
	modelFileWanted,
	reconcileDictationSelection,
	sanitizeDictationState,
} from "../src/core/dictation.ts";
import { MIN_SPEECH_FRAMES, PAUSE_FRAMES, PREROLL_FRAMES, createSegmenter } from "../components/local-dictation.ts";

describe("where local models run", () => {
	const model = LOCAL_DICTATION_MODELS[0]!;

	it("defaults to WebGPU, keeps a CPU pick", () => {
		assert.equal(sanitizeDictationState(null).device, "webgpu");
		assert.equal(sanitizeDictationState({ device: "cpu" }).device, "cpu");
		assert.equal(sanitizeDictationState({ device: "tpu" }).device, "webgpu");
	});

	it("GPU-ready files run where the picker says", () => {
		assert.deepEqual(localRunSpec(model, "webgpu"), { dtype: model.dtype, device: "webgpu" });
		assert.deepEqual(localRunSpec(model, "cpu"), { dtype: model.dtype, device: "wasm" });
	});
});

describe("dictation method (single choice, no fallback — issue #15)", () => {
	it("keeps the selection while it is configured", () => {
		assert.equal(reconcileDictationSelection("deepgram", ["local:a", "deepgram"]), "deepgram");
	});

	it("nothing selected → the first configured method in setup order", () => {
		assert.equal(reconcileDictationSelection(null, ["local:a", "deepgram"]), "local:a");
		assert.equal(reconcileDictationSelection(null, []), null);
	});

	it("a selection that is gone (model removed, key deleted) falls to the default choice", () => {
		assert.equal(reconcileDictationSelection("local:b", ["deepgram"]), "deepgram");
		assert.equal(reconcileDictationSelection("deepgram", []), null);
	});

	it("sanitizes the stored record field by field", () => {
		assert.deepEqual(sanitizeDictationState(null), { selected: null, device: "webgpu" });
		assert.deepEqual(sanitizeDictationState({ selected: "deepgram", device: "cpu" }), { selected: "deepgram", device: "cpu" });
		assert.deepEqual(sanitizeDictationState({ selected: 3, device: "tpu" }), { selected: null, device: "webgpu" });
	});
});

describe("the curated catalog", () => {
	it("ids are unique and resolve through their method id", () => {
		const ids = LOCAL_DICTATION_MODELS.map((m) => m.id);
		assert.equal(new Set(ids).size, ids.length);
		for (const m of LOCAL_DICTATION_MODELS) assert.equal(localModelOf(localMethodId(m.id)), m);
		assert.equal(localModelOf("deepgram"), undefined);
	});

	it("downloads root JSON plus exactly the chosen files", () => {
		const gpu = { encoder_model: "fp32", decoder_model_merged: "q4" } as const;
		assert.ok(modelFileWanted("config.json", gpu));
		assert.ok(modelFileWanted("tokenizer.json", gpu));
		assert.ok(!modelFileWanted("README.md", gpu));
		assert.ok(!modelFileWanted("merges.txt", gpu));
		assert.ok(modelFileWanted("onnx/encoder_model.onnx", gpu));
		assert.ok(modelFileWanted("onnx/encoder_model.onnx_data", gpu));
		assert.ok(modelFileWanted("onnx/decoder_model_merged_q4.onnx", gpu));
		assert.ok(!modelFileWanted("onnx/encoder_model_quantized.onnx", gpu));
		assert.ok(!modelFileWanted("onnx/decoder_model_merged.onnx", gpu));
		assert.ok(!modelFileWanted("onnx/encoder_model_q4f16.onnx", { encoder_model: "q4", decoder_model_merged: "q4" }));
	});

	it("every model carries its published WER, or null for none (\"WER n/a\")", () => {
		for (const m of LOCAL_DICTATION_MODELS) assert.ok(m.werPct === null || (m.werPct > 0 && m.werPct < 100), m.id);
		assert.equal(formatWer(8.59), "8.59% WER");
		assert.equal(formatWer(null), "WER n/a");
	});

	it("lists smallest download first", () => {
		const sizes = LOCAL_DICTATION_MODELS.map((m) => m.sizeMb);
		assert.deepEqual(sizes, [...sizes].sort((x, y) => x - y));
	});

	it("prefetches the runtime version the engine actually loads", () => {
		const installed = JSON.parse(fs.readFileSync("node_modules/onnxruntime-web/package.json", "utf-8")) as { version: string };
		assert.equal(ORT_WEB_VERSION, installed.version);
	});

	it("formats sizes short", () => {
		assert.equal(formatModelSize(81), "81 MB");
		assert.equal(formatModelSize(1250), "1.3 GB");
	});
});

describe("pause segmenter", () => {
	const loud = () => new Int16Array(2048).fill(8000); // RMS ≈ 0.24
	const quiet = () => new Int16Array(2048);

	it("cuts an utterance at a pause, keeping the pre-roll", () => {
		const out: Float32Array[] = [];
		const seg = createSegmenter((a) => out.push(a));
		for (let i = 0; i < 5; i++) seg.push(quiet());
		for (let i = 0; i < 6; i++) seg.push(loud());
		for (let i = 0; i < PAUSE_FRAMES; i++) seg.push(quiet());
		assert.equal(out.length, 1);
		assert.equal(out[0]!.length, (PREROLL_FRAMES + 6 + PAUSE_FRAMES) * 2048);
	});

	it("never emits silence, and drops a lone click", () => {
		const out: Float32Array[] = [];
		const seg = createSegmenter((a) => out.push(a));
		for (let i = 0; i < 20; i++) seg.push(quiet());
		seg.flush();
		for (let i = 0; i < MIN_SPEECH_FRAMES - 1; i++) seg.push(loud());
		for (let i = 0; i < PAUSE_FRAMES; i++) seg.push(quiet());
		assert.equal(out.length, 0);
	});

	it("flush emits the utterance in progress (the stop)", () => {
		const out: Float32Array[] = [];
		const seg = createSegmenter((a) => out.push(a));
		for (let i = 0; i < 4; i++) seg.push(loud());
		assert.equal(out.length, 0);
		seg.flush();
		assert.equal(out.length, 1);
	});

	it("hard-cuts long speech inside Whisper's 30s window", () => {
		const out: Float32Array[] = [];
		const seg = createSegmenter((a) => out.push(a));
		for (let i = 0; i < 400; i++) seg.push(loud()); // 51s
		assert.equal(out.length, 2);
		assert.ok(out.every((a) => a.length < 30 * 16000));
	});
});
