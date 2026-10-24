/**
 * The on-device dictation engine (issue #15, PR #50): a module
 * Web Worker running transformers.js speech recognition, so model loads
 * and inference never block the page.
 *
 * Everything loads from OUR server, never the Hub or a CDN at run time:
 *  - model files → /api/stt/files/<id>/… (downloaded into the data dir
 *    from Settings → Providers → Dictation);
 *  - the ONNX runtime → /api/stt/runtime/<version>/… (fetched once by the
 *    server, then kept — offline from there on).
 * Browser caches stay off: the desktop renderer's origin changes every
 * launch, so they would only ever be cold.
 *
 * Every /api request goes THROUGH THE PAGE (env.fetch → postMessage →
 * the page's fetch → a transferred body stream). The desktop shell only
 * attaches its per-launch API capability to the main window's own
 * requests (electron/desktop-api.cjs), so a worker fetching /api itself
 * would be refused in the packaged app.
 *
 * Device: the spec says webgpu or wasm (CPU). A
 * webgpu load that can't start — no adapter, or the session is refused
 * — loads the same files on wasm; "loaded" reports the device that won.
 * Loading a model under a new spec disposes its other pipelines (a
 * picker switch must not keep two copies in memory).
 *
 * Protocol (components/local-dictation.ts is the only client):
 *   in  {type:"load", key, model}                 → {type:"loaded", key, device} | {type:"load-error", key, message}
 *   in  {type:"transcribe", id, key, model, audio} → {type:"result", id, text}    | {type:"transcribe-error", id, message}
 */

import { env, pipeline } from "@huggingface/transformers";

type ModelSpec = {
	id: string;
	dtype: { encoder_model: string; decoder_model_merged: string };
	device: "wasm" | "webgpu";
};
type Transcriber = (audio: Float32Array) => Promise<{ text: string } | Array<{ text: string }>>;

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = "/api/stt/files/";
env.useBrowserCache = false;
const onnx = env.backends.onnx;
if (onnx.wasm) {
	const runtime = `/api/stt/runtime/${onnx.versions?.web ?? "unknown"}/ort-wasm-simd-threaded.asyncify`;
	onnx.wasm.wasmPaths = { mjs: `${runtime}.mjs`, wasm: `${runtime}.wasm` };
}

const post = (msg: unknown) => (self as unknown as { postMessage: (m: unknown) => void }).postMessage(msg);

/** In-flight page fetches (see the header): id → resolver. */
let nextFetch = 1;
const fetches = new Map<number, { resolve: (r: Response) => void; reject: (e: Error) => void }>();

function viaPage(url: string, init?: RequestInit): Promise<Response> {
	const id = nextFetch++;
	const headers = [...new Headers(init?.headers).entries()];
	return new Promise((resolve, reject) => {
		fetches.set(id, { resolve, reject });
		post({ type: "fetch", id, url, method: init?.method ?? "GET", headers });
	});
}

const directFetch = env.fetch;
env.fetch = (input: string | URL, init?: RequestInit) => {
	const url = new URL(String(input), self.location.href);
	if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) return viaPage(url.href, init);
	return directFetch(input, init);
};

type Loaded = { run: Transcriber; device: string; dispose: () => Promise<void> };

/** One pipeline per (model, files, device) key for the worker's lifetime;
 *  a failed load is forgotten so the next attempt retries. */
const loaded = new Map<string, { id: string; p: Promise<Loaded> }>();

async function create(spec: ModelSpec, device: "wasm" | "webgpu"): Promise<Loaded> {
	const pipe = (await pipeline("automatic-speech-recognition", spec.id, {
		device,
		dtype: spec.dtype as never,
	})) as unknown as Transcriber & { dispose: () => Promise<void> };
	return { run: (audio) => pipe(audio), device, dispose: () => pipe.dispose() };
}

/** WebGPU when asked and an adapter exists; otherwise — or when the GPU
 *  session can't start — the same files on CPU (wasm). */
async function createOnDevice(spec: ModelSpec): Promise<Loaded> {
	if (spec.device !== "webgpu") return create(spec, "wasm");
	const adapter = "gpu" in navigator ? await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter().catch(() => null) : null;
	if (!adapter) return create(spec, "wasm");
	return create(spec, "webgpu").catch(() => create(spec, "wasm"));
}

function load(key: string, spec: ModelSpec): Promise<Loaded> {
	const hit = loaded.get(key);
	if (hit) return hit.p;
	// A new spec for this model (picker switch, update): drop the others.
	for (const [k, v] of loaded) {
		if (v.id !== spec.id) continue;
		loaded.delete(k);
		v.p.then((l) => l.dispose()).catch(() => {});
	}
	const p = createOnDevice(spec).catch((e: unknown) => {
		loaded.delete(key);
		throw e;
	});
	loaded.set(key, { id: spec.id, p });
	return p;
}

/** Whisper's no-speech placeholders ("[BLANK_AUDIO]", "(music)") are not
 *  dictation — drop lines that are only bracketed tags. */
function cleanText(text: string): string {
	const t = text.replace(/\s+/g, " ").trim();
	return /^(\[[^\]]*\]|\([^)]*\)|\s)*$/.test(t) ? "" : t;
}

self.addEventListener("message", (ev: MessageEvent) => {
	const msg = ev.data as
		| { type: "load"; key: string; model: ModelSpec }
		| { type: "transcribe"; id: number; key: string; model: ModelSpec; audio: Float32Array }
		| {
				type: "fetched";
				id: number;
				status?: number;
				headers?: [string, string][];
				body?: ReadableStream<Uint8Array> | null;
				error?: string;
		  };
	if (msg.type === "fetched") {
		const f = fetches.get(msg.id);
		if (!f) return;
		fetches.delete(msg.id);
		if (msg.error !== undefined) f.reject(new Error(msg.error));
		else f.resolve(new Response(msg.body ?? null, { status: msg.status ?? 200, headers: msg.headers ?? [] }));
	} else if (msg.type === "load") {
		load(msg.key, msg.model).then(
			({ device }) => post({ type: "loaded", key: msg.key, device }),
			(e: unknown) => post({ type: "load-error", key: msg.key, message: e instanceof Error ? e.message : String(e) }),
		);
	} else if (msg.type === "transcribe") {
		load(msg.key, msg.model)
			.then(({ run }) => run(msg.audio))
			.then(
				(out) => post({ type: "result", id: msg.id, text: cleanText((Array.isArray(out) ? out[0]?.text : out.text) ?? "") }),
				(e: unknown) => post({ type: "transcribe-error", id: msg.id, message: e instanceof Error ? e.message : String(e) }),
			);
	}
});
