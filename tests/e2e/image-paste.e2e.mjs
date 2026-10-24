/**
 * END-TO-END: composer image paste (spec:
 * docs/superpowers/plans/2026-10-24-chat-image-paste-spec-and-plan.md).
 *
 * Real Next server + real Chrome, no provider spend: the browser-side
 * clipboard work (paste → draft → preview → lightbox → remove) on EVERY
 * sending surface (home, /chat/new, a live session), the first-message
 * handoff that a `?prompt=` URL cannot carry, and the server's trust
 * boundary over real HTTP.
 *
 *   npm run test:e2e
 *
 * Requirements: a built app (`npm run build`) and Google Chrome (or set
 * LH_E2E_CHROME). Not part of `npm test`: it boots a server and a browser.
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
const CHROME = process.env.LH_E2E_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** A real (tiny) PNG: the clipboard refuses fake bytes, so the fixture must decode. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const SLOT = { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } };

let server;
let browser;
let page;
let dataDir;
const created = [];

/** A session whose three model slots are pinned: the first-run gate is a
 *  real gate, and the paste → send surfaces sit behind it. The provider key
 *  is fake, so a turn can never reach (or bill) a model. */
function writeSettings(dir) {
	fs.writeFileSync(
		path.join(dir, "settings.json"),
		JSON.stringify({ models: { strong: SLOT, cheap: SLOT, vision: SLOT } }, null, "\t"),
	);
}

async function waitForServer(timeoutMs = 120_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`${BASE}/api/chats`)).ok) return;
		} catch {
			/* not listening yet */
		}
		await new Promise((r) => setTimeout(r, 400));
	}
	throw new Error(`server did not answer on ${BASE}`);
}

/** Create a session through the API, then open it. */
async function openSession(title) {
	const res = await fetch(`${BASE}/api/chats`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title }),
	});
	const { id } = await res.json();
	created.push(id);
	await page.goto(`${BASE}/chat/${id}`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector('[data-testid="composer"] textarea');
	return id;
}

/**
 * Dispatch a REAL paste event carrying `files` at the surface's textarea —
 * every surface's own handler must pick it up (the bug this suite exists
 * for: home and the draft had no handler at all).
 */
async function pasteFiles(target, files) {
	return page.evaluate(
		async ({ selector, specs }) => {
			const data = new DataTransfer();
			for (const spec of specs) {
				const blob = await (await fetch(`data:${spec.type};base64,${spec.data}`)).blob();
				data.items.add(new File([blob], spec.name ?? "pasted", { type: spec.type }));
			}
			const textarea = document.querySelector(selector);
			if (!textarea) return { ok: false, why: "no textarea" };
			textarea.focus();
			const notCancelled = textarea.dispatchEvent(
				new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
			);
			return { ok: true, handled: !notCancelled };
		},
		{ selector: target, specs: files.map((f) => ({ type: f.type, data: f.data, name: f.name })) },
	);
}

const thumbs = () => page.$$eval('[data-testid="composer-images"] img', (els) => els.length);

before(async () => {
	// A throwaway data dir: the e2e never touches the developer's sessions.
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-e2e-"));
	writeSettings(dataDir);
	server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
		cwd: path.resolve(import.meta.dirname, "../.."),
		env: { ...process.env, LH_DATA_DIR: dataDir, NODE_ENV: "production", OPENROUTER_API_KEY: "e2e-fake-key" },
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
	it("home: paste drafts a preview whose remove cross sits at the top-right", async () => {
		await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
		await page.waitForSelector("textarea");
		assert.equal((await pasteFiles("textarea", [{ type: "image/png", data: PNG }])).handled, true);
		await page.waitForSelector('[data-testid="composer-images"] img');
		const box = await (await page.$('[data-testid="composer-images"] img')).boundingBox();
		const cbox = await (await page.$('[data-testid="composer-images"] [aria-label="Remove image"]')).boundingBox();
		assert.ok(box.width > 0 && box.height > 0, "the preview has real size");
		assert.ok(cbox.x > box.x + box.width / 2, "cross on the RIGHT half");
		assert.ok(cbox.y < box.y + box.height / 2, "cross on the TOP half");
	});

	it("session: click opens the picture full size, Esc closes it", async () => {
		await openSession("e2e lightbox");
		await pasteFiles('[data-testid="composer"] textarea', [{ type: "image/png", data: PNG }]);
		await page.waitForSelector('[data-testid="composer-images"] img');
		await page.click('[data-testid="composer-images"] button[aria-label="View pasted image in full"]');
		await page.waitForSelector('[data-testid="image-lightbox"] img');
		const src = await page.$eval('[data-testid="image-lightbox"] img', (el) => el.getAttribute("src"));
		assert.match(src, /^data:image\/png;base64,/, "the full view shows the pasted bytes");
		await page.keyboard.press("Escape");
		await page.waitForFunction(() => !document.querySelector('[data-testid="image-lightbox"]'));
	});

	it("session: the remove cross takes the image out of the draft", async () => {
		await openSession("e2e remove");
		await pasteFiles('[data-testid="composer"] textarea', [{ type: "image/png", data: PNG }]);
		await page.waitForSelector('[data-testid="composer-images"] img');
		// An image alone makes the draft sendable.
		assert.equal(await page.$eval('[data-testid="composer"] button[aria-label="Send"]', (el) => el.disabled), false);
		await page.click('[data-testid="composer-images"] [aria-label="Remove image"]');
		await page.waitForFunction(() => !document.querySelector('[data-testid="composer-images"]'));
		assert.equal(await page.$eval('[data-testid="composer"] button[aria-label="Send"]', (el) => el.disabled), true);
	});

	it("session: an unsupported clipboard image is refused in place", async () => {
		await openSession("e2e refused format");
		await pasteFiles('[data-testid="composer"] textarea', [{ type: "image/tiff", data: PNG }]);
		await page.waitForSelector('[data-testid="composer-images"] p');
		const text = await page.$eval('[data-testid="composer-images"] p', (el) => el.textContent ?? "");
		assert.match(text, /PNG, JPEG, WebP, or GIF/);
		assert.equal(await thumbs(), 0, "no thumbnail for a refused image");
	});

	it("session: send persists the picture and it survives a reload", async () => {
		await openSession("e2e send persists");
		await pasteFiles('[data-testid="composer"] textarea', [{ type: "image/png", data: PNG }]);
		await page.waitForSelector('[data-testid="composer-images"] img');
		await page.keyboard.press("Enter");
		await page.waitForSelector('[data-testid="user-image"]', { timeout: 20_000 });
		assert.equal(await thumbs(), 0, "the draft clears on send");
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.waitForSelector('[data-testid="user-image"]', { timeout: 20_000 });
		await page.click('[data-testid="user-image"]');
		await page.waitForSelector('[data-testid="image-lightbox"] img', { timeout: 20_000 });
		await page.keyboard.press("Escape");
	});

	it("home: an image-only first message opens the new session with the picture in it", async () => {
		await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
		await page.waitForSelector("textarea");
		await pasteFiles("textarea", [{ type: "image/png", data: PNG }]);
		await page.waitForSelector('[data-testid="composer-images"] img');
		await page.evaluate(() =>
			[...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Start session")?.click(),
		);
		// The image cannot ride ?prompt= — the handoff must land it here.
		await page.waitForFunction(() => location.pathname.startsWith("/chat/") && !location.search, { timeout: 20_000 });
		const id = new URL(page.url()).pathname.split("/").pop();
		if (id) created.push(id);
		await page.waitForSelector('[data-testid="user-image"]', { timeout: 20_000 });
		assert.equal(await page.$$eval('[data-testid="user-message"]', (els) => els.length), 1, "one learner message");
	});

	it("draft: /chat/new sends the first image the same way", async () => {
		await page.goto(`${BASE}/chat/new`, { waitUntil: "domcontentloaded" });
		await page.waitForSelector('[data-testid="composer"] textarea');
		await pasteFiles('[data-testid="composer"] textarea', [{ type: "image/png", data: PNG }]);
		await page.waitForSelector('[data-testid="composer-images"] img');
		await page.click('[data-testid="composer"] button[aria-label="Send"]');
		await page.waitForFunction(() => location.pathname.startsWith("/chat/") && location.pathname !== "/chat/new", { timeout: 20_000 });
		const id = new URL(page.url()).pathname.split("/").pop();
		if (id) created.push(id);
		await page.waitForSelector('[data-testid="user-image"]', { timeout: 20_000 });
	});

	it("the server refuses a malformed image with a 400 over real HTTP", async () => {
		const chatId = await openSession("e2e server boundary");
		const res = await fetch(`${BASE}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chatId,
				input: { type: "text", text: "", images: [{ type: "image", mimeType: "image/tiff", data: PNG }] },
			}),
		});
		assert.equal(res.status, 400);
		const body = await res.json();
		assert.match(body.error ?? "", /PNG, JPEG, WebP, or GIF/);
	});
});
