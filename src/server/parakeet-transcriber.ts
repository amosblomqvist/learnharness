/**
 * Local transcription with sherpa-onnx. One recognizer is loaded lazily on
 * the first request, shared by every request (decoded one at a time, since
 * the model is ~670 MB and a second concurrent decode only adds memory and
 * contention) and released after a quiet period.
 */
import type { ParakeetModelFiles } from "./parakeet-model.ts";

export const PARAKEET_SAMPLE_RATE = 16_000;
/** Release the recognizer after this long without a request. */
export const PARAKEET_IDLE_MS = 5 * 60_000;

export class ParakeetNotReadyError extends Error {
	constructor() {
		super("The Parakeet model is not installed");
		this.name = "ParakeetNotReadyError";
	}
}

/** The slice of sherpa-onnx's OfflineRecognizer we use. */
export interface ParakeetRecognizer {
	createStream(): { acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void };
	decodeAsync(stream: ReturnType<ParakeetRecognizer["createStream"]>): Promise<void>;
	getResult(stream: ReturnType<ParakeetRecognizer["createStream"]>): { text: string };
}

/** Little-endian 16-bit PCM → floats in [-1, 1). */
export function pcm16ToFloat32(pcm: Uint8Array): Float32Array {
	const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2));
	const out = new Float32Array(view.byteLength / 2);
	for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
	return out;
}

async function loadSherpaRecognizer(files: ParakeetModelFiles): Promise<ParakeetRecognizer> {
	const sherpa = (await import("sherpa-onnx-node")).default;
	return sherpa.OfflineRecognizer.createAsync({
		featConfig: { sampleRate: PARAKEET_SAMPLE_RATE, featureDim: 80 },
		modelConfig: {
			transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
			tokens: files.tokens,
			numThreads: 2,
			provider: "cpu",
			debug: 0,
			modelType: "nemo_transducer",
		},
	});
}

export interface ParakeetTranscriberOptions {
	files: () => ParakeetModelFiles | null;
	load?: (files: ParakeetModelFiles) => Promise<ParakeetRecognizer>;
	idleMs?: number;
}

export function createParakeetTranscriber(options: ParakeetTranscriberOptions) {
	const load = options.load ?? loadSherpaRecognizer;
	const idleMs = options.idleMs ?? PARAKEET_IDLE_MS;
	let recognizer: Promise<ParakeetRecognizer> | null = null;
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let queue: Promise<unknown> = Promise.resolve();
	const isLoaded = () => recognizer !== null;

	const armIdle = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => { recognizer = null; idleTimer = null; }, idleMs);
		idleTimer.unref?.();
	};

	async function decode(pcm: Uint8Array): Promise<string> {
		const files = options.files();
		if (!files) throw new ParakeetNotReadyError();
		if (pcm.byteLength % 2 !== 0) throw new RangeError("Audio must be 16-bit PCM samples");
		if (pcm.byteLength === 0) return "";
		if (idleTimer) clearTimeout(idleTimer);
		const loading = recognizer ??= load(files).catch((error: unknown) => {
			recognizer = null; // a failed load must not stick
			throw error;
		});
		try {
			const engine = await loading;
			const stream = engine.createStream();
			stream.acceptWaveform({ sampleRate: PARAKEET_SAMPLE_RATE, samples: pcm16ToFloat32(pcm) });
			await engine.decodeAsync(stream);
			return engine.getResult(stream).text.trim();
		} finally {
			if (isLoaded()) armIdle();
		}
	}

	function enqueue<T>(job: () => Promise<T>): Promise<T> {
		const run = queue.then(job);
		queue = run.catch(() => {});
		return run;
	}

	return {
		/** `pcm`: mono 16 kHz signed 16-bit little-endian samples. */
		transcribe(pcm: Uint8Array): Promise<string> {
			return enqueue(() => decode(pcm));
		},
		/** Wait for the decode in flight, drop the recognizer (its native memory
		 *  goes with the next GC) and run `task` before any later decode, so
		 *  the model files can be removed while nothing is reading them. */
		unload<T>(task: () => Promise<T>): Promise<T> {
			return enqueue(() => {
				if (idleTimer) clearTimeout(idleTimer);
				idleTimer = null;
				recognizer = null;
				return task();
			});
		},
	};
}
