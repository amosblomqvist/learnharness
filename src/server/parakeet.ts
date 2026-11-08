/**
 * The app's single Parakeet instance: NVIDIA Parakeet TDT 0.6B v3 (int8),
 * sherpa-onnx's conversion, CC BY 4.0. The release archive is pinned by
 * size and SHA-256, so a changed or tampered download is refused.
 */
import { PARAKEET_MODEL_DIR } from "../../config.ts";
import { createParakeetModel } from "./parakeet-model.ts";
import { createParakeetHandlers } from "./parakeet-http.ts";
import { createParakeetTranscriber } from "./parakeet-transcriber.ts";

export const PARAKEET_ARCHIVE_URL =
	"https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2";
export const PARAKEET_ARCHIVE_SHA256 = "1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9";
export const PARAKEET_ARCHIVE_BYTES = 487_211_443;
/** 10 minutes of 16 kHz mono 16-bit audio; the client stops dictation here. */
export const PARAKEET_MAX_AUDIO_BYTES = 10 * 60 * 16_000 * 2;

export const parakeetModel = createParakeetModel({
	dir: PARAKEET_MODEL_DIR,
	url: PARAKEET_ARCHIVE_URL,
	sha256: PARAKEET_ARCHIVE_SHA256,
	sizeBytes: PARAKEET_ARCHIVE_BYTES,
	requiredFiles: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
});

export const parakeetTranscriber = createParakeetTranscriber({ files: () => parakeetModel.files() });

export const parakeetHandlers = createParakeetHandlers({
	model: parakeetModel,
	transcriber: parakeetTranscriber,
	maxAudioBytes: PARAKEET_MAX_AUDIO_BYTES,
});
