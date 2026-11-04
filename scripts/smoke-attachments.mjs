/** Session context attachments (2026-10-29) — the live-UI happy path, end
 * to end through the real app: pick files in the new-session composer, see
 * the chips, send, land on the chat page with the files stored in the
 * session and their ids on the opening message; then a second session
 * attaching the same book shares its stored copy. No model/provider calls:
 * /api/chat is intercepted, the catalog is a fixture, app HOME/data/auth
 * are throwaway. Uploads hit the REAL route (proxy.ts included).
 * Run: LH_TEST_CHROME=/usr/bin/google-chrome node scripts/smoke-attachments.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-attach-ui-"));
fs.mkdirSync(path.join(home, "data"));
fs.writeFileSync(path.join(home, "auth.json"), "{}\n");
const require = createRequire(import.meta.url);
const { getFontAxes } = require("next/dist/compiled/@next/font/dist/google/get-font-axes.js");
const { getGoogleFontsUrl } = require("next/dist/compiled/@next/font/dist/google/get-google-fonts-url.js");
const fonts = Object.fromEntries(["JetBrains Mono", "Source Sans 3"].map(family => [
	getGoogleFontsUrl(family, getFontAxes(family, ["variable"], ["normal"]), "swap"),
	`@font-face { font-family: '${family}'; src: local('Arial'); font-weight: 100 900; }`,
]));
fs.writeFileSync(path.join(home, "fonts.cjs"), `module.exports = ${JSON.stringify(fonts)};\n`);

// The files the learner picks: a minimal EPUB and a 1×1 PNG.
const files = path.join(home, "pick");
fs.mkdirSync(files);
const epubPath = path.join(files, "book.epub");
fs.writeFileSync(epubPath, zipSync({
	mimetype: [strToU8("application/epub+zip"), { level: 0 }],
	"META-INF/container.xml": strToU8(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
	"content.opf": strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Smoke Book</dc:title></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`),
	"c1.xhtml": strToU8(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>One</h1><p>Hello.</p></body></html>`),
}));
const pngPath = path.join(files, "figure.png");
fs.writeFileSync(pngPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

const listener = net.createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const dataDir = path.join(home, "data");
const env = {
	PATH: process.env.PATH, HOME: home, TMPDIR: home, NODE_ENV: "development",
	LH_DATA_DIR: dataDir, LH_AUTH_FILE: path.join(home, "auth.json"),
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
const errors = [];
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
	const page = await browser.newPage();
	page.setDefaultTimeout(60000);
	page.on("pageerror", err => errors.push(err.message));
	const model = { id: "synthetic", name: "Synthetic (no calls)", provider: "fixture", input: ["text", "image"], reasoning: false, supportedLevels: ["off"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
	const slot = { model: { provider: model.provider, id: model.id }, thinkingLevel: "off" };
	const catalog = { models: [model], providers: [{ id: "fixture", label: "Fixture", keyPresent: true }], defaults: null,
		slots: { strong: slot, cheap: slot, vision: slot }, rolePins: {} };
	const posts = [];
	const uploads = [];
	await page.setRequestInterception(true);
	page.on("request", async request => {
		try {
			const url = new URL(request.url());
			if (url.origin !== origin) { await request.abort(); return; }
			const respond = body => request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
			if (url.pathname === "/api/models") return await respond(catalog);
			if (url.pathname === "/api/events") return await request.respond({ status: 204 });
			if (url.pathname === "/api/chat") { posts.push(JSON.parse(request.postData())); return await respond({ ok: true }); }
			if (/^\/api\/chats\/[^/]+\/stream$/.test(url.pathname)) return await request.respond({ status: 204 });
			if (/^\/api\/chats\/[^/]+\/attachments$/.test(url.pathname)) uploads.push(url.pathname);
			await request.continue();
		} catch (err) { if (!/Target closed|Session closed|Invalid InterceptionId/.test(String(err))) errors.push(String(err)); }
	});

	/** Start a new session from /chat/new with these files picked. */
	const startSession = async (paths, names, text) => {
		await page.goto(origin + "/chat/new", { waitUntil: "domcontentloaded", timeout: 120000 });
		await page.waitForSelector('[data-testid="attach-context"]');
		const input = await page.$('[data-testid="attachment-input"]');
		await input.uploadFile(...paths);
		await page.waitForFunction(n => document.querySelectorAll('[data-testid="attachment-chip"]').length === n, {}, paths.length);
		const chipText = await page.$$eval('[data-testid="attachment-chip"]', els => els.map(e => e.textContent));
		assert.deepEqual(chipText, names);

		await page.evaluate(value => {
			const input = document.querySelector('[data-testid="composer"] [data-file-path-input]') || document.querySelector("[data-file-path-input]");
			input.textContent = value;
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}, text);
		await page.waitForFunction(() => {
			const button = document.querySelector('button[aria-label="Start session"], [data-testid="composer"] button[aria-label="Send"]');
			return button && !button.disabled;
		});
		await page.locator('button[aria-label="Start session"], [data-testid="composer"] button[aria-label="Send"]').click();
		await page.waitForFunction(() => /^\/chat\/chat_/.test(location.pathname));
		await page.waitForFunction(n => document.querySelectorAll('[data-testid="message-attachments"] [data-testid="attachment-chip"]').length === n, {}, paths.length);
		return new URL(page.url()).pathname.split("/").at(-1);
	};

	const chatId = await startSession([epubPath, pngPath], ["book.epub", "figure.png"], "teach me from my book");
	assert.equal(uploads.length, 2, "one upload request per file");
	const sent = posts.at(-1);
	assert.equal(sent.chatId, chatId);
	assert.equal(sent.input.text, "teach me from my book");
	assert.equal(sent.input.attachmentIds.length, 2);
	const record = JSON.parse(fs.readFileSync(path.join(dataDir, "chats", `${chatId}.json`), "utf-8"));
	assert.deepEqual(record.attachments.map(a => [a.name, a.kind]), [["book.epub", "epub"], ["figure.png", "image"]]);
	assert.deepEqual(record.attachments.map(a => a.id), sent.input.attachmentIds);
	assert.equal(record.attachments[0].chapters, 1);
	for (const a of record.attachments) assert.ok(fs.existsSync(path.join(dataDir, "attachments", a.file)), `${a.name} stored`);
	const shown = await page.$$eval('[data-testid="message-attachments"] [data-testid="attachment-chip"]', els => els.map(e => e.textContent));
	assert.deepEqual(shown, ["book.epub", "figure.png"]);
	console.log("✓ new session: 2 files picked → chips → uploaded to the session → ids on the opening message → chips in the transcript");

	// The top bar's session-files panel on the first session: remove, undo, add, close, open from a transcript chip.
	const readRecord = () => JSON.parse(fs.readFileSync(path.join(dataDir, "chats", `${chatId}.json`), "utf-8"));
	const until = async (check, what) => {
		const deadline = Date.now() + 15000;
		while (!check(readRecord())) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	};
	const chipText = () => page.$eval('[data-testid="session-files-chip"]', el => el.textContent);
	// Still on /chat/<chatId>: the opening message (POST intercepted) lives only in this page.
	await page.waitForSelector('[data-testid="session-files-chip"]');
	assert.match(await chipText(), /Files · 2/);
	await page.locator('[data-testid="session-files-chip"]').click();
	await page.waitForSelector('[data-testid="session-files-panel"]');

	await page.locator('button[aria-label="Remove book.epub"]').click();
	await until(r => r.attachments[0].detachedAt, "book.epub detached");
	await page.waitForFunction(() => /Files · 1/.test(document.querySelector('[data-testid="session-files-chip"]').textContent));
	const bookChip = await page.$eval('[data-testid="message-attachments"] [data-testid="attachment-chip"]', el => el.textContent);
	assert.match(bookChip, /removed/);

	await page.locator('button[aria-label="Undo removing book.epub"]').click();
	await until(r => !("detachedAt" in r.attachments[0]), "book.epub restored");
	await page.waitForFunction(() => /Files · 2/.test(document.querySelector('[data-testid="session-files-chip"]').textContent));

	const postsBefore = posts.length;
	const panelInput = await page.$('[data-testid="session-files-input"]');
	await panelInput.uploadFile(path.join(root, "tests/fixtures/sample-3page.pdf"));
	await until(r => r.attachments.length === 3, "the panel upload");
	const added = readRecord().attachments[2];
	assert.equal(added.name, "sample-3page.pdf");
	assert.equal(added.pages, 3);
	await page.waitForFunction(() => /Files · 3/.test(document.querySelector('[data-testid="session-files-chip"]').textContent));
	assert.equal(posts.length, postsBefore, "adding a file sends no message");

	await page.keyboard.press("Escape");
	await page.waitForFunction(() => !document.querySelector('[data-testid="session-files-panel"]'));
	assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "session-files-chip");

	const figureId = readRecord().attachments[1].id;
	const chips = await page.$$('[data-testid="message-attachments"] [data-testid="attachment-chip"]');
	await chips[1].click();
	await page.waitForSelector(`[data-testid="session-files-panel"] [data-attachment-id="${figureId}"][data-highlighted="true"]`);
	assert.deepEqual(errors, []);
	console.log("✓ session files: remove → Files · 1 + struck chip → Undo → panel upload (no message sent) → Esc returns focus → transcript chip opens its row");

	const secondId = await startSession([epubPath], ["book.epub"], "quiz me on my book");
	assert.notEqual(secondId, chatId);
	const second = JSON.parse(fs.readFileSync(path.join(dataDir, "chats", `${secondId}.json`), "utf-8"));
	assert.equal(second.attachments.length, 1);
	assert.equal(second.attachments[0].file, record.attachments[0].file, "the same book points at the same stored file");
	assert.equal(fs.readdirSync(path.join(dataDir, "attachments")).length, 3, "4 attachments across 2 sessions, 3 files stored");
	console.log("✓ second session: the same book attached again is stored once, shared by both sessions");
} catch (err) {
	console.error(logs.slice(-4000));
	throw err;
} finally {
	await browser?.close().catch(() => {});
	server.kill("SIGTERM");
	fs.rmSync(home, { recursive: true, force: true });
}
