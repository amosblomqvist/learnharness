/**
 * smoke-server.mjs — boot the packaged standalone server and prove it serves.
 *
 * The payload gate that pays for itself (2026-10-08): `next build` success
 * and a completed electron-builder run say NOTHING about whether the
 * packaged server actually starts. On its first day this smoke caught two
 * real defects nothing else saw: (1) a trace-exclude regression that
 * stripped the pi engine packages to bare package.jsons — the server
 * answered 500 on every route with ERR_MODULE_NOT_FOUND; (2) before that,
 * the dev auth.json (BYOK keys) shipping inside the bundle. It runs
 * between build-server.mjs and electron-builder so a broken payload fails
 * in seconds, not after a full packaging pass.
 *
 * What it does: spawns .next/standalone/server.js exactly the way the
 * Electron shell does (electron/main.cjs) — with --electron it uses
 * Electron's bundled Node via ELECTRON_RUN_AS_NODE, otherwise host Node —
 * 127.0.0.1 on a kernel-assigned
 * free port, NODE_ENV=production, a THROWAWAY LH_DATA_DIR and an EMPTY
 * LH_AUTH_FILE under os.tmpdir() (no real keys or data ever touch it) —
 * polls GET / until 200, then probes the GET-only API surface (graph /
 * models / settings — no side effects). Any non-200, an early server
 * exit, or a 30s boot timeout fails the gate and prints the server's own
 * log tail for diagnosis. The child is ALWAYS killed before exit — a
 * leaked server holds its port against the next run (learned the hard
 * way, same day).
 */
import { spawn } from "node:child_process";
import { probeEnv, verifyDemoRuntime } from "./smoke-demo-runtime.mjs";
import { verifyProviderRuntime } from "./smoke-provider-runtime.mjs";
import { createPluginSmokeFixture, verifyPluginServer } from "./smoke-plugin-runtime.mjs";
import { verifyCompressionRuntime } from "./smoke-compression-runtime.mjs";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE_STANDALONE = path.join(ROOT, ".next", "standalone");
const ISOLATED_MODE = process.argv.includes("--isolated");
const BROWSER_MODE = process.argv.includes("--browser");
let isolatedRoot;
const ELECTRON_MODE = process.argv.includes("--electron");
const RUNTIME = ELECTRON_MODE ? createRequire(import.meta.url)("electron") : process.execPath;

const POLL_MS = 500;
const BOOT_TIMEOUT_MS = 30_000;
/** GET-only probes — the routes that exercised today's failure class. */
const PROBES = ["/api/graph", "/api/models", "/api/settings", "/api/plugins"];

if (!fs.existsSync(path.join(SOURCE_STANDALONE, "server.js"))) {
	console.error("[smoke-server] .next/standalone/server.js missing — run next build first.");
	process.exit(1);
}

/** A free TCP port (listen(0) → the kernel assigns one) — mirrors main.cjs. */
function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

/** One GET; resolves the status code (0 = connection refused/failed). */
function get(url) {
	return new Promise((resolve) => {
		const req = http.get(url, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", () => resolve(0));
		req.setTimeout(5000, () => {
			req.destroy();
			resolve(0);
		});
	});
}

async function main() {
	// Optional source-free proof: run a copy outside the checkout, so missing
	// dependencies cannot resolve upward into development node_modules.
	if (ISOLATED_MODE) {
		isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lh-isolated-server-"));
		// Preserve Next's relative external-package links. cpSync otherwise
		// rewrites them to absolute links back into the original checkout.
		fs.cpSync(SOURCE_STANDALONE, path.join(isolatedRoot, "standalone"), { recursive: true, verbatimSymlinks: true });
	}
	const standalone = isolatedRoot ? path.join(isolatedRoot, "standalone") : SOURCE_STANDALONE;
	const server = path.join(standalone, "server.js");
	// HTTP boot alone never imports the dynamically loaded demo engine.
	// Fail before packaging if its standalone dependency graph is incomplete.
	verifyDemoRuntime(standalone, RUNTIME);
	// /api/models only reads catalogs; initialize the real lazy SDK offline too.
	verifyProviderRuntime(standalone, RUNTIME);
	// A plain GET without Accept-Encoding never exercises gzip backpressure.
	verifyCompressionRuntime(standalone, RUNTIME);
	const port = await freePort();
	const url = `http://127.0.0.1:${port}`;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-smoke-"));
	const dataDir = path.join(home, "data");
	const authFile = path.join(home, "auth.json");
	fs.writeFileSync(authFile, "{}\n", "utf-8");
	createPluginSmokeFixture(home);
	const imports = [];
	if (ISOLATED_MODE) {
		// Reject absolute import escapes as well as incidental upward resolution.
		const guard = path.join(home, "payload-import-guard.mjs");
		fs.writeFileSync(guard, `import {registerHooks} from 'node:module'; import {realpathSync} from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
const roots = ${JSON.stringify([standalone, path.join(home, "data", "plugins")])}.map(p=>realpathSync(p));
registerHooks({resolve(specifier,context,next){ const result=next(specifier,context); if(result.url.startsWith('file:')) { const file=realpathSync(fileURLToPath(result.url)); if(!roots.some(root=>file===root || file.startsWith(root+path.sep))) throw new Error('Import escaped standalone/plugin payload: '+file); } return result; }});`);
		imports.push("--import", guard);
	}

	const tail = []; // rolling log tail for failure diagnosis
	let tailBytes = 0;
	const keep = (buf) => {
		for (const line of buf.toString().split("\n")) {
			tail.push(line);
			tailBytes += line.length + 1;
		}
		while (tailBytes > 16_000 && tail.length > 2) {
			tailBytes -= tail[0].length + 1;
			tail.shift();
		}
	};
	const dumpTail = () => {
		console.error("--- server log tail " + "-".repeat(20));
		for (const line of tail.slice(-40)) if (line.trim()) console.error(`    ${line}`);
	};

	console.log(`[smoke-server] runtime: ${ELECTRON_MODE ? "Electron bundled Node" : "host Node"}`);
	const child = spawn(RUNTIME, [...imports, server], {
		cwd: standalone,
		env: {
			...probeEnv(process.env, home),
			...(ELECTRON_MODE ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
			NODE_ENV: "production",
			PORT: String(port),
			HOSTNAME: "127.0.0.1",
			LH_DATA_DIR: dataDir,
			LH_AUTH_FILE: authFile,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let exited = false;
	child.stdout.on("data", keep);
	child.stderr.on("data", keep);
	child.on("exit", () => {
		exited = true;
	});

	const kill = () =>
		new Promise((resolve) => {
			if (exited) return resolve();
			const done = () => resolve();
			child.once("exit", done);
			child.kill("SIGTERM");
			setTimeout(() => {
				if (!exited) {
					try {
						child.kill("SIGKILL");
					} catch {
						/* already gone */
					}
				}
				done();
			}, 3000);
		});

	let failed = null;
	try {
		// 1) Boot: poll GET / until 200 (or timeout / early exit).
		let boot = 0;
		const deadline = Date.now() + BOOT_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (exited) throw new Error(`server exited before answering on ${url}`);
			boot = await get(url);
			if (boot === 200) break;
			await new Promise((r) => setTimeout(r, POLL_MS));
		}
		if (boot !== 200) throw new Error(`server never answered 200 on ${url} (last status: ${boot})`);
		console.log(`[smoke-server] boot ok: GET / → 200 (${url})`);

		// 2) API surface: every probe must be 200.
		for (const route of PROBES) {
			const status = await get(url + route);
			if (status !== 200) throw new Error(`GET ${route} → ${status} (expected 200)`);
			console.log(`[smoke-server] GET ${route} → 200`);
		}
		await verifyPluginServer(url, home);
		if (BROWSER_MODE) {
			const { verifyPluginBrowser } = await import("./smoke-plugin-browser.mjs");
			const evidenceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-plugin-browser-evidence-"));
			console.log("[smoke-server] browser evidence:", evidenceDirectory);
			await verifyPluginBrowser(url, { scratchDirectory: evidenceDirectory });
		}
	} catch (err) {
		failed = err;
	} finally {
		await kill();
		try {
			fs.rmSync(home, { recursive: true, force: true });
		} catch {
			/* best effort — it's under os.tmpdir() */
		}
	}

	if (failed) {
		console.error(`[smoke-server] FAIL: ${failed.message}`);
		dumpTail();
		throw failed;
	}
	console.log(`[smoke-server] smoke passed — the packaged server boots and serves${ISOLATED_MODE ? " outside the source checkout" : ""}${BROWSER_MODE ? ", including live plugin UI" : ""}.`);
}

main().catch((err) => {
	console.error(`[smoke-server] FAIL: ${err.message}`);
	process.exitCode = 1;
}).finally(() => {
	if (isolatedRoot) fs.rmSync(isolatedRoot, { recursive: true, force: true });
});
