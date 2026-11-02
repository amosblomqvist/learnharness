/**
 * The Parakeet model on disk: download once from the pinned release, verify,
 * extract flat into one directory, remove on request. Mutable state lives
 * under the data root (config.ts), never in the app bundle.
 *
 * A download works in `<dir>.partial` and the finished tree is renamed into
 * `<dir>` in one step, so `<dir>` is either complete or absent — a crash or
 * a cancel leaves nothing the app would mistake for a model.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface ParakeetModelOptions {
	/** Final install directory (holds the model files directly). */
	dir: string;
	/** Release archive (.tar.bz2 with one top-level directory). */
	url: string;
	/** Pinned SHA-256 of the archive, lowercase hex. */
	sha256: string;
	/** Exact archive size — progress denominator and download ceiling. */
	sizeBytes: number;
	/** Files that must exist, relative to `dir`, for the model to count as installed. */
	requiredFiles: readonly string[];
	/** Ceiling on the unpacked tree's total size (default MAX_UNPACKED_BYTES). */
	maxUnpackedBytes?: number;
	fetchImpl?: typeof fetch;
}

export type ParakeetModelStatus =
	| { state: "missing"; error?: string }
	| { state: "downloading"; receivedBytes: number; totalBytes: number }
	| { state: "ready"; diskBytes: number };

export interface ParakeetModelFiles {
	encoder: string;
	decoder: string;
	joiner: string;
	tokens: string;
}

export const DOWNLOAD_CANCELLED = "Download cancelled";

/** The model unpacks to ~670 MB; anything past this is not that archive. */
export const MAX_UNPACKED_BYTES = 800_000_000;

interface ActiveDownload {
	receivedBytes: number;
	controller: AbortController;
	promise: Promise<void>;
}

function extractArchive(archive: string, dest: string, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		fs.mkdirSync(dest, { recursive: true });
		const child = spawn("tar", ["-xjf", archive, "-C", dest, "--strip-components=1"], { stdio: ["ignore", "ignore", "pipe"], signal });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		child.on("error", (error) => reject(new Error(`Could not run tar to unpack the model: ${error.message}`)));
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`Unpacking the model failed (tar exit ${code}): ${stderr.trim().slice(0, 200)}`));
		});
	});
}

/** Total size of an unpacked tree, refusing symbolic links and oversize. */
function checkUnpacked(dir: string, limit: number): void {
	let total = 0;
	const walk = (current: string) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isSymbolicLink()) throw new Error("Model archive contains a symbolic link");
			if (entry.isDirectory()) { walk(full); continue; }
			total += fs.lstatSync(full).size;
			if (total > limit) throw new Error("Unpacked model is larger than expected");
		}
	};
	walk(dir);
}

function treeBytes(dir: string): number {
	let total = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		total += entry.isDirectory() ? treeBytes(full) : fs.statSync(full).size;
	}
	return total;
}

export function createParakeetModel(options: ParakeetModelOptions) {
	const { dir, url, sha256, sizeBytes, requiredFiles } = options;
	const maxUnpackedBytes = options.maxUnpackedBytes ?? MAX_UNPACKED_BYTES;
	const partial = `${dir}.partial`;
	const request = options.fetchImpl ?? fetch;
	let active: ActiveDownload | null = null;
	let lastError: string | undefined;

	const installed = () => requiredFiles.every((file) => {
		try { return fs.statSync(path.join(dir, file)).size > 0; } catch { return false; }
	});

	async function transfer(archive: string, active: ActiveDownload) {
		const res = await request(url, { signal: active.controller.signal });
		if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
		const hash = createHash("sha256");
		const counter = new Transform({
			transform(chunk: Buffer, _encoding, done) {
				active.receivedBytes += chunk.length;
				if (active.receivedBytes > sizeBytes) return done(new Error("Download is larger than expected"));
				hash.update(chunk);
				done(null, chunk);
			},
		});
		await pipeline(
			Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
			counter,
			fs.createWriteStream(archive),
			{ signal: active.controller.signal },
		);
		if (hash.digest("hex") !== sha256) throw new Error("Model integrity check failed (checksum mismatch)");
	}

	async function run(active: ActiveDownload) {
		fs.rmSync(partial, { recursive: true, force: true });
		fs.mkdirSync(partial, { recursive: true });
		try {
			const archive = path.join(partial, "archive.tar.bz2");
			await transfer(archive, active);
			const unpacked = path.join(partial, "model");
			await extractArchive(archive, unpacked, active.controller.signal);
			// A cancel that lands as tar exits must not publish the model.
			if (active.controller.signal.aborted) throw new Error(DOWNLOAD_CANCELLED);
			checkUnpacked(unpacked, maxUnpackedBytes);
			for (const file of requiredFiles) {
				if (!fs.existsSync(path.join(unpacked, file))) throw new Error(`Model archive is missing ${file}`);
			}
			fs.rmSync(archive, { force: true });
			fs.rmSync(dir, { recursive: true, force: true });
			fs.mkdirSync(path.dirname(dir), { recursive: true });
			fs.renameSync(unpacked, dir);
		} finally {
			fs.rmSync(partial, { recursive: true, force: true });
		}
	}

	function download(): Promise<void> {
		if (active) return active.promise;
		if (installed()) return Promise.resolve();
		lastError = undefined;
		const current: ActiveDownload = { receivedBytes: 0, controller: new AbortController(), promise: Promise.resolve() };
		current.promise = run(current).then(
			() => { active = null; },
			(error: unknown) => {
				active = null;
				if (current.controller.signal.aborted) throw new Error(DOWNLOAD_CANCELLED);
				lastError = error instanceof Error ? error.message : "Download failed";
				throw error;
			},
		);
		active = current;
		return current.promise;
	}

	return {
		status(): ParakeetModelStatus {
			if (active) return { state: "downloading", receivedBytes: active.receivedBytes, totalBytes: sizeBytes };
			if (installed()) return { state: "ready", diskBytes: treeBytes(dir) };
			return lastError ? { state: "missing", error: lastError } : { state: "missing" };
		},
		files(): ParakeetModelFiles | null {
			if (!installed()) return null;
			return {
				encoder: path.join(dir, "encoder.int8.onnx"),
				decoder: path.join(dir, "decoder.int8.onnx"),
				joiner: path.join(dir, "joiner.int8.onnx"),
				tokens: path.join(dir, "tokens.txt"),
			};
		},
		download,
		cancel(): void { active?.controller.abort(); },
		async remove(): Promise<void> {
			if (active) {
				active.controller.abort();
				await active.promise.catch(() => {});
			}
			lastError = undefined;
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(partial, { recursive: true, force: true });
		},
	};
}
