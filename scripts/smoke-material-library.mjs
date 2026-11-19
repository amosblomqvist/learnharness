/** Real local source selection -> preview -> native opening request, no inference. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "..");
const home = await fs.mkdtemp(path.join(os.tmpdir(), "lh-material-browser-"));
const vault = path.join(home, "vault"), origin = "http://127.0.0.1:3186";
await fs.mkdir(path.join(vault, "Course"), { recursive: true });
const source = "# Semaphore notes\nA successful wait consumes one available permit.";
await fs.writeFile(path.join(vault, "Course", "Lesson.md"), source);
await fs.writeFile(path.join(vault, "Course", "Other.md"), "UNSELECTED CONTENT MUST NOT BE SENT");
const server = spawn(process.execPath, [".next/standalone/server.js"], { cwd: root, windowsHide: true, env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: "3186", NODE_ENV: "production", LH_AUTH_FILE: path.join(home, "auth.json"), LH_DATA_DIR: path.join(home, "data"), LH_IGNORE_ENV_KEYS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let browser, logs = "";
server.stdout.on("data", data => { logs = (logs + data).slice(-12000); }); server.stderr.on("data", data => { logs = (logs + data).slice(-12000); });
const click = (page, text) => page.evaluate(text => { const button = [...document.querySelectorAll("button")].find(button => button.textContent.trim() === text); if (!button) throw new Error(`Missing ${text}`); button.click(); }, text);
try {
	for (let i = 0; i < 100; i++) { try { if ((await fetch(origin)).ok) break; } catch {} if (server.exitCode !== null) throw new Error(logs); await new Promise(resolve => setTimeout(resolve, 200)); }
	browser = await puppeteer.launch({ executablePath: process.env.LH_TEST_CHROME, headless: true, args: ["--disable-background-networking", "--no-first-run"] });
	const page = await browser.newPage(); page.setDefaultTimeout(30000); await page.setViewport({ width: 1440, height: 1000 });
	const errors = []; page.on("pageerror", error => errors.push(error.message));
	const model = { id: "synthetic", name: "Synthetic", provider: "fixture", input: ["text"], reasoning: false, supportedLevels: ["off"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 4096 };
	const slot = { model: { provider: model.provider, id: model.id }, thinkingLevel: "off" };
	await page.setRequestInterception(true);
	page.on("request", request => {
		const url = new URL(request.url());
		if (url.pathname === "/api/models") return request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ models: [model], slots: { strong: slot, cheap: slot, vision: slot }, providers: [{ id: "fixture", label: "Fixture", keyPresent: true }] }) });
		if (url.pathname === "/api/chat" && request.method() === "POST") return request.respond({ status: 503, contentType: "application/json", body: '{"error":"No inference in browser acceptance"}' });
		return request.continue();
	});
	await page.goto(`${origin}/materials`, { waitUntil: "networkidle2" });
	await page.type('[aria-label="Obsidian vault folder"]', vault); await click(page, "Save connections");
	await page.waitForFunction(() => document.body.innerText.includes("↳ Course")); await click(page, "↳ Course");
	await page.waitForFunction(() => [...document.querySelectorAll("label")].some(label => label.textContent.includes("Lesson.md")));
	await page.evaluate(() => [...document.querySelectorAll("label")].find(label => label.textContent.includes("Lesson.md")).querySelector("input").click());
	await click(page, "Review selected materials");
	await page.waitForSelector('[aria-label="Review extracted content"]');
	await page.evaluate(() => [...document.querySelectorAll('[aria-label="Review extracted content"] summary')][0].click());
	assert.equal(await page.$eval('[aria-label="Review extracted content"] pre', node => node.textContent), source);
	await page.type('[aria-label="Learning goal"]', "Help me understand semaphore wait.");
	const geometry = () => page.evaluate(() => {
		const search = document.querySelector('[aria-label="Search material titles"]').getBoundingClientRect(), goal = document.querySelector('[aria-label="Learning goal"]').getBoundingClientRect();
		return { gap: Math.abs(search.left - goal.left), searchHeight: search.height, goalHeight: goal.height, overflow: document.documentElement.scrollWidth > innerWidth };
	});
	await page.addStyleTag({content: "::-webkit-scrollbar { width: 12px; }"});
	const desktop = await geometry(); assert(desktop.gap <= 1.1); assert.equal(desktop.searchHeight, 44); assert.equal(desktop.goalHeight, 44); assert.equal(desktop.overflow, false);
	if (process.env.LH_UI_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.LH_UI_SCREENSHOTS, "materials-desktop.png") });
	await page.setViewport({ width: 390, height: 844 });
	await page.click('[aria-label="Close sidebar"]');
	await page.waitForFunction(() => document.querySelector('[data-testid="material-library"]').getBoundingClientRect().width > 380);
	const mobile = await geometry(); assert(mobile.gap <= 1.1); assert.equal(mobile.overflow, false);
	if (process.env.LH_UI_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.LH_UI_SCREENSHOTS, "materials-mobile.png") });
	const posted = page.waitForRequest(request => new URL(request.url()).pathname === "/api/chat" && request.method() === "POST");
	await click(page, "Start learning from selection");
	const input = JSON.parse((await posted).postData());
	assert.equal(input.input.type, "text"); assert(input.input.text.includes("Help me understand semaphore wait."));
	assert(input.input.text.includes("A successful wait consumes one available permit."));
	assert(!input.input.text.includes("UNSELECTED CONTENT MUST NOT BE SENT"));
	assert.equal(await fs.readFile(path.join(vault, "Course", "Lesson.md"), "utf8"), source);
	assert.deepEqual(errors, []);
	console.log("Material browser acceptance passed: folder browsing, selection, exact preview, native learning handoff, no unselected content, desktop/mobile alignment and 44px controls; no inference.");
} catch (error) { console.error(logs.slice(-4000)); throw error; }
finally { await browser?.close(); server.kill(); if (server.exitCode === null) await once(server, "close"); assert.equal(await fs.realpath(path.dirname(home)), await fs.realpath(os.tmpdir())); await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
