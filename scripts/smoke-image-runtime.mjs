/**
 * OFFLINE image runtime gate: exercise the shipped Photon/WASM resize core and
 * actual worker, with file modules confined to the standalone payload. No app,
 * provider, canvas, or network needed; a tiny synthetic PNG is generated here.
 *
 * node scripts/smoke-image-runtime.mjs [--standalone <dir>] [--runtime <Node/Electron>]
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { deflateSync } from "node:zlib";
import { formatProbeError, probeEnv } from "./smoke-demo-runtime.mjs";

export function verifyImageRuntime(standalone, runtime = process.execPath) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-image-runtime-"));
	try {
		fs.writeFileSync(path.join(home, "auth.json"), "{}\n", { mode: 0o600 });
		const result = spawnSync(runtime, [fileURLToPath(import.meta.url), "--probe", path.resolve(standalone)], {
			cwd: home,
			env: { ...probeEnv(process.env, home), ELECTRON_RUN_AS_NODE: "1" },
			encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024,
		});
		if (result.status !== 0 || result.error) {
			throw new Error(`image runtime probe failed (${result.error?.message ?? result.status}):\n${result.stdout ?? ""}${result.stderr ?? ""}`);
		}
		assert.match(result.stdout, /Photon in-process and worker resizing passed/, "probe exited without success marker");
		process.stdout.write(result.stdout);
	} finally { fs.rmSync(home, { recursive: true, force: true }); }
}

// Self-contained so the eval worker can install the SAME guards using only
// builtins, before importing any payload module. Module hooks do not otherwise
// propagate from the dedicated probe process into Worker threads.
function installGuards(require, standalone) {
	const assert = require("node:assert/strict");
	const fs = require("node:fs");
	const path = require("node:path");
	const { fileURLToPath } = require("node:url");
	const { registerHooks, syncBuiltinESMExports } = require("node:module");
	const root = fs.realpathSync(standalone);
	const inside = (file) => {
		const real = fs.realpathSync(file);
		const relative = path.relative(root, real);
		assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
			`dependency escaped standalone payload: ${file}`);
		return real;
	};
	const photonRoot = path.join(root, "node_modules/@silvia-odwyer/photon-node");
	const manifest = JSON.parse(fs.readFileSync(inside(path.join(photonRoot, "package.json")), "utf8"));
	assert.equal(manifest.version, "0.3.4", "unexpected Photon engine version");
	const photonEntry = inside(path.join(photonRoot, "photon_rs.js"));
	const photonWasm = inside(path.join(photonRoot, "photon_rs_bg.wasm"));
	assert.ok(fs.statSync(photonWasm).size > 0, "empty Photon WASM asset");
	let attempts = 0;
	const deny = () => { attempts++; throw new Error("OFFLINE image gate: network forbidden"); };
	globalThis.fetch = deny;
	globalThis.WebSocket = class { constructor() { deny(); } };
	for (const [name, methods] of [
		["http", ["request", "get"]], ["https", ["request", "get"]],
		["net", ["connect", "createConnection"]], ["tls", ["connect"]],
		["dgram", ["createSocket"]],
		["dns", ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"]],
		["dns/promises", ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"]],
	]) {
		const module = require(`node:${name}`);
		for (const method of methods) module[method] = deny;
	}
	require("node:net").Socket.prototype.connect = deny;
	const loaded = new Set();
	const wasmReads = new Set();
	const originalRead = fs.readFileSync;
	fs.readFileSync = function (file, ...args) {
		const filename = file instanceof URL ? fileURLToPath(file) : file;
		const wasmFile = typeof filename === "string" && filename.endsWith(".wasm") ? inside(filename) : null;
		const bytes = originalRead.call(this, file, ...args);
		if (wasmFile) wasmReads.add(wasmFile);
		return bytes;
	};
	syncBuiltinESMExports();
	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			const result = nextResolve(specifier, context);
			if (result.url.startsWith("file:")) loaded.add(inside(fileURLToPath(result.url)));
			else assert.ok(result.url.startsWith("node:"), `unexpected dependency URL: ${result.url}`);
			return result;
		},
	});
	return {
		report() {
			assert.equal(attempts, 0, "image runtime attempted network access");
			assert.ok(loaded.has(photonEntry), "Photon JS was not loaded from the payload");
			assert.ok(wasmReads.has(photonWasm), "Photon WASM was not loaded from the payload");
			return { modules: loaded.size, wasmFiles: [...wasmReads], networkAttempts: attempts };
		},
		cleanup() {
			hooks.deregister();
			fs.readFileSync = originalRead;
			syncBuiltinESMExports();
		},
	};
}

/** Pure Node 2×2 RGBA PNG, with valid PNG CRCs and zlib image data. */
function fixturePng() {
	const chunk = (type, data) => {
		const buffer = Buffer.alloc(data.length + 12);
		buffer.writeUInt32BE(data.length);
		buffer.write(type, 4, "ascii");
		data.copy(buffer, 8);
		let crc = ~0;
		for (const byte of buffer.subarray(4, -4)) {
			crc ^= byte;
			for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
		}
		buffer.writeUInt32BE(~crc >>> 0, buffer.length - 4);
		return buffer;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(2, 0);
	header.writeUInt32BE(2, 4);
	header[8] = 8; // bit depth
	header[9] = 6; // RGBA
	const pixels = Buffer.from([
		0, 255, 0, 0, 255, 0, 255, 0, 255,
		0, 0, 0, 255, 255, 255, 255, 255, 255,
	]);
	return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

function assertResized(result) {
	assert.ok(result, "resize returned null (missing/broken Photon must not silently pass)");
	assert.equal(result.originalWidth, 2);
	assert.equal(result.originalHeight, 2);
	assert.equal(result.width, 1);
	assert.equal(result.height, 1);
	assert.equal(result.wasResized, true);
	assert.equal(result.mimeType, "image/png");
	const png = Buffer.from(result.data, "base64");
	assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
	assert.equal(png.readUInt32BE(16), 1);
	assert.equal(png.readUInt32BE(20), 1);
}

async function probeWorker(root, inputBytes, options, responseType) {
	const readyType = "lh:image-runtime-ready";
	const worker = new Worker(`
		const { parentPort, workerData } = require("node:worker_threads");
		const guards = (${installGuards.toString()})(require, workerData.root);
		const post = parentPort.postMessage.bind(parentPort);
		parentPort.postMessage = (message, ...args) => {
			if (message?.type === workerData.responseType) {
				post({ ...message, runtimeProof: guards.report() }, ...args);
			} else post(message, ...args);
		};
		void import(workerData.entry).then(() => post({ type: workerData.readyType }));
	`, {
		eval: true,
		workerData: { root, responseType, readyType, entry: pathToFileURL(path.join(root, "src/agent/image-processing/resize-worker.mjs")).href },
	});
	try {
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("image resize worker timed out")), 10_000);
			const fail = (error) => { clearTimeout(timer); reject(error); };
			let ready = false;
			worker.once("error", fail);
			worker.once("exit", (code) => fail(new Error(`image resize worker exited before response: ${code}`)));
			worker.on("message", (message) => {
				try {
					if (message?.type === readyType) {
						assert.equal(ready, false, "duplicate worker READY");
						ready = true;
						worker.postMessage({ inputBytes, mimeType: "image/png", options });
					} else if (message?.type === responseType) {
						assert.equal(ready, true, "worker replied before its import completed");
						assert.equal(message.error, undefined, `worker resize failed: ${message.error}`);
						assertResized(message.result);
						assert.ok(message.runtimeProof?.modules > 0, "missing worker module-confinement proof");
						assert.equal(message.runtimeProof.networkAttempts, 0);
						assert.equal(message.runtimeProof.wasmFiles.length, 1);
						clearTimeout(timer);
						resolve(message.runtimeProof);
					}
				} catch (error) { fail(error); }
			});
		});
	} finally { await worker.terminate(); }
}

async function probe(standalone) {
	const root = fs.realpathSync(standalone);
	const guards = installGuards(createRequire(import.meta.url), root);
	try {
		const entry = pathToFileURL(path.join(root, "src/agent/image-processing/resize-core.mjs"));
		const { resizeImageInProcess, IMAGE_RESIZE_WORKER_RESPONSE_TYPE } = await import(entry.href);
		assert.equal(typeof resizeImageInProcess, "function");
		assert.equal(IMAGE_RESIZE_WORKER_RESPONSE_TYPE, "pi:image-resize-response");
		const input = fixturePng();
		const options = { maxWidth: 1, maxHeight: 1, maxBytes: 1024 * 1024 };
		assertResized(await resizeImageInProcess(input, "image/png", options));
		const inProcess = guards.report();
		console.log(`[smoke-image-runtime] shipped resize core: PNG 2×2 → 1×1; ${inProcess.modules} modules and Photon WASM confined to ${root}`);
		const worker = await probeWorker(root, input, options, IMAGE_RESIZE_WORKER_RESPONSE_TYPE);
		guards.report();
		console.log(`[smoke-image-runtime] shipped resize worker: READY then tagged PNG 2×2 → 1×1; ${worker.modules} modules and Photon WASM confined to ${root}`);
		console.log("[smoke-image-runtime] Photon in-process and worker resizing passed; zero network attempts");
	} finally { guards.cleanup(); }
}

async function main() {
	const args = process.argv.slice(2);
	if (args[0] === "--probe") return probe(args[1]);
	const value = (name, fallback) => {
		const index = args.indexOf(name);
		if (index < 0) return fallback;
		assert.ok(args[index + 1] && !args[index + 1].startsWith("--"), `${name} requires a path`);
		return path.resolve(args[index + 1]);
	};
	verifyImageRuntime(value("--standalone", path.resolve(import.meta.dirname, "../.next/standalone")), value("--runtime", process.execPath));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(`[smoke-image-runtime] FAIL: ${formatProbeError(error)}`); process.exitCode = 1; });
}
