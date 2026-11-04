/** Live composer check with synthetic catalog/POST/streams and isolated data.
 * No provider calls. Run LH_TEST_CHROME=/path/to/chrome node scripts/smoke-chat-attachments.mjs.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-attachments-"));
const output = process.env.LH_SMOKE_OUTPUT || home;
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(path.join(home, "data"));
fs.writeFileSync(path.join(home, "auth.json"), "{}");
const require = createRequire(import.meta.url);
const { getFontAxes } = require("next/dist/compiled/@next/font/dist/google/get-font-axes.js");
const { getGoogleFontsUrl } = require("next/dist/compiled/@next/font/dist/google/get-google-fonts-url.js");
const fonts = Object.fromEntries(["JetBrains Mono", "Source Sans 3"].map(family => [getGoogleFontsUrl(family, getFontAxes(family, ["variable"], ["normal"]), "swap"), `@font-face { font-family: '${family}'; src: local('Arial'); font-weight: 100 900; }`]));
fs.writeFileSync(path.join(home, "fonts.cjs"), `module.exports = ${JSON.stringify(fonts)};`);
const env = { ...process.env, HOME: home, USERPROFILE: home, LH_DATA_DIR: path.join(home, "data"), LH_AUTH_FILE: path.join(home, "auth.json"), LH_IGNORE_ENV_KEYS: "1", NEXT_TELEMETRY_DISABLED: "1", NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(home, "fonts.cjs") };
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "0"], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
server.stdout.on("data", data => { logs += data; });
server.stderr.on("data", data => { logs += data; });
let browser;
let held;
const errors = [];
const checks = [];
try {
	await new Promise((resolve, reject) => {
		const deadline = setTimeout(() => reject(new Error("App startup timed out")), 60000);
		const ready = () => { if (logs.includes("Ready in")) { clearTimeout(deadline); server.stdout.off("data", ready); resolve(); } };
		server.stdout.on("data", ready);
		server.once("exit", code => { clearTimeout(deadline); reject(new Error(`App exited ${code}`)); });
	});
	const origin = logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
	assert.ok(origin, logs);
	browser = await puppeteer.launch({ executablePath: process.env.LH_TEST_CHROME, headless: true, userDataDir: path.join(home, "browser"), args: ["--disable-background-networking", "--disable-sync", "--no-first-run"] });
	const page = await browser.newPage();
	await page.setViewport({ width: 1280, height: 900 });
	page.setDefaultTimeout(45000);
	page.on("pageerror", error => errors.push(error.message));
	const model = { id: "fixture", name: "Fixture (no calls)", provider: "fixture", input: ["text", "image"], reasoning: false, supportedLevels: ["off"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1024 };
	const slot = { model: { provider: "fixture", id: "fixture" }, thinkingLevel: "off" };
	const catalog = { models: [model], providers: [{ id: "fixture", label: "Fixture", keyPresent: true }], defaults: null, slots: { strong: slot, cheap: slot, vision: slot }, rolePins: {} };
	let mode = "refuse";
	const posts = [];
	let messages = [];
	await page.setRequestInterception(true);
	page.on("request", async request => {
		try {
			const url = new URL(request.url());
			if (url.origin !== origin) return await request.abort();
			const respond = (body, status = 200) => request.respond({ status, contentType: "application/json", body: JSON.stringify(body) });
			if (url.pathname === "/api/models") return await respond(catalog);
			if (url.pathname === "/api/events") return await request.respond({ status: 204 });
			if (url.pathname === "/api/chat") {
				const body = JSON.parse(request.postData()); posts.push(body);
				if (mode === "refuse") return await respond({ error: "Synthetic upload refusal" }, 400);
				held = request;
				messages = [{ id: "saved_attachment", role: "user", content: [{ type: "text", text: body.input.text }], attachments: body.input.attachments, timestamp: Date.now() }];
				return;
			}
			if (/\/api\/chats\/[^/]+\/stream$/.test(url.pathname)) return await request.respond({ status: 200, contentType: "text/event-stream", body: "data: [DONE]\n\n" });
			if (/^\/api\/chats\/[^/]+$/.test(url.pathname) && request.method() === "GET") return await respond({ messages, turns: [], turnInFlight: false });
			await request.continue();
		} catch (error) { if (!/Target closed|Session closed|Invalid InterceptionId/.test(String(error))) errors.push(String(error)); }
	});
	await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 120000 });
	const id = await page.evaluate(async () => (await (await fetch("/api/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Attachment smoke fixture" }) })).json()).id);
	await page.goto(`${origin}/chat/${id}`, { waitUntil: "domcontentloaded", timeout: 120000 });
	await page.waitForSelector('button[aria-label="Attach PDFs or photos"]');
	await page.waitForFunction(() => !document.querySelector('[data-testid="setup-cta"]'));
	const photo = path.join(home, "diagram.png");
	fs.writeFileSync(photo, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6WhQAAAAASUVORK5CYII=", "base64"));
	const pdf = path.join(home, "lesson.pdf");
	fs.writeFileSync(pdf, "%PDF-1.4\n% Synthetic browser-only file; server extraction has separate tests.\n%%EOF");
	const input = await page.$('input[type="file"]');
	await input.uploadFile(photo, pdf);
	await page.waitForSelector('[aria-label="Remove lesson.pdf"]');
	await page.locator('[data-testid="composer"] textarea').fill("Explain these attachments");
	await page.screenshot({ path: path.join(output, "chat-attachments-draft.png"), fullPage: true });
	await page.locator('[data-testid="composer"] button[aria-label="Send"]').click();
	await page.waitForFunction(() => document.body.innerText.includes("Synthetic upload refusal"));
	assert.equal(posts.length, 1);
	assert.equal(posts[0].input.attachments.length, 2);
	assert.equal(await page.$eval('[data-testid="composer"] textarea', node => node.value), "Explain these attachments");
	assert.ok(await page.$('[aria-label="Remove lesson.pdf"]'));
	checks.push("PDF/photo selection and caption survive a refused POST");
	mode = "hold";
	await page.locator('[data-testid="composer"] button[aria-label="Send"]').click();
	await page.waitForFunction(() => !!document.querySelector('[data-testid="composer"] button[aria-label="Stop"]'));
	const deadline = Date.now() + 5000;
	while (!held && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
	assert.ok(held, "the synthetic POST reached the acknowledgement gate");
	assert.ok(await page.$('[aria-label="Remove lesson.pdf"]'), "draft stays until acknowledgement");
	await page.locator('[data-testid="composer"] textarea').fill("A newer caption");
	await page.keyboard.press("Enter");
	assert.equal(posts.length, 2, "a waiting attachment draft must not become a text-only steer");
	await held.respond({ status: 200, contentType: "application/json", body: '{"ok":true}' });
	await page.waitForFunction(() => !document.querySelector('[aria-label="Attached files"]'));
	assert.equal(await page.$eval('[data-testid="composer"] textarea', node => node.value), "A newer caption");
	await page.waitForSelector('[data-testid="user-message"] a[download="lesson.pdf"]');
	checks.push("acknowledgement clears sent files, preserves newer edits and renders downloadable transcript attachments");
	const svg = path.join(home, "unsupported.svg"); fs.writeFileSync(svg, "<svg/>");
	await input.uploadFile(svg);
	await page.waitForFunction(() => document.body.innerText.includes("choose a PDF, PNG, JPEG, or WebP"));
	assert.equal(posts.length, 2);
	checks.push("unsupported file produces an accessible error without a request");
	await page.screenshot({ path: path.join(output, "chat-attachments.png"), fullPage: true });
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ checks, pageErrors: errors, screenshot: path.join(output, "chat-attachments.png"), isolation: "throwaway data/auth; synthetic catalog/POST/stream; no model calls" }, null, 2));
} catch (error) {
	console.error(logs.slice(-10000));
	throw error;
} finally {
	await browser?.close();
	server.kill();
}
