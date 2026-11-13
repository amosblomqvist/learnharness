/** Fake-input regression for Next's real compression/backpressure path.
 * Runs in a disposable child so zlib instrumentation cannot affect the app.
 * node scripts/smoke-compression-runtime.mjs [--standalone <dir>] [--runtime <Node/Electron>]
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

export function verifyCompressionRuntime(root, runtime = process.execPath) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-compression-runtime-"));
	try {
		for (const dir of ["data", "tmp"]) fs.mkdirSync(path.join(home, dir));
		fs.writeFileSync(path.join(home, "auth.json"), "{}\n", { mode: 0o600 });
		// Allowlist rather than inherit credentials, Node preloads, or app settings.
		const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"].flatMap(key =>
			process.env[key] === undefined ? [] : [[key, process.env[key]]]));
		const result = spawnSync(runtime, [fileURLToPath(import.meta.url), "--probe", path.resolve(root)], {
			cwd: home,
			env: { ...env, HOME: home, USERPROFILE: home, TMPDIR: path.join(home, "tmp"), TEMP: path.join(home, "tmp"), TMP: path.join(home, "tmp"),
				LH_DATA_DIR: path.join(home, "data"), LH_AUTH_FILE: path.join(home, "auth.json"), NODE_ENV: "production", ELECTRON_RUN_AS_NODE: "1", NEXT_TELEMETRY_DISABLED: "1" },
			encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024,
		});
		assert.equal(result.error, undefined, `compression probe failed: ${result.error?.message}`);
		assert.equal(result.status, 0, `compression probe failed:\n${result.stdout}${result.stderr}`);
		const report = JSON.parse(result.stdout);
		assert.equal(report.passed, true);
		console.log(`[compression-runtime] passed (${report.node}): gzip Node/Web, identity, no-transform, disconnect`);
		return report;
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
}

async function probe(root) {
	const require = createRequire(path.join(root, "package.json"));
	const inside = (specifier) => {
		const resolved = fs.realpathSync(require.resolve(specifier));
		const relative = path.relative(fs.realpathSync(root), resolved);
		assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `dependency escaped payload: ${resolved}`);
		return require(resolved);
	};
	const zlib = require("node:zlib");
	const descriptor = Object.getOwnPropertyDescriptor(zlib, "createGzip");
	const records = [];
	const warnings = [];
	const onWarning = warning => {
		if (warning.name === "MaxListenersExceededWarning" && warning.type === "drain" && warning.emitter?.constructor.name === "Gzip") warnings.push(warning.message);
	};
	process.on("warning", onWarning);
	let active;
	Object.defineProperty(zlib, "createGzip", { ...descriptor, value: (...args) => {
		const stream = descriptor.value(...args);
		const record = active;
		record.gzip = stream;
		record.registrations = 0;
		record.drains = 0;
		record.maxListeners = stream.getMaxListeners();
		stream.on("newListener", event => { if (event === "drain") record.registrations++; });
		const emit = stream.emit;
		stream.emit = function(event, ...args) {
			if (event === "drain") record.drains++;
			return emit.call(this, event, ...args);
		};
		return stream;
	} });
	const compression = inside("next/dist/compiled/compression");
	const { pipeNodeReadableToNodeResponse, pipeToNodeResponse } = inside("next/dist/server/pipe-readable");
	const { releaseCompressionStream } = inside("next/dist/server/lib/release-compression-stream");
	const middleware = compression();
	const chunk = randomBytes(128 * 1024);
	const pieces = 24;
	const server = http.createServer((req, res) => {
		const record = { mode: req.url, backpressure: 0, lateResumes: 0 };
		active = record;
		records.push(record);
		middleware(req, res, () => {});
		// Match router-server's abort teardown; do not compensate for drain ownership.
		record.closed = new Promise(resolve => res.once("close", () => {
			if (!res.writableFinished) releaseCompressionStream(res);
			record.finished = res.writableFinished;
			resolve();
		}));
		res.setHeader("Content-Type", "text/plain");
		if (req.url === "/no-transform") res.setHeader("Cache-Control", "no-cache, no-transform");
		const write = res.write;
		res.write = function(...args) {
			const ok = write.apply(this, args);
			if (!ok) record.backpressure++;
			return ok;
		};
		const source = Readable.from(Array.from({ length: pieces }, () => chunk));
		record.source = source;
		const resume = source.resume;
		source.resume = function() {
			if (this.destroyed) record.lateResumes++;
			return resume.call(this);
		};
		record.pipe = req.url === "/web" ? pipeToNodeResponse(Readable.toWeb(source), res) : pipeNodeReadableToNodeResponse(source, res);
		// Observe failures immediately, including client abort, without unhandled rejections.
		record.pipe.catch(error => { record.error = error; res.destroy(); });
	});
	async function request(mode) {
		await new Promise((resolve, reject) => {
			const req = http.get({ host: "127.0.0.1", port: server.address().port, path: mode, agent: false,
				headers: { "Accept-Encoding": mode === "/identity" ? "identity" : "gzip" } }, res => {
				const chunks = [];
				res.on("data", data => {
					if (mode === "/abort") { res.destroy(); resolve(); return; }
					chunks.push(data);
					// A slow reader exercises both zlib and socket backpressure.
					res.pause();
					setTimeout(() => res.resume(), 1);
				});
				res.on("error", reject);
				res.on("end", () => {
					try {
						const record = records.at(-1);
						record.encoding = res.headers["content-encoding"] || "identity";
						const body = Buffer.concat(chunks);
						const output = record.encoding === "gzip" ? zlib.gunzipSync(body) : body;
						assert.equal(output.length, pieces * chunk.length);
						for (let i = 0; i < pieces; i++) assert.deepEqual(output.subarray(i * chunk.length, (i + 1) * chunk.length), chunk);
						record.payloadVerified = true;
						resolve();
					} catch (error) { reject(error); }
				});
			});
			req.setTimeout(5_000, () => req.destroy(new Error(`compression request stalled: ${mode}`)));
			req.on("error", reject);
		});
		const record = records.at(-1);
		await record.closed;
		await record.pipe;
		assert.equal(record.error, undefined);
		assert.ok(record.backpressure > 0, `${mode} did not exercise backpressure`);
		if (mode === "/abort") {
			assert.equal(record.finished, false);
			if (!record.gzip.closed) await once(record.gzip, "close");
			assert.equal(record.gzip.destroyed, true);
			assert.equal(record.source.destroyed, true);
		} else {
			assert.equal(record.finished, true);
			assert.equal(record.payloadVerified, true);
		}
		if (mode === "/node" || mode === "/web") {
			assert.equal(record.encoding, "gzip");
			assert.ok(record.backpressure > 10, "must exceed the original warning threshold");
			assert.ok(record.drains > 10, "must repeat real drain cycles");
			assert.equal(record.registrations, 1, "drain registrations must not scale with writes");
			assert.equal(record.gzip.listenerCount("drain"), 1, "upstream retains one response-lifetime listener");
		}
		if (mode === "/identity" || mode === "/no-transform") {
			assert.equal(record.gzip, undefined);
			assert.equal(record.encoding, "identity");
		} else {
			assert.equal(record.maxListeners, 10, "do not raise or silence the listener limit");
			if (mode !== "/web") {
				// The gzip listener survives off() but must ignore post-teardown drain.
				record.gzip.emit("drain");
				assert.equal(record.lateResumes, 0);
			}
		}
	}
	try {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		for (const mode of ["/node", "/web", "/identity", "/no-transform", "/abort"]) await request(mode);
		await new Promise(resolve => setImmediate(resolve)); // Node delivers warnings asynchronously.
		assert.deepEqual(warnings, []);
		return { passed: true, node: process.version, cases: records.map(({ mode, backpressure, registrations, payloadVerified, finished }) => ({ mode, backpressure, registrations, payloadVerified, finished })) };
	} finally {
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
		process.off("warning", onWarning);
		Object.defineProperty(zlib, "createGzip", descriptor);
	}
}

const args = process.argv.slice(2);
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (args[0] === "--probe") {
		probe(path.resolve(args[1])).then(report => console.log(JSON.stringify(report))).catch(error => { console.error(error); process.exitCode = 1; });
	} else {
		verifyCompressionRuntime(value("--standalone", path.resolve(import.meta.dirname, "../.next/standalone")), value("--runtime", process.execPath));
	}
}
