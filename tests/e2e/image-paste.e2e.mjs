/**
 * END-TO-END: composer image paste (spec:
 * docs/superpowers/plans/2026-10-24-chat-image-paste-spec-and-plan.md).
 *
 * Real Next server + real Chrome, no provider spend: the browser-side
 * clipboard work (paste, draft, preview, lightbox, remove) on EVERY
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
import { after, afterEach, before, describe, it } from "node:test";
import puppeteer from "puppeteer-core";

const PORT = Number(process.env.LH_E2E_PORT ?? 3311);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.LH_E2E_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** A real (tiny) PNG: the clipboard refuses fake bytes, so the fixture must decode. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
/** A large real PNG: its FileReader pass is slow enough to race an Enter. */
const BIG_PNG = fs.readFileSync(path.resolve(import.meta.dirname, "../../docs/assets/knowledge-graph.png")).toString("base64");
/** Bytes that are not an image, wearing an image/png label. */
const NOT_A_PNG = Buffer.from("this is plain text, not a picture").toString("base64");
const SLOT = { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } }; // reads images
const TEXT_ONLY_MODEL = { provider: "openrouter", id: "aion-labs/aion-2.0" };
const HOME = '[data-testid="home-composer"] textarea';
const COMPOSER = '[data-testid="composer"] textarea';

let server;
let browser;
let page;
let dataDir;
/** Per-test hook over POST /api/chat (default: let it through). */
let onChatPost = (req) => req.continue();

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

/** Wait until React owns `selector` (server HTML renders the textarea before
 *  hydration attaches its handlers; a paste in that gap goes nowhere). */
async function waitForHydrated(selector) {
	await page.waitForFunction(
		(sel) => {
			const el = document.querySelector(sel);
			return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps"));
		},
		{ timeout: 30_000 },
		selector,
	);
}

/** Create a session through the API, then open it. */
async function openSession(title) {
	const res = await fetch(`${BASE}/api/chats`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title }),
	});
	const { id } = await res.json();
	await page.goto(`${BASE}/chat/${id}`, { waitUntil: "domcontentloaded" });
	await waitForHydrated(COMPOSER);
	return id;
}

/**
 * Dispatch a REAL paste event carrying `files` at the surface's textarea.
 * Every surface's own handler must pick it up (the bug this suite exists
 * for: home and the draft had no handler at all). `thenEnter` presses Enter
 * as the very next task, before the file read can finish.
 */
async function pasteFiles(target, files, { thenEnter = false } = {}) {
	return page.evaluate(
		async ({ selector, specs, thenEnter }) => {
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
			let thumbsAtEnter = null;
			if (thenEnter) {
				// Next task, like a real keystroke: React has rendered the paste,
				// but the file read is still running.
				await new Promise((r) => setTimeout(r, 0));
				thumbsAtEnter = document.querySelectorAll('[data-testid="composer-images"] img').length;
				textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			}
			return { ok: true, handled: !notCancelled, thumbsAtEnter };
		},
		{ selector: target, specs: files.map((f) => ({ type: f.type, data: f.data, name: f.name })), thenEnter },
	);
}

/** The persisted learner messages of a session (the record, not the view). */
async function userMessages(chatId) {
	const record = await (await fetch(`${BASE}/api/chats/${chatId}`)).json();
	return record.messages.filter((m) => m.role === "user");
}

const png = (data = PNG) => [{ type: "image/png", data }];

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
	await page.setRequestInterception(true);
	page.on("request", (req) => {
		if (req.method() === "POST" && new URL(req.url()).pathname === "/api/chat") return onChatPost(req);
		return req.continue();
	});
});

after(async () => {
	await browser?.close();
	server?.kill("SIGTERM");
	fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("composer image paste (e2e)", () => {
	afterEach(() => {
		onChatPost = (req) => req.continue();
	});

	it("home: paste drafts a preview whose remove cross sits at the top-right", async () => {
		await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
		await waitForHydrated(HOME);
		assert.equal((await pasteFiles(HOME, png())).handled, true);
		await page.waitForSelector('[data-testid="composer-images"] img');
		const box = await (await page.$('[data-testid="composer-images"] img')).boundingBox();
		const cbox = await (await page.$('[data-testid="composer-images"] [aria-label="Remove image"]')).boundingBox();
		assert.ok(box.width > 0 && box.height > 0, "the preview has real size");
		assert.ok(cbox.x > box.x + box.width / 2, "cross on the RIGHT half");
		assert.ok(cbox.y < box.y + box.height / 2, "cross on the TOP half");
		await page.click('[data-testid="composer-images"] button[aria-label="View pasted image in full"]');
		await page.waitForSelector('[data-testid="image-lightbox"] img');
		await page.keyboard.press("Escape");
		await page.waitForFunction(() => !document.querySelector('[data-testid="image-lightbox"]'));
	});

	it("session: click opens the picture full size, Esc closes it", async () => {
		await openSession("e2e lightbox");
		await pasteFiles(COMPOSER, png());
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
		await pasteFiles(COMPOSER, png());
		await page.waitForSelector('[data-testid="composer-images"] img');
		// An image alone makes the draft sendable.
		assert.equal(await page.$eval('[data-testid="composer"] button[aria-label="Send"]', (el) => el.disabled), false);
		await page.click('[data-testid="composer-images"] [aria-label="Remove image"]');
		await page.waitForFunction(() => !document.querySelector('[data-testid="composer-images"]'));
		assert.equal(await page.$eval('[data-testid="composer"] button[aria-label="Send"]', (el) => el.disabled), true);
	});

	it("session: an unsupported format and a renamed non-image are refused in place", async () => {
		await openSession("e2e refused paste");
		await pasteFiles(COMPOSER, [{ type: "image/tiff", data: PNG }]);
		await page.waitForSelector('[data-testid="composer-images"] p');
		assert.match(await page.$eval('[data-testid="composer-images"] p', (el) => el.textContent), /PNG, JPEG, WebP, or GIF/);
		await pasteFiles(COMPOSER, png(NOT_A_PNG));
		await page.waitForFunction(() => /not the image it claims/.test(document.querySelector('[data-testid="composer-images"] p')?.textContent ?? ""));
		assert.equal(await thumbs(), 0, "no thumbnail for a refused image");
	});

	it("session: send persists caption then picture, in order, across a reload", async () => {
		const chatId = await openSession("e2e send persists");
		await page.type(COMPOSER, "what is this?");
		await pasteFiles(COMPOSER, png());
		await page.waitForSelector('[data-testid="composer-images"] img');
		await page.keyboard.press("Enter");
		await page.waitForSelector('[data-testid="user-image"]', { timeout: 20_000 });
		assert.equal(await thumbs(), 0, "the draft clears on send");
		// After the turn settles and the record is adopted, the optimistic row
		// must have merged with the server's copy: one row, not two.
		await page.waitForFunction(() => !document.querySelector('[aria-label="Stop"]'), { timeout: 20_000 });
		await new Promise((r) => setTimeout(r, 1000));
		assert.equal(await page.$$eval('[data-testid="user-message"]', (els) => els.length), 1, "no doubled learner row");
		await page.click('[data-testid="user-image"]');
		await page.waitForSelector('[data-testid="image-lightbox"] img');
		await page.keyboard.press("Escape");
		const markdown = await (await fetch(`${BASE}/api/chats/${chatId}/markdown`)).text();
		assert.match(markdown, /what is this\?/, "the export keeps the words");
		assert.ok(!markdown.includes(PNG.slice(0, 24)), "the export never carries base64");
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.waitForSelector('[data-testid="user-image"]', { timeout: 20_000 });
		const order = await page.$eval('[data-testid="user-message"]', (row) =>
			[...row.children].slice(1).map((el) => (el.matches('[data-testid="user-image"]') ? "image" : el.textContent)),
		);
		assert.deepEqual(order, ["what is this?", "image"]);
		assert.equal((await userMessages(chatId)).length, 1, "exactly one learner message persisted");
	});

	it("session: Enter pressed before the paste finished reading still sends the picture", async () => {
		const chatId = await openSession("e2e paste race");
		const { thumbsAtEnter } = await pasteFiles(COMPOSER, png(BIG_PNG), { thenEnter: true });
		assert.equal(thumbsAtEnter, 0, "Enter landed while the read was still running (the race)");
		await page.waitForSelector('[data-testid="user-image"]', { timeout: 20_000 });
		const [sent] = await userMessages(chatId);
		assert.equal(sent.content.filter((b) => b.type === "image").length, 1, "the image rode the send");
	});

	it("session: a refused send restores its picture AND keeps one pasted meanwhile", async () => {
		await openSession("e2e refusal merge");
		let release;
		const held = new Promise((r) => (release = r));
		onChatPost = async (req) => {
			await held; // hold the refusal until the learner pasted again
			req.respond({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({ error: "No model configured", code: "models_not_configured", missing: ["strong"] }),
			});
		};
		await pasteFiles(COMPOSER, png());
		await page.waitForSelector('[data-testid="composer-images"] img');
		await page.keyboard.press("Enter");
		await page.waitForFunction(() => !document.querySelector('[data-testid="composer-images"] img'));
		await pasteFiles(COMPOSER, png());
		await page.waitForSelector('[data-testid="composer-images"] img');
		release();
		await page.waitForFunction(() => document.querySelectorAll('[data-testid="composer-images"] img').length === 2, { timeout: 20_000 });
		await page.keyboard.press("Escape"); // the setup dialog the refusal opened
	});

	it("session: a 409 retry re-sends the same event and persists ONE message", async () => {
		const chatId = await openSession("e2e retry");
		let first = true;
		onChatPost = (req) => {
			if (!first) return req.continue();
			first = false;
			return req.respond({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "A turn is already running" }) });
		};
		await pasteFiles(COMPOSER, png());
		await page.waitForSelector('[data-testid="composer-images"] img');
		await page.keyboard.press("Enter");
		await page.waitForSelector('[data-testid="user-image"]', { timeout: 20_000 });
		await new Promise((r) => setTimeout(r, 1500)); // any duplicate POST lands by now
		assert.equal((await userMessages(chatId)).length, 1, "no second copy");
	});

	it("session: a text-only model refuses the picture, and the draft comes back with the reason", async () => {
		const chatId = await openSession("e2e text-only model");
		const put = await fetch(`${BASE}/api/chats/${chatId}/settings`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: TEXT_ONLY_MODEL }),
		});
		assert.equal(put.status, 200);
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitForHydrated(COMPOSER);
		await pasteFiles(COMPOSER, png());
		await page.waitForSelector('[data-testid="composer-images"] img');
		await page.keyboard.press("Enter");
		await page.waitForFunction(() => /cannot read images/.test(document.querySelector('[data-testid="composer-images"] p')?.textContent ?? ""), { timeout: 20_000 });
		assert.equal(await thumbs(), 1, "the picture is back in the draft");
		assert.equal((await userMessages(chatId)).length, 0, "nothing was persisted");
	});

	it("session: switching to a text-only model keeps an image history usable for text", async () => {
		const chatId = await openSession("e2e history downgrade");
		await pasteFiles(COMPOSER, png());
		await page.waitForSelector('[data-testid="composer-images"] img');
		await page.keyboard.press("Enter");
		await page.waitForSelector('[data-testid="user-image"]', { timeout: 20_000 });
		await page.waitForFunction(() => !document.querySelector('[aria-label="Stop"]'), { timeout: 20_000 });
		await fetch(`${BASE}/api/chats/${chatId}/settings`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: TEXT_ONLY_MODEL }),
		});
		// The image gate applies to NEW pictures only; pi-ai downgrades the
		// history's picture to a text placeholder for this model.
		const res = await fetch(`${BASE}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId, input: { type: "text", text: "and now in words?" } }),
		});
		assert.equal(res.status, 200, await res.clone().text());
	});

	it("home: an image-only first message opens a session titled for it, with the picture in it", async () => {
		await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
		await waitForHydrated(HOME);
		await pasteFiles(HOME, png());
		await page.waitForSelector('[data-testid="composer-images"] img');
		await page.click('[data-testid="home-composer"] button[aria-label="Start session"]');
		// The image cannot ride ?prompt=: the handoff must land it here.
		await page.waitForFunction(() => location.pathname.startsWith("/chat/") && !location.search, { timeout: 20_000 });
		const chatId = new URL(page.url()).pathname.split("/").pop();
		await page.waitForSelector('[data-testid="user-image"]', { timeout: 20_000 });
		assert.equal(await page.$$eval('[data-testid="user-message"]', (els) => els.length), 1, "one learner message");
		const record = await (await fetch(`${BASE}/api/chats/${chatId}`)).json();
		assert.equal(record.title, "Pasted image");
	});

	it("draft: /chat/new sends the first image the same way", async () => {
		await page.goto(`${BASE}/chat/new`, { waitUntil: "domcontentloaded" });
		await waitForHydrated(COMPOSER);
		await pasteFiles(COMPOSER, png());
		await page.waitForSelector('[data-testid="composer-images"] img');
		await page.click('[data-testid="composer"] button[aria-label="Send"]');
		await page.waitForFunction(() => location.pathname.startsWith("/chat/") && location.pathname !== "/chat/new", { timeout: 20_000 });
		await page.waitForSelector('[data-testid="user-image"]', { timeout: 20_000 });
	});

	it("the server refuses a bad format and a renamed non-image with a 400, persisting nothing", async () => {
		const chatId = await openSession("e2e server boundary");
		for (const [image, reason] of [
			[{ type: "image", mimeType: "image/tiff", data: PNG }, /PNG, JPEG, WebP, or GIF/],
			[{ type: "image", mimeType: "image/png", data: NOT_A_PNG }, /not the image it claims/],
		]) {
			const res = await fetch(`${BASE}/api/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId, input: { type: "text", text: "", images: [image] } }),
			});
			assert.equal(res.status, 400);
			assert.match((await res.json()).error ?? "", reason);
		}
		assert.equal((await userMessages(chatId)).length, 0);
	});
});
