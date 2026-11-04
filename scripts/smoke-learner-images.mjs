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
import { createCanvas, loadImage } from "@napi-rs/canvas";
import puppeteer from "puppeteer-core";
import { boundedSmokeOperation, stopOwnedSmokeServer } from "./lib/owned-smoke-lifetime.mjs";

// This developer smoke needs detached POSIX groups to own descendant cleanup.
if (process.platform === "win32") throw new Error("Learner-image UI smoke requires POSIX owned process groups");
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
const ordinary = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="1600"><rect width="400" height="1600" fill="blue"/></svg>';
for (const [id, result] of [["annotated", { svg: annotation, image: { path: source, snapshotId } }], ["ordinary", { svg: ordinary }]]) {
	messages.push({ id: `steer_${id}`, role: "custom", customType: "subagent-steer", content: "Figure delivered.", display: true, details: { jobId: `job_${id}`, kind: "visual", toolCallId: id, result }, timestamp: 4 });
}
const imageSnapshots = { [snapshotId]: image };
for (const [name, width, height] of [["portrait", 600, 1600], ["landscape", 1600, 400]]) {
	const picture = createCanvas(width, height);
	picture.getContext("2d").fillStyle = "#ffcc00";
	picture.getContext("2d").fillRect(0, 0, width, height);
	picture.getContext("2d").fillStyle = "#00cc00";
	picture.getContext("2d").fillRect(0, 0, width / 5, height / 5);
	picture.getContext("2d").fillStyle = "blue";
	picture.getContext("2d").fillRect(width * 0.8, height * 0.8, width / 5, height / 5);
	const data = picture.toBuffer("image/png").toString("base64");
	const id = createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
	imageSnapshots[id] = { mimeType: "image/png", data, width, height };
	messages.push(assistant(`a_${name}`, [{ type: "toolCall", id: name, name: "show_image", arguments: { path: source, caption: name } }]));
	messages.push({ id: `r_${name}`, role: "toolResult", toolCallId: name, toolName: "show_image", content: [{ type: "text", text: "Shown." }], details: { ...details(name), snapshotId: id, width, height }, isError: false, timestamp: 3 });
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image href="learner-image" width="${width}" height="${height}"/><circle cx="${width / 2}" cy="${height / 2}" r="40" stroke="red" stroke-width="16" fill="none"/></svg>`;
	messages.push({ id: `steer_${name}`, role: "custom", customType: "subagent-steer", content: "Figure delivered.", display: true, details: { jobId: `job_${name}`, kind: "visual", toolCallId: name, result: { svg, image: { path: source, snapshotId: id } } }, timestamp: 4 });
}
messages.push(assistant("finished", [{ type: "text", text: "The annotated image and ordinary figure are already displayed." }]));
const chatId = "chat_synthetic_images";
fs.writeFileSync(path.join(data, "chats", `${chatId}.json`), JSON.stringify({ id: chatId, title: "Synthetic learner images", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages, imageSnapshots }));
const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: home, LH_DATA_DIR: data, LH_AUTH_FILE: path.join(home, "auth.json"), NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(home, "fonts.cjs") };
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
	browser = await puppeteer.launch({ executablePath: process.env.LH_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, protocolTimeout: 30000, userDataDir: path.join(home, "browser"), env, args: ["--disable-background-networking", "--disable-sync", "--no-first-run", "--disable-default-apps"] });
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
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="image-card"]').length === 4 && document.querySelectorAll('[data-testid="visual-card"]').length === 4);
	await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="image-card"] img, [data-testid="visual-card"] img')].every(image => image.complete && image.naturalWidth > 0));
	for (const viewport of [{ width: 1100, height: 900 }, { width: 1000, height: 600 }, { width: 480, height: 700 }]) {
		await page.setViewport(viewport);
		const sizes = await page.evaluate(() => [...document.querySelectorAll('[data-testid="image-card"], [data-testid="visual-card"]')].map(card => {
			const image = card.querySelector('img');
			const rect = image.getBoundingClientRect();
			const caption = card.querySelector('figcaption') || card.lastElementChild;
			return { name: card.getAttribute('data-testid'), naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, width: rect.width, height: rect.height, cardWidth: card.getBoundingClientRect().width, captionWidth: caption.getBoundingClientRect().width, controlsRight: caption.lastElementChild.getBoundingClientRect().right, imageRight: rect.right, maxHeight: getComputedStyle(image).maxHeight };
		}));
		console.log('inline sizing', JSON.stringify({ viewport, sizes }));
		for (const size of sizes) {
			const ordinary = size.name === 'visual-card' && size.naturalWidth === 400 && size.naturalHeight === 1600;
			if (ordinary) {
				assert.equal(size.maxHeight, 'none');
				assert.ok(size.height > viewport.height * 0.6, 'ordinary tall SVG remains uncapped');
				continue;
			}
			assert.ok(size.height <= viewport.height * 0.6 + 1, `inline cap: ${JSON.stringify({ viewport, size })}`);
			assert.ok(size.width <= size.naturalWidth + 1 && size.height <= size.naturalHeight + 1, 'never enlarge');
			assert.ok(Math.abs(size.width / size.height - size.naturalWidth / size.naturalHeight) < 0.01, 'preserve aspect ratio');
			assert.ok(Math.abs(size.cardWidth - size.width) < 1, `card follows image: ${JSON.stringify(size)}`);
			assert.ok(Math.abs(size.captionWidth - size.width) < 1, 'caption follows displayed image');
			assert.ok(Math.abs(size.controlsRight - size.imageRight) < 1, 'controls follow displayed image edge');
			if (size.naturalWidth === 80) assert.deepEqual([size.width, size.height], [80, 60], 'small pictures retain natural size');
		}
	}
	await page.setViewport({ width: 1100, height: 1100 });
	// Paint the browser-decoded image at its observed CSS display size. This
	// isolates source/annotation pixels from the transcript's moving scroll dock.
	// Both corners must survive, and marks must keep their source coordinates.
	for (const [selector, width] of [['[data-testid="image-card"] img', 600], ['[data-testid="visual-card"] img', 600], ['[data-testid="visual-card"] img', 1600]]) {
		const images = await page.$$(selector);
		const target = (await Promise.all(images.map(async image => ({ image, width: await image.evaluate(node => node.naturalWidth) })))).find(item => item.width === width).image;
		const rendered = await target.evaluate(node => {
			const rect = node.getBoundingClientRect();
			const canvas = document.createElement('canvas');
			canvas.width = Math.ceil(rect.width); canvas.height = Math.ceil(rect.height);
			canvas.getContext('2d').drawImage(node, 0, 0, canvas.width, canvas.height);
			return canvas.toDataURL('image/png').split(',')[1];
		});
		const pixels = await loadImage(Buffer.from(rendered, 'base64'));
		const sample = createCanvas(pixels.width, pixels.height);
		const context = sample.getContext('2d'); context.drawImage(pixels, 0, 0);
		const color = (x, y) => [...context.getImageData(Math.floor(x * pixels.width), Math.floor(y * pixels.height), 1, 1).data];
		assert.ok(color(0.1, 0.1)[1] > 150 && color(0.1, 0.1)[0] < 50, `uncropped green source corner: ${selector}/${width} ${color(0.1, 0.1)}`);
		assert.ok(color(0.9, 0.9)[2] > 200 && color(0.9, 0.9)[0] < 50, `uncropped blue source corner: ${selector}/${width} ${color(0.9, 0.9)}`);
		if (selector.includes('visual-card')) {
			const [r, g, b] = color(0.5 + 40 / width, 0.5);
			assert.ok(r > 200 && g < 90 && b < 90, 'red annotation remains aligned');
		}
	}
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
	await page.$$eval('[data-testid="image-download"]', buttons => buttons[2].click());
	const portraitBytes = Object.values(imageSnapshots).find(image => image.width === 600).data;
	assert.equal(await page.evaluate(async () => btoa(String.fromCharCode(...new Uint8Array(await window.savedBlobs[2].arrayBuffer())))), portraitBytes, 'portrait download keeps original snapshot bytes');
	await page.$$eval('[data-testid="visual-download"]', buttons => buttons[2].click());
	const portraitSvg = await page.evaluate(() => window.savedBlobs[3].text());
	assert.ok(portraitSvg.includes('width="600" height="1600" viewBox="0 0 600 1600"'));
	assert.ok(portraitSvg.includes('cx="300" cy="800"') && portraitSvg.includes(portraitBytes), 'annotation download keeps source coordinates and bytes');
	await page.$$eval('[data-testid="visual-download"]', buttons => buttons[1].click());
	assert.equal(await page.evaluate(() => window.savedBlobs[4].text()), ordinary, 'ordinary SVG download unchanged');
	for (const selector of ['[data-testid="image-open"]', '[data-testid="visual-open"]']) {
		await page.$$eval(selector, buttons => buttons[2].click());
		await page.waitForFunction(() => {
			const image = document.querySelector('[data-testid="mermaid-overlay"] img');
			return image?.naturalWidth === 600 && image.naturalHeight === 1600;
		});
		assert.equal(await page.$eval('[data-testid="mermaid-overlay"] img', image => getComputedStyle(image).maxHeight), 'none', 'fullscreen has no inline cap');
		await page.$eval('[data-testid="mermaid-overlay"] [aria-label="Zoom in"]', button => button.click());
		await page.waitForFunction(() => document.querySelector('[data-testid="mermaid-overlay"] img').getBoundingClientRect().height > innerHeight * 0.6);
		await page.locator('[data-testid="mermaid-overlay-close"]').click();
	}
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'chats', `${chatId}.json`), 'utf8')).imageSnapshots, imageSnapshots, 'display sizing never rewrites snapshots');
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="image-card"]').length === 4 && document.querySelectorAll('[data-testid="visual-card"]').length === 4);
	assert.deepEqual(errors, []);
	console.log("PASS: learner images and annotations obey 60vh across portrait/landscape/small/viewport resize, preserve aspect/corners/mark alignment and caption sizing; ordinary SVG, fullscreen, downloads, snapshots and reload unchanged.");
} catch (error) {
	console.error(error);
	console.error(await boundedSmokeOperation(async () => page ? page.evaluate(() => ({ text: document.body.innerText.slice(-5000), images: [...document.images].map(image => ({ src: image.src.slice(0, 90), width: image.naturalWidth, complete: image.complete })) })) : null, 1000, null));
	console.error(logs.slice(-16000));
	throw error;
} finally {
	// Only retained own handles/groups. Server cleanup starts independently of
	// browser diagnostics/close, and waits for the GROUP, not the CLI's exit.
	const browserProcess = browser?.process();
	const cleanup = await Promise.allSettled([
		stopOwnedSmokeServer(server),
		(async () => {
			const closed = await boundedSmokeOperation(async () => { await browser?.close(); return true; }, 3000, false);
			if (!closed && browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
				const exited = await boundedSmokeOperation(async () => {
					const exit = once(browserProcess, "exit");
					browserProcess.kill("SIGKILL");
					await exit;
					return true;
				}, 3000, false);
				if (!exited) throw new Error("Owned smoke browser did not exit after bounded cleanup");
			}
		})(),
	]);
	server.stdout.destroy(); server.stderr.destroy();
	const failed = cleanup.find(result => result.status === "rejected");
	if (failed) { console.error(`Cleanup incomplete; preserving scratch ${home}`); throw failed.reason; }
	fs.rmSync(home, { recursive: true, force: true });
}
