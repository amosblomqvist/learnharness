/** Offline synthetic UI + actual Electron preload smoke. No providers/accounts.
 * Run: node scripts/smoke-file-paths.mjs
 * App/profile/auth/OS-backed fixture files are temporary; only this script's
 * processes are stopped. Browser requests outside the owned origin are blocked.
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
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-file-paths-"));
const require = createRequire(import.meta.url);
const checks = [];
const errors = [];
const visualFailures = [];
const coverageFailures = [];
const posts = [];
const blocked = [];
const networkFailures = [];
const consoleErrors = [];
const children = [];
const browsers = [];
const screenshots = [];
let serverLogs = "";
let electronLogs = "";
let page;
let origin;
let shuttingDown = false;
const fixtureCatalog = (() => {
	const model = { id: "synthetic", name: "Synthetic (no calls)", provider: "fixture", input: ["text"], reasoning: false, supportedLevels: ["off"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
	const slot = { model: { provider: model.provider, id: model.id }, thinkingLevel: "off" };
	return { models: [model], providers: [{ id: "fixture", label: "Fixture", keyPresent: true }], defaults: null, slots: { strong: slot, cheap: slot, vision: slot }, rolePins: {} };
})();
async function freePort() {
	const listener = net.createServer();
	listener.listen(0, "127.0.0.1");
	await once(listener, "listening");
	const port = listener.address().port;
	await new Promise(resolve => listener.close(resolve));
	return port;
}
async function stop(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGTERM");
	const timer = setTimeout(() => child.kill("SIGKILL"), 5000); timer.unref();
	await exited; clearTimeout(timer);
}
async function startup(child, getLogs, marker, timeout = 90000) {
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error(`Startup timed out: ${getLogs()}`)), timeout);
		const inspect = () => { if (marker.test(getLogs())) finish(); };
		const exited = code => finish(new Error(`Process exited ${code}: ${getLogs()}`));
		function finish(error) {
			clearTimeout(timer); child.stdout.off("data", inspect); child.stderr.off("data", inspect); child.off("exit", exited);
			if (error) reject(error); else resolve();
		}
		child.stdout.on("data", inspect); child.stderr.on("data", inspect); child.once("exit", exited); inspect();
	});
}
async function instrument(target) {
	target.setDefaultTimeout(20000);
	target.on("pageerror", error => { if (!shuttingDown) errors.push(error.message); });
	target.on("requestfailed", request => { if (!shuttingDown) networkFailures.push({ url: request.url(), error: request.failure()?.errorText }); });
	target.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
	await target.setRequestInterception(true);
	target.on("request", async request => {
		try {
			const url = new URL(request.url());
			if (url.protocol === "data:" || url.protocol === "about:") return await request.continue();
			if (url.origin !== origin) { blocked.push(request.url()); return await request.abort(); }
			const respond = body => request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
			if (url.pathname === "/api/models") return await respond(fixtureCatalog);
			if (url.pathname === "/api/events") return await request.respond({ status: 204 });
			// Never forward agent, answer or import requests, even if a UI bug
			// submits while dropping. Record their complete synthetic bodies.
			if (request.method() === "POST" && (/^\/api\/(chat|answer)(\/|$)/.test(url.pathname) || /\/(answer|import|turn|retry)(\/|$)/.test(url.pathname))) {
				posts.push({ pathname: url.pathname, body: JSON.parse(request.postData() || "{}") });
				return await request.respond({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "models_not_configured", missing: ["strong"] }) });
			}
			if (/^\/api\/chats\/[^/]+\/stream$/.test(url.pathname)) return await request.respond({ status: 204 });
			return await request.continue();
		} catch (error) {
			if (!shuttingDown && !/Target closed|Session closed|Invalid InterceptionId|already handled/.test(String(error))) errors.push(String(error));
		}
	});
}
const inputSelector = '[data-file-path-input]';
async function open(target, route) {
	await target.goto(origin + route, { waitUntil: "domcontentloaded", timeout: 120000 });
	await target.waitForSelector(inputSelector);
	await target.waitForFunction(() => !document.querySelector('[data-testid="setup-cta"], [data-testid="setup-cta-keys"]'));
	await target.waitForFunction(() => document.querySelector('[data-testid="file-path-drop-zone"]'));
}
async function read(target, selector = inputSelector) {
	return target.$eval(selector, element => [...element.childNodes].map(node => node.nodeType === 1 ? node.getAttribute("data-file-path-source") ?? node.textContent : node.textContent).join(""));
}
async function expectValue(target, expected, selector = inputSelector) {
	await target.waitForFunction((selector, expected) => {
		const element = document.querySelector(selector);
		return element && [...element.childNodes].map(node => node.nodeType === 1 ? node.getAttribute("data-file-path-source") ?? node.textContent : node.textContent).join("") === expected;
	}, {}, selector, expected);
}
async function fill(target, value, selector = inputSelector) {
	await target.$eval(selector, (element, value) => {
		element.focus(); element.textContent = value;
		const selection = document.getSelection(); selection.collapse(element, element.childNodes.length);
		element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
	}, value);
	await expectValue(target, value, selector);
}
async function caret(target, offset, selector = inputSelector) {
	await target.$eval(selector, (element, offset) => {
		element.focus(); let rest = offset;
		for (const node of element.childNodes) {
			const source = node.nodeType === 1 ? node.getAttribute("data-file-path-source") : null;
			const length = source?.length ?? node.textContent.length;
			if (rest <= length) {
				if (source !== null) {
					const index = [...element.childNodes].indexOf(node);
					document.getSelection().collapse(element, index + (rest > 0 ? 1 : 0));
				} else document.getSelection().collapse(node, rest);
				document.dispatchEvent(new Event("selectionchange")); return;
			}
			rest -= length;
		}
		document.getSelection().collapse(element, element.childNodes.length);
		document.dispatchEvent(new Event("selectionchange"));
	}, offset);
}
async function shortcut(target, key, shift = false) {
	await target.keyboard.down("Meta"); if (shift) await target.keyboard.down("Shift");
	await target.keyboard.press(key);
	if (shift) await target.keyboard.up("Shift"); await target.keyboard.up("Meta");
}
async function clipboardCommand(target, command, key, modifiers = 4) {
	// Headless Chromium does not run the macOS menu accelerator for Meta+C/V.
	// CDP's native edit command triggers the real browser clipboard event.
	const session = await target.createCDPSession();
	try { await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: key ?? (command === "copy" ? "c" : "v"), modifiers, commands: [command] }); }
	finally { await session.detach(); }
}
async function syntheticDrop(target, paths, selector = '[data-testid="file-path-drop-zone"]') {
	return target.$eval(selector, (zone, paths) => {
		const transfer = new DataTransfer();
		window.__syntheticPaths = new WeakMap();
		window.lh = { platform: "darwin", getPathForFile(file) { return window.__syntheticPaths.get(file) ?? ""; } };
		for (const [index, path] of paths.entries()) {
			const file = new File(["never read"], `synthetic-display-${index}.pdf`, { type: "application/pdf" });
			window.__syntheticPaths.set(file, path);
			for (const method of ["text", "arrayBuffer", "stream"]) Object.defineProperty(file, method, { value() { throw new Error("File bytes must not be read"); } });
			transfer.items.add(file);
		}
		const event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
		zone.dispatchEvent(event); return event.defaultPrevented;
	}, paths);
}
async function blur(target) { await target.evaluate(() => { document.activeElement?.blur(); }); }
function seedChatFixtures() {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const transcript = Array.from({ length: 100 }, (_, index) => `Synthetic lesson paragraph ${index}: one and one make two. These are offline fixture notes.`).join("\n\n");
	const assistant = (id, content) => ({ id, role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "synthetic", timestamp: 1, stopReason: "toolUse", usage, content });
	const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
	const result = (id, toolCallId, toolName, details) => ({ id, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "Synthetic tool completed." }], ...(details ? { details } : {}), isError: false, timestamp: 2 });
	const quiz = { type: "check", nodeId: "addition", question: "What is 1 + 1?", options: [{ value: "two", label: "2" }, { value: "three", label: "3" }], explanation: "Adding one to one gives two.", correctAnswer: "two" };
	const records = [
		{ id: "path_teach", messages: [assistant("m_probe", [{ type: "text", text: transcript }, call("call_probe", "probe_done", { assessment: { strands: [{ strand: "Addition", assessment: "Ready for a check." }] } })]), result("m_probe_result", "call_probe", "probe_done", { ok: true }), assistant("m_quiz", [call("call_quiz", "quiz", quiz)])] },
		{ id: "path_probe", messages: [assistant("m_probe_question", [{ type: "text", text: transcript }, call("call_probe_question", "probe", quiz)])] },
		{ id: "path_practice", kind: "practice", messages: [assistant("m_problem", [{ type: "text", text: transcript }, call("call_problem", "problem", { statement: "Compute 1 + 1. Explain your reasoning.", mode: "recall", modelSolution: "1 + 1 = 2." })]), result("m_problem_result", "call_problem", "problem")] },
	];
	for (const record of records) {
		record.messages.unshift({ id: "sent_user", role: "user", content: "Attached `/synthetic/transcript notes.pdf`", timestamp: 0 });
		fs.writeFileSync(path.join(home, "data", "chats", `${record.id}.json`), JSON.stringify({ version: 1, title: `Synthetic ${record.id}`, createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T00:00:00.000Z", ...record }));
	}
}
async function foldDock(target, barSelector) {
	// Let growth/geometry muting settle, then use a real wheel gesture so
	// stick-to-bottom records user intent instead of a programmatic clamp.
	// The explicit reveal owns a bounded 2s fold-suppression window.
	await target.evaluate(() => new Promise(resolve => setTimeout(resolve, 2250)));
	const log = await target.$('[role="log"]'); const box = await log.boundingBox();
	await target.mouse.move(box.x + box.width / 2, box.y + 100);
	// Multiple real wheel frames let stick-to-bottom publish isAtBottom
	// before DockOverlay evaluates the next away-from-bottom scroll event.
	for (const deltaY of [-420, -420, -840]) {
		await target.mouse.wheel({ deltaY });
		await target.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
	}
	try { await target.waitForSelector(barSelector, { visible: true, timeout: 5000 }); return true; }
	catch {
		coverageFailures.push({ url: target.url(), case: barSelector, message: "Native wheel did not expose collapsed bar", scrollers: await target.evaluate(() => [...document.querySelectorAll('[role="log"], [role="log"] *')].filter(element => element.scrollHeight > element.clientHeight + 100 && getComputedStyle(element).overflowY !== "visible").map(element => ({ tag: element.tagName, className: element.className, scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }))) });
		return false;
	}
}

try {
	fs.mkdirSync(path.join(home, "data", "chats"), { recursive: true });
	fs.writeFileSync(path.join(home, "auth.json"), "{}\n");
	seedChatFixtures();
	const { getFontAxes } = require("next/dist/compiled/@next/font/dist/google/get-font-axes.js");
	const { getGoogleFontsUrl } = require("next/dist/compiled/@next/font/dist/google/get-google-fonts-url.js");
	const fonts = Object.fromEntries(["JetBrains Mono", "Source Sans 3"].map(family => [getGoogleFontsUrl(family, getFontAxes(family, ["variable"], ["normal"]), "swap"), `@font-face { font-family: '${family}'; src: local('Arial'); font-weight: 100 900; }`]));
	fs.writeFileSync(path.join(home, "fonts.cjs"), `module.exports = ${JSON.stringify(fonts)};\n`);
	const port = await freePort(); origin = `http://127.0.0.1:${port}`;
	const env = { PATH: process.env.PATH, HOME: home, TMPDIR: home, NODE_ENV: "development", LH_DATA_DIR: path.join(home, "data"), LH_AUTH_FILE: path.join(home, "auth.json"), LH_IGNORE_ENV_KEYS: "1", NEXT_TELEMETRY_DISABLED: "1", NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(home, "fonts.cjs") };
	const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] }); children.push(server);
	const captureServer = data => { serverLogs = (serverLogs + data).slice(-28000); };
	server.stdout.on("data", captureServer); server.stderr.on("data", captureServer);
	await startup(server, () => serverLogs, /Ready in/);
	if (!process.argv.includes("--desktop-only")) {
	const chrome = await puppeteer.launch({ executablePath: process.env.LH_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, userDataDir: path.join(home, "chrome-profile"), env, args: ["--disable-background-networking", "--disable-sync", "--no-first-run", "--disable-default-apps"] }); browsers.push(chrome);
	page = await chrome.newPage(); await page.setViewport({ width: 1280, height: 900 }); await instrument(page);
	await chrome.defaultBrowserContext().overridePermissions(origin, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
	const token = "`/synthetic/course notes.pdf`";
	for (const route of ["/", "/chat/new"]) {
		await open(page, route);
		// Sidebar drops prevent browser navigation but must not stage paths or
		// activate the right-content attachment indicator.
		assert.equal(await page.$eval("aside", sidebar => {
			const transfer = new DataTransfer(); transfer.items.add(new File(["not uploaded"], "sidebar.pdf"));
			const event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }); sidebar.dispatchEvent(event); return event.defaultPrevented;
		}), true);
		assert.equal(await page.$('[data-testid="file-path-drop-indicator"]'), null);
		await expectValue(page, "");
		// Browser mode has no bridge: prevent file navigation with a clear notice.
		const prevented = await page.$eval('[data-testid="file-path-drop-zone"]', zone => {
			const transfer = new DataTransfer(); transfer.items.add(new File(["not uploaded"], "notes.pdf"));
			const event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }); zone.dispatchEvent(event); return event.defaultPrevented;
		});
		assert.equal(prevented, true);
		await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes("desktop app"));
		await fill(page, "read "); await page.keyboard.type(token + " now");
		await expectValue(page, `read ${token} now`);
		assert.equal(await page.$$eval('[data-file-path-input] [role="img"]', elements => elements.length), 1);
		// Native browser arrows cross the atomic host without entering its label.
		await caret(page, 5); await page.keyboard.press("ArrowRight");
		assert.equal(await page.evaluate(() => !!document.getSelection().anchorNode?.parentElement?.closest('[role="img"]')), false);
		await page.keyboard.press("Backspace"); await expectValue(page, "read  now");
		await shortcut(page, "KeyZ"); await expectValue(page, `read ${token} now`);
		await shortcut(page, "KeyZ", true); await expectValue(page, "read  now");
		await shortcut(page, "KeyZ"); await caret(page, 5); await page.keyboard.press("Delete"); await expectValue(page, "read  now");
		await shortcut(page, "KeyZ"); await expectValue(page, `read ${token} now`);
		// Select the actual rendered label; copy must emit the full source token.
		await page.$eval('[data-file-path-input] [role="img"] span', label => {
			const range = document.createRange(); range.selectNodeContents(label); const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event("selectionchange"));
		});
		await clipboardCommand(page, "copy");
		assert.equal(await page.evaluate(() => navigator.clipboard.readText()), token);
		await clipboardCommand(page, "cut", "Delete", 8);
		await expectValue(page, "read  now");
		assert.equal(await page.evaluate(() => navigator.clipboard.readText()), token, "Shift+Delete is native cut, not editor-only deletion");
		await shortcut(page, "KeyZ"); await expectValue(page, `read ${token} now`);
		// Clipboard image-only input must not erase the current selected path.
		await page.$eval('[data-file-path-input]', editor => {
			const host = editor.querySelector('[data-file-path-source]'); const range = document.createRange(); range.selectNode(host); const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event("selectionchange"));
			const data = new DataTransfer(); data.items.add(new File(["image fixture"], "image.png", { type: "image/png" }));
			editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
		});
		await expectValue(page, `read ${token} now`);
		// Pasting HTML-bearing clipboard content is plain text, at the range.
		await page.evaluate(() => navigator.clipboard.writeText('<img src=x onerror="alert(1)">\n中'));
		await clipboardCommand(page, "paste");
		await expectValue(page, 'read <img src=x onerror="alert(1)">\n中 now');
		assert.equal(await page.$('[data-file-path-input] img'), null);
		await fill(page, "readthis"); await caret(page, 4);
		assert.equal(await syntheticDrop(page, ["/synthetic/one.pdf", "~/two`final.pdf"]), true);
		await expectValue(page, "read `/synthetic/one.pdf` ``~/two`final.pdf`` this");
		assert.equal(posts.length, 0, "typing/paste/drop must never submit");
		await fill(page, "one visible line"); await caret(page, "one visible line".length);
		const beforeNewline = await page.$eval(inputSelector, element => element.getBoundingClientRect().height);
		await page.keyboard.down("Shift"); await page.keyboard.press("Enter"); await page.keyboard.up("Shift");
		await expectValue(page, "one visible line\n");
		const afterNewline = await page.$eval(inputSelector, element => {
			const range = document.getSelection().getRangeAt(0); const rect = range.getBoundingClientRect();
			return { height: element.getBoundingClientRect().height, caret: { top: rect.top, height: rect.height }, html: element.innerHTML };
		});
		// Record this independently so a visual editor regression does not hide
		// the higher-priority actual Electron/target-routing evidence below.
		try { assert.ok(afterNewline.height > beforeNewline, `Trailing newline must occupy a visible blank line: ${JSON.stringify({ beforeNewline, afterNewline })}`); }
		catch (error) { visualFailures.push({ route, message: error.message }); }
		await page.keyboard.type("second line");
		const afterTyping = await read(page);
		try { assert.equal(afterTyping, "one visible line\nsecond line", "Typing after Shift+Enter must stay after the newline"); }
		catch (error) { visualFailures.push({ route, message: error.message }); }
		assert.equal(posts.length, 0, "Shift+Enter is a newline, never submit");
		await fill(page, "composer fallback"); await blur(page);
		await syntheticDrop(page, ["/synthetic/default.pdf"]);
		await expectValue(page, "composer fallback `/synthetic/default.pdf`");
		// Small viewport: wrapped multiline content stays scrollable inside its editor.
		await page.setViewport({ width: 900, height: 520 });
		await fill(page, (`${token} a long synthetic line wrapping at narrow widths.\n`).repeat(24));
		const sizing = await page.$eval(inputSelector, element => ({ height: element.clientHeight, scrollHeight: element.scrollHeight, overflowY: getComputedStyle(element).overflowY, bodyWidth: document.body.scrollWidth, viewport: innerWidth }));
		assert.ok(sizing.scrollHeight > sizing.height && sizing.height > 0, JSON.stringify(sizing));
		assert.ok(["auto", "scroll"].includes(sizing.overflowY));
		assert.ok(sizing.bodyWidth <= sizing.viewport + 1, JSON.stringify(sizing));
		const screenshot = path.join(home, `chrome-${route === "/" ? "home" : "new"}.png`); await page.screenshot({ path: screenshot }); screenshots.push({ surface: route, bytes: fs.statSync(screenshot).size, sizing });
		await page.setViewport({ width: 1280, height: 900 });
		checks.push(`${route}: native typing/chips/arrows/deletion/undo-redo/full-source clipboard/plaintext paste/caret drop/newlines/wrap-scroll`);
	}
	// Only an explicit Enter may initiate a send; agent endpoint is refused.
	await fill(page, "explicit synthetic send `/synthetic/one.pdf`");
	await page.keyboard.press("Enter");
	await page.waitForFunction(() => /^\/chat\/chat_/.test(location.pathname));
	await new Promise((resolve, reject) => {
		const deadline = Date.now() + 15000;
		const inspect = () => { if (posts.length) resolve(); else if (Date.now() > deadline) reject(new Error("Explicit Enter did not send")); else setTimeout(inspect, 50); }; inspect();
	});
	assert.equal(posts.length, 1); assert.equal(posts[0].body.input.text, "explicit synthetic send `/synthetic/one.pdf`");
	checks.push("Explicit Enter submitted exactly one full-source prompt; endpoint intercepted/refused");

	// These raw JSON fixtures are synthetic native records, never store imports.
	const reading = '[data-testid="reading-thinking-field"] [data-file-path-input]';
	const question = '[data-testid="thinking-field"] [data-file-path-input]';
	const practice = '[data-testid="practice-thinking-field"] [data-file-path-input]';
	await open(page, "/chat/path_teach");
	await page.waitForSelector('[data-testid="teach-check-reveal"]', { visible: true });
	assert.equal(await page.$eval('[data-testid="user-message"] [role="img"]', chip => chip.title), "/synthetic/transcript notes.pdf");
	assert.equal(await page.$eval('[data-testid="user-message"] [role="img"]', chip => chip.textContent), "transcript notes.pdf");
	checks.push("Seeded sent learner message renders a filename chip with full-path title; raw record retains quoted full path");
	await blur(page); await syntheticDrop(page, ["/synthetic/reading.pdf"]);
	await expectValue(page, "`/synthetic/reading.pdf`", reading);
	assert.equal(await read(page, question), "");
	checks.push("Unrevealed teaching check: unfocused drop lands in reading-thinking via dictation registry");
	await page.locator('[data-testid="teach-check-reveal"]').click();
	await page.waitForSelector(question, { visible: true });
	await fill(page, "AB", reading); await caret(page, 1, reading);
	await syntheticDrop(page, ["/synthetic/focused-reading.pdf"]);
	await expectValue(page, "A `/synthetic/focused-reading.pdf` B", reading);
	assert.equal(await read(page, question), "", "focused reading field overrides opened question default");
	await blur(page); await syntheticDrop(page, ["/synthetic/question.pdf"]);
	await expectValue(page, "`/synthetic/question.pdf`", question);
	checks.push("Opened teaching check: current reading focus wins; otherwise default routes to question-thinking");
	if (await foldDock(page, '[data-testid="question-dock-bar"]')) {
		await blur(page); await syntheticDrop(page, ["/synthetic/collapsed-question.pdf"]);
		await expectValue(page, "`/synthetic/question.pdf` `/synthetic/collapsed-question.pdf`", question);
		await page.locator('[data-testid="question-dock-bar"]').click();
		await page.waitForSelector(question, { visible: true });
		assert.equal(await read(page, question), "`/synthetic/question.pdf` `/synthetic/collapsed-question.pdf`");
		checks.push("Collapsed revealed teaching dock keeps question-thinking claim/state through expansion");
	}
	await open(page, "/chat/path_probe"); await page.waitForSelector(question, { visible: true });
	await blur(page); await syntheticDrop(page, ["/synthetic/probe.pdf"]);
	await expectValue(page, "`/synthetic/probe.pdf`", question);
	checks.push("Probe-phase pending question default routes to question-thinking");
	await open(page, "/chat/path_practice"); await page.waitForSelector(practice, { visible: true });
	await blur(page); await syntheticDrop(page, ["/synthetic/practice.pdf"]);
	await expectValue(page, "`/synthetic/practice.pdf`", practice);
	checks.push("Expanded practice thinking is the unfocused drop default");
	if (await foldDock(page, '[data-testid="practice-dock-bar"]')) {
		await blur(page); await syntheticDrop(page, ["/synthetic/collapsed-practice.pdf"]);
		// Practice keeps the owning hook/state mounted, but hides its field
		// by returning the bar. Inspect the controlled text after expansion.
		assert.equal(await page.$('[role="status"]'), null, "successful attachment has no confirmation bubble");
		await page.locator('[data-testid="practice-dock-bar"]').click();
		await page.waitForSelector(practice, { visible: true });
		await expectValue(page, "`/synthetic/practice.pdf` `/synthetic/collapsed-practice.pdf`", practice);
		checks.push("Collapsed practice thinking keeps its claim/state through expansion without submission");
	}
	assert.equal(posts.length, 1, "all claim/drop cases stage text only");

	}
	// Actual Electron main + actual sandboxed preload. Temporary launcher sets
	// userData BEFORE production main appends its -dev suffix or takes a lock.
	const debugPort = await freePort();
	const launcher = path.join(home, "electron-launcher.cjs");
	fs.mkdirSync(path.join(home, "desktop-profile"), { recursive: true });
	fs.mkdirSync(path.join(home, "desktop-profile-dev"), { recursive: true });
	fs.writeFileSync(launcher, `const {app,session}=require('electron');\napp.setPath('home',${JSON.stringify(home)});\napp.setPath('userData',${JSON.stringify(path.join(home, "desktop-profile"))});\napp.commandLine.appendSwitch('remote-debugging-port',${JSON.stringify(String(debugPort))});\napp.commandLine.appendSwitch('disable-background-networking');\napp.commandLine.appendSwitch('disable-sync');\napp.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest((details,cb)=>{let u;try{u=new URL(details.url)}catch{return cb({cancel:true})}cb({cancel:!(${JSON.stringify(origin)}===u.origin||(u.protocol==='ws:'&&u.host===${JSON.stringify(new URL(origin).host)})||['about:','data:','devtools:'].includes(u.protocol))});}));\nrequire(${JSON.stringify(path.join(root, "electron", "main.cjs"))});\nconsole.log('LH_FILE_PATH_PROFILE '+JSON.stringify({home:app.getPath('home'),userData:app.getPath('userData')}));\n`);
	const electron = spawn(require("electron"), [launcher], { cwd: root, env: { ...env, LH_DEV_URL: origin }, stdio: ["ignore", "pipe", "pipe"] }); children.push(electron);
	const captureElectron = data => { electronLogs = (electronLogs + data).slice(-24000); }; electron.stdout.on("data", captureElectron); electron.stderr.on("data", captureElectron);
	await startup(electron, () => electronLogs, /DevTools listening on (ws:\/\/[^\s]+)/, 45000);
	const profile = JSON.parse(electronLogs.match(/LH_FILE_PATH_PROFILE ([^\r\n]+)/)[1]);
	assert.equal(profile.home, home); assert.equal(profile.userData, path.join(home, "desktop-profile-dev"));
	const desktopLaunch = { executable: require("electron"), args: [launcher], LH_DEV_URL: origin, HOME: home, userDataBeforeMain: path.join(home, "desktop-profile"), actualProfile: profile, cleanup: "all temporary profiles/data/fixtures removed on exit" };
	const endpoint = electronLogs.match(/DevTools listening on (ws:\/\/[^\s]+)/)[1];
	const desktop = await puppeteer.connect({ browserWSEndpoint: endpoint }); browsers.push(desktop);
	const desktopPage = await desktop.waitForTarget(target => target.type() === "page").then(target => target.page());
	await instrument(desktopPage); page = desktopPage;
	await open(desktopPage, "/chat/new");
	assert.equal(await desktopPage.evaluate(() => typeof window.lh?.getPathForFile), "function");
	const fixturePath = path.join(home, "actual OS-backed α `notes`.pdf"); fs.writeFileSync(fixturePath, "%PDF-1.7\nsynthetic offline fixture\n");
	await desktopPage.evaluate(() => { const input = document.createElement("input"); input.type = "file"; input.id = "os-backed-fixture"; document.body.append(input); });
	await (await desktopPage.$("#os-backed-fixture")).uploadFile(fixturePath);
	const resolved = await desktopPage.evaluate(() => {
		const input = document.querySelector("#os-backed-fixture");
		return { count: input.files.length, actual: window.lh.getPathForFile(input.files[0]), virtual: window.lh.getPathForFile(new File(["virtual"], "/not/a/backing/path.pdf")) };
	});
	assert.equal(resolved.count, 1); assert.equal(resolved.actual, fixturePath); assert.equal(resolved.virtual, "");
	await fill(desktopPage, "readthis"); await caret(desktopPage, 4);
	const beforeDesktopDrop = posts.length;
	assert.equal(await desktopPage.evaluate(() => {
		const file = document.querySelector("#os-backed-fixture").files[0];
		for (const method of ["text", "arrayBuffer", "stream"]) Object.defineProperty(file, method, { value() { throw new Error("No file content read"); } });
		const transfer = new DataTransfer(); transfer.items.add(file);
		const event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
		document.querySelector('[data-testid="file-path-drop-zone"]').dispatchEvent(event); return event.defaultPrevented;
	}), true);
	const expectedQuoted = "``" + fixturePath + "``";
	await expectValue(desktopPage, `read ${expectedQuoted} this`);
	assert.equal(await desktopPage.$eval('[data-file-path-input] [role="img"]', chip => chip.title), fixturePath);
	assert.equal(posts.length, beforeDesktopDrop, "actual OS-backed desktop drop must stage only");
	assert.equal(await desktopPage.$('[role="status"]'), null, "successful desktop attachment has no confirmation bubble");
	assert.ok(fs.existsSync(fixturePath));
	assert.deepEqual(fs.readdirSync(path.join(home, "data")).filter(name => /upload|attachment/i.test(name)), []);
	checks.push("Actual Electron production preload: Puppeteer-selected OS-backed File resolves exact Unicode/backtick full path; virtual File returns empty; real DataTransfer drop inserts at caret without submit or file reads");
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ checks, visualFailures, coverageFailures, screenshots, desktopLaunch, postsIntercepted: posts.length, blockedExternalRequests: blocked, isolation: "temporary HOME/data/auth/browser+Electron profiles; synthetic catalog; agent POSTs refused; no providers", origin }, null, 2));
	assert.deepEqual(visualFailures, [], "Visible trailing-newline/caret projection must pass");
	assert.deepEqual(coverageFailures, [], "Required collapsed target coverage must run");
} catch (error) {
	console.error(error);
	console.error(JSON.stringify({ checks, visualFailures, coverageFailures, errors, consoleErrors, networkFailures: networkFailures.slice(-30), posts, origin, url: page?.url(), dom: await page?.evaluate(() => ({ inputs: [...document.querySelectorAll('[data-file-path-input]')].map(element => ({ placeholder: element.getAttribute("data-placeholder"), text: element.textContent, html: element.innerHTML.slice(0, 1200) })), text: document.body.innerText.slice(-2600) })).catch(() => null), serverLogs, electronLogs }, null, 2));
	process.exitCode = 1;
} finally {
	shuttingDown = true;
	for (const browser of browsers.reverse()) { try { await browser.close(); } catch {} }
	for (const child of children.reverse()) await stop(child);
	fs.rmSync(home, { recursive: true, force: true });
}
