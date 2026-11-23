/**
 * The on-device dictation model on disk: download once from a pinned
 * Hugging Face commit, verify every file, remove on request. Adapted from
 * the downloader in heohlee's PR #478.
 *
 * A download writes into `<dir>.partial` and renames the finished set into
 * `<dir>` in one step, so `<dir>` is either complete or absent. A crash or a
 * cancel leaves nothing the app would mistake for a model.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { LocalSttModelState } from "../../core/dictation.ts";

export interface LocalSttModelFile {
	name: string;
	size: number;
	/** Lowercase hex SHA-256 of the file. */
	sha256: string;
}

export interface LocalSttModelSpec {
	id: string;
	label: string;
	repo: string;
	/** A full commit hash, so the files behind each URL never change. */
	revision: string;
	files: readonly LocalSttModelFile[];
}

/** NVIDIA Parakeet TDT 0.6B v3 (CC-BY-4.0), int8 export by the sherpa-onnx project. */
export const PARAKEET_V3: LocalSttModelSpec = {
	id: "parakeet-tdt-0.6b-v3-int8",
	label: "Parakeet v3",
	repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
	revision: "ed5d745623472f97cfc2e6c2916ee248798fc5a8",
	files: [
		{ name: "tokens.txt", size: 93_939, sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d" },
		{ name: "decoder.int8.onnx", size: 11_845_274, sha256: "0222a86147299d4dee90edf95b6d13827edb42ad8b7c9cf0b2582f030937c0b5" },
		{ name: "joiner.int8.onnx", size: 6_355_277, sha256: "cbd02f3696e9944970111fb439d9c3fd365a80374565f13f2b9c7007d253fc98" },
		{ name: "encoder.int8.onnx", size: 652_282_294, sha256: "1afbe69c1ffdabee94755f42e4daf1d93549131a3da11356bda84fcef0f2c479" },
	],
};

export function modelFileUrl(spec: LocalSttModelSpec, name: string): string {
	return `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${encodeURIComponent(name)}`;
}

export function modelBytes(spec: LocalSttModelSpec): number {
	return spec.files.reduce((total, file) => total + file.size, 0);
}


export const DOWNLOAD_CANCELLED = "Download cancelled";

interface ActiveDownload {
	receivedBytes: number;
	controller: AbortController;
	promise: Promise<void>;
}

export interface LocalSttModelOptions {
	spec: LocalSttModelSpec;
	/** The model's own directory; the files sit directly inside it. */
	dir: string;
	fetchImpl?: typeof fetch;
	url?: (spec: LocalSttModelSpec, name: string) => string;
}

export function createLocalSttModel(options: LocalSttModelOptions) {
	const { spec, dir } = options;
	const partial = `${dir}.partial`;
	const request = options.fetchImpl ?? fetch;
	const urlFor = options.url ?? modelFileUrl;
	const totalBytes = modelBytes(spec);
	let active: ActiveDownload | null = null;
	let lastError: string | undefined;

	/** Exact sizes are the load-time check; hashes were checked on download. */
	const installed = () => spec.files.every((file) => {
		try {
			return fs.statSync(path.join(dir, file.name)).size === file.size;
		} catch {
			return false;
		}
	});

	async function fetchFile(file: LocalSttModelFile, target: string, download: ActiveDownload) {
		const res = await request(urlFor(spec, file.name), { signal: download.controller.signal, redirect: "follow" });
		if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
		const hash = createHash("sha256");
		let fileBytes = 0;
		const counter = new Transform({
			transform(chunk: Buffer, _encoding, done) {
				fileBytes += chunk.length;
				if (fileBytes > file.size) return done(new Error("Download is larger than expected"));
				download.receivedBytes += chunk.length;
				hash.update(chunk);
				done(null, chunk);
			},
		});
		await pipeline(
			Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
			counter,
			fs.createWriteStream(target),
			{ signal: download.controller.signal },
		);
		if (fileBytes !== file.size) throw new Error("Download ended early");
		if (hash.digest("hex") !== file.sha256) throw new Error("Model integrity check failed (checksum mismatch)");
	}

	async function run(download: ActiveDownload) {
		fs.rmSync(partial, { recursive: true, force: true });
		fs.mkdirSync(partial, { recursive: true });
		try {
			for (const file of spec.files) await fetchFile(file, path.join(partial, file.name), download);
			// A cancel that lands after the last chunk must not publish the model.
			if (download.controller.signal.aborted) throw new Error(DOWNLOAD_CANCELLED);
			fs.rmSync(dir, { recursive: true, force: true });
			fs.renameSync(partial, dir);
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
			() => {
				active = null;
			},
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
		spec,
		status(): LocalSttModelState {
			if (active) return { state: "downloading", receivedBytes: active.receivedBytes, totalBytes };
			if (installed()) return { state: "ready", totalBytes };
			return lastError ? { state: "missing", totalBytes, error: lastError } : { state: "missing", totalBytes };
		},
		/** The model directory when every file is in place, else null. */
		directory(): string | null {
			return installed() ? dir : null;
		},
		download,
		cancel(): void {
			active?.controller.abort();
		},
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

export type LocalSttModel = ReturnType<typeof createLocalSttModel>;
