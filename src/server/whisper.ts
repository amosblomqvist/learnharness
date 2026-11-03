/**
 * Local dictation (whisper.cpp) — the server half, kept in its own module so
 * the local-whisper branch touches as little upstream code as possible.
 *
 * Layout under the data dir (LH_DATA_DIR / userData/data):
 *   whisper/whisper-cli(.exe) + its DLLs   — LH_WHISPER_BIN overrides
 *   whisper/ggml-base.en.bin               — LH_WHISPER_MODEL overrides
 *   dictation-engine.json                  — {"engine": "whisper" | "deepgram"}
 *
 * The engine choice deliberately lives OUTSIDE settings.json: the upstream
 * dictation section is written replace-whole by the language picker, which
 * would drop any field it doesn't know.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SETTINGS_FILE } from "../../config.ts";

export const DICTATION_ENGINES = ["whisper", "deepgram"] as const;
export type DictationEngine = (typeof DICTATION_ENGINES)[number];
export const DEFAULT_DICTATION_ENGINE: DictationEngine = "whisper";

const DATA_ROOT = path.dirname(SETTINGS_FILE);
const WHISPER_DIR = path.join(DATA_ROOT, "whisper");
const ENGINE_FILE = path.join(DATA_ROOT, "dictation-engine.json");

export const WHISPER_BIN =
	process.env.LH_WHISPER_BIN ?? path.join(WHISPER_DIR, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
export const WHISPER_MODEL = process.env.LH_WHISPER_MODEL ?? path.join(WHISPER_DIR, "ggml-base.en.bin");

export const WHISPER_SAMPLE_RATE = 16000;

export function isDictationEngine(value: unknown): value is DictationEngine {
	return (DICTATION_ENGINES as readonly unknown[]).includes(value);
}

export function readDictationEngine(): DictationEngine {
	try {
		const raw = JSON.parse(fs.readFileSync(ENGINE_FILE, "utf-8")) as { engine?: unknown };
		return isDictationEngine(raw.engine) ? raw.engine : DEFAULT_DICTATION_ENGINE;
	} catch {
		return DEFAULT_DICTATION_ENGINE; // absent or corrupt → the default
	}
}

export function writeDictationEngine(engine: DictationEngine): void {
	fs.mkdirSync(DATA_ROOT, { recursive: true });
	fs.writeFileSync(ENGINE_FILE, JSON.stringify({ engine }, null, "\t"), "utf-8");
}

export function whisperInstalled(): boolean {
	return fs.existsSync(WHISPER_BIN) && fs.existsSync(WHISPER_MODEL);
}

/**
 * Deepgram language code → whisper.cpp's. Whisper takes bare ISO codes
 * ("en-US" → "en"), "multi" becomes auto-detect, and English-only models
 * (*.en.bin) always run as "en".
 */
export function whisperLanguage(language: string | null): string {
	if (/\.en\.bin$/i.test(WHISPER_MODEL)) return "en";
	if (!language) return "en";
	if (language === "multi") return "auto";
	return language.split("-")[0]!.toLowerCase();
}

/** Wrap raw linear16 mono PCM in a 44-byte RIFF/WAVE header. */
export function pcmToWav(pcm: Buffer): Buffer {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16); // fmt chunk size
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(WHISPER_SAMPLE_RATE, 24);
	header.writeUInt32LE(WHISPER_SAMPLE_RATE * 2, 28); // byte rate
	header.writeUInt16LE(2, 32); // block align
	header.writeUInt16LE(16, 34); // bits per sample
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

/** whisper.cpp's non-speech markers ("[BLANK_AUDIO]", "(music)") are not dictation. */
export function cleanTranscript(stdout: string): string {
	return stdout
		.replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Transcribe one run's PCM with whisper-cli over a temp WAV file. */
export async function transcribePcm(pcm: Buffer, language: string): Promise<string> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-whisper-"));
	const wavPath = path.join(dir, "dictation.wav");
	try {
		fs.writeFileSync(wavPath, pcmToWav(pcm));
		const threads = String(Math.max(1, Math.min(8, os.cpus().length - 1)));
		const stdout = await new Promise<string>((resolve, reject) => {
			execFile(
				WHISPER_BIN,
				["-m", WHISPER_MODEL, "-f", wavPath, "-l", language, "-t", threads, "-nt", "-np"],
				{ timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
				(err, out, stderr) => {
					if (err) reject(new Error(stderr.trim().split("\n").pop() || err.message));
					else resolve(out);
				},
			);
		});
		return cleanTranscript(stdout);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
