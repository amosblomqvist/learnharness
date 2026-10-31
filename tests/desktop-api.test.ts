import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { NextRequest } from "next/server";
// Installed Next 16.3.2 retains the old test-helper export despite proxy.md's new name.
import { unstable_doesMiddlewareMatch as unstable_doesProxyMatch } from "next/experimental/testing/server";
import { desktopAPIAuthorized } from "../src/server/desktop-access.ts";
import { proxy, config } from "../proxy.ts";
import { BASE_DATA } from "../config.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { browserServiceSpawnEnv } from "../src/agent/subagents/headless.ts";
const require = createRequire(import.meta.url);
const { desktopAPIHeaders, HEADER } = require("../electron/desktop-api.cjs");
const { trustedSender, chatGPTControl } = require("../electron/chatgpt-ipc.cjs");
const secret = "a".repeat(64);
const origin = "http://127.0.0.1:12345";

function fixture() {
	const mainFrame = { url: `${origin}/chat/new` };
	const contents = { id: 5, mainFrame, isDestroyed: () => false };
	const win = { webContents: contents, isDestroyed: () => false };
	const details = { url: `${origin}/api/settings`, webContentsId: contents.id, webContents: contents, frame: mainFrame, initiatorOrigin: origin, requestHeaders: { Accept: "application/json" } };
	return { mainFrame, contents, win, details };
}

test("desktop capability injects only trusted app mainframe exact-origin API requests and strips every other case", () => {
	const { details, win, mainFrame, contents } = fixture();
	assert.equal(desktopAPIHeaders(details, origin, secret, [win])[HEADER], secret);
	for (const mutation of [
		{ url: "https://thirdparty.invalid/api/settings" },
		{ url: "http://127.0.0.1:12346/api/settings" },
		{ url: `${origin}/chat/new` },
		{ frame: { url: `${origin}/chat/new` } }, // forged frame identity
		{ frame: { url: "about:srcdoc", parent: mainFrame } },
		{ frame: null },
		{ webContentsId: 6 },
		{ webContents: { ...contents } },
		{ initiatorOrigin: "https://thirdparty.invalid" },
		{ initiatorOrigin: "null" },
	]) {
		const result = desktopAPIHeaders({ ...details, ...mutation, requestHeaders: { "X-LearnHarness-Desktop": secret } }, origin, secret, [win]);
		assert(!Object.keys(result).some((key) => key.toLowerCase() === HEADER), JSON.stringify(mutation));
	}
	assert.equal(desktopAPIHeaders(details, origin, secret, [])[HEADER], undefined, "other WebContents are not app windows");
	mainFrame.url = "https://thirdparty.invalid/after-navigation";
	assert.equal(desktopAPIHeaders(details, origin, secret, [win])[HEADER], undefined, "navigation revokes trust even for the same native frame");
	assert.equal(desktopAPIHeaders(details, origin, null, [win])[HEADER], undefined, "externally launched desktop dev receives no packaged capability");
});

test("all methods fail closed for desktop missing/wrong secret; the gate covers pages and APIs", async () => {
	assert(desktopAPIAuthorized(new Headers(), {}), "browser-only API-key mode unchanged");
	assert(!desktopAPIAuthorized(new Headers({ [HEADER]: secret }), { LH_DESKTOP_SERVER: "1" }), "missing server secret must not disable authorization");
	for (const value of [undefined, "", "wrong", secret + ", " + secret]) {
		assert(!desktopAPIAuthorized(new Headers(value === undefined ? {} : { [HEADER]: value }), { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: secret }));
	}
	assert(desktopAPIAuthorized(new Headers({ [HEADER]: secret }), { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: secret }));
	// The gate now runs on everything except build assets: API calls AND pages.
	for (const pathname of ["/api/events", "/api/chat", "/api/settings/models", "/api/chats/scratch/markdown", "/chat/new", "/settings"])
		assert(unstable_doesProxyMatch({ config, nextConfig: {}, url: origin + pathname }), pathname);
	assert(!unstable_doesProxyMatch({ config, nextConfig: {}, url: origin + "/_next/static/chunk.js" }));
	assert(!unstable_doesProxyMatch({ config, nextConfig: {}, url: origin + "/manifest.webmanifest" }));

	// The gate needs an initialized registry; give it one in an isolated data root.
	const usersFile = path.join(BASE_DATA, "users.json");
	const previousUsers = fs.existsSync(usersFile) ? fs.readFileSync(usersFile, "utf-8") : null;
	const originalMarker = process.env.LH_DESKTOP_SERVER;
	const originalSecret = process.env.LH_DESKTOP_API_SECRET;
	const originalEnv = process.env.NODE_ENV;
	try {
		fs.mkdirSync(BASE_DATA, { recursive: true });
		fs.writeFileSync(usersFile, JSON.stringify({ version: 1, users: [{ id: "usr_gate_test", name: "Gate", email: "gate@example.com", role: "admin", passwordHash: "scrypt$32768$8$1$c2FsdA$aGFzaA", createdAt: new Date().toISOString(), sessionVersion: 1 }], invites: [] }), { mode: 0o600 });
		process.env.LH_DESKTOP_SERVER = "1";
		process.env.LH_DESKTOP_API_SECRET = secret;
		// Route handlers must not take the test-mode shortcut here: this is the
		// production gate contract, exercised from a test runner.
		delete (process.env as unknown as Record<string, string | undefined>)["NODE_ENV"];
		for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
			const denied = await proxy(new NextRequest(origin + "/api/settings", { method }));
			assert.equal(denied.status, 401, `${method} without the desktop secret is refused`);
			const allowed = await proxy(new NextRequest(origin + "/api/settings", { method, headers: { [HEADER]: secret } }));
			assert.equal(allowed.headers.get("x-middleware-next"), "1", `${method} with the desktop secret passes`);
		}
		const loginRedirect = await proxy(new NextRequest(origin + "/chat/new"));
		assert.equal(loginRedirect.status, 307, "a browser page without a session redirects to /login");
		assert.equal(new URL(loginRedirect.headers.get("location") ?? "http://x/").pathname, "/login");
	} finally {
		if (previousUsers === null) fs.rmSync(usersFile, { force: true });
		else fs.writeFileSync(usersFile, previousUsers, { mode: 0o600 });
		if (originalEnv === undefined) delete (process.env as unknown as Record<string, string | undefined>)["NODE_ENV"];
		else (process.env as unknown as Record<string, string | undefined>)["NODE_ENV"] = originalEnv;
		if (originalMarker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = originalMarker;
		if (originalSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = originalSecret;
	}
});

test("renderer controls route explicit account forgetting and account-independent boolean consent only", async () => {
	const forgotten: string[] = [], changes: boolean[] = [];
	const connection = { disconnect: async (id: string) => { forgotten.push(id); return { ok: true }; }, consent: async (enabled: boolean) => { changes.push(enabled); return { ok: true }; } };
	assert.deepEqual(await chatGPTControl({ op: "disconnect", id: "fixture-account" }, connection), { ok: true });
	assert.deepEqual(await chatGPTControl({ op: "consent", enabled: false }, connection), { ok: true });
	assert.deepEqual(forgotten, ["fixture-account"]); assert.deepEqual(changes, [false]);
	for (const command of [{ op: "disconnect" }, { op: "disconnect", id: 7 }, { op: "consent", enabled: "false" }]) assert.deepEqual(await chatGPTControl(command, connection), { error: "Unsupported ChatGPT control." });
	assert.deepEqual(changes, [false]);
});

test("renderer controls have no lease or general token bridge, and require the trusted main frame", async () => {
	let leased = false;
	const connection = { lease: async () => { leased = true; return { accessToken: "scratch-private-token" }; } };
	assert.deepEqual(await chatGPTControl({ op: "lease", background: false }, connection), { error: "Unsupported ChatGPT control." });
	assert.equal(leased, false);
	const { contents, mainFrame, win } = fixture();
	const BrowserWindow = { fromWebContents: (value: unknown) => value === contents ? win : null };
	assert(trustedSender({ sender: contents, senderFrame: mainFrame }, origin, BrowserWindow));
	assert(!trustedSender({ sender: contents, senderFrame: { url: mainFrame.url } }, origin, BrowserWindow));
	mainFrame.url = "https://thirdparty.invalid/";
	assert(!trustedSender({ sender: contents, senderFrame: mainFrame }, origin, BrowserWindow));
	assert.equal(browserServiceSpawnEnv({ LH_DESKTOP_API_SECRET: secret, LH_DESKTOP_SERVER: "1" }).LH_DESKTOP_API_SECRET, undefined);
});
