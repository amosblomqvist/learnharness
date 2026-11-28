import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createLocalSttModel, DOWNLOAD_CANCELLED, modelFileUrl, PARAKEET_V3, type LocalSttModelSpec } from "../src/server/local-stt/model.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-local-stt-"));
	dirs.push(dir);
	return path.join(dir, "models", "test-model");
}

const files = { "a.txt": Buffer.from("alpha"), "b.onnx": Buffer.from("bravo-bytes") };
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const spec: LocalSttModelSpec = {
	id: "test-model", label: "Test", repo: "org/repo", revision: "0".repeat(40),
	files: Object.entries(files).map(([name, bytes]) => ({ name, size: bytes.length, sha256: sha(bytes) })),
};

function server(override: Partial<Record<string, Buffer>> = {}) {
	const requests: string[] = [];
	const fetchImpl = (async (url: string) => {
		requests.push(url);
		const name = url.split("/").pop()!;
		const body = override[name] ?? files[name as keyof typeof files];
		return body ? new Response(new Uint8Array(body)) : new Response("missing", { status: 404 });
	}) as typeof fetch;
	return { requests, fetchImpl };
}

test("the pinned Parakeet spec names an immutable commit and four hashed files", () => {
	assert.match(PARAKEET_V3.revision, /^[0-9a-f]{40}$/);
	assert.deepEqual(PARAKEET_V3.files.map((file) => file.name).sort(), ["decoder.int8.onnx", "encoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]);
	for (const file of PARAKEET_V3.files) assert.match(file.sha256, /^[0-9a-f]{64}$/);
	assert.equal(
		modelFileUrl(PARAKEET_V3, "tokens.txt"),
		`https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/${PARAKEET_V3.revision}/tokens.txt`,
	);
});

test("downloads every file, verifies it, and publishes the directory in one step", async () => {
	const dir = scratch();
	const { requests, fetchImpl } = server();
	const model = createLocalSttModel({ spec, dir, fetchImpl });
	assert.equal(model.status().state, "missing");
	assert.equal(model.directory(), null);
	await model.download();
	assert.deepEqual(model.status(), { state: "ready", totalBytes: 16 });
	assert.equal(model.directory(), dir);
	assert.equal(fs.readFileSync(path.join(dir, "b.onnx"), "utf8"), "bravo-bytes");
	assert.equal(fs.existsSync(`${dir}.partial`), false);
	assert.equal(requests.length, 2);
	assert.match(requests[0]!, /\/org\/repo\/resolve\/0{40}\/a\.txt$/);
	// Installed: a second download is a no-op.
	await model.download();
	assert.equal(requests.length, 2);
});

test("a checksum mismatch publishes nothing and reports the error", async () => {
	const dir = scratch();
	const model = createLocalSttModel({ spec, dir, fetchImpl: server({ "b.onnx": Buffer.from("bravo-BYTES") }).fetchImpl });
	await assert.rejects(model.download(), /checksum mismatch/);
	assert.equal(fs.existsSync(dir), false);
	assert.equal(fs.existsSync(`${dir}.partial`), false);
	assert.deepEqual(model.status(), { state: "missing", totalBytes: 16, error: "Model integrity check failed (checksum mismatch)" });
});

test("an oversized or short file is refused", async () => {
	const big = createLocalSttModel({ spec, dir: scratch(), fetchImpl: server({ "a.txt": Buffer.from("alphabet") }).fetchImpl });
	await assert.rejects(big.download(), /larger than expected/);
	const short = createLocalSttModel({ spec, dir: scratch(), fetchImpl: server({ "a.txt": Buffer.from("alp") }).fetchImpl });
	await assert.rejects(short.download(), /ended early/);
	const missing = createLocalSttModel({ spec, dir: scratch(), fetchImpl: server({}).fetchImpl, url: () => "https://x/none" });
	await assert.rejects(missing.download(), /HTTP 404/);
});

test("a file with the wrong size on disk does not count as installed", async () => {
	const dir = scratch();
	const model = createLocalSttModel({ spec, dir, fetchImpl: server().fetchImpl });
	await model.download();
	fs.writeFileSync(path.join(dir, "a.txt"), "alph");
	assert.equal(model.status().state, "missing");
	assert.equal(model.directory(), null);
});

test("cancel stops a download in flight; remove deletes the model", async () => {
	const dir = scratch();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		const name = url.split("/").pop()!;
		const body = files[name as keyof typeof files];
		if (name === "b.onnx") {
			await gate;
			init?.signal?.throwIfAborted();
		}
		return new Response(new Uint8Array(body));
	}) as typeof fetch;
	const model = createLocalSttModel({ spec, dir, fetchImpl });
	const running = model.download();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(model.status().state, "downloading");
	model.cancel();
	release();
	await assert.rejects(running, new RegExp(DOWNLOAD_CANCELLED));
	assert.deepEqual(model.status(), { state: "missing", totalBytes: 16 });
	assert.equal(fs.existsSync(dir), false);
	assert.equal(fs.existsSync(`${dir}.partial`), false);

	const done = createLocalSttModel({ spec, dir, fetchImpl: server().fetchImpl });
	await done.download();
	await done.remove();
	assert.equal(fs.existsSync(dir), false);
	assert.equal(done.status().state, "missing");
});
