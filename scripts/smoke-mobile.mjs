/**
 * smoke-mobile.mjs — prove the phone build's on-device backend runs a real
 * lesson turn in a browser and keeps it across a reload (mobile Phase 0).
 *
 * Serves dist-mobile/ (run `node scripts/build-mobile.mjs` first), opens the
 * proof page in headless Chromium, and replaces https://api.anthropic.com
 * with a scripted streaming reply — no key, no network, no spend. Then it
 * walks the page the way a person would: save a key, pick a model, start a
 * lesson, wait for the streamed reply; reloads; and checks the session is
 * still listed from IndexedDB. It also checks the request that reached the
 * "provider" carried the agent's bundled system prompt and its tools.
 *
 * Needs Playwright with a Chromium build (`require("playwright")`); it is a
 * developer gate, not part of `npm test`.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { createRequire } from "node:module";

// require(), not import: a globally installed Playwright is found via NODE_PATH.
const { chromium } = createRequire(import.meta.url)("playwright");

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist-mobile");
const REPLY = "Before we start: what do you already know about how light scatters?";

if (!fs.existsSync(path.join(DIST, "spike", "index.html"))) {
	console.error("[smoke-mobile] dist-mobile/spike missing — run `node scripts/build-mobile.mjs` first.");
	process.exit(1);
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".map": "application/json", ".json": "application/json" };
const server = http.createServer((req, res) => {
	const url = new URL(req.url, "http://x");
	const file = path.join(DIST, path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, ""));
	if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
		res.writeHead(404).end();
		return;
	}
	res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
	fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

/** One Anthropic Messages API streaming reply, as server-sent events. */
function anthropicStream(text) {
	const events = [
		["message_start", { type: "message_start", message: { id: "msg_smoke", type: "message", role: "assistant", model: "smoke", content: [], stop_reason: null, usage: { input_tokens: 1200, output_tokens: 1 } } }],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		...text.match(/.{1,12}/g).map((chunk) => ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } }]),
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 24 } }],
		["message_stop", { type: "message_stop" }],
	];
	return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

const failures = [];
const check = (ok, what) => {
	console.log(`${ok ? "  ok " : "FAIL "} ${what}`);
	if (!ok) failures.push(what);
};

const browser = await chromium.launch();
try {
	const context = await browser.newContext();
	const page = await context.newPage();
	const pageErrors = [];
	page.on("pageerror", (err) => pageErrors.push(err.message));
	page.on("console", (msg) => {
		if (msg.type() === "error") pageErrors.push(msg.text());
		if (process.env.SMOKE_VERBOSE) console.log(`  [page ${msg.type()}] ${msg.text()}`);
	});

	const providerRequests = [];
	await context.route("https://api.anthropic.com/**", async (route) => {
		const req = route.request();
		providerRequests.push({ url: req.url(), headers: req.headers(), body: req.postDataJSON() });
		await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" }, body: anthropicStream(REPLY) });
	});
	// Anything else leaving the page would be a leak (the backend is local).
	const offPage = [];
	await context.route(/^https?:\/\/(?!127\.0\.0\.1|api\.anthropic\.com)/, (route) => {
		offPage.push(route.request().url());
		return route.abort();
	});

	await page.goto(`${base}/spike/index.html`);
	await page.waitForFunction(() => document.getElementById("status")?.textContent?.startsWith("Ready"), null, { timeout: 30_000 });
	check(true, `backend booted: ${await page.textContent("#status")}`);

	await page.selectOption("#provider", "ANTHROPIC_API_KEY");
	await page.fill("#key", "sk-ant-api03-" + "x".repeat(93) + "AA");
	await page.click("#save-key");
	await page.waitForFunction(() => /Saved|not saved/.test(document.getElementById("status")?.textContent ?? ""));
	check((await page.textContent("#status")).startsWith("Saved"), `key saved: ${await page.textContent("#status")}`);

	const options = await page.$$eval("#model option", (os) => os.map((o) => o.value));
	check(options.length > 0, `model catalog lists ${options.length} Anthropic models`);
	await page.selectOption("#model", options[0]);
	await page.click("#save-model");
	await page.waitForFunction(() => /Using|not saved/.test(document.getElementById("status")?.textContent ?? ""));
	check((await page.textContent("#status")).startsWith("Using"), `model slots saved: ${await page.textContent("#status")}`);

	await page.click("#start");
	await page.waitForFunction(() => /Turn finished|Turn failed/.test(document.getElementById("status")?.textContent ?? ""), null, { timeout: 60_000 });
	const after = await page.textContent("#status");
	check(after.startsWith("Turn finished"), `turn: ${after}`);
	const rendered = (await page.textContent("#output")).includes(REPLY);
	check(rendered, "streamed reply rendered");
	if (!rendered) {
		const record = await page.evaluate(async () => {
			const { chats } = await (await fetch("/api/chats")).json();
			return (await fetch(`/api/chats/${chats[0].id}`)).json();
		});
		console.log(JSON.stringify(record.messages, null, 1).slice(0, 3000), record.turnError);
	}

	const sent = providerRequests[0];
	check(providerRequests.length >= 1, `provider called ${providerRequests.length} time(s)`);
	if (sent) {
		const system = JSON.stringify(sent.body.system ?? "");
		check(system.length > 2000, `system prompt sent (${system.length} chars, from bundled prompt files)`);
		check(Array.isArray(sent.body.tools) && sent.body.tools.length > 0, `tools sent: ${(sent.body.tools ?? []).map((t) => t.name).join(", ")}`);
		check(sent.headers["anthropic-dangerous-direct-browser-access"] === "true", "browser-access header present");
		check(sent.headers["x-api-key"]?.startsWith("sk-ant-"), "key read from on-device auth store");
	}

	await page.reload();
	await page.waitForFunction(() => document.getElementById("status")?.textContent?.startsWith("Ready"), null, { timeout: 30_000 });
	const sessions = await page.$$eval("#sessions li", (lis) => lis.map((li) => li.textContent));
	check(sessions.length === 1 && /Why does the sky look blue/.test(sessions[0]), `after reload, session listed: ${sessions[0]}`);
	const modelKept = await page.$eval("#model", (s) => s.value);
	check(modelKept === options[0], "after reload, model slot and key still configured");

	check(offPage.length === 0, `no other network requests${offPage.length ? `: ${offPage.join(", ")}` : ""}`);
	check(pageErrors.length === 0, `no page errors${pageErrors.length ? `:\n${pageErrors.join("\n")}` : ""}`);
} finally {
	await browser.close();
	server.close();
}

if (failures.length) {
	console.error(`[smoke-mobile] ${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("[smoke-mobile] passed");
