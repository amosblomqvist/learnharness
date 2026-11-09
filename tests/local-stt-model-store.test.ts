/**
 * The on-device model store with a fake download server and a temp folder: success,
 * SHA-256 and size mismatches, resume with a Range request, cancel, delete and a
 * concurrent start. Nothing here touches the network (huggingface.co is never contacted).
 * The fake server and scenarios are adapted from pi-voice test/models.test.ts (MIT).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CATALOG_MODELS, LANGUAGE_DETECTION_MODEL, catalogModelUrl, getCatalogModel } from "../src/core/local-stt-catalog.ts";
import { createModelStore, type ModelStore } from "../src/server/local-stt/model-store.ts";

const CHUNK = 16384;

function testData(length: number): Buffer {
	const data = Buffer.alloc(length);
	let seed = 42;
	for (let index = 0; index < length; index += 1) {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		data[index] = seed & 0xff;
	}
	return data;
}

/** The catalog is frozen JSON, so the test swaps in a small file: entries are patched in place and restored. */
const ID = "whisper-small";
const original = { ...getCatalogModel(ID)! };
const patch = (data: Buffer, sha = createHash("sha256").update(data).digest("hex")) => {
	const entry = CATALOG_MODELS.find((model) => model.id === ID) as { size: number; sha256: string };
	entry.size = data.length;
	entry.sha256 = sha;
};
const restore = () => patch(Buffer.alloc(original.size), original.sha256);

/** A fake download server with real Range semantics, counting what it serves. */
function fakeServer(options: {
	data: Buffer;
	honorRanges?: boolean;
	/** Error the stream once after serving this many bytes. */
	failAfter?: number;
	/** End the stream cleanly after serving this many bytes. */
	endAfter?: number;
	onServed?: (total: number) => void;
	/** Answer range requests with this status and no body. */
	resumeStatus?: number;
	wrongRangeStart?: boolean;
	/** Hold every response open until released. */
	gate?: Promise<void>;
}) {
	const requests: { url: string; range: string | null }[] = [];
	let served = 0;
	let failAfter = options.failAfter;
	const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const range = new Headers(init?.headers).get("range");
		requests.push({ url: String(input), range });
		await options.gate;
		if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
		const match = range?.match(/^bytes=(\d+)-$/);
		if (match && options.resumeStatus !== undefined) return new Response(null, { status: options.resumeStatus });
		const honored = Boolean(match) && options.honorRanges !== false;
		const start = honored ? Number(match![1]) : 0;
		const payload = options.data.subarray(start);
		let offset = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (init?.signal?.aborted) { controller.error(new DOMException("aborted", "AbortError")); return; }
				if (failAfter !== undefined && served >= failAfter) { failAfter = undefined; controller.error(new Error("connection reset")); return; }
				if (options.endAfter !== undefined && served >= options.endAfter) { controller.close(); return; }
				if (offset >= payload.length) { controller.close(); return; }
				const end = Math.min(offset + CHUNK, payload.length);
				controller.enqueue(new Uint8Array(payload.subarray(offset, end)));
				served += end - offset;
				offset = end;
				options.onServed?.(served);
			},
		});
		return new Response(body, {
			status: honored ? 206 : 200,
			headers: honored
				? { "content-range": `bytes ${start + (options.wrongRangeStart ? 1 : 0)}-${options.data.length - 1}/${options.data.length}` }
				: {},
		});
	}) as typeof fetch;
	return { fetchImpl, requests, served: () => served };
}

let dir: string;
let store: ModelStore;
let data: Buffer;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "lh-stt-store-"));
	data = testData(256 * 1024);
	patch(data);
});
afterEach(async () => {
	restore();
	await rm(dir, { recursive: true, force: true });
});

const storeWith = (server: { fetchImpl: typeof fetch }) => (store = createModelStore({ dir, fetch: server.fetchImpl }));
const sha = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");

describe("listing", () => {
	it("lists every catalog model and the detector as not installed in an empty folder", async () => {
		store = createModelStore({ dir: path.join(dir, "missing"), fetch: fakeServer({ data }).fetchImpl });
		const { models, languageDetector } = await store.statuses();
		assert.equal(models.length, 29);
		assert.deepEqual(models.map((m) => m.id), CATALOG_MODELS.map((m) => m.id));
		assert.deepEqual(languageDetector, { id: LANGUAGE_DETECTION_MODEL.id, installed: false, partialBytes: 0, download: null });
		assert.equal(models.every((m) => !m.installed && m.download === null), true);
	});

	it("refuses ids that are not in the catalog", async () => {
		store = storeWith(fakeServer({ data }));
		for (const id of ["nope", "../x", "", "whisper-small.gguf"]) {
			await assert.rejects(store.start(id), /Unknown local model/);
			await assert.rejects(store.delete(id), /Unknown local model/);
		}
		assert.equal(await store.installedPath("../x"), undefined);
	});

	it("counts a file as installed only at the catalog size", async () => {
		store = storeWith(fakeServer({ data }));
		await writeFile(path.join(dir, `${ID}.gguf`), data.subarray(0, 1000));
		assert.equal((await store.status(ID)).installed, false);
		await writeFile(path.join(dir, `${ID}.gguf`), data);
		assert.equal((await store.status(ID)).installed, true);
		assert.equal(await store.installedPath(ID), path.join(dir, `${ID}.gguf`));
	});
});

describe("downloading", () => {
	it("downloads from the catalog URL only, verifies, and installs atomically", async () => {
		const server = fakeServer({ data });
		storeWith(server);
		const first = await store.start(ID);
		assert.equal(first.download?.state, "downloading");
		assert.equal(first.download?.total, data.length);
		await store.settled(ID);
		const status = await store.status(ID);
		assert.deepEqual(status, { id: ID, installed: true, partialBytes: 0, download: null });
		assert.equal(sha(await readFile(path.join(dir, `${ID}.gguf`))), sha(data));
		assert.equal(existsSync(path.join(dir, `${ID}.partial`)), false);
		assert.deepEqual(server.requests, [{ url: catalogModelUrl(getCatalogModel(ID)!), range: null }]);
	});

	it("reports progress while it runs", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		storeWith(fakeServer({ data, gate }));
		await store.start(ID);
		assert.equal((await store.status(ID)).download?.bytes, 0);
		release();
		await store.settled(ID);
		assert.equal((await store.status(ID)).installed, true);
	});

	it("does nothing when the model is already installed", async () => {
		const server = fakeServer({ data });
		storeWith(server);
		await writeFile(path.join(dir, `${ID}.gguf`), data);
		const status = await store.start(ID);
		assert.equal(status.installed, true);
		assert.equal(status.download, null);
		assert.equal(server.requests.length, 0);
	});

	it("starts one download per model however many starts arrive", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const server = fakeServer({ data, gate });
		storeWith(server);
		const starts = await Promise.all([store.start(ID), store.start(ID), store.start(ID)]);
		assert.ok(starts.every((s) => s.download !== null));
		release();
		await store.settled(ID);
		assert.equal(server.requests.length, 1, "one request, one writer");
		assert.equal((await store.status(ID)).installed, true);
	});

	it("rejects a download whose bytes do not match the SHA-256, removing them, and a retry succeeds", async () => {
		patch(data, "0".repeat(64));
		storeWith(fakeServer({ data }));
		await store.start(ID);
		await store.settled(ID);
		const failed = await store.status(ID);
		assert.equal(failed.installed, false);
		assert.equal(failed.download?.state, "error");
		assert.match(failed.download?.message ?? "", /did not pass verification/);
		assert.equal(existsSync(path.join(dir, `${ID}.partial`)), false);
		assert.equal(existsSync(path.join(dir, `${ID}.gguf`)), false);

		patch(data);
		await store.start(ID);
		await store.settled(ID);
		assert.equal((await store.status(ID)).installed, true);
	});

	it("rejects a download of the wrong size", async () => {
		storeWith(fakeServer({ data: Buffer.concat([data, Buffer.from("extra")]) }));
		await store.start(ID);
		await store.settled(ID);
		const status = await store.status(ID);
		assert.equal(status.installed, false);
		assert.match(status.download?.message ?? "", /did not pass verification/);
	});

	it("keeps the error until the next start, and says so for a refused request", async () => {
		storeWith({ fetchImpl: (async () => new Response("no", { status: 503 })) as typeof fetch });
		await store.start(ID);
		await store.settled(ID);
		const failed = await store.status(ID);
		assert.equal(failed.download?.state, "error");
		assert.match(failed.download?.message ?? "", /HTTP 503/);
		assert.equal((await store.status(ID)).download?.state, "error", "polling again still shows it");
		assert.equal((await store.cancel(ID)).download, null, "cancel dismisses it");
	});
});

describe("resuming", () => {
	it("keeps a resumable partial after a dropped connection and finishes with a Range request", async () => {
		storeWith(fakeServer({ data, failAfter: 100_000 }));
		await store.start(ID);
		await store.settled(ID);
		const interrupted = await store.status(ID);
		assert.equal(interrupted.download?.state, "error");
		assert.ok(interrupted.partialBytes > 0 && interrupted.partialBytes < data.length, `partial ${interrupted.partialBytes}`);

		const second = fakeServer({ data });
		storeWith(second);
		await store.start(ID);
		await store.settled(ID);
		assert.equal(second.requests[0]!.range, `bytes=${interrupted.partialBytes}-`);
		assert.equal(second.served(), data.length - interrupted.partialBytes);
		assert.equal(sha(await readFile(path.join(dir, `${ID}.gguf`))), sha(data));
		assert.equal(existsSync(path.join(dir, `${ID}.partial`)), false);
	});

	it("keeps the partial after an early end of stream", async () => {
		storeWith(fakeServer({ data, endAfter: 100_000 }));
		await store.start(ID);
		await store.settled(ID);
		const status = await store.status(ID);
		assert.match(status.download?.message ?? "", /ended early/);
		assert.ok(status.partialBytes > 0);
		storeWith(fakeServer({ data }));
		await store.start(ID);
		await store.settled(ID);
		assert.equal((await stat(path.join(dir, `${ID}.gguf`))).size, data.length);
	});

	it("restarts cleanly when the server ignores the range", async () => {
		await writeFile(path.join(dir, `${ID}.partial`), data.subarray(0, 100_000));
		const server = fakeServer({ data, honorRanges: false });
		storeWith(server);
		await store.start(ID);
		await store.settled(ID);
		assert.equal(server.requests[0]!.range, "bytes=100000-");
		assert.equal(server.requests[1]!.range, null);
		assert.equal(sha(await readFile(path.join(dir, `${ID}.gguf`))), sha(data));
	});

	it("removes a corrupted partial at verification, then a retry succeeds", async () => {
		await writeFile(path.join(dir, `${ID}.partial`), Buffer.alloc(100_000, 7));
		storeWith(fakeServer({ data }));
		await store.start(ID);
		await store.settled(ID);
		assert.match((await store.status(ID)).download?.message ?? "", /did not pass verification/);
		assert.equal(existsSync(path.join(dir, `${ID}.partial`)), false);
		await store.start(ID);
		await store.settled(ID);
		assert.equal((await store.status(ID)).installed, true);
	});

	it("verifies and installs a full-size partial without contacting the server", async () => {
		await writeFile(path.join(dir, `${ID}.partial`), data);
		const server = fakeServer({ data });
		storeWith(server);
		await store.start(ID);
		await store.settled(ID);
		assert.equal(server.requests.length, 0);
		assert.equal((await store.status(ID)).installed, true);
	});

	it("preserves the partial across a transient server error while resuming", async () => {
		await writeFile(path.join(dir, `${ID}.partial`), data.subarray(0, 100_000));
		storeWith(fakeServer({ data, resumeStatus: 500 }));
		await store.start(ID);
		await store.settled(ID);
		const status = await store.status(ID);
		assert.match(status.download?.message ?? "", /HTTP 500/);
		assert.equal(status.partialBytes, 100_000);
	});

	it("refuses a 206 that starts at the wrong offset, leaving the partial untouched", async () => {
		await writeFile(path.join(dir, `${ID}.partial`), data.subarray(0, 100_000));
		storeWith(fakeServer({ data, wrongRangeStart: true }));
		await store.start(ID);
		await store.settled(ID);
		const status = await store.status(ID);
		assert.match(status.download?.message ?? "", /unexpected range/);
		assert.equal(status.partialBytes, 100_000);
	});
});

describe("cancel and delete", () => {
	it("cancels a running download, keeping the partial so it can resume", async () => {
		const server = fakeServer({ data, onServed: (total) => { if (total >= 100_000) void store.cancel(ID); } });
		storeWith(server);
		await store.start(ID);
		await store.settled(ID);
		const status = await store.status(ID);
		assert.equal(status.installed, false);
		assert.equal(status.download, null, "a cancelled download is not an error");
		assert.ok(status.partialBytes > 0 && status.partialBytes < data.length);
	});

	it("deletes an installed model and its partial, and stops a running download first", async () => {
		storeWith(fakeServer({ data }));
		await writeFile(path.join(dir, `${ID}.gguf`), data);
		await writeFile(path.join(dir, `${ID}.partial`), data.subarray(0, 10));
		const status = await store.delete(ID);
		assert.deepEqual(status, { id: ID, installed: false, partialBytes: 0, download: null });
		assert.equal(existsSync(path.join(dir, `${ID}.gguf`)), false);
		assert.equal(existsSync(path.join(dir, `${ID}.partial`)), false);

		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		storeWith(fakeServer({ data, gate }));
		await store.start(ID);
		const deleting = store.delete(ID);
		release();
		assert.deepEqual(await deleting, { id: ID, installed: false, partialBytes: 0, download: null });
		assert.equal(existsSync(path.join(dir, `${ID}.partial`)), false);
	});

	it("deleting a model that is not there is fine", async () => {
		storeWith(fakeServer({ data }));
		assert.equal((await store.delete(ID)).installed, false);
	});
});
