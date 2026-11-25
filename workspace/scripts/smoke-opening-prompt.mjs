/** Focused synthetic live-UI check. No model/provider calls: /api/chat is
 * intercepted, catalog is a fixture, app HOME/data/auth are throwaway, and
 * the browser uses a fresh profile. Creates only synthetic session records.
 * Run: node scripts/smoke-opening-prompt.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh154-ui-"));
fs.mkdirSync(path.join(home, "data"));
fs.writeFileSync(path.join(home, "auth.json"), "{}\n");
// Next's supported font fixture avoids external font downloads in this check.
const require = createRequire(import.meta.url);
const { getFontAxes } = require("next/dist/compiled/@next/font/dist/google/get-font-axes.js");
const { getGoogleFontsUrl } = require("next/dist/compiled/@next/font/dist/google/get-google-fonts-url.js");
const fonts = Object.fromEntries(["JetBrains Mono", "Source Sans 3"].map(family => [
	getGoogleFontsUrl(family, getFontAxes(family, ["variable"], ["normal"]), "swap"),
	`@font-face { font-family: '${family}'; src: local('Arial'); font-weight: 100 900; }`,
]));
fs.writeFileSync(path.join(home, "fonts.cjs"), `module.exports = ${JSON.stringify(fonts)};\n`);
const listener = net.createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const env = {
	PATH: process.env.PATH, HOME: home, TMPDIR: home, NODE_ENV: "development",
	LH_DATA_DIR: path.join(home, "data"), LH_AUTH_FILE: path.join(home, "auth.json"),
	LH_IGNORE_ENV_KEYS: "1", NEXT_TELEMETRY_DISABLED: "1",
	NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(home, "fonts.cjs"),
};
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
	cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
const capture = data => { logs = (logs + data).slice(-24000); };
server.stdout.on("data", capture); server.stderr.on("data", capture);
let browser;
let page;
const errors = [];
const checks = [];
try {
	await new Promise((resolve, reject) => {
		const deadline = setTimeout(() => reject(new Error("app startup timed out")), 60000);
		const ready = () => { if (logs.includes("Ready in")) { clearTimeout(deadline); server.stdout.off("data", ready); resolve(); } };
		server.stdout.on("data", ready);
		server.once("exit", code => { clearTimeout(deadline); reject(new Error(`app exited ${code}`)); });
		ready();
	});
	browser = await puppeteer.launch({
		executablePath: process.env.LH_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		headless: true, userDataDir: path.join(home, "browser"), env,
		args: ["--disable-background-networking", "--disable-sync", "--no-first-run", "--disable-default-apps"],
	});
	page = await browser.newPage();
	page.setDefaultTimeout(45000);
	page.on("pageerror", err => errors.push(err.message));
	const model = { id: "synthetic", name: "Synthetic (no calls)", provider: "fixture", input: ["text"], reasoning: false, supportedLevels: ["off"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
	const slot = { model: { provider: model.provider, id: model.id }, thinkingLevel: "off" };
	const catalog = { models: [model], providers: [{ id: "fixture", label: "Fixture", keyPresent: true }], defaults: null,
		slots: { strong: slot, cheap: slot, vision: slot }, rolePins: {} };
	const posts = [];
	const creates = [];
	const accepted = new Map();
	let mode = "accepted";
	let held = [];
	await page.setRequestInterception(true);
	page.on("request", async request => {
		try {
			const url = new URL(request.url());
			if (url.origin !== origin) { await request.abort(); return; }
			const pathname = url.pathname;
			const respond = body => request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
			if (pathname === "/api/models") return await respond(catalog);
			// Notifications are outside this handover check. 204 tells native
			// EventSource not to reconnect or hold a test connection open.
			if (pathname === "/api/events") return await request.respond({ status: 204 });
			if (pathname === "/api/chat") {
				const body = JSON.parse(request.postData()); posts.push(body);
				if (mode === "held-post") { held.push(request); return; }
				if (mode === "lost-ack") return await request.abort("failed");
				if (mode === "refused") return await request.respond({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "models_not_configured", missing: ["strong"] }) });
				accepted.set(body.chatId, [{ id: "saved_user", role: "user", content: body.input.text, timestamp: Date.now() }]);
				return await respond({ ok: true });
			}
			if (/^\/api\/chats\/[^/]+\/stream$/.test(pathname)) {
				// Keep teacher delivery unfinished: cleanup must NOT wait for it.
				held.push(request); return;
			}
			const match = pathname.match(/^\/api\/chats\/([^/]+)$/);
			if (match && request.method() === "GET" && accepted.has(match[1])) {
				return await respond({ messages: accepted.get(match[1]), turns: [], turnInFlight: false });
			}
			if (pathname === "/api/chats" && request.method() === "POST") creates.push(JSON.parse(request.postData()));
			await request.continue();
		} catch (err) { if (!/Target closed|Session closed|Invalid InterceptionId/.test(String(err))) errors.push(String(err)); }
	});
	async function open(route) {
		// CDP-intercepted requests do not settle themselves on navigation.
		// Release synthetic streams from prior cases rather than pin slots.
		await Promise.all(held.splice(0).map(request => request.abort("aborted").catch(() => {})));
		await page.goto(origin + route, { waitUntil: "domcontentloaded", timeout: 120000 });
		await page.waitForSelector(route === "/" ? "[data-file-path-input]" : '[data-testid="composer"] [data-file-path-input]');
		await page.waitForFunction(() => !document.querySelector('[data-testid="setup-cta"]') && !document.querySelector('[data-testid="setup-cta-keys"]'));
	}
	async function fill(text) {
		await page.evaluate(value => {
			const input = document.querySelector('[data-testid="composer"] [data-file-path-input]') || document.querySelector("[data-file-path-input]");
			input.textContent = value;
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}, text);
	}
	async function submit() {
		await page.waitForFunction(() => {
			const button = document.querySelector('button[aria-label="Start session"], [data-testid="composer"] button[aria-label="Send"]');
			return button && !button.disabled;
		});
		await page.locator('button[aria-label="Start session"], [data-testid="composer"] button[aria-label="Send"]').click();
	}
	async function stash(id) { return page.evaluate(chat => sessionStorage.getItem(`lh.openingPrompt.${chat}`), id); }
	async function assertDraft(text) { await page.waitForFunction(value => {
		const input = document.querySelector('[data-testid="composer"] [data-file-path-input]');
		return input && [...input.childNodes].map(node => node.nodeType === 1 ? node.getAttribute("data-file-path-source") ?? node.textContent : node.textContent).join("") === value;
	}, {}, text); }
	const long = "A full synthetic syllabus — 世界 & ? #. ".repeat(1200).trim();
	for (const route of ["/", "/chat/new"]) {
		for (const text of ["a short synthetic topic", long]) {
			await open(route);
			const count = posts.length;
			await fill(text); await submit();
			await page.waitForFunction(() => /^\/chat\/chat_/.test(location.pathname) && !location.search);
			await page.waitForFunction(() => document.querySelector('[data-testid="composer"]'));
			await page.waitForFunction(() => !Object.keys(sessionStorage).some(k => k.startsWith("lh.openingPrompt.")));
			assert.equal(posts.length, count + 1);
			assert.equal(posts.at(-1).input.text, text);
			assert.equal(new URL(page.url()).search, "");
			assert.equal(await stash(posts.at(-1).chatId), null);
			checks.push(`${route}: ${text.length > 1000 ? "long" : "short"} input delivered intact through short URL; stash removed while stream held`);
		}
	}
	// The old long-query mechanism really is rejected by this isolated Node server.
	const oldResponse = await fetch(`${origin}${new URL(page.url()).pathname}?prompt=${encodeURIComponent(long)}`);
	assert.equal(oldResponse.status, 431); await oldResponse.text();
	checks.push("old long-query request returned431 (browser-shell blank appearance not asserted)");

	for (const route of ["/", "/chat/new"]) {
		await open(route);
		await page.evaluate(() => {
			const setItem = Storage.prototype.setItem;
			Storage.prototype.setItem = function(key, value) {
				if (window.failOpeningStorage && key.startsWith("lh.openingPrompt.")) throw new DOMException("synthetic quota", "QuotaExceededError");
				return setItem.call(this, key, value);
			};
			window.failOpeningStorage = true;
		});
		const createCount = creates.length; const sendCount = posts.length;
		await fill(long); await submit();
		await page.waitForSelector('[role="alert"]');
		assert.equal(new URL(page.url()).pathname, route);
		assert.equal(await page.$eval("[data-file-path-input]", element => [...element.childNodes].map(node => node.nodeType === 1 ? node.getAttribute("data-file-path-source") ?? node.textContent : node.textContent).join("")), long);
		assert.equal(posts.length, sendCount);
		assert.equal(creates.length, createCount + 1);
		await page.evaluate(() => { window.failOpeningStorage = false; });
		await submit();
		await page.waitForFunction(() => /^\/chat\/chat_/.test(location.pathname));
		await page.waitForFunction(() => !Object.keys(sessionStorage).some(k => k.startsWith("lh.openingPrompt.")));
		assert.equal(creates.length, createCount + 1, "unchanged retry reuses creation");
		assert.equal(posts.at(-1).input.text, long);
		checks.push(`${route}: quota failure preserved visible draft/no navigation; retry reused creation`);
	}

	for (const failure of ["lost-ack", "refused", "held-post"]) {
		mode = failure;
		await open("/chat/new");
		const text = `recover interrupted ${failure}`;
		await fill(text); await submit();
		await page.waitForFunction(() => /^\/chat\/chat_/.test(location.pathname));
		await page.waitForFunction(() => Object.values(sessionStorage).some(v => v.includes('"attempted":true')));
		if (failure !== "held-post") await assertDraft(text);
		const count = posts.length;
		await page.reload({ waitUntil: "domcontentloaded" });
		await assertDraft(text);
		assert.equal(posts.length, count, "interrupted start must not automatically repost");
		checks.push(`${failure}: reload restored full draft, no automatic repost`);
		if (failure === "lost-ack") {
			mode = "accepted";
			await submit();
			const id = new URL(page.url()).pathname.split("/").at(-1);
			await page.waitForFunction(chat => !sessionStorage.getItem(`lh.openingPrompt.${chat}`), {}, id);
			assert.equal(posts.length, count + 1);
			assert.equal(posts.at(-1).input.text, text);
			checks.push("restored draft sent only after explicit click and cleaned up on acceptance");
		}
	}
	mode = "accepted";
	// Marker-only session must still automatically deliver a fresh opening.
	await open("/chat/new");
	const markerId = await page.evaluate(async () => {
		const res = await fetch("/api/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "marker fixture", graphContext: { propositions: [{ id: "synthetic_node", name: "Fixture", statement: "Synthetic" }] } }) });
		return (await res.json()).id;
	});
	await page.evaluate(id => sessionStorage.setItem(`lh.openingPrompt.${id}`, JSON.stringify({ text: "marker opening", attempted: false })), markerId);
	const markerCount = posts.length;
	await page.goto(`${origin}/chat/${markerId}`, { waitUntil: "domcontentloaded" });
	await page.waitForFunction(id => !sessionStorage.getItem(`lh.openingPrompt.${id}`), {}, markerId);
	assert.equal(posts.length, markerCount + 1);
	assert.equal(posts.at(-1).input.text, "marker opening");
	checks.push("graph-marker-only record still receives opening text");
	// A real persisted user prevents delivery and cleans a stale copy on mount.
	const chatFile = path.join(home, "data", "chats", `${markerId}.json`);
	const record = JSON.parse(fs.readFileSync(chatFile, "utf8"));
	record.messages.push({ id: "confirmed_fixture", role: "user", content: "already received", timestamp: Date.now() });
	fs.writeFileSync(chatFile, JSON.stringify(record));
	await page.evaluate(id => sessionStorage.setItem(`lh.openingPrompt.${id}`, JSON.stringify({ text: "stale opening", attempted: true })), markerId);
	const completedCount = posts.length;
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForFunction(id => !sessionStorage.getItem(`lh.openingPrompt.${id}`), {}, markerId);
	assert.equal(posts.length, completedCount);
	checks.push("persisted real conversation removed stale stash without reposting");
	await open("/chat/new");
	const legacyId = await page.evaluate(async () => {
		const response = await fetch("/api/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "legacy fixture" }) });
		return (await response.json()).id;
	});
	const legacyCount = posts.length;
	await page.goto(`${origin}/chat/${legacyId}?prompt=${encodeURIComponent("legacy opening")}`, { waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => document.body.innerText.includes("legacy opening"));
	await page.waitForFunction(id => !sessionStorage.getItem(`lh.openingPrompt.${id}`), {}, legacyId);
	assert.equal(posts.length, legacyCount + 1);
	assert.equal(posts.at(-1).input.text, "legacy opening");
	checks.push("legacy short ?prompt link still sends its complete opening message");
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ checks, pageErrors: errors, isolation: "synthetic catalog/POST+streams; empty auth; no providers", origin }, null, 2));
} catch (err) {
	console.error(err);
	console.error(JSON.stringify({ checks, errors, url: page?.url(), dom: await page?.evaluate(() => ({ inputs: [...document.querySelectorAll('[data-file-path-input]')].map(e => ({ length: [...e.childNodes].map(n => n.nodeType === 1 ? n.getAttribute('data-file-path-source') ?? n.textContent : n.textContent).join('').length, placeholder: e.getAttribute('data-placeholder') })), buttons: [...document.querySelectorAll('button[aria-label="Send"], button[aria-label="Start session"]')].map(e => ({ disabled: e.disabled, label: e.getAttribute('aria-label') })), alerts: [...document.querySelectorAll('[role="alert"]')].map(e => e.textContent), failStorage: window.failOpeningStorage, text: document.body.innerText.slice(-1200) })).catch(() => null) }, null, 2));
	console.error(logs); process.exitCode = 1;
} finally {
	await browser?.close();
	const exited = once(server, "exit");
	server.kill("SIGTERM");
	const killTimer = setTimeout(() => server.kill("SIGKILL"), 5000); killTimer.unref();
	await exited; clearTimeout(killTimer);
	fs.rmSync(home, { recursive: true, force: true });
}
