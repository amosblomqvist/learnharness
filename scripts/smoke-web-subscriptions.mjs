/** Offline Next runtime gate (run after next build, with no dev server running).
 * Proves cold-start registration, cross-route owner/events and dev reloads using
 * synthetic credentials in a fresh profile. No OAuth, provider traffic or real
 * auth/data. The dev reload changes only a source mtime, restoring it afterward.
 * This is a test, not an alternative app launcher. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { SCOPES } = require("../electron/chatgpt.cjs");
const sdk = (file) => import(pathToFileURL(path.join(ROOT, "node_modules/@earendil-works/pi-ai/dist", file)));
const { createModels } = await sdk("index.js");
const { builtinProviders } = await sdk("providers/all.js");
const { githubCopilotProvider } = await sdk("providers/github-copilot.js");
const models = createModels();
for (const provider of builtinProviders()) models.setProvider(provider);
const model = models.getModels("openai").find((entry) => entry.api === "openai-responses");
const copilot = githubCopilotProvider().getModels()[0];
assert(model && copilot, "Installed SDK catalogs required.");

const profile = await fs.mkdtemp(path.join(os.tmpdir(), "lh-web-runtime-"));
await fs.chmod(profile, 0o700);
for (const name of ["home", "config", "cache", "xdg-data", "data", "pi", "claude", "codex", "tmp"]) await fs.mkdir(path.join(profile, name), { mode: 0o700 });
await fs.writeFile(path.join(profile, "auth.json"), "{}\n", { mode: 0o600 });
const preload = path.join(profile, "offline-fetch.mjs");
await fs.writeFile(preload, `const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
 const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
 if (url.href === 'https://api.openai.com/v1/models') return Response.json({ models: [{ slug: ${JSON.stringify(model.id)}, display_name: 'Offline fixture ChatGPT', visibility: 'list' }] });
 if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return original(input, init);
 throw new Error('Offline subscription gate forbids external network: ' + url.origin + url.pathname);
};\n`, { mode: 0o600 });
// Intentionally an allowlist, not a copy of the calling shell's environment.
const env = {
	PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: path.join(profile, "home"),
	XDG_CONFIG_HOME: path.join(profile, "config"), XDG_CACHE_HOME: path.join(profile, "cache"), XDG_DATA_HOME: path.join(profile, "xdg-data"),
	PI_CODING_AGENT_DIR: path.join(profile, "pi"), PI_AGENT_DIR: path.join(profile, "pi"), CLAUDE_CONFIG_DIR: path.join(profile, "claude"), CODEX_HOME: path.join(profile, "codex"),
	TMPDIR: path.join(profile, "tmp"), LH_AUTH_FILE: path.join(profile, "auth.json"), LH_DATA_DIR: path.join(profile, "data"),
	NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, NEXT_TELEMETRY_DISABLED: "1",
};
const saved = {
	version: 1, hostId: "offline-host", allowBackgroundUse: true, activeId: "offline-account",
	registrations: [{ id: "offline-account", clientId: "oaiapp_fixture", issuer: "https://auth.openai.com", subject: "offline-subject", email: "fixture@example.invalid", tokens: { accessToken: "fixture-chatgpt-access", refreshToken: "fixture-chatgpt-refresh", idToken: "fixture-id-token", scopes: SCOPES, expiresAt: Date.now() + 3600000 } }],
};
function timeout(promise, milliseconds, message) {
	let timer;
	return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]).finally(() => clearTimeout(timer));
}
async function freePort() {
	const socket = createServer();
	await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
	const { port } = socket.address(); await new Promise((resolve) => socket.close(resolve)); return port;
}
async function run(mode) {
	await fs.writeFile(path.join(profile, "chatgpt-credentials.json"), JSON.stringify(saved), { mode: 0o600 });
	for (const id of ["github-copilot", "xai"]) await fs.writeFile(path.join(profile, `${id}-credentials.json`), JSON.stringify({
		version: 1, allowBackgroundUse: true, connectionId: "00000000-0000-4000-8000-000000000001",
		credential: { type: "oauth", access: id === "xai" ? "fixture-xai-access" : "tid=fixture;proxy-ep=proxy.individual.githubcopilot.com;", refresh: "fixture-refresh", expires: Date.now() + 3600000, ...(id === "github-copilot" ? { availableModelIds: [copilot.id] } : {}) },
	}), { mode: 0o600 });
	const port = await freePort(), origin = `http://localhost:${port}`;
	let logs = "", exited = false;
	const child = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), mode, "-p", String(port)], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
	const exit = new Promise((resolve) => child.once("exit", () => { exited = true; resolve(); }));
	try {
		await timeout(new Promise((resolve, reject) => {
			const receive = (data) => { logs = (logs + data).slice(-16000); if (logs.includes("Ready in")) resolve(); };
			child.stdout.on("data", receive); child.stderr.on("data", receive);
			child.once("error", reject); child.once("exit", (code) => reject(new Error(`Next ${mode} exited ${code}.`)));
		}), 60000, `Next ${mode} readiness timeout.`);
		const request = (url, command) => fetch(origin + url, {
			...(command ? { method: "POST", body: JSON.stringify(command) } : {}),
			headers: { origin, "sec-fetch-site": "same-origin", "x-learnharness-subscriptions": "1", "content-type": "application/json" },
			signal: AbortSignal.timeout(60000),
		});
		// Controls have not been imported through an HTTP request yet.
		const catalog = (await (await request("/api/models")).json()).providers;
		for (const id of ["chatgpt", "github-copilot-subscription", "xai-subscription"]) assert(catalog.find((provider) => provider.id === id)?.keyPresent, `${mode}: cold ${id} unavailable.`);
		let state = await (await request("/api/subscriptions")).json();
		assert.equal(state.chatgpt.accounts[0].email, "fixture@example.invalid"); assert.equal(state.native.length, 2);
		for (const secret of ["fixture-chatgpt-access", "fixture-chatgpt-refresh", "fixture-id-token", "fixture-xai-access", "fixture-refresh"]) assert(!JSON.stringify(state).includes(secret));
		const stream = await fetch(origin + "/api/events", { signal: AbortSignal.timeout(60000) });
		const reader = stream.body.getReader();
		try {
			const first = await reader.read(); assert(first.value);
			assert.equal((await request("/api/subscriptions", { providerId: "chatgpt", op: "consent", enabled: false })).status, 200);
			let events = new TextDecoder().decode(first.value);
			while (!events.includes("subscriptions-changed")) {
				const frame = await timeout(reader.read(), 5000, "Cross-route subscription SSE timeout.");
				assert(!frame.done, "Subscription event stream ended early."); events += new TextDecoder().decode(frame.value);
			}
		} finally { await reader.cancel(); }
		state = await (await request("/api/subscriptions")).json(); assert.equal(state.chatgpt.allowBackgroundUse, false);
		const login = await (await request("/api/subscriptions", { providerId: "chatgpt", op: "login" })).json();
		assert(login.browserAction); assert(!JSON.stringify(login).includes("auth.openai.com"));
		if (mode === "dev") {
			const file = path.join(ROOT, "src/server/web-subscriptions.ts"), times = await fs.stat(file);
			await fs.utimes(file, new Date(), new Date());
			try { assert.equal((await request("/api/models")).status, 200); assert.equal((await request("/api/subscriptions")).status, 200); }
			finally { await fs.utimes(file, times.atime, times.mtime); }
		}
		const navigate = () => fetch(origin + login.browserAction, { redirect: "manual", headers: { "sec-fetch-site": "same-origin" }, signal: AbortSignal.timeout(30000) });
		const browser = await navigate(); assert.equal(browser.status, 303, `${mode}: owner/action lost across routes or reload.`);
		const location = new URL(browser.headers.get("location")); assert.equal(location.origin, "https://auth.openai.com"); assert.equal(new URL(location.searchParams.get("redirect_uri")).hostname, "127.0.0.1");
		assert.equal((await navigate()).status, 410);
		assert.equal((await request("/api/subscriptions", { providerId: "chatgpt", op: "cancel" })).status, 200);
		assert.equal((await fetch(origin + "/api/subscriptions", { method: "POST", headers: { origin: "https://unrelated.invalid", "content-type": "application/json", "x-learnharness-subscriptions": "1" }, body: JSON.stringify({ providerId: "chatgpt", op: "disconnect", id: "offline-account" }) })).status, 403);
		assert.equal((await request("/api/subscriptions", { providerId: "chatgpt", op: "disconnect", id: "offline-account" })).status, 200);
		assert.equal((await (await request("/api/models")).json()).providers.find((provider) => provider.id === "chatgpt").keyPresent, false);
		console.log(`[smoke-web-subscriptions] ${mode}: cold catalogs, safe status, cross-route SSE/consent/disconnect, opaque redirect/replay, CSRF${mode === "dev" ? ", owner retained across source reload" : ""} passed`);
	} catch (error) { console.error(logs); throw error; }
	finally {
		if (!exited) child.kill("SIGTERM");
		try { await timeout(exit, 5000, "Next shutdown timeout."); }
		catch { child.kill("SIGKILL"); await exit; }
	}
}
try { await run("start"); await run("dev"); }
finally { await fs.rm(profile, { recursive: true, force: true }); }
