/**
 * The fs adapter for local dictation (issue #15, PR #50): implements
 * core/ports.ts DictationStore over config.DICTATION_DIR. Persistence and
 * nothing else — selection rules, the model catalog and every network
 * fetch live in src/server/dictation.ts and core/dictation.ts.
 *
 *   dictation/state.json            {selected, device}
 *   dictation/models/<id>/…         one curated model, repo layout kept
 *                                   (config.json, onnx/encoder_model.onnx…)
 *   dictation/models/<id>.partial/  a download in flight; swapped in
 *                                   whole by commitModel
 *   dictation/runtime/<ver>/…       the ONNX runtime wasm + factory
 *
 * Under the LH_DATA_DIR seam on purpose: browser storage is per-origin and
 * the desktop shell picks a fresh loopback port every launch.
 */

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { DICTATION_DIR } from "../../config.ts";
import { sanitizeDictationState, type DictationState } from "../core/dictation.ts";
import type { DictationStore } from "../core/ports.ts";

const STATE_FILE = path.join(DICTATION_DIR, "state.json");
const MODELS_DIR = path.join(DICTATION_DIR, "models");
const RUNTIME_DIR = path.join(DICTATION_DIR, "runtime");

const modelDir = (id: string) => path.join(MODELS_DIR, id);
const stagedDir = (id: string) => `${modelDir(id)}.partial`;

/** Stream a body to `dest` via a sibling .partial file, renamed into place
 *  only when complete — a cut download never looks finished. */
async function streamToFile(body: ReadableStream<Uint8Array>, dest: string, onBytes?: (n: number) => void) {
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	const source = Readable.fromWeb(body as NodeReadableStream<Uint8Array>);
	if (onBytes) source.on("data", (chunk: Buffer) => onBytes(chunk.length));
	const tmp = `${dest}.partial`;
	await pipeline(source, fs.createWriteStream(tmp));
	fs.renameSync(tmp, dest);
}

/** `rest` resolved inside `root`, or null when it escapes it. */
function inside(root: string, rest: string[]): string | null {
	const full = path.resolve(root, ...rest);
	return full.startsWith(root + path.sep) ? full : null;
}

export const dictationStore: DictationStore = {
	readState() {
		try {
			return sanitizeDictationState(JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")));
		} catch {
			return sanitizeDictationState(null);
		}
	},

	writeState(state: DictationState) {
		const clean = sanitizeDictationState(state);
		fs.mkdirSync(DICTATION_DIR, { recursive: true });
		fs.writeFileSync(STATE_FILE, JSON.stringify(clean, null, "\t"), "utf-8");
		return clean;
	},

	modelExists(id) {
		return fs.existsSync(path.join(modelDir(id), "config.json"));
	},

	modelHasFile(id, repoPath) {
		const full = inside(modelDir(id), [repoPath]);
		return full !== null && fs.existsSync(full);
	},

	modelTime(id) {
		try {
			return fs.statSync(modelDir(id)).mtimeMs;
		} catch {
			return 0;
		}
	},

	modelFilePath(id, repoPath) {
		const full = inside(modelDir(id), repoPath);
		if (!full || !fs.existsSync(full)) return null;
		return fs.statSync(full).isFile() ? full : null;
	},

	beginModel(id) {
		fs.rmSync(stagedDir(id), { recursive: true, force: true });
	},

	async writeModelFile(id, repoPath, body, onBytes) {
		const dest = inside(stagedDir(id), [repoPath]);
		if (!dest) throw new Error(`Refusing to write outside the model folder: ${repoPath}`);
		await streamToFile(body, dest, onBytes);
	},

	commitModel(id) {
		// Synchronous, so no request sees a gap between the two steps.
		fs.rmSync(modelDir(id), { recursive: true, force: true });
		fs.renameSync(stagedDir(id), modelDir(id));
	},

	discardStaged(id) {
		fs.rmSync(stagedDir(id), { recursive: true, force: true });
	},

	removeModel(id) {
		fs.rmSync(stagedDir(id), { recursive: true, force: true });
		fs.rmSync(modelDir(id), { recursive: true, force: true });
	},

	runtimeFilePath(version, file) {
		const full = inside(RUNTIME_DIR, [version, file]);
		return full && fs.existsSync(full) ? full : null;
	},

	async writeRuntimeFile(version, file, body, onBytes) {
		const dest = inside(RUNTIME_DIR, [version, file]);
		if (!dest) throw new Error(`Refusing to write outside the runtime folder: ${version}/${file}`);
		await streamToFile(body, dest, onBytes);
	},
};
