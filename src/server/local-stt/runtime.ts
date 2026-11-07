/**
 * The on-device dictation runtime: transcribe.cpp (loaded lazily, never unless Local
 * is used), one loaded ASR model at a time, the bundled Silero VAD, and the
 * VoxLingua detector for Auto on models that cannot detect language themselves.
 * Ported from pi-voice src/transcription.ts, transcription-service.ts and vad.ts
 * (MIT, Copyright (c) 2026 Earendil Works contributors):
 * https://github.com/earendil-works/pi-voice
 *
 * Concurrency: transcribe.cpp allows at most one run in flight per native model,
 * across all its sessions (a second one throws Busy). Work on the ASR model (and
 * the detector, which a chunk uses before its own decode) therefore goes through
 * one queue, and Silero, a separate model, through another. A model switch or
 * delete waits its turn in the ASR queue, so it can never free a model that is
 * decoding. State lives on globalThis because Next compiles each route into its
 * own module instance.
 *
 * Memory: after IDLE_UNLOAD_MS with no transcribe request, the ASR model and the
 * detector are freed (the next request reloads them). Silero is 1.2 MB and stays.
 */
import path from "node:path";
import type { LangIdResult, TranscribeModel } from "transcribe-cpp";
import { PATHS } from "../../../config.ts";
import {
	LANGUAGE_DETECTION_MODEL,
	displayLanguage,
	getCatalogModel,
	resolveModelLanguage,
	type CatalogModel,
} from "../../core/local-stt-catalog.ts";
import { shouldConvertChinese, isChineseLanguage, type LocalChineseOutput } from "../../core/local-stt-chinese.ts";
import {
	DETECTION_MIN_SECONDS,
	DETECTION_WINDOW_SECONDS,
	languageForModel,
	localLanguagePolicy,
	LOCAL_AUTO_LANGUAGE,
	missingDetectorWarning,
	pickDetectedLanguage,
	type DetectPolicy,
} from "../../core/local-stt-language-policy.ts";
import type { MachineTier } from "../../core/local-stt-recommendations.ts";
import { DICTATION_SAMPLE_RATE } from "../../core/dictation.ts";
import type { LocalTranscribeResponse } from "../../core/local-stt.ts";
import { convertChineseOutput } from "./chinese.ts";
import { localModelStore, type ModelStore } from "./model-store.ts";

type Engine = typeof import("transcribe-cpp");

/** The bundled Silero VAD (GGUF, MIT). It ships with the app, never downloaded. */
export const SILERO_FILE = "silero-vad-v6.2-F32.gguf";
export function defaultSileroPath(): string {
	return path.join(PATHS.root, "src", "server", "local-stt", SILERO_FILE);
}

/** A failure the learner can read. `status` and `retryable` become the route's answer. */
export class LocalSttError extends Error {
	constructor(
		message: string,
		readonly status = 500,
		readonly retryable = false,
	) {
		super(message);
	}
}

export type TranscribeChunkOptions = {
	/** A catalog model id. */
	modelId: string;
	/** "auto" or a language code. */
	language: string;
	preferredLanguages: readonly string[];
	chineseOutput: LocalChineseOutput;
	signal?: AbortSignal;
};

export type LocalSttHardware = { tier: MachineTier; available: boolean; error?: string };

export type LocalSttRuntime = {
	hardware(): Promise<LocalSttHardware>;
	/** Transcribe one PCM16 16 kHz chunk with an installed model. */
	transcribeChunk(pcm16: Int16Array, options: TranscribeChunkOptions): Promise<LocalTranscribeResponse>;
	/** Load an installed model ahead of its first chunk (counts as use for the idle clock). */
	warm(modelId: string): Promise<void>;
	/** Silero's speech probability for each 512-sample frame of the clip (the last zero padded). */
	scoreVad(pcm16: Int16Array, signal?: AbortSignal): Promise<number[]>;
	/** Free a model if it is the loaded one (call before deleting its file). */
	unload(id: string): Promise<void>;
	dispose(): Promise<void>;
};

/** How long the ASR model and the language detector stay loaded with no transcribe request. */
export const IDLE_UNLOAD_MS = 10 * 60 * 1000;

export type RuntimeDeps = {
	store?: ModelStore;
	/** Idle time before the ASR model and detector are unloaded. */
	idleUnloadMs?: number;
	/** Injectable for tests; default setTimeout, unref'd so it never keeps the process alive. */
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	/** Injectable for tests; defaults to a dynamic import of transcribe-cpp. */
	loadEngine?: () => Promise<Engine>;
	sileroPath?: string;
};

/** Runs one job at a time, in order; a failed job does not stop the queue. */
class Queue {
	private tail: Promise<unknown> = Promise.resolve();
	run<T>(job: () => Promise<T>): Promise<T> {
		const next = this.tail.then(job, job);
		this.tail = next.catch(() => undefined);
		return next;
	}
}

const pcmToFloat = (pcm: Int16Array): Float32Array => {
	const out = new Float32Array(pcm.length);
	for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 32768;
	return out;
};

// transcribe-cpp log levels: 2 is a warning, 3 an error, 5 continues the line before it.
// Everything else (its info is a screenful of GPU setup on every load) is dropped.
let lastNativeLevel = 0;

function routeNativeLog(engine: Engine): void {
	engine.setLogHandler((level, message) => {
		if (level !== 5) lastNativeLevel = level;
		if (lastNativeLevel === 2 || lastNativeLevel === 3) console[lastNativeLevel === 2 ? "warn" : "error"](`[stt] ${message.trimEnd()}`);
	});
}

/** A model load failure the learner can act on. */
function loadFailure(engine: Engine, model: CatalogModel, error: unknown): LocalSttError {
	if (error instanceof engine.OutOfMemory) {
		return new LocalSttError(`Not enough memory to load ${model.name}. Choose a smaller model in Settings.`);
	}
	if (error instanceof engine.ModelFileNotFound || error instanceof engine.ModelLoadError) {
		return new LocalSttError(`${model.name} could not be loaded. Delete it in Settings and download it again.`);
	}
	return new LocalSttError(`${model.name} could not be loaded: ${describe(error)}`);
}

function describe(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

export function createLocalSttRuntime(deps: RuntimeDeps = {}): LocalSttRuntime {
	const store = deps.store ?? localModelStore();
	const sileroPath = deps.sileroPath ?? defaultSileroPath();
	const loadEngine = deps.loadEngine ?? (() => import("transcribe-cpp"));
	const idleMs = deps.idleUnloadMs ?? IDLE_UNLOAD_MS;
	const setTimer = deps.setTimer ?? ((callback, ms) => {
		const handle = setTimeout(callback, ms);
		handle.unref();
		return handle;
	});
	const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));

	const asrQueue = new Queue();
	const vadQueue = new Queue();
	let engine: Promise<Engine> | undefined;
	let asr: { id: string; model: TranscribeModel } | undefined;
	let detector: TranscribeModel | undefined;
	let silero: Promise<TranscribeModel> | undefined;
	let disposed = false;
	/** Transcribe requests queued or running; the idle clock only runs at zero. */
	let pending = 0;
	let idleTimer: unknown;

	/** Free the ASR model and the detector. Only call inside asrQueue. */
	function freeModels(): void {
		asr?.model.dispose();
		asr = undefined;
		detector?.dispose();
		detector = undefined;
	}

	function stopIdleClock(): void {
		if (idleTimer !== undefined) clearTimer(idleTimer);
		idleTimer = undefined;
	}

	function startIdleClock(): void {
		stopIdleClock();
		if (disposed || (!asr && !detector)) return;
		idleTimer = setTimer(() => {
			idleTimer = undefined;
			// Through the queue, so a decode that began since cannot lose its model.
			void asrQueue.run(async () => {
				if (pending === 0) freeModels();
			}).catch(() => undefined);
		}, idleMs);
	}

	/** Run a job in the ASR queue as a use of the models. The idle clock stops while it waits and
	 * runs, and the last job out starts it again, even after a failed load. */
	function withIdleClock<T>(job: () => Promise<T>): Promise<T> {
		pending++;
		stopIdleClock();
		return asrQueue.run(job).finally(() => {
			if (--pending === 0) startIdleClock();
		});
	}

	function engineReady(): Promise<Engine> {
		engine ??= loadEngine().then(
			(loaded) => { routeNativeLog(loaded); return loaded; },
			(error: unknown) => {
				engine = undefined; // a later request retries
				throw new LocalSttError(
					`On-device dictation can't run on this computer (${describe(error)}).`, 503,
				);
			},
		);
		return engine;
	}

	/** The loaded ASR model, switching if another is loaded. Only call inside asrQueue. */
	async function asrModel(loaded: Engine, model: CatalogModel): Promise<TranscribeModel> {
		if (asr?.id === model.id) return asr.model;
		const file = await store.installedPath(model.id);
		if (!file) {
			throw new LocalSttError(`${model.name} isn't downloaded. Choose a model in Settings → Dictation.`, 409);
		}
		// One ASR model at a time: free the old one before the new one takes its memory.
		asr?.model.dispose();
		asr = undefined;
		try {
			asr = { id: model.id, model: await loaded.TranscribeModel.load(file) };
		} catch (error) {
			throw loadFailure(loaded, model, error);
		}
		return asr.model;
	}

	async function detectorModel(loaded: Engine): Promise<TranscribeModel | undefined> {
		if (detector) return detector;
		const file = await store.installedPath(LANGUAGE_DETECTION_MODEL.id);
		if (!file) return undefined;
		try {
			return (detector = await loaded.TranscribeModel.load(file));
		} catch (error) {
			throw loadFailure(loaded, LANGUAGE_DETECTION_MODEL, error);
		}
	}

	async function identify(loaded: Engine, policy: DetectPolicy, pcm: Float32Array, signal?: AbortSignal): Promise<{ language: string; warning?: string }> {
		const fallback = policy.languages[0]!;
		// Under half a second is not worth the detector's time (or loading it).
		if (pcm.length < DETECTION_MIN_SECONDS * DICTATION_SAMPLE_RATE) return { language: fallback };
		const model = await detectorModel(loaded);
		if (!model) return { language: fallback, warning: missingDetectorWarning(fallback) };
		const head = pcm.subarray(0, DETECTION_WINDOW_SECONDS * DICTATION_SAMPLE_RATE);
		const session = model.createLangIdSession();
		try {
			const result: LangIdResult = await session.run(head, { allowed: policy.allowed, signal });
			const picked = pickDetectedLanguage(policy, result);
			return picked.warning ? { language: picked.language, warning: picked.warning } : { language: picked.language };
		} catch (error) {
			signal?.throwIfAborted();
			console.warn(`[stt] language detection failed: ${describe(error)}`);
			return { language: fallback, warning: `Couldn't detect the language. Transcribed as ${displayLanguage(fallback)}.` };
		} finally {
			session.dispose();
		}
	}

	/** Decode failures the learner should see in plain words. */
	function decodeFailure(loaded: Engine, model: CatalogModel, error: unknown): LocalSttError {
		if (error instanceof loaded.OutOfMemory) {
			return new LocalSttError(`Not enough memory to transcribe with ${model.name}. Choose a smaller model in Settings.`);
		}
		if (error instanceof loaded.UnsupportedRequest || error instanceof loaded.InvalidArgument) {
			return new LocalSttError(`${model.name} can't transcribe in that language. Choose another language or model in Settings.`, 400);
		}
		return new LocalSttError(`Transcription failed: ${describe(error)}`, 500, true);
	}

	async function transcribeChunk(pcm16: Int16Array, options: TranscribeChunkOptions): Promise<LocalTranscribeResponse> {
		const model = getCatalogModel(options.modelId);
		if (!model) throw new LocalSttError("Unknown dictation model.", 400);
		if (pcm16.length === 0) return { text: "" };
		const { signal } = options;
		const pcm = pcmToFloat(pcm16);
		// Auto gives way to a fixed language when the preferences cannot support it (pi-voice's rule).
		const requested = options.language === LOCAL_AUTO_LANGUAGE
			? languageForModel(LOCAL_AUTO_LANGUAGE, model, options.preferredLanguages)
			: options.language;
		if (requested !== LOCAL_AUTO_LANGUAGE && resolveModelLanguage(model, requested) === undefined) {
			throw new LocalSttError(`${model.name} doesn't support that language. Choose another language or model in Settings.`, 400);
		}
		const policy = localLanguagePolicy(model.id, requested, options.preferredLanguages);

		return withIdleClock(async () => {
			signal?.throwIfAborted();
			if (disposed) throw new LocalSttError("Dictation is shutting down.", 503);
			const loaded = await engineReady();
			const native = await asrModel(loaded, model);
			signal?.throwIfAborted();

			let language: string | undefined;
			let warning: string | undefined;
			if (policy.kind === "fixed") language = resolveModelLanguage(model, policy.language) ?? policy.language;
			else if (policy.kind === "detect") {
				({ language, warning } = await identify(loaded, policy, pcm, signal));
				language = resolveModelLanguage(model, language) ?? language;
			}
			// native: the model detects. unsupported cannot happen here: languageForModel resolved it.
			signal?.throwIfAborted();

			let text: string;
			let spoken: string;
			try {
				const result = await native.transcribe(pcm, { signal, timestamps: "none", ...(language ? { language } : {}) });
				text = result.text;
				spoken = result.language;
			} catch (error) {
				signal?.throwIfAborted();
				// A clip too short to hold speech, or output cut off after it began repeating, is not a failure:
				// there is nothing to say, or a usable partial transcript.
				if (error instanceof loaded.InputTooShort) return { text: "", ...(language ? { language } : {}) };
				if (error instanceof loaded.OutputTruncated && error.partialResult) {
					text = error.partialResult.text;
					spoken = error.partialResult.language;
				} else throw decodeFailure(loaded, model, error);
			}

			const trimmed = text.trim();
			const finalLanguage = spoken || language || "";
			const converted = shouldConvertChinese(trimmed, {
				chineseEnabled: isChineseLanguage(options.language) || options.preferredLanguages.some(isChineseLanguage),
				language: finalLanguage,
			})
				? await convertChineseOutput(trimmed, options.chineseOutput)
				: trimmed;
			return {
				text: converted,
				...(finalLanguage ? { language: finalLanguage } : {}),
				...(warning ? { warning } : {}),
			};
		});
	}

	/** Load the model (and the engine) without transcribing, so a recording's first chunk does not wait for it. */
	async function warm(modelId: string): Promise<void> {
		const model = getCatalogModel(modelId);
		if (!model) throw new LocalSttError("Unknown dictation model.", 400);
		return withIdleClock(async () => {
			if (disposed) throw new LocalSttError("Dictation is shutting down.", 503);
			await asrModel(await engineReady(), model);
		});
	}

	async function scoreVad(pcm16: Int16Array, signal?: AbortSignal): Promise<number[]> {
		if (pcm16.length === 0) return [];
		const pcm = pcmToFloat(pcm16);
		return vadQueue.run(async () => {
			signal?.throwIfAborted();
			if (disposed) throw new LocalSttError("Dictation is shutting down.", 503);
			const loaded = await engineReady();
			// A failed load is retried by the next request.
			const model = await (silero ??= loaded.TranscribeModel.load(sileroPath).catch((error: unknown) => {
				silero = undefined;
				throw new LocalSttError(`Voice activity detection couldn't start: ${describe(error)}`, 503);
			}));
			const session = model.createVadSession();
			try {
				return (await session.run(pcm, { signal })).probs;
			} finally {
				session.dispose();
			}
		});
	}

	return {
		async hardware() {
			try {
				const loaded = await engineReady();
				const devices = await loaded.getAvailableBackendsAsync();
				return { tier: devices.some((device) => device.deviceType !== "cpu") ? "accelerated" : "cpu", available: true };
			} catch (error) {
				return { tier: "cpu", available: false, error: describe(error) };
			}
		},
		transcribeChunk,
		warm,
		scoreVad,
		unload(id) {
			return asrQueue.run(async () => {
				if (asr?.id === id) { asr.model.dispose(); asr = undefined; }
				if (id === LANGUAGE_DETECTION_MODEL.id && detector) { detector.dispose(); detector = undefined; }
			});
		},
		async dispose() {
			disposed = true;
			stopIdleClock();
			await asrQueue.run(async () => freeModels());
			await vadQueue.run(async () => {
				const model = await silero?.catch(() => undefined);
				silero = undefined;
				model?.dispose();
			});
		},
	};
}

const g = globalThis as typeof globalThis & { __lhLocalSttRuntime?: LocalSttRuntime };

/** The process-wide runtime. The first use creates it; nothing loads until a request needs a model. */
export function localSttRuntime(): LocalSttRuntime {
	return (g.__lhLocalSttRuntime ??= createLocalSttRuntime());
}

/** Test seam: replace (or clear) the process-wide runtime. */
export function setLocalSttRuntime(runtime: LocalSttRuntime | undefined): void {
	g.__lhLocalSttRuntime = runtime;
}
