/**
 * END-TO-END: composer image paste (spec:
 * docs/superpowers/plans/2026-10-24-chat-image-paste-spec-and-plan.md).
 *
 * Real Next server + real Chrome, no provider spend: the browser-side
 * clipboard work (paste → draft → preview → lightbox → remove), the send
 * path's optimistic transcript (the no-key 503 refusal restores the draft),
 * and the server's trust boundary over real HTTP.
 *
 *   npm run test:e2e
 *
 * Requirements: a built app (`npm run build`) and Google Chrome (or set
 * LH_E2E_CHROME to another Chrome/Chromium binary). Not part of `npm test`:
 * it boots a server and drives a browser.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import puppeteer from "puppeteer-core";

const PORT = Number(process.env.LH_E2E_PORT ?? 3311);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME =
	process.env.LH_E2E_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** A 1x1 PNG — the smallest real image a clipboard can carry. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

let server;
let browser;
let page;
let dataDir;
const created = [];

async function waitForServer(timeoutMs = 120_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${BASE}/api/chats`);
			if (res.ok) return;
		} catch {
			/* not listening yet */
		}
		await new Promise((r) => setTimeout(r, 400));
	}
	throw new Error(`server did not answer on ${BASE}`);
}

/** Create a session through the API (the composer's own route), then open it. */
async function openSession(title) {
	const res = await fetch(`${BASE}/api/chats`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title }),
	});
	const { id } = await res.json();
	created.push(id);
	await page.goto(`${BASE}/chat/${id}`, { waitUntil: "networkidle2" });
	await page.waitForSelector('[data-testid="composer"] textarea');
	return id;
}

/** Dispatch a real paste event carrying `files` at the composer's textarea. */
async function pasteFiles(files) {
	await page.evaluate(
		async (specs) => {
			const data = new DataTransfer();
			for (const spec of specs) {
				const blob = await (await fetch(`data:${spec.type};base64,${spec.data}`)).blob();
				data.items.add(new File([blob], spec.name ?? "pasted", { type: spec.type }));
			}
			const textarea = document.querySelector('[data-testid="composer"] textarea');
			textarea.focus();
			textarea.dispatchEvent(
				new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
			);
		},
		files.map((f) => ({ type: f.type, data: f.data, name: f.name })),
	);
}

before(async () => {
	// A throwaway data dir: the e2e never touches the developer's sessions.
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-e2e-"));
	server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
		cwd: path.resolve(import.meta.dirname, "../.."),
		env: { ...process.env, LH_DATA_DIR: dataDir, NODE_ENV: "production" },
		stdio: "ignore",
	});
	await waitForServer();
	browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
	page = await browser.newPage();
	await page.setViewport({ width: 1280, height: 900 });
});

after(async () => {
	await browser?.close();
	server?.kill("SIGTERM");
	fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("composer image paste (e2e)", () => {
	it("pasting a screenshot shows a preview with a remove cross at its top-right", async () => {
		await openSession("e2e paste preview");
		await pasteFiles([{ type: "image/png", data: PNG, name: "shot.png" }]);
		await page.waitForSelector('[data-testid="composer-images"] img');
		const thumb = await page.$('[data-testid="composer-images"] img');
		const box = await thumb.boundingBox();
		assert.ok(box.width > 0 && box.height > 0, "the preview has real size");
		const cross = await page.$('[data-testid="composer-images"] [aria-label="Remove image"]');
		assert.ok(cross, "the remove affordance exists");
		const cbox = await cross.boundingBox();
		assert.ok(cbox.x > box.x + box.width / 2, "cross sits on the RIGHT half");
		assert.ok(cbox.y < box.y + box.height / 2, "cross sits on the TOP half");
	});

	it("clicking the preview opens the image full size; Esc closes it", async () => {
		await openSession("e2e lightbox");
		await pasteFiles([{ type: "image/png", data: PNG, name: "shot.png" }]);
		await page.waitForSelector('[data-testid="composer-images"] img');
		await page.click('[data-testid="composer-images"] button[aria-label="View pasted image in full"]');
		await page.waitForSelector('[data-testid="image-lightbox"] img');
		const src = await page.$eval('[data-testid="image-lightbox"] img', (el) => el.getAttribute("src"));
		assert.match(src, /^data:image\/png;base64,/, "the full view shows the pasted bytes");
		await page.keyboard.press("Escape");
		await page.waitForFunction(() => !document.querySelector('[data-testid="image-lightbox"]'));
	});

	it("the remove cross takes the image out of the draft", async () => {
		await openSession("e2e remove");
		await pasteFiles([{ type: "image/png", data: PNG, name: "shot.png" }]);
		await page.waitForSelector('[data-testid="composer-images"] img');
		// An image alone makes the draft sendable — the button is live.
		assert.equal(await page.$eval('[data-testid="composer"] button[aria-label="Send"]', (el) => el.disabled), false);
		await page.click('[data-testid="composer-images"] [aria-label="Remove image"]');
		await page.waitForFunction(() => !document.querySelector('[data-testid="composer-images"]'));
		assert.equal(await page.$eval('[data-testid="composer"] button[aria-label="Send"]', (el) => el.disabled), true);
	});

	it("an unsupported clipboard image is refused in place, and nothing is drafted", async () => {
		await openSession("e2e refused format");
		await pasteFiles([{ type: "image/tiff", data: PNG, name: "shot.tiff" }]);
		await page.waitForSelector('[data-testid="composer-images"] p');
		const text = await page.$eval('[data-testid="composer-images"] p', (el) => el.textContent ?? "");
		assert.match(text, /PNG, JPEG, WebP, or GIF/);
		assert.equal((await page.$$('[data-testid="composer-images"] img')).length, 0, "no thumbnail for a refused image");
	});

	it("sending an image-only message puts it in the transcript, and the refusal restores the draft", async () => {
		await openSession("e2e send");
		await pasteFiles([{ type: "image/png", data: PNG, name: "shot.png" }]);
		await page.waitForSelector('[data-testid="composer-images"] img');
		await page.click('[data-testid="composer"] button[aria-label="Send"]');
		// The optimistic user turn renders the picture at once (the server has
		// no model configured here, so the turn is refused — never sent).
		// (Not clicked here: the refusal refetch replaces the optimistic tail
		// within a frame — the lightbox path is pinned on stable thumbnails.)
		await page.waitForSelector('[data-testid="user-image"]', { timeout: 15_000 });
		// The refusal returns the draft to the composer (nothing lost).
		await page.waitForSelector('[data-testid="composer-images"] img', { timeout: 15_000 });
	});

	it("the server refuses a malformed image with a 400 over real HTTP", async () => {
		const res = await fetch(`${BASE}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chatId: created[0],
				input: { type: "text", text: "", images: [{ type: "image", mimeType: "image/tiff", data: PNG }] },
			}),
		});
		assert.equal(res.status, 400);
		assert.match(await res.json().then((b) => b.error ?? ""), /PNG, JPEG, WebP, or GIF/);
	});
});
