/**
 * The on-device dictation engine's page side (issue #15, PR #50): the
 * worker client (components/local-dictation.worker.ts) and the pause
 * segmenter that turns the mic stream into utterances.
 *
 * Why segments: Deepgram commits a final ~300ms after each pause
 * (endpointing=300, the owner's tuned config). The local engine mirrors
 * that — the segmenter cuts the run at pauses and each utterance is
 * transcribed in the background WHILE the user keeps talking, so the
 * stop only waits for the last one. Same deferred transcript as the
 * cloud engine: results buffer and reach the input once, at the end.
 */

import type { LocalModelEntry, ModelDtype } from "@/src/core";

/** How to run a model: its files' dtype + the requested backend
 *  (core/dictation.ts localRunSpec). */
export type LocalRun = { dtype: ModelDtype; device: "webgpu" | "wasm" };

/** The capture worklet's frame: 2048 Int16 samples at 16 kHz = 128ms. */
const SAMPLE_RATE = 16000;
/** A frame louder than this (RMS, 0..1 ≈ −40 dB) counts as speech. The
 *  capture chain runs noise suppression + AGC, so room tone sits well
 *  below it. */
export const SPEECH_RMS = 0.01;
/** Pause that ends an utterance: 4 frames ≈ 512ms. */
export const PAUSE_FRAMES = 4;
/** Quiet frames kept before speech starts (≈256ms) so onsets aren't clipped. */
export const PREROLL_FRAMES = 2;
/** Hard cut: Whisper's window is 30s — cut well inside it. */
export const MAX_SEGMENT_SECONDS = 25;
/** An utterance needs this many loud frames (≈256ms) — a lone click or
 *  bump is dropped instead of transcribed into a phantom word. */
export const MIN_SPEECH_FRAMES = 2;

function frameRms(frame: Int16Array): number {
	let sum = 0;
	for (let i = 0; i < frame.length; i++) {
		const s = (frame[i] ?? 0) / 0x8000;
		sum += s * s;
	}
	return frame.length ? Math.sqrt(sum / frame.length) : 0;
}

function toFloat(frames: Int16Array[]): Float32Array {
	const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
	let o = 0;
	for (const f of frames) for (let i = 0; i < f.length; i++) out[o++] = (f[i] ?? 0) / 0x8000;
	return out;
}

export type Segmenter = { push: (frame: Int16Array) => void; flush: () => void };

/** Cut a linear16 frame stream into utterances at pauses. Silence-only
 *  stretches never emit (Whisper hallucinates on silence). Pure apart
 *  from the callback — unit-tested in tests/local-dictation.test.ts. */
export function createSegmenter(onSegment: (audio: Float32Array) => void): Segmenter {
	let frames: Int16Array[] = [];
	let preroll: Int16Array[] = [];
	let quiet = 0;
	let loud = 0;
	let samples = 0;
	const emit = () => {
		if (loud >= MIN_SPEECH_FRAMES) onSegment(toFloat(frames));
		frames = [];
		quiet = 0;
		loud = 0;
		samples = 0;
	};
	return {
		push(frame) {
			const speech = frameRms(frame) >= SPEECH_RMS;
			if (frames.length === 0) {
				if (!speech) {
					preroll.push(frame);
					if (preroll.length > PREROLL_FRAMES) preroll.shift();
					return;
				}
				frames = preroll;
				preroll = [];
				samples = frames.reduce((n, f) => n + f.length, 0);
			}
			frames.push(frame);
			samples += frame.length;
			if (speech) loud++;
			quiet = speech ? 0 : quiet + 1;
			if (quiet >= PAUSE_FRAMES || samples >= MAX_SEGMENT_SECONDS * SAMPLE_RATE) emit();
		},
		flush: emit,
	};
}

// ─── Worker client ───────────────────────────────────────────────────────────

/** The worker's /api requests, made by the page (the worker's header has
 *  why): only same-origin /api/stt/ reads; the body goes back as a
 *  transferred stream, so even a 600 MB model is never buffered here. */
async function fetchForWorker(w: Worker, id: number, url: string, method: string, headers: [string, string][]) {
	try {
		const target = new URL(url, location.href);
		if (target.origin !== location.origin || !target.pathname.startsWith("/api/stt/")) throw new Error("blocked");
		if (method !== "GET" && method !== "HEAD") throw new Error("blocked");
		const res = await fetch(target, { method, headers, cache: "no-store" });
		const body = res.body;
		w.postMessage(
			{ type: "fetched", id, status: res.status, headers: [...res.headers.entries()], body },
			body ? [body as unknown as Transferable] : [],
		);
	} catch (e) {
		w.postMessage({ type: "fetched", id, error: e instanceof Error ? e.message : String(e) });
	}
}

type Pending = { resolve: (text: string) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
type Load = { promise: Promise<string>; resolve: (device: string) => void; reject: (e: Error) => void };
const loads = new Map<string, Load>();

function runKey(model: LocalModelEntry, run: LocalRun): string {
	return `${model.id}|${run.device}|${run.dtype.encoder_model}/${run.dtype.decoder_model_merged}`;
}

function spec(model: LocalModelEntry, run: LocalRun) {
	return { id: model.id, dtype: run.dtype, device: run.device };
}

function ensureWorker(): Worker {
	if (worker) return worker;
	const w = new Worker(new URL("./local-dictation.worker.ts", import.meta.url), { type: "module" });
	w.addEventListener("message", (ev: MessageEvent) => {
		const msg = ev.data as {
			type: string;
			id?: number;
			key?: string;
			device?: string;
			text?: string;
			message?: string;
			url?: string;
			method?: string;
			headers?: [string, string][];
		};
		if (msg.type === "fetch") {
			void fetchForWorker(w, msg.id ?? 0, msg.url ?? "", msg.method ?? "GET", msg.headers ?? []);
		} else if (msg.type === "loaded" || msg.type === "load-error") {
			const l = loads.get(msg.key ?? "");
			if (!l) return;
			if (msg.type === "loaded") l.resolve(msg.device ?? "wasm");
			else {
				loads.delete(msg.key ?? "");
				l.reject(new Error(msg.message ?? "Model failed to load"));
			}
		} else if (msg.type === "result" || msg.type === "transcribe-error") {
			const p = pending.get(msg.id ?? -1);
			if (!p) return;
			pending.delete(msg.id ?? -1);
			if (msg.type === "result") p.resolve(msg.text ?? "");
			else p.reject(new Error(msg.message ?? "Transcription failed"));
		}
	});
	w.addEventListener("error", () => {
		// A dead worker fails everything in flight; the next call respawns.
		for (const l of loads.values()) l.reject(new Error("Dictation engine crashed"));
		for (const p of pending.values()) p.reject(new Error("Dictation engine crashed"));
		loads.clear();
		pending.clear();
		worker = null;
	});
	worker = w;
	return w;
}

/** Load (once per model + files + device) and keep it warm in the
 *  worker. Resolves with the device that actually runs it ("webgpu", or
 *  "wasm" when WebGPU couldn't start). A failed load is forgotten, so the
 *  next call retries; a new spec for the same model replaces the old. */
export function loadLocalModel(model: LocalModelEntry, run: LocalRun): Promise<string> {
	const key = runKey(model, run);
	const existing = loads.get(key);
	if (existing) return existing.promise;
	for (const k of loads.keys()) if (k.startsWith(`${model.id}|`)) loads.delete(k);
	let resolve!: (device: string) => void;
	let reject!: (e: Error) => void;
	const promise = new Promise<string>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	loads.set(key, { promise, resolve, reject });
	ensureWorker().postMessage({ type: "load", key, model: spec(model, run) });
	return promise;
}

export function transcribeLocal(model: LocalModelEntry, run: LocalRun, audio: Float32Array): Promise<string> {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		ensureWorker().postMessage({ type: "transcribe", id, key: runKey(model, run), model: spec(model, run), audio }, [
			audio.buffer,
		]);
	});
}
