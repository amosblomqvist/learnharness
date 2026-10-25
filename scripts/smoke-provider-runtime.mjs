/**
 * OFFLINE native Pi Google initialization gate (no generation or provider calls).
 * Unlike /api/models, this traverses Pi's lazy adapter and constructs GoogleGenAI.
 * The real onPayload hook throws a unique sentinel BEFORE generateContentStream.
 * All file modules must resolve inside the payload, including nested dependencies.
 *
 * node scripts/smoke-provider-runtime.mjs [--standalone <dir>] [--runtime <Node/Electron>]
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatProbeError, probeEnv } from "./smoke-demo-runtime.mjs";

export function verifyProviderRuntime(standalone, runtime = process.execPath) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-provider-runtime-"));
	try {
		fs.writeFileSync(path.join(home, "auth.json"), "{}\n", { mode: 0o600 });
		const result = spawnSync(runtime, [fileURLToPath(import.meta.url), "--probe", path.resolve(standalone)], {
			cwd: home,
			env: { ...probeEnv(process.env, home), ELECTRON_RUN_AS_NODE: "1" },
			encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024,
		});
		if (result.status !== 0 || result.error) {
			throw new Error(`provider runtime probe failed (${result.error?.message ?? result.status}):\n${result.stdout ?? ""}${result.stderr ?? ""}`);
		}
		assert.match(result.stdout, /native Pi Google initialization passed/, "probe exited without success marker");
		process.stdout.write(result.stdout);
	} finally { fs.rmSync(home, { recursive: true, force: true }); }
}

// Dedicated child only: nothing delegates to a live transport, even if the SDK
// changes its fetch path. Count attempts as well: a swallowed guard error fails.
function closeNetwork() {
	let attempts = 0;
	const deny = () => { attempts++; throw new Error("OFFLINE provider gate: network forbidden"); };
	globalThis.fetch = deny;
	globalThis.WebSocket = class { constructor() { deny(); } };
	const require = createRequire(import.meta.url);
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
	syncBuiltinESMExports();
	return () => assert.equal(attempts, 0, "SDK attempted network access");
}

async function probe(standalone) {
	const noNetwork = closeNetwork();
	const root = fs.realpathSync(standalone);
	const inside = (file) => {
		const relative = path.relative(root, fs.realpathSync(file));
		assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
			`dependency escaped standalone payload: ${file}`);
	};
	const loaded = new Set();
	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			const result = nextResolve(specifier, context);
			if (result.url.startsWith("file:")) {
				inside(fileURLToPath(result.url));
				loaded.add(fileURLToPath(result.url));
			} else assert.ok(result.url.startsWith("node:"), `unexpected dependency URL: ${result.url}`);
			return result;
		},
	});
	try {
		// Pi is an explicit server external. Import its shipped public entry and
		// factories, never the checkout's module or a direct/fake Google adapter.
		const entry = pathToFileURL(path.join(root, "node_modules/@earendil-works/pi-ai/dist/index.js"));
		const { createModels } = await import(entry.href);
		const models = createModels();
		for (const [name, factory] of [["google", "googleProvider"], ["opencode", "opencodeProvider"], ["opencode-go", "opencodeGoProvider"]]) {
			const provider = (await import(new URL(`providers/${name}.js`, entry).href))[factory]();
			models.setProvider(provider);
			const model = provider.getModels().find((candidate) => candidate.api === "google-generative-ai");
			assert.ok(model, `${name}: missing Google-backed catalog model`);
			const sentinel = `LH_OFFLINE_ON_PAYLOAD_${randomUUID()}`;
			let reached = 0;
			const result = await models.streamSimple(model, { messages: [{ role: "user", content: "Offline initialization only", timestamp: 0 }] }, {
				apiKey: "dummy-offline-provider-gate-not-a-key",
				onPayload(payload, selected) {
					assert.equal(selected.api, "google-generative-ai");
					assert.ok(payload && typeof payload === "object");
					reached++;
					throw new Error(sentinel);
				},
			}).result();
			assert.equal(reached, 1, `${name}: did not reach onPayload: ${result.errorMessage}`);
			assert.equal(result.stopReason, "error");
			assert.equal(result.errorMessage, sentinel, `${name}: unexpected initialization error`);
			noNetwork();
			console.log(`[smoke-provider-runtime] ${name}: native lazy Google adapter reached onPayload; generation stopped`);
		}
		// Exercise the public lazy OAuth surface offline. toAuth evaluates the
		// real flow module and its imports but neither logs in nor refreshes.
		for (const [name, factory] of [["github-copilot", "githubCopilotProvider"], ["xai", "xaiProvider"]]) {
			const provider = (await import(new URL(`providers/${name}.js`, entry).href))[factory]();
			const credential = { type: "oauth", access: name === "github-copilot" ? "tid=offline;proxy-ep=proxy.individual.githubcopilot.com;" : "offline-xai-oauth-not-a-token", refresh: "offline-refresh-not-a-token", expires: Date.now() + 3600000, availableModelIds: provider.getModels().map((model) => model.id) };
			const auth = await provider.auth.oauth.toAuth(credential);
			assert.equal(auth.apiKey, credential.access);
			if (name === "github-copilot") assert.equal(auth.baseUrl, "https://api.individual.githubcopilot.com");
			const seenApis = new Set();
			for (const model of provider.getModels()) {
				if (seenApis.has(model.api)) continue;
				seenApis.add(model.api);
				const sentinel = `LH_OFFLINE_SUBSCRIPTION_${randomUUID()}`;
				let reached = 0;
				const result = await provider.streamSimple({ ...model, ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}) }, { messages: [{ role: "user", content: "Offline initialization only", timestamp: 0 }] }, {
					...auth, maxRetries: 0, onPayload() { reached++; throw new Error(sentinel); },
				}).result();
				assert.equal(reached, 1, `${name}/${model.api}: ${result.errorMessage}`);
				assert.equal(result.errorMessage, sentinel);
			}
			noNetwork();
			console.log(`[smoke-provider-runtime] ${name}: public native OAuth and ${seenApis.size} transport APIs initialized offline`);
		}
		// Resolution/evaluation, not folder-exists checks. This also covers the
		// previously missing transitive edge and permits legitimate nested deps.
		for (const name of ["@google/genai", "google-auth-library", "gcp-metadata", "json-bigint", "bignumber.js"]) {
			assert.ok([...loaded].some((file) => file.includes(`${path.sep}node_modules${path.sep}${name.replaceAll("/", path.sep)}${path.sep}`)),
				`Google runtime chain was not loaded: ${name}`);
		}
		console.log(`[smoke-provider-runtime] native Pi Google initialization passed; ${loaded.size} modules confined to ${root}; zero network attempts`);
	} finally { hooks.deregister(); }
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
	verifyProviderRuntime(value("--standalone", path.resolve(import.meta.dirname, "../.next/standalone")), value("--runtime", process.execPath));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(`[smoke-provider-runtime] FAIL: ${formatProbeError(error)}`); process.exitCode = 1; });
}
