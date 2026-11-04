/**
 * Offline native-provider seam gate through REAL production Next routes.
 * Prerequisites: next build (LH_NATIVE_PROVIDER_CONFIG UNSET), then
 * node scripts/build-server.mjs. No dev server or GUI is needed.
 * Runs host Node and, when installed locally, Electron's embedded Node.
 * Private fixtures live outside the checkout; no provider HTTP or real auth.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const STANDALONE = path.join(ROOT, ".next", "standalone");
const SERVER = path.join(STANDALONE, "server.js");
const SELF = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);

// Loaded with --import in the dedicated server child, BEFORE any Next/Pi code.
// Inbound loopback requests still work; ALL outbound connects are forbidden,
// including undici/SDK sockets. Log attempts so even swallowed errors fail.
function closeNetwork() {
	const deny = (kind) => {
		fs.appendFileSync(process.env.LH_NATIVE_SMOKE_NETWORK_LOG, `${kind}\n`);
		throw new Error(`OFFLINE native-provider smoke: outbound network forbidden (${kind})`);
	};
	globalThis.fetch = () => deny("fetch");
	globalThis.WebSocket = class { constructor() { deny("WebSocket"); } };
	for (const [name, methods] of [
		["http", ["request", "get"]], ["https", ["request", "get"]],
		["http2", ["connect"]], ["net", ["connect", "createConnection"]],
		["tls", ["connect"]], ["dgram", ["createSocket"]],
		["dns", ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"]],
		["dns/promises", ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"]],
	]) {
		const module = require(`node:${name}`);
		for (const method of methods) {
			const original = module[method];
			module[method] = (...args) => {
				// net.Server.listen resolves its numeric bind via dns.lookup too.
				// Numeric loopback lookup cannot dispatch DNS or outbound sockets.
				if (method === "lookup" && (name === "dns" || name === "dns/promises")
					&& (args[0] === "127.0.0.1" || args[0] === "::1")) return original(...args);
				return deny(`${name}.${method}`);
			};
		}
	}
	require("node:net").Socket.prototype.connect = () => deny("Socket.connect");
	syncBuiltinESMExports();
}

function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close((error) => error ? reject(error) : resolve(port));
		});
	});
}

function fixtureSource(sdk, sentinel) {
	// Absolute ESM import resolves the compatible SDK from the private module's
	// location, explicitly pointing to this payload. The app must native-require
	// this .mjs; importing it directly in the smoke would miss bundler regressions.
	return `import { createProvider } from ${JSON.stringify(pathToFileURL(sdk).href)};
import { appendFileSync } from "node:fs";
const sentinel = ${JSON.stringify(sentinel)};
export function createLearnHarnessProvider(options) {
  const record = (event) => appendFileSync(options.receipt, JSON.stringify({ event, id: options.id, sentinel }) + "\\n");
  record("factory");
  if (options.fail) throw new Error("synthetic factory failure");
  const unreachable = () => { record("stream"); throw new Error("Synthetic catalog-only provider: no HTTP operations"); };
  const provider = createProvider({
    id: options.id, name: "Offline synthetic native provider",
    auth: { apiKey: { name: "Synthetic local readiness", async resolve() {
      record("auth"); throw new Error("Catalog/settings must not resolve request auth");
    } } },
    models: [{ id: "offline-model", name: "Offline synthetic model", provider: options.id,
      api: "openai-completions", baseUrl: "", reasoning: false, input: ["text", "image"],
      contextWindow: 32768, maxTokens: 2048,
      cost: { input: 2, output: 3, cacheRead: 1, cacheWrite: 4 } }],
    api: { stream: unreachable, streamSimple: unreachable }
  });
  return { provider, isReady: () => options.ready === true,
    ...(options.pricing ? { pricing: options.pricing } : {}) };
}
`;
}

// Scan actual bytes (also binary files) with bounded memory. A unique TEMP
// sentinel/path must not occur; the script's built source/template is allowed.
async function auditPayload(forbidden) {
	const needles = forbidden.map((value) => Buffer.from(value));
	const overlap = Math.max(...needles.map((needle) => needle.length)) - 1;
	let files = 0;
	async function walk(directory) {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const file = path.join(directory, entry.name);
			assert.ok(!forbidden.some((value) => file.includes(value)), "private fixture path leaked into payload");
			if (entry.isDirectory()) await walk(file);
			else if (entry.isFile()) {
				files++;
				let previous = Buffer.alloc(0);
				for await (const chunk of fs.createReadStream(file, { highWaterMark: 256 * 1024 })) {
					const bytes = Buffer.concat([previous, chunk]);
					assert.ok(!needles.some((needle) => bytes.includes(needle)), `private fixture leaked into ${path.relative(STANDALONE, file)}`);
					previous = bytes.subarray(Math.max(0, bytes.length - overlap));
				}
			} else if (entry.isSymbolicLink()) {
				assert.ok(!forbidden.some((value) => fs.readlinkSync(file).includes(value)), "private module symlink leaked into payload");
			}
		}
	}
	await walk(STANDALONE);
	console.log(`[smoke-native-providers] payload audit: ${files} files; no private manifest/module path or unique sentinel`);
}

function verifyListener(child, port) {
	if (process.platform !== "darwin" && process.platform !== "linux") {
		console.log("[smoke-native-providers] listener inspection skipped: lsof check supports macOS/Linux only (HOSTNAME=127.0.0.1)");
		return;
	}
	const result = spawnSync("lsof", ["-nP", "-a", "-p", String(child.pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { encoding: "utf8" });
	if (result.error?.code === "ENOENT") {
		console.log("[smoke-native-providers] listener inspection skipped: lsof unavailable (HOSTNAME=127.0.0.1)");
		return;
	}
	assert.equal(result.status, 0, `lsof failed: ${result.stderr}`);
	const listeners = result.stdout.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
	assert.ok(listeners.includes(`127.0.0.1:${port}`), `expected private listener, got ${listeners.join(", ")}`);
	assert.ok(listeners.every((listener) => listener.startsWith("127.0.0.1:") || listener.startsWith("[::1]:")), "non-loopback listener found");
	console.log(`[smoke-native-providers] verified listener: 127.0.0.1:${port}`);
}

async function runRuntime(runtime, electron) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-native-providers-"));
	let child;
	let childClosed;
	let interrupted = false;
	let logs = "";
	const onSignal = () => { interrupted = true; child?.kill("SIGTERM"); };
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	try {
		const sentinel = `lh-private-native-${randomUUID()}`;
		const moduleFile = path.join(home, "synthetic-provider.mjs");
		const manifestFile = path.join(home, "manifest.json");
		const receipt = path.join(home, "receipt.jsonl");
		const networkLog = path.join(home, "network.log");
		const authFile = path.join(home, "auth.json");
		const dataDir = path.join(home, "data");
		const ids = ["native-smoke-unknown", "native-smoke-catalog", "native-smoke-not-ready", "native-smoke-failed"];
		fs.mkdirSync(dataDir, { mode: 0o700 });
		fs.writeFileSync(authFile, "{}\n", { mode: 0o600 });
		fs.writeFileSync(receipt, "", { mode: 0o600 });
		fs.writeFileSync(networkLog, "", { mode: 0o600 });
		fs.writeFileSync(moduleFile, fixtureSource(path.join(STANDALONE, "node_modules/@earendil-works/pi-ai/dist/index.js"), sentinel), { mode: 0o600 });
		fs.writeFileSync(manifestFile, JSON.stringify({ version: 1, providers: ids.map((id, index) => ({
			id, module: moduleFile, export: "createLearnHarnessProvider",
			options: { id, receipt, ready: index < 2, ...(index === 1 ? { pricing: "catalog" } : {}), ...(index === 3 ? { fail: true } : {}) },
		})) }), { mode: 0o600 });
		// Existing unavailable pins survive catalog/read/settings operations.
		const savedCheap = { model: { provider: ids[3], id: "saved-unavailable-model" }, thinkingLevel: "high" };
		fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ version: 1, models: { cheap: savedCheap } }), { mode: 0o600 });

		const port = await freePort();
		const origin = `http://127.0.0.1:${port}`;
		const capability = randomBytes(32).toString("hex");
		// Minimal allowlisted environment: no ambient credentials/config/profile,
		// custom NODE_OPTIONS, proxy agents, provider flags or CLI opt-ins.
		const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP", "LANG"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
		Object.assign(env, {
			HOME: home, USERPROFILE: home, APPDATA: path.join(home, "config"), LOCALAPPDATA: path.join(home, "local"),
			XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"),
			NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", LH_IGNORE_ENV_KEYS: "1",
			HOSTNAME: "127.0.0.1", PORT: String(port), LH_DATA_DIR: dataDir, LH_AUTH_FILE: authFile,
			LH_NATIVE_PROVIDER_CONFIG: manifestFile, LH_NATIVE_SMOKE_CHILD: "1", LH_NATIVE_SMOKE_NETWORK_LOG: networkLog,
			LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: capability,
			...(electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
		});
		console.log(`[smoke-native-providers] runtime: ${electron ? "Electron embedded Node" : "host Node"}`);
		child = spawn(runtime, ["--import", SELF, SERVER], { cwd: STANDALONE, env, stdio: ["ignore", "pipe", "pipe"] });
		let exited = false;
		let spawnError;
		childClosed = new Promise((resolve) => {
			child.once("error", (error) => { spawnError = error; exited = true; resolve(); });
			child.once("close", () => { exited = true; resolve(); });
		});
		const keep = (buffer) => { logs = (logs + buffer.toString()).slice(-16000); };
		child.stdout.on("data", keep); child.stderr.on("data", keep);
		async function request(route, body, expected = 200, authorized = true) {
			const response = await fetch(origin + route, {
				...(body !== undefined ? { method: "PUT", body: JSON.stringify(body) } : {}),
				headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json", ...(authorized ? { "x-learnharness-desktop": capability } : {}) },
				signal: AbortSignal.timeout(10000), redirect: "error",
			});
			assert.equal(response.status, expected, `${route}: expected ${expected}, received ${response.status}`);
			return response.json();
		}
		let ready = false;
		const deadline = Date.now() + 30000;
		while (Date.now() < deadline && !interrupted) {
			if (exited) throw spawnError ?? new Error("standalone exited before readiness");
			try {
				const response = await fetch(origin, { signal: AbortSignal.timeout(2000), redirect: "error" });
				await response.arrayBuffer();
				if (response.status === 200) { ready = true; break; }
			} catch { /* startup connection refusal */ }
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		assert.ok(ready && !interrupted, "standalone readiness timed out/interrupted");
		verifyListener(child, port);
		await request("/api/models", undefined, 403, false);
		const catalog = await request("/api/models");
		for (const [index, id] of ids.entries()) {
			assert.deepEqual(catalog.providers.find((row) => row.id === id), { id, envVar: "", keyPresent: index < 2 }, `readiness row: ${id}`);
			const model = catalog.models.find((row) => row.provider === id && row.id === "offline-model");
			if (index >= 2) { assert.equal(model, undefined, `${id}: unavailable model entered picker`); continue; }
			assert.ok(model, `${id}: module was not loaded by production /api/models`);
			assert.deepEqual(model.input, ["text", "image"]);
			assert.equal(model.contextWindow, 32768); assert.equal(model.maxTokens, 2048);
			assert.deepEqual(model.cost, index === 1 ? { input: 2, output: 3, cacheRead: 1, cacheWrite: 4 } : null);
		}
		assert.deepEqual(catalog.slots.cheap, savedCheap, "unavailable saved pin was changed by catalog read");
		const chosen = { model: { provider: ids[0], id: "offline-model" } };
		const slots = { strong: chosen, cheap: savedCheap, vision: chosen };
		await request("/api/settings/models", slots);
		const pins = await request("/api/models");
		assert.deepEqual(pins.slots, slots, "slot writes did not preserve unavailable pins");
		assert.deepEqual(pins.defaults.model, chosen.model);
		const allSlots = { strong: chosen, cheap: chosen, vision: chosen };
		await request("/api/settings/models", allSlots);
		const roles = Object.fromEntries(["researcher", "demoBuilder", "visualMaker", "extractor", "auditor"].map((role) => [role, chosen]));
		await request("/api/settings/agent", { models: roles });
		const selected = await request("/api/models");
		assert.deepEqual(selected.slots, allSlots, "native models cannot be selected for all slots");
		for (const role of Object.keys(roles)) assert.deepEqual(selected.rolePins[role].model, chosen.model);
		assert.deepEqual((await request("/api/settings")).settings.models, allSlots);
		const events = fs.readFileSync(receipt, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
		assert.deepEqual(events.map(({ id, event, sentinel: value }) => ({ id, event, sentinel: value })), ids.map((id) => ({ id, event: "factory", sentinel })), "native factory must run once per entry; catalog/settings must not resolve auth or stream");
		assert.equal(fs.readFileSync(networkLog, "utf8"), "", "server attempted outbound network");
		assert.equal(fs.readFileSync(authFile, "utf8"), "{}\n", "smoke unexpectedly wrote auth credentials");
		await auditPayload([home, moduleFile, manifestFile, sentinel]);
		assert.ok(!interrupted, "smoke interrupted");
		assert.equal(fs.readFileSync(networkLog, "utf8"), "", "server attempted outbound network during payload audit");
		console.log("[smoke-native-providers] production routes: native ESM/SDK loading, readiness/failed rows, pricing, all slots/role pins, preserved saved pin, lazy auth and anonymous denial passed");
	} catch (error) {
		console.error(logs);
		throw error;
	} finally {
		if (child && child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
			try { await childClosed; } finally { clearTimeout(timer); }
		}
		process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
		fs.rmSync(home, { recursive: true, force: true });
	}
}

async function main() {
	for (const required of [SERVER, path.join(STANDALONE, ".next/static"), path.join(STANDALONE, "node_modules/@earendil-works/pi-ai/dist/index.js")]) {
		assert.ok(fs.existsSync(required), "standalone payload missing/incomplete: run next build with LH_NATIVE_PROVIDER_CONFIG UNSET, then node scripts/build-server.mjs");
	}
	await runRuntime(process.execPath, false);
	let electron;
	try { electron = require("electron"); }
	catch (error) {
		if (error.code !== "MODULE_NOT_FOUND" && !/Electron failed to install correctly/.test(error.message)) throw error;
	}
	if (typeof electron === "string" && fs.existsSync(electron)) await runRuntime(electron, true);
	else console.log("[smoke-native-providers] SKIP Electron embedded Node: local Electron binary is not installed");
	console.log("[smoke-native-providers] PASS (fixtures and server children removed)");
}

if (process.env.LH_NATIVE_SMOKE_CHILD === "1") closeNetwork();
else main().catch((error) => {
	console.error(`[smoke-native-providers] FAIL: ${error.message}`);
	process.exitCode = 1;
});
