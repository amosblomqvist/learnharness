import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createParakeetModel } from "../src/server/parakeet-model.ts";

const REQUIRED = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"];
const root = mkdtempSync(path.join(tmpdir(), "lh-parakeet-model-"));
let server: Server;
let base = "";
let hits = 0;
/** What the fake release server does for /model.tar.bz2: "ok", "slow", "404". */
let mode: "ok" | "slow" | "404" = "ok";
let archive: Buffer;
let archiveSha = "";
let brokenArchive: Buffer;
let linkedArchive: Buffer;

function makeArchive(name: string, files: string[], symlink = false): Buffer {
	const src = path.join(root, `src-${name}`);
	const top = path.join(src, "parakeet-fixture");
	mkdirSync(top, { recursive: true });
	for (const file of files) writeFileSync(path.join(top, file), `fixture:${file}`);
	if (symlink) symlinkSync("/etc/hostname", path.join(top, "link.txt"));
	const out = path.join(root, `${name}.tar.bz2`);
	execFileSync("tar", ["-cjf", out, "-C", src, "parakeet-fixture"]);
	return readFileSync(out);
}

before(async () => {
	archive = makeArchive("good", [...REQUIRED, "test_wavs.txt"]);
	archiveSha = createHash("sha256").update(archive).digest("hex");
	brokenArchive = makeArchive("broken", REQUIRED.slice(1));
	linkedArchive = makeArchive("linked", REQUIRED, true);
	server = createServer((req, res) => {
		hits++;
		if (req.url === "/broken.tar.bz2") return void res.end(brokenArchive);
		if (req.url === "/linked.tar.bz2") return void res.end(linkedArchive);
		if (mode === "404") { res.statusCode = 404; return void res.end("nope"); }
		res.setHeader("content-length", String(archive.length));
		if (mode === "ok") return void res.end(archive);
		res.write(archive.subarray(0, 8));
		const timer = setInterval(() => res.write(Buffer.alloc(0)), 20);
		res.on("close", () => clearInterval(timer));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
	server.closeAllConnections();
	server.close();
	rmSync(root, { recursive: true, force: true });
});

let n = 0;
function fresh(overrides: Partial<Parameters<typeof createParakeetModel>[0]> = {}) {
	const dir = path.join(root, `model-${++n}`, "parakeet");
	hits = 0;
	mode = "ok";
	const model = createParakeetModel({
		dir, url: `${base}/model.tar.bz2`, sha256: archiveSha, sizeBytes: archive.length, requiredFiles: REQUIRED, ...overrides,
	});
	return { dir, model, leftovers: () => (existsSync(path.dirname(dir)) ? readdirSync(path.dirname(dir)) : []) };
}

describe("Parakeet model manager", () => {
	it("starts as missing with nothing on disk", () => {
		const { model, dir } = fresh();
		assert.deepEqual(model.status(), { state: "missing" });
		assert.equal(model.files(), null);
		assert.equal(existsSync(dir), false);
	});

	it("downloads, verifies the pinned hash, extracts flat and reports ready with the file paths", async () => {
		const { model, dir, leftovers } = fresh();
		const done = model.download();
		const status = model.status();
		assert.equal(status.state, "downloading");
		await done;
		const ready = model.status();
		assert.equal(ready.state, "ready");
		assert.ok(ready.state === "ready" && ready.diskBytes > 0);
		assert.deepEqual(model.files(), {
			encoder: path.join(dir, "encoder.int8.onnx"),
			decoder: path.join(dir, "decoder.int8.onnx"),
			joiner: path.join(dir, "joiner.int8.onnx"),
			tokens: path.join(dir, "tokens.txt"),
		});
		assert.deepEqual(leftovers(), ["parakeet"], "no partial or archive left beside the model");
	});

	it("reports byte progress while downloading", async () => {
		const { model } = fresh();
		const done = model.download();
		const during = model.status();
		assert.ok(during.state === "downloading" && during.totalBytes === archive.length);
		await done;
	});

	it("rejects a hash mismatch, installs nothing and keeps the reason", async () => {
		const { model, dir, leftovers } = fresh({ sha256: "0".repeat(64) });
		await assert.rejects(model.download(), /integrity|checksum|hash/i);
		const status = model.status();
		assert.equal(status.state, "missing");
		assert.match((status as { error?: string }).error ?? "", /integrity|checksum|hash/i);
		assert.equal(existsSync(dir), false);
		assert.deepEqual(leftovers(), []);
	});

	it("rejects an archive that lacks a required file", async () => {
		const sha = createHash("sha256").update(brokenArchive).digest("hex");
		const { model, dir, leftovers } = fresh({ url: `${base}/broken.tar.bz2`, sha256: sha, sizeBytes: brokenArchive.length });
		await assert.rejects(model.download(), /encoder\.int8\.onnx/);
		assert.equal(model.status().state, "missing");
		assert.equal(existsSync(dir), false);
		assert.deepEqual(leftovers(), []);
	});

	it("rejects an HTTP failure with the status in the reason", async () => {
		const { model, leftovers } = fresh();
		mode = "404";
		await assert.rejects(model.download(), /404/);
		assert.match((model.status() as { error?: string }).error ?? "", /404/);
		assert.deepEqual(leftovers(), []);
	});

	it("cancel aborts the transfer without recording an error or leaving files", async () => {
		const { model, dir, leftovers } = fresh();
		mode = "slow";
		const done = model.download();
		await new Promise((r) => setTimeout(r, 80));
		model.cancel();
		await assert.rejects(done, /cancel/i);
		assert.deepEqual(model.status(), { state: "missing" });
		assert.equal(existsSync(dir), false);
		assert.deepEqual(leftovers(), []);
	});

	it("shares one transfer between concurrent download calls", async () => {
		const { model } = fresh();
		await Promise.all([model.download(), model.download()]);
		assert.equal(hits, 1);
	});

	it("download on an installed model is a no-op", async () => {
		const { model } = fresh();
		await model.download();
		hits = 0;
		await model.download();
		assert.equal(hits, 0);
	});

	it("removes an installed model and tolerates removing nothing", async () => {
		const { model, dir } = fresh();
		await model.remove();
		await model.download();
		await model.remove();
		assert.deepEqual(model.status(), { state: "missing" });
		assert.equal(existsSync(dir), false);
	});

	it("cleans a partial directory left by a crashed earlier download", async () => {
		const { model, dir, leftovers } = fresh();
		mkdirSync(`${dir}.partial`, { recursive: true });
		writeFileSync(path.join(`${dir}.partial`, "stale"), "x");
		assert.equal(model.status().state, "missing");
		await model.download();
		assert.deepEqual(leftovers(), ["parakeet"]);
	});

	it("treats a directory missing a required file as not installed", () => {
		const { model, dir } = fresh();
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "tokens.txt"), "x");
		assert.equal(model.status().state, "missing");
		assert.equal(model.files(), null);
	});

	it("cancel during extraction aborts tar and ends missing with nothing left behind", async () => {
		const { model, dir, leftovers } = fresh();
		const bin = path.join(root, `bin-${n}`);
		const entered = path.join(root, `entered-${n}`);
		const release = path.join(root, `release-${n}`);
		mkdirSync(bin);
		// A tar that announces itself, then waits, then really extracts.
		writeFileSync(path.join(bin, "tar"), `#!/bin/sh\nprintf entered > '${entered}'\nwhile [ ! -f '${release}' ]; do sleep .01; done\nexec "${execFileSync("which", ["tar"]).toString().trim()}" "$@"\n`, { mode: 0o755 });
		const previous = process.env.PATH;
		process.env.PATH = `${bin}:${previous}`;
		const done = model.download();
		try {
			for (let i = 0; i < 300 && !existsSync(entered); i++) await new Promise((r) => setTimeout(r, 10));
			assert.ok(existsSync(entered), "tar started");
			model.cancel();
			writeFileSync(release, "");
			await assert.rejects(done, /cancel/i);
			assert.deepEqual(model.status(), { state: "missing" });
			assert.equal(existsSync(dir), false);
			assert.deepEqual(leftovers(), []);
		} finally {
			writeFileSync(release, "");
			await done.catch(() => {});
			process.env.PATH = previous;
		}
	});

	it("refuses an archive that unpacks a symbolic link and cleans up", async () => {
		const sha = createHash("sha256").update(linkedArchive).digest("hex");
		const { model, dir, leftovers } = fresh({ url: `${base}/linked.tar.bz2`, sha256: sha, sizeBytes: linkedArchive.length });
		await assert.rejects(model.download(), /symbolic link/i);
		assert.match((model.status() as { error?: string }).error ?? "", /symbolic link/i);
		assert.equal(model.status().state, "missing");
		assert.equal(existsSync(dir), false);
		assert.deepEqual(leftovers(), []);
	});

	it("refuses an archive whose unpacked tree exceeds the size ceiling and cleans up", async () => {
		const { model, dir, leftovers } = fresh({ maxUnpackedBytes: 20 });
		await assert.rejects(model.download(), /larger than expected/i);
		assert.equal(model.status().state, "missing");
		assert.equal(existsSync(dir), false);
		assert.deepEqual(leftovers(), []);
	});
});
