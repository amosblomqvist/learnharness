/**
 * The on-device model store: which catalog models are on disk, and downloading,
 * cancelling and deleting them. Models live in `<data dir>/stt-models/<id>.gguf`.
 *
 * A download goes to `<id>.partial`, resumes with an HTTP Range request, and is renamed
 * into place only if its size and SHA-256 match the catalog. The resume and verification
 * logic is adapted from pi-voice src/models.ts (MIT, Copyright (c) 2026 Earendil Works
 * contributors): https://github.com/earendil-works/pi-voice
 *
 * Only a URL built from the catalog entry (catalogModelUrl) is ever fetched.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { PATHS } from "../../../config.ts";
import {
	CATALOG_MODELS,
	LANGUAGE_DETECTION_MODEL,
	catalogModelUrl,
	getDownloadableModel,
	type CatalogModel,
} from "../../core/local-stt-catalog.ts";
import type { LocalModelStatus } from "../../core/local-stt.ts";

export type ModelStoreOptions = {
	/** Where models live. Created on first download. */
	dir: string;
	/** Injectable for tests; defaults to the global fetch. */
	fetch?: typeof fetch;
};

export type ModelStore = {
	readonly dir: string;
	/** The file's path when the model is fully installed, else undefined. */
	installedPath(id: string): Promise<string | undefined>;
	status(id: string): Promise<LocalModelStatus>;
	/** Every catalog model, in catalog order, and the language detector. */
	statuses(): Promise<{ models: LocalModelStatus[]; languageDetector: LocalModelStatus }>;
	/** Start (or resume) a download in the background. A running one is left alone. */
	start(id: string): Promise<LocalModelStatus>;
	/** Stop a running download. Its partial file is kept so a later start resumes. */
	cancel(id: string): Promise<LocalModelStatus>;
	/** Remove the installed file and any partial, stopping a running download first. */
	delete(id: string): Promise<LocalModelStatus>;
	/** Resolves when the download of this model, if any, has settled. */
	settled(id: string): Promise<void>;
};

type Active = {
	controller: AbortController;
	download: { state: "downloading" | "verifying"; bytes: number; total: number };
	done: Promise<void>;
};

class DownloadFailure extends Error {}

const finalName = (model: CatalogModel) => `${model.id}.gguf`;
const partialName = (model: CatalogModel) => `${model.id}.partial`;

/** The size of a file, or undefined when it is not there. */
async function sizeOf(file: string): Promise<number | undefined> {
	try {
		return (await stat(file)).size;
	} catch {
		return undefined;
	}
}

function failureMessage(model: CatalogModel, error: unknown): string {
	if (error instanceof DownloadFailure) return error.message;
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code === "ENOSPC") return `Not enough disk space to download ${model.name}.`;
	if (code === "EACCES" || code === "EPERM" || code === "EROFS") return `Cannot write ${model.name} to the model folder.`;
	return `Could not download ${model.name}. Check your connection and try again.`;
}

export function createModelStore(options: ModelStoreOptions): ModelStore {
	const { dir } = options;
	const fetchImpl = options.fetch ?? fetch;
	const active = new Map<string, Active>();
	/** The last failure of a download, until the next start or delete. */
	const failures = new Map<string, string>();

	const modelFor = (id: string): CatalogModel => {
		const model = getDownloadableModel(id);
		if (!model) throw new Error(`Unknown local model: ${id}`);
		return model;
	};

	async function installedPath(id: string): Promise<string | undefined> {
		const model = getDownloadableModel(id);
		if (!model) return undefined;
		const file = path.join(dir, finalName(model));
		return (await sizeOf(file)) === model.size ? file : undefined;
	}

	async function status(id: string): Promise<LocalModelStatus> {
		const model = modelFor(id);
		const running = active.get(id);
		const failure = failures.get(id);
		const installed = (await installedPath(id)) !== undefined;
		const partialBytes = (await sizeOf(path.join(dir, partialName(model)))) ?? 0;
		return {
			id,
			installed,
			partialBytes: installed ? 0 : partialBytes,
			download: running
				? { ...running.download }
				: failure !== undefined
					? { state: "error", bytes: partialBytes, total: model.size, message: failure }
					: null,
		};
	}

	/** The body of one download attempt: resume, stream, verify, publish. */
	async function transfer(model: CatalogModel, run: Active): Promise<void> {
		const { signal } = run.controller;
		const partial = path.join(dir, partialName(model));
		await mkdir(dir, { recursive: true });

		let digest = createHash("sha256");
		let bytes = 0;
		let resume = false;
		const saved = (await sizeOf(partial)) ?? 0;
		if (saved > model.size) await rm(partial, { force: true });
		else if (saved > 0) {
			// Hash the saved prefix, then request only the rest.
			for await (const chunk of createReadStream(partial)) {
				signal.throwIfAborted();
				digest.update(chunk as Buffer);
				bytes += (chunk as Buffer).length;
			}
			resume = true;
		}
		run.download.bytes = bytes;

		const write = async (body: NodeReadableStream<Uint8Array>, append: boolean): Promise<void> => {
			const file = await open(partial, append ? "a" : "w");
			try {
				for await (const value of body) {
					signal.throwIfAborted();
					const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
					// Await every write so an abort or error leaves a clean prefix that can be resumed.
					await file.writeFile(chunk);
					bytes += chunk.length;
					digest.update(chunk);
					run.download.bytes = bytes;
				}
			} finally {
				await file.close();
			}
		};

		const request = async (from: number): Promise<Response> =>
			fetchImpl(catalogModelUrl(model), { signal, ...(from > 0 ? { headers: { Range: `bytes=${from}-` } } : {}) });

		if (bytes < model.size) {
			let response = await request(bytes);
			if (resume && response.status === 200) {
				// The server ignored the range: discard this response and start over.
				await response.body?.cancel().catch(() => undefined);
				await rm(partial, { force: true });
				digest = createHash("sha256");
				bytes = 0;
				resume = false;
				run.download.bytes = 0;
				response = await request(0);
			}
			if (resume) {
				if (response.status !== 206 || !response.body) {
					// Keep the saved prefix across transient server failures.
					await response.body?.cancel().catch(() => undefined);
					throw new DownloadFailure(`The download server answered HTTP ${response.status} while resuming ${model.name}. Try again shortly.`);
				}
				const contentRange = response.headers.get("content-range");
				const range = contentRange?.match(/^bytes (\d+)-\d+\/(\d+)$/);
				if (!range || Number(range[1]) !== bytes || Number(range[2]) !== model.size) {
					// Never append bytes that belong somewhere else.
					await response.body.cancel().catch(() => undefined);
					throw new DownloadFailure(`The download server sent an unexpected range while resuming ${model.name}. Try again.`);
				}
			} else if (response.status !== 200 || !response.body) {
				await response.body?.cancel().catch(() => undefined);
				throw new DownloadFailure(`The download server answered HTTP ${response.status} for ${model.name}. Try again shortly.`);
			}
			await write(response.body as unknown as NodeReadableStream<Uint8Array>, resume);
		}
		signal.throwIfAborted();

		run.download.state = "verifying";
		const written = (await sizeOf(partial)) ?? 0;
		if (written < model.size) {
			throw new DownloadFailure(`The download of ${model.name} ended early. Start it again to resume.`);
		}
		if (written > model.size || digest.digest("hex") !== model.sha256) {
			await rm(partial, { force: true });
			throw new DownloadFailure(`${model.name} did not pass verification, so it was removed. Download it again.`);
		}
		// Same directory, so the rename is atomic: the model appears whole or not at all.
		await rename(partial, path.join(dir, finalName(model)));
	}

	async function start(id: string): Promise<LocalModelStatus> {
		const model = modelFor(id);
		if (!active.has(id) && (await installedPath(id)) === undefined && !active.has(id)) {
			failures.delete(id);
			const controller = new AbortController();
			const run: Active = {
				controller,
				download: { state: "downloading", bytes: 0, total: model.size },
				done: Promise.resolve(),
			};
			// Registered before the first await below, so a concurrent start sees it.
			active.set(id, run);
			run.done = transfer(model, run)
				.catch((error: unknown) => {
					if (controller.signal.aborted) return;
					failures.set(id, failureMessage(model, error));
					if (!(error instanceof DownloadFailure)) console.warn(`[stt] download of ${id} failed:`, error);
				})
				.finally(() => { active.delete(id); });
		}
		return status(id);
	}

	/** Stop a running download, wait for it to settle, and forget its failure. */
	async function stopDownload(id: string): Promise<void> {
		const run = active.get(id);
		if (run) {
			run.controller.abort();
			await run.done;
		}
		failures.delete(id);
	}

	async function cancel(id: string): Promise<LocalModelStatus> {
		modelFor(id);
		await stopDownload(id);
		return status(id);
	}

	async function remove(id: string): Promise<LocalModelStatus> {
		const model = modelFor(id);
		await stopDownload(id);
		await rm(path.join(dir, finalName(model)), { force: true });
		await rm(path.join(dir, partialName(model)), { force: true });
		return status(id);
	}

	return {
		dir,
		installedPath,
		status,
		async statuses() {
			return {
				models: await Promise.all(CATALOG_MODELS.map((model) => status(model.id))),
				languageDetector: await status(LANGUAGE_DETECTION_MODEL.id),
			};
		},
		start,
		cancel,
		delete: remove,
		settled: async (id) => { await active.get(id)?.done; },
	};
}

/** The stt-models folder inside the data dir (LH_DATA_DIR relocates it, as for every mutable record). */
export function modelStoreDir(): string {
	return path.join(PATHS.data, "stt-models");
}

// Next compiles each route into its own module instance; downloads in flight
// must be one registry for the whole process, so the store lives on globalThis.
const g = globalThis as typeof globalThis & { __lhLocalModelStore?: ModelStore };

export function localModelStore(): ModelStore {
	return (g.__lhLocalModelStore ??= createModelStore({ dir: modelStoreDir() }));
}

/** Test seam: replace (or clear) the process-wide store. */
export function setLocalModelStore(store: ModelStore | undefined): void {
	g.__lhLocalModelStore = store;
}
