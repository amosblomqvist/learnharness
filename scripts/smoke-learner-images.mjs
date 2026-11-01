/** Offline synthetic browser smoke: shared snapshots, cards, fullscreen and downloads.
 * No inference, private files or ambient credentials; fresh HOME/data/browser profile.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lh364-ui-"));
const data = path.join(home, "data");
fs.mkdirSync(path.join(data, "chats"), { recursive: true });
fs.writeFileSync(path.join(home, "auth.json"), "{}");
const require = createRequire(import.meta.url);
const { getFontAxes } = require("next/dist/compiled/@next/font/dist/google/get-font-axes.js");
const { getGoogleFontsUrl } = require("next/dist/compiled/@next/font/dist/google/get-google-fonts-url.js");
const fonts = Object.fromEntries(["JetBrains Mono", "Source Sans 3"].map(family => [getGoogleFontsUrl(family, getFontAxes(family, ["variable"], ["normal"]), "swap"), `@font-face { font-family:'${family}';src:local('Arial');font-weight:100 900; }`]));
fs.writeFileSync(path.join(home, "fonts.cjs"), `module.exports=${JSON.stringify(fonts)};`);
const canvas = createCanvas(80, 60);
canvas.getContext("2d").fillStyle = "#ffcc00";
canvas.getContext("2d").fillRect(0, 0, 80, 60);
const bytes = canvas.toBuffer("image/png");
const snapshotId = createHash("sha256").update(bytes).digest("hex");
const image = { mimeType: "image/png", data: bytes.toString("base64"), width: 80, height: 60 };
const source = path.join(home, "deleted-source.png"); // Deliberately never exists.
const details = caption => ({ path: source, snapshotId, mimeType: image.mimeType, width: 80, height: 60, caption });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (id, content) => ({ id, role: "assistant", content, api: "openai-completions", provider: "fixture", model: "synthetic", usage, stopReason: "stop", timestamp: 2 });
const messages = [{ id: "u1", role: "user", content: "Synthetic image lesson", timestamp: 1 }];
for (const [id, caption] of [["first", "First explanation"], ["second", "Later explanation"]]) {
	messages.push(assistant(`a_${id}`, [{ type: "toolCall", id, name: "show_image", arguments: { path: source, caption } }]));
	messages.push({ id: `r_${id}`, role: "toolResult", toolCallId: id, toolName: "show_image", content: [{ type: "text", text: "Shown." }], details: details(caption), isError: false, timestamp: 3 });
}
const annotation = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60" viewBox="0 0 80 60"><image href="learner-image" width="80" height="60"/><circle cx="20" cy="30" r="10" stroke="red" fill="none"/></svg>';
const ordinary = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><circle cx="20" cy="30" r="10" fill="blue"/></svg>';
for (const [id, result] of [["annotated", { svg: annotation, image: { path: source, snapshotId } }], ["ordinary", { svg: ordinary }]]) {
	messages.push({ id: `steer_${id}`, role: "custom", customType: "subagent-steer", content: "Figure delivered.", display: true, details: { jobId: `job_${id}`, kind: "visual", toolCallId: id, result }, timestamp: 4 });
}
messages.push(assistant("finished", [{ type: "text", text: "The annotated image and ordinary figure are already displayed." }]));
const chatId = "chat_synthetic_images";
fs.writeFileSync(path.join(data, "chats", `${chatId}.json`), JSON.stringify({ id: chatId, title: "Synthetic learner images", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages, imageSnapshots: { [snapshotId]: image } }));
const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: home, LH_DATA_DIR: data, LH_AUTH_FILE: path.join(home, "auth.json"), NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(home, "fonts.cjs") };
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
server.stdout.on("data", chunk => { logs += chunk; }); server.stderr.on("data", chunk => { logs += chunk; });
let browser;
let page;
const errors = [];
try {
	await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("startup timed out")), 60000);
		const ready = () => { if (logs.includes("Ready in")) { clearTimeout(timeout); server.stdout.off("data", ready); resolve(); } };
		server.stdout.on("data", ready); server.once("exit", code => { clearTimeout(timeout); reject(new Error(`server exited ${code}`)); }); ready();
	});
	browser = await puppeteer.launch({ executablePath: process.env.LH_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, userDataDir: path.join(home, "browser"), env, args: ["--disable-background-networking", "--disable-sync", "--no-first-run", "--disable-default-apps"] });
	page = await browser.newPage(); page.setDefaultTimeout(30000);
	page.on("pageerror", error => errors.push(error.message));
	await page.setRequestInterception(true);
	page.on("request", async request => {
		const url = new URL(request.url());
		if (url.origin !== origin) return request.abort();
		if (url.pathname === "/api/chat") { errors.push("Unexpected inference request"); return request.abort(); }
		if (url.pathname === "/api/events") return request.respond({ status: 204 });
		return request.continue();
	});
	await page.goto(`${origin}/chat/${chatId}`, { waitUntil: "domcontentloaded", timeout: 120000 });
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="image-card"]').length === 2 && document.querySelectorAll('[data-testid="visual-card"]').length === 2);
	await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="image-card"] img, [data-testid="visual-card"] img')].every(image => image.complete && image.naturalWidth > 0));
	assert.equal(await page.$$eval('[data-testid="visual-card"] [aria-label="Invert figure brightness"]', nodes => nodes.length), 1);
	assert.equal(await page.$$eval('[data-testid="image-card"] [aria-label="Invert figure brightness"]', nodes => nodes.length), 0);
	await page.evaluate(() => { window.savedBlobs = []; const original = URL.createObjectURL; URL.createObjectURL = blob => { window.savedBlobs.push(blob); return original(blob); }; });
	await page.$eval('[data-testid="image-download"]', button => button.click());
	assert.equal(await page.evaluate(async () => btoa(String.fromCharCode(...new Uint8Array(await window.savedBlobs[0].arrayBuffer())))), image.data);
	await page.$eval('[data-testid="visual-download"]', button => button.click());
	const downloaded = await page.evaluate(() => window.savedBlobs[1].text());
	assert.ok(downloaded.includes(`data:image/png;base64,${image.data}`)); assert.ok(!downloaded.includes('href="learner-image"'));
	await page.$eval('[data-testid="image-open"]', button => button.click());
	await page.waitForSelector('[data-testid="mermaid-overlay"] img');
	await page.waitForFunction(() => document.querySelector('[data-testid="mermaid-overlay"] img')?.naturalWidth > 0);
	await page.locator('[data-testid="mermaid-overlay-close"]').click();
	await page.$eval('[data-testid="visual-open"]', button => button.click());
	await page.waitForSelector('[data-testid="mermaid-overlay"] img');
	await page.waitForFunction(() => document.querySelector('[data-testid="mermaid-overlay"] img')?.naturalWidth > 0);
	await page.locator('[data-testid="mermaid-overlay-close"]').click();
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="image-card"]').length === 2 && document.querySelectorAll('[data-testid="visual-card"]').length === 2);
	assert.deepEqual(errors, []);
	console.log("PASS: duplicate appearances share a snapshot; deleted source is unnecessary; image/annotation/ordinary SVG render, invert controls, fullscreen, self-contained downloads and reload.");
} catch (error) {
	console.error(error);
	console.error(await page?.evaluate(() => ({ text: document.body.innerText.slice(-5000), images: [...document.images].map(image => ({ src: image.src.slice(0, 90), width: image.naturalWidth, complete: image.complete })) })).catch(() => null));
	console.error(logs.slice(-16000));
	throw error;
} finally {
	// Clean up only this invocation's exact spawned processes; never discover by name.
	let timer;
	await Promise.race([browser?.close().catch(() => {}), new Promise(resolve => { timer = setTimeout(() => { browser?.process()?.kill("SIGKILL"); resolve(); }, 3000); })]);
	clearTimeout(timer);
	try { if (process.platform !== "win32") process.kill(-server.pid, "SIGTERM"); else server.kill("SIGTERM"); } catch { /* already exited */ }
	await Promise.race([once(server, "exit").catch(() => {}), new Promise(resolve => { timer = setTimeout(() => { try { if (process.platform !== "win32") process.kill(-server.pid, "SIGKILL"); else server.kill("SIGKILL"); } catch { /* already exited */ } resolve(); }, 3000); })]);
	clearTimeout(timer);
	server.stdout.destroy(); server.stderr.destroy();
	fs.rmSync(home, { recursive: true, force: true });
}
