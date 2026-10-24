/**
 * Local dictation, server side (issue #15, PR #50): the method selection,
 * curated-model downloads, and the files the in-app engine loads. Bytes
 * live behind the DictationStore port (src/store/dictation.ts, wired in
 * stores.ts); this module decides what to fetch and what counts as
 * selected.
 *
 * Selection is DERIVED on read (core/dictation.ts reconcileDictationSelection:
 * the stored pick while it is configured, else the first configured
 * method) and written only at the write points that could change the
 * answer — an explicit pick, a finished download, a removal. A status read
 * never writes.
 *
 * Downloads run in-process (one per model, progress polled by the
 * Dictation settings while one runs). The ONNX runtime rides along with
 * the first model download, so a downloaded model runs offline; a request
 * that finds it missing fetches it then, as a backstop.
 */

import {
	DEEPGRAM_METHOD_ID,
	LOCAL_DICTATION_MODELS,
	ORT_WEB_VERSION,
	localMethodId,
	modelFileWanted,
	modelOnnxFiles,
	reconcileDictationSelection,
	type DictationDevice,
	type DictationStatus,
	type LocalModelEntry,
	type LocalModelStatus,
} from "../core/dictation.ts";
import { keyValue } from "./keys.ts";
import { stores } from "./stores.ts";

const store = () => stores.dictationStore;

/** The runtime files the engine asks for (transformers.js's default
 *  asyncify build of onnxruntime-web). */
export const DICTATION_RUNTIME_FILES = [
	"ort-wasm-simd-threaded.asyncify.mjs",
	"ort-wasm-simd-threaded.asyncify.wasm",
] as const;

function runtimeUrl(version: string, file: string): string {
	return `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/${file}`;
}

// ─── Models on disk ──────────────────────────────────────────────────────────

function modelEntry(id: string): LocalModelEntry | undefined {
	return LOCAL_DICTATION_MODELS.find((m) => m.id === id);
}

/** Downloaded = the config plus both ONNX files this entry loads are on
 *  disk. A folder missing them reads as absent, so Download replaces it. */
function modelDownloaded(entry: LocalModelEntry): boolean {
	return (
		store().modelExists(entry.id) && modelOnnxFiles(entry.dtype).every((f) => store().modelHasFile(entry.id, f))
	);
}

/** Configured method ids in SETUP ORDER: downloaded models by folder
 *  time, then Deepgram. The default pick is the first of these. */
function configuredMethods(): string[] {
	const models = LOCAL_DICTATION_MODELS.filter(modelDownloaded)
		.map((m) => ({ id: localMethodId(m.id), at: store().modelTime(m.id) }))
		.sort((a, b) => a.at - b.at)
		.map((m) => m.id);
	return keyValue("DEEPGRAM_API_KEY") ? [...models, DEEPGRAM_METHOD_ID] : models;
}

/** The effective selection + the choices. Pure read — derived, never written. */
export function currentDictationSelection(): { selected: string | null; configured: string[] } {
	const configured = configuredMethods();
	return { selected: reconcileDictationSelection(store().readState().selected, configured), configured };
}

/** Persist a pick (write points only). No-op when it is already stored. */
function pinSelection(selected: string | null): void {
	const state = store().readState();
	if (state.selected !== selected) store().writeState({ ...state, selected });
}

/** Pick the method Dictate uses. False when it isn't configured. */
export function selectDictationMethod(id: string): boolean {
	if (!configuredMethods().includes(id)) return false;
	pinSelection(id);
	return true;
}

/** Where local models run (the WebGPU/CPU picker). */
export function setDictationDevice(device: DictationDevice): void {
	store().writeState({ ...store().readState(), device });
}

// ─── Downloads ───────────────────────────────────────────────────────────────

type Download = { received: number; total: number; error?: string; abort: AbortController };

/** In-flight downloads, on globalThis so dev-mode module reloads keep
 *  one map (and one fetch per model). */
const downloads: Map<string, Download> = ((globalThis as { __lhDictationDownloads?: Map<string, Download> })
	.__lhDictationDownloads ??= new Map());

export function dictationStatus(): DictationStatus {
	const { selected, configured } = currentDictationSelection();
	const models: LocalModelStatus[] = LOCAL_DICTATION_MODELS.map((m) => {
		const d = downloads.get(m.id);
		if (d && !d.error) return { ...m, state: "downloading", progress: d.total ? d.received / d.total : 0 };
		if (modelDownloaded(m)) return { ...m, state: "ready" };
		if (d?.error) return { ...m, state: "error", error: d.error };
		return { ...m, state: "absent" };
	});
	return {
		selected,
		configured,
		device: store().readState().device,
		deepgram: !!keyValue("DEEPGRAM_API_KEY"),
		models,
	};
}

/** Start (or no-op on an already running/finished) download. Returns
 *  false for an unknown id. */
export function startModelDownload(id: string): boolean {
	const entry = modelEntry(id);
	if (!entry) return false;
	if (modelDownloaded(entry)) return true;
	const existing = downloads.get(id);
	if (existing && !existing.error) return true;
	const d: Download = { received: 0, total: 0, abort: new AbortController() };
	downloads.set(id, d);
	void runDownload(entry, d).then(
		() => downloads.delete(id),
		(e: unknown) => {
			if (d.abort.signal.aborted) return;
			d.error = e instanceof Error ? e.message : "Download failed";
			console.warn(`[dictation] ${id} download failed: ${d.error}`);
		},
	);
	return true;
}

async function runDownload(entry: LocalModelEntry, d: Download): Promise<void> {
	const listing = await fetch(`https://huggingface.co/api/models/${entry.repo}/tree/main?recursive=true`, {
		signal: d.abort.signal,
	});
	if (!listing.ok) throw new Error(`Hugging Face listing failed (${listing.status})`);
	const tree = (await listing.json()) as Array<{ type: string; path: string; size?: number }>;
	const files = tree.filter((f) => f.type === "file" && modelFileWanted(f.path, entry.dtype));
	if (!files.some((f) => f.path === "config.json")) throw new Error("Model files not found");
	// The runtime rides along when it isn't cached yet: a model that lands
	// is a model that runs, network or not (issue #15: "no API key or
	// network"). Sized up front so the progress bar never runs backwards.
	const runtime = DICTATION_RUNTIME_FILES.filter((f) => !store().runtimeFilePath(ORT_WEB_VERSION, f));
	const runtimeSizes = await Promise.all(
		runtime.map((f) =>
			fetch(runtimeUrl(ORT_WEB_VERSION, f), { method: "HEAD", signal: d.abort.signal })
				.then((r) => Number(r.headers.get("content-length") ?? 0))
				.catch(() => 0),
		),
	);
	d.total = files.reduce((n, f) => n + (f.size ?? 0), 0) + runtimeSizes.reduce((n, x) => n + x, 0);
	const onBytes = (n: number) => {
		d.received += n;
	};

	store().beginModel(entry.id);
	for (const f of files) {
		const res = await fetch(`https://huggingface.co/${entry.repo}/resolve/main/${f.path}`, { signal: d.abort.signal });
		if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
		await store().writeModelFile(entry.id, f.path, res.body, onBytes);
	}
	for (const f of runtime) {
		const res = await fetch(runtimeUrl(ORT_WEB_VERSION, f), { signal: d.abort.signal });
		if (!res.ok || !res.body) throw new Error(`Speech runtime download failed (${res.status})`);
		await store().writeRuntimeFile(ORT_WEB_VERSION, f, res.body, onBytes);
	}
	// A new download never takes over the pick: pin whatever was in effect
	// before it landed — or this model, when nothing was set up yet.
	const before = currentDictationSelection().selected;
	store().commitModel(entry.id);
	pinSelection(before ?? localMethodId(entry.id));
}

/** Cancel an in-flight download, or delete a downloaded model. */
export function removeModel(id: string): boolean {
	if (!modelEntry(id)) return false;
	const d = downloads.get(id);
	if (d) {
		d.abort.abort();
		downloads.delete(id);
		store().discardStaged(id);
		if (!d.error) return true; // cancel, not remove
	}
	const wasPicked = store().readState().selected === localMethodId(id);
	store().removeModel(id);
	// A removed pick falls to the default choice — pinned now, so a later
	// download can't take it over.
	if (wasPicked) pinSelection(currentDictationSelection().selected);
	return true;
}

// ─── File serving ────────────────────────────────────────────────────────────

/** Absolute path of a downloaded model file, or null when it isn't one. */
export function modelFilePath(segments: string[]): string | null {
	const [id, ...rest] = segments;
	if (!id || !modelEntry(id) || rest.length === 0) return null;
	return store().modelFilePath(id, rest);
}

/** The runtime file for this onnxruntime-web version — normally already
 *  cached by a model download; fetched now (and kept) otherwise. Null for
 *  anything outside the allowlist. */
export async function runtimeFilePath(version: string, file: string): Promise<string | null> {
	if (!/^[0-9A-Za-z.+-]{1,64}$/.test(version)) return null;
	if (!(DICTATION_RUNTIME_FILES as readonly string[]).includes(file)) return null;
	const cached = store().runtimeFilePath(version, file);
	if (cached) return cached;
	const res = await fetch(runtimeUrl(version, file));
	if (!res.ok || !res.body) return null;
	await store().writeRuntimeFile(version, file, res.body);
	return store().runtimeFilePath(version, file);
}

export function contentTypeFor(file: string): string {
	if (file.endsWith(".json")) return "application/json";
	if (file.endsWith(".wasm")) return "application/wasm";
	if (file.endsWith(".mjs")) return "text/javascript";
	return "application/octet-stream";
}
