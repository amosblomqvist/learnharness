/**
 * DICTATION METHODS (issue #15, PR #50): the cloud engine
 * (Deepgram, keyed) and on-device models (transformers.js in the
 * renderer), one of which is the SELECTED method.
 *
 * Design (issue #15, PR #50, 2026-10-23/24):
 *  - A method is CONFIGURED when it can run: Deepgram = a key is set; a
 *    local model = its files are downloaded.
 *  - Dictate uses exactly ONE method — the one picked in Settings →
 *    Providers → Dictation. No automatic fallback to another method:
 *    a failure names the selected engine (issue #15's acceptance
 *    criteria).
 *  - DEFAULT CHOICE: when nothing is selected (first setup, or the
 *    selected model was removed / key deleted) the first configured method
 *    in setup order is picked. A new download never steals the selection
 *    — the user switches by clicking it.
 *  - DEVICE: local models run on WebGPU or CPU, one
 *    picker in the Dictation settings, default WebGPU. When WebGPU can't
 *    start (no adapter, session refused) the SAME model runs on CPU —
 *    a device fallback, not a different engine.
 *  - FILES: one GPU-ready set per model (full-precision encoder + 4-bit
 *    decoder; Turbo 4-bit both) that also runs on CPU (chosen over
 *    per-device downloads: switching is instant, the CPU fallback always
 *    has its files).
 *  - The catalog is CURATED (chosen over a live Hugging Face search):
 *    models known to run in the in-app engine, each with a short line.
 *
 * Browser-safe: pure logic + types only. Storage and downloads live in
 * src/server/dictation.ts.
 */

export const DEEPGRAM_METHOD_ID = "deepgram";

/** The onnxruntime-web build the engine runs on (transformers.js pins it;
 *  the worker reads the same value at run time). The server fetches its
 *  runtime files with every model download, so a model is usable offline
 *  the moment it lands. tests/local-dictation.test.ts pins this to the
 *  installed package — a dependency bump fails the test instead of
 *  silently needing the network on first use. */
export const ORT_WEB_VERSION = "1.31.0-dev.20260914-8d85527a0";

/** transformers.js data types we download (file suffix per its
 *  DEFAULT_DTYPE_SUFFIX_MAPPING). */
export type ModelDataType = "fp32" | "fp16" | "q8" | "q4";
/** Per-module data types — the shape transformers.js takes as `dtype`. */
export interface ModelDtype {
	encoder_model: ModelDataType;
	decoder_model_merged: ModelDataType;
}

export type DictationDevice = "webgpu" | "cpu";
export const DEFAULT_DICTATION_DEVICE: DictationDevice = "webgpu";

/** One curated on-device model. `dtype` names the GPU-ready files we
 *  download (and nothing else); they run on CPU too. */
export interface LocalModelEntry {
	/** Our stable id — the method id's suffix and the on-disk folder name. */
	id: string;
	name: string;
	/** The Hugging Face repo the files come from. */
	repo: string;
	dtype: ModelDtype;
	/** Download size, rounded (model weights + tokenizer/config files). */
	sizeMb: number;
	/** Word error rate, %: the Open ASR Leaderboard's mean over its eight
	 *  English sets (AMI, Earnings22, GigaSpeech, LibriSpeech clean/other,
	 *  SPGISpeech, TED-LIUM, VoxPopuli), as Hugging Face posted it on each
	 *  model card ("Add Open ASR Leaderboard evaluation results" PRs).
	 *  Measured on the full-precision weights — our quantized files may
	 *  differ slightly. null = no published score (the row says
	 *  "WER n/a" rather than a number from another benchmark). */
	werPct: number | null;
}

/** The GPU-ready set: full-precision encoder (the heavy pass, fast on
 *  WebGPU) + 4-bit merged decoder. Measured 2026-10-24 on Whisper Tiny:
 *  ~0.3s per 9s clip on WebGPU vs ~1.1s for 8-bit files on CPU;
 *  the same files on CPU ran ~1.3s. */
const GPU_READY: ModelDtype = { encoder_model: "fp32", decoder_model_merged: "q4" };

/** Smallest download first; each row shows only the
 *  name, size and WER. */
export const LOCAL_DICTATION_MODELS: readonly LocalModelEntry[] = [
	{
		id: "moonshine-tiny",
		name: "Moonshine Tiny",
		repo: "onnx-community/moonshine-tiny-ONNX",
		dtype: GPU_READY,
		sizeMb: 79,
		werPct: 12.65,
	},
	{
		id: "whisper-tiny-en",
		name: "Whisper Tiny",
		repo: "onnx-community/whisper-tiny.en",
		dtype: GPU_READY,
		sizeMb: 123,
		werPct: 12.81,
	},
	{
		id: "moonshine-base",
		name: "Moonshine Base",
		repo: "onnx-community/moonshine-base-ONNX",
		dtype: GPU_READY,
		sizeMb: 157,
		werPct: 9.99,
	},
	{
		id: "whisper-base-en",
		name: "Whisper Base",
		repo: "onnx-community/whisper-base.en",
		dtype: GPU_READY,
		sizeMb: 210,
		werPct: 10.32,
	},
	{
		id: "whisper-base",
		name: "Whisper Base Multilingual",
		repo: "onnx-community/whisper-base",
		dtype: GPU_READY,
		sizeMb: 210,
		werPct: null,
	},
	{
		id: "whisper-small-en",
		name: "Whisper Small",
		repo: "onnx-community/whisper-small.en",
		dtype: GPU_READY,
		sizeMb: 590,
		werPct: 8.59,
	},
	{
		id: "whisper-large-v3-turbo",
		name: "Whisper Large v3 Turbo",
		repo: "onnx-community/whisper-large-v3-turbo",
		dtype: { encoder_model: "q4", decoder_model_merged: "q4" },
		sizeMb: 763,
		werPct: 7.83,
	},
];

export function localMethodId(modelId: string): string {
	return `local:${modelId}`;
}

/** The catalog entry a method id names, or undefined (Deepgram, unknown). */
export function localModelOf(methodId: string): LocalModelEntry | undefined {
	if (!methodId.startsWith("local:")) return undefined;
	const id = methodId.slice("local:".length);
	return LOCAL_DICTATION_MODELS.find((m) => m.id === id);
}

/** "12.65% WER" / "WER n/a" — the accuracy part of a model's subtitle. */
export function formatWer(werPct: number | null): string {
	return werPct === null ? "WER n/a" : `${werPct}% WER`;
}

/** "32 MB" / "1.2 GB" — the size half of a model's subtitle. */
export function formatModelSize(mb: number): string {
	return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}

/** transformers.js file-name suffix per data type (its DEFAULT_DTYPE_SUFFIX_MAPPING). */
const DTYPE_SUFFIX: Record<ModelDataType, string> = { fp32: "", fp16: "_fp16", q8: "_quantized", q4: "_q4" };

/** The two ONNX files a dtype loads (repo paths, sidecars not included). */
export function modelOnnxFiles(dtype: ModelDtype): [string, string] {
	return [
		`onnx/encoder_model${DTYPE_SUFFIX[dtype.encoder_model]}.onnx`,
		`onnx/decoder_model_merged${DTYPE_SUFFIX[dtype.decoder_model_merged]}.onnx`,
	];
}

/** Is this repo file part of the download for `dtype`? Root JSON
 *  (config, generation/preprocessor config, tokenizer) plus exactly the
 *  encoder + merged decoder of the chosen types (and their external-data
 *  sidecars, when a repo ships them). */
export function modelFileWanted(repoPath: string, dtype: ModelDtype): boolean {
	if (!repoPath.includes("/")) return repoPath.endsWith(".json");
	return modelOnnxFiles(dtype).some((f) => repoPath === f || repoPath === `${f}_data`);
}

/** How a local model runs: its files' dtype on the picked backend. */
export function localRunSpec(
	model: LocalModelEntry,
	device: DictationDevice,
): { dtype: ModelDtype; device: "webgpu" | "wasm" } {
	return { dtype: model.dtype, device: device === "cpu" ? "wasm" : "webgpu" };
}

/** The persisted record (dictation/state.json). */
export interface DictationState {
	selected: string | null;
	device: DictationDevice;
}

/** A missing or malformed record reads as the defaults, field by field. */
export function sanitizeDictationState(raw: unknown): DictationState {
	const r = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	const selected = typeof r.selected === "string" ? r.selected : null;
	const device = r.device === "cpu" || r.device === "webgpu" ? r.device : DEFAULT_DICTATION_DEVICE;
	return { selected, device };
}

/** The effective selection: the stored one while it is still configured,
 *  else the first configured method in setup order (null = nothing set
 *  up). Pure; the server persists the result. */
export function reconcileDictationSelection(selected: string | null, configured: readonly string[]): string | null {
	if (selected !== null && configured.includes(selected)) return selected;
	return configured[0] ?? null;
}

export interface LocalModelStatus extends LocalModelEntry {
	state: "absent" | "downloading" | "ready" | "error";
	/** 0..1 while downloading. */
	progress?: number;
	error?: string;
}

/** GET /api/stt/methods — everything the Dictate button, the setup
 *  chooser and the Dictation settings need in one read. */
export interface DictationStatus {
	/** The method Dictate uses; null = nothing set up (the chooser card). */
	selected: string | null;
	/** Every configured method id, in setup order — the choices. */
	configured: string[];
	/** Where local models run (the WebGPU/CPU picker). */
	device: DictationDevice;
	deepgram: boolean;
	models: LocalModelStatus[];
}

/** Display name for a method id (the method list's rows, error lines). */
export function dictationMethodLabel(methodId: string): string {
	if (methodId === DEEPGRAM_METHOD_ID) return "Deepgram";
	return localModelOf(methodId)?.name ?? methodId;
}
