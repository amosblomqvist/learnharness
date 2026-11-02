/**
 * smoke-mobile.mjs — prove the phone app works end to end in a real browser
 * (docs/mobile.md). Serves dist-mobile/ (run `node scripts/build-mobile.mjs`
 * first) with single-page-app fallback, opens it at iPhone size in headless
 * Chromium, and replaces https://api.anthropic.com with scripted streaming
 * replies — no key, no network, no spend. Then, through the real UI:
 *
 *   1. save a key + model slots, start a lesson from the home composer;
 *   2. the agent's multiple-choice question appears; answer it; the reply
 *      streams in — and the provider request carried the bundled system
 *      prompt, the tools (WITHOUT the learner-file tools), the browser-access
 *      header and the on-device key;
 *   3. the knowledge graph: extraction runs on the device (scripted
 *      extractor + auditor), the graph home draws it, a tap on a node opens
 *      its card, a double-tap on empty space re-frames the whole graph;
 *   4. the sidebar drawer opens over the page and closes on navigation;
 *   5. Settings → Phone data saves a backup zip (keys excluded) and restores
 *      a zipped desktop data folder, replacing the phone's sessions;
 *   6. after a reload the restored data is still there (IndexedDB);
 *   7. offline, the app still starts (service worker app shell).
 *
 * Needs Playwright with Chromium (`require("playwright")`); a developer
 * gate, not part of `npm test`. SMOKE_VERBOSE=1 echoes the page console.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

// require(), not import: a globally installed Playwright is found via NODE_PATH.
const { chromium, devices } = createRequire(import.meta.url)("playwright");

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist-mobile");
if (!fs.existsSync(path.join(DIST, "index.html"))) {
	console.error("[smoke-mobile] dist-mobile/ missing — run `node scripts/build-mobile.mjs` first.");
	process.exit(1);
}

const TYPES = {
	".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
	".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml",
	".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".map": "application/json",
};
const server = http.createServer((req, res) => {
	const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
	let file = path.join(DIST, path.normalize(pathname).replace(/^([/\\])+/, ""));
	// Single-page-app fallback, like Cloudflare Pages: unknown paths → index.html.
	if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
	res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
	fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

/** One Anthropic Messages API streaming reply: optional text, optional tool calls. */
function anthropicStream({ text = "", tools = [] }) {
	const ev = [["message_start", { type: "message_start", message: { id: "msg_smoke", type: "message", role: "assistant", model: "smoke", content: [], stop_reason: null, usage: { input_tokens: 1500, output_tokens: 1 } } }]];
	let i = 0;
	if (text) {
		ev.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } }]);
		for (const chunk of text.match(/[\s\S]{1,16}/g)) ev.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: chunk } }]);
		ev.push(["content_block_stop", { type: "content_block_stop", index: i++ }]);
	}
	for (const t of tools) {
		ev.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: t.id, name: t.name, input: {} } }]);
		ev.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(t.input) } }]);
		ev.push(["content_block_stop", { type: "content_block_stop", index: i++ }]);
	}
	ev.push(["message_delta", { type: "message_delta", delta: { stop_reason: tools.length ? "tool_use" : "end_turn" }, usage: { output_tokens: 40 } }]);
	ev.push(["message_stop", { type: "message_stop" }]);
	return ev.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

const QUESTION = "When sunlight passes through air, what happens to the different colours?";
const REPLY = "Exactly: blue light scatters more strongly than red.";
const SCRIPT = [
	{ text: "Let me find where your picture of light starts.", tools: [{ id: "toolu_smoke_1", name: "ask_user_question", input: { question: QUESTION, options: [{ label: "They pass straight through equally", value: "equal" }, { label: "Some colours scatter more than others", value: "scatter" }] } }] },
	{ text: REPLY },
];

/** What the scripted extractor "finds" in the lesson. */
const FINDINGS = {
	propositions: [
		{ id: "p1", name: "Rayleigh scattering", statement: "Small particles scatter short wavelengths far more than long ones." },
		{ id: "p2", name: "Blue scatters most", statement: "Blue light is scattered across the sky much more than red." },
		{ id: "p3", name: "Sky looks blue", statement: "Scattered blue light reaches the eye from every direction, so the sky looks blue." },
	],
	chains: [{ premises: ["p1"], conclusion: "p2" }, { premises: ["p2"], conclusion: "p3" }],
};
let extractorCalls = 0;
let auditorCalls = 0;

const failures = [];
const check = (ok, what) => {
	console.log(`${ok ? "  ok " : "FAIL "} ${what}`);
	if (!ok) failures.push(what);
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-smoke-mobile-"));
const browser = await chromium.launch();
try {
	const context = await browser.newContext({ ...devices["iPhone 13"], acceptDownloads: true });
	const page = await context.newPage();
	const pageErrors = [];
	page.on("pageerror", (err) => pageErrors.push(err.message));
	page.on("console", (msg) => {
		if (process.env.SMOKE_VERBOSE) console.log(`  [page ${msg.type()}] ${msg.text()}`);
		if (msg.type() === "error" && !/Failed to load resource/.test(msg.text())) pageErrors.push(msg.text());
	});
	page.on("dialog", (d) => d.accept());

	const providerRequests = [];
	await context.route("https://api.anthropic.com/**", async (route) => {
		const req = route.request();
		const body = req.postDataJSON();
		const tools = (body.tools ?? []).map((t) => t.name);
		let reply;
		if (tools.includes("submit_findings")) {
			extractorCalls++;
			// The extractor anchors each idea to a teacher passage by its label.
			const anchor = /TEACHER \[([^\]]+)\]/.exec(JSON.stringify(body.messages))?.[1] ?? "missing";
			reply = { tools: [{ id: "toolu_smoke_x", name: "submit_findings", input: { ...FINDINGS, propositions: FINDINGS.propositions.map((p) => ({ ...p, messageId: anchor })) } }] };
		} else if (tools.includes("submit_review")) {
			auditorCalls++;
			reply = { tools: [{ id: "toolu_smoke_a", name: "submit_review", input: { links: [] } }] };
		} else {
			providerRequests.push({ headers: req.headers(), body });
			reply = SCRIPT[Math.min(providerRequests.length - 1, SCRIPT.length - 1)];
		}
		await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: anthropicStream(reply) });
	});
	// Fonts come from Google in production; offline here. Anything else
	// leaving the page would be a leak — the backend is on the device.
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	const offPage = [];
	await context.route(/^https?:\/\/(?!127\.0\.0\.1|api\.anthropic\.com|fonts\.)/, (route) => {
		offPage.push(route.request().url());
		return route.abort();
	});

	// ── 1. configure, start a lesson ─────────────────────────────────────
	await page.goto(`${base}/`);
	await page.waitForSelector("[contenteditable=true]", { timeout: 30_000 });
	const configured = await page.evaluate(async () => {
		const put = (u, b) => fetch(u, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
		const key = await put("/api/keys/ANTHROPIC_API_KEY", { value: "sk-ant-api03-" + "x".repeat(93) + "AA" });
		const { models } = await (await fetch("/api/models")).json();
		const model = models.find((m) => m.provider === "anthropic");
		const slot = { model: { provider: "anthropic", id: model.id } };
		const slots = await put("/api/settings/models", { strong: slot, cheap: slot, vision: slot });
		return key.ok && slots.ok;
	});
	check(configured, "key and model slots saved through the on-device API");
	await page.reload();
	await page.waitForSelector("[contenteditable=true]");
	check((await page.getByRole("button", { name: "Open sidebar" }).count()) === 1, "drawer starts closed on a phone");

	await page.locator("[contenteditable=true]").first().click();
	await page.keyboard.type("Why is the sky blue?");
	await page.keyboard.press("Enter");
	await page.waitForURL(/\/chat\/chat_/, { timeout: 15_000 });
	const chatUrl = page.url();
	await page.getByText(QUESTION).waitFor({ timeout: 30_000 });
	check(true, "lesson started; the agent's question is shown");

	const first = providerRequests[0]?.body;
	const toolNames = (first?.tools ?? []).map((t) => t.name);
	check(JSON.stringify(first?.system ?? "").length > 2000, "system prompt sent (bundled prompt files)");
	check(toolNames.includes("ask_user_question"), `tools sent: ${toolNames.join(", ")}`);
	check(!toolNames.some((n) => ["read", "ls", "find", "grep"].includes(n)), "learner-file tools absent on the phone");
	check(!JSON.stringify(first?.system ?? "").includes("## Learner files"), "learner-files prompt section absent");
	check(providerRequests[0]?.headers["anthropic-dangerous-direct-browser-access"] === "true", "browser-access header present");
	check(providerRequests[0]?.headers["x-api-key"]?.startsWith("sk-ant-"), "key read from the on-device store");

	await page.getByText("Some colours scatter more than others").click();
	await page.getByRole("button", { name: /submit answer/i }).click();
	await page.getByText(REPLY).waitFor({ timeout: 30_000 });
	check(true, "answer submitted; the reply streamed in");

	// ── 3. knowledge graph ───────────────────────────────────────────────
	const chatId = chatUrl.split("/").pop();
	const started = await page.evaluate(
		async (id) => (await fetch("/api/graph/coverage/extract", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: id }) })).status,
		chatId,
	);
	const graphNodes = async () => page.evaluate(async () => (await (await fetch("/api/graph")).json()).propositions?.length ?? 0);
	let nodes = 0;
	for (let i = 0; i < 40 && nodes < 3; i++) {
		await page.waitForTimeout(250);
		nodes = await graphNodes();
	}
	check(started === 202 && extractorCalls === 1 && auditorCalls === 1, `extraction ran on the device (extractor ${extractorCalls}, auditor ${auditorCalls})`);
	check(nodes === 3, `the graph holds the extracted ideas (${nodes} propositions)`);

	await page.goto(`${base}/`);
	await page.waitForSelector("canvas");
	await page.waitForTimeout(2500); // let the layout settle
	const toggleBox = await page.getByRole("button", { name: "Open sidebar" }).boundingBox();
	const searchBox = await page.getByRole("textbox", { name: "Search nodes" }).boundingBox();
	check(toggleBox && searchBox && searchBox.x > toggleBox.x + toggleBox.width, "graph toolbar fits beside the sidebar button");

	const camera = () => page.evaluate(() => ({ ...document.querySelector("canvas").__zoom }));
	const screenNodes = () =>
		page.evaluate(async () => {
			const c = document.querySelector("canvas");
			const r = c.getBoundingClientRect();
			const t = c.__zoom;
			const { positions, propositions } = await (await fetch("/api/graph")).json();
			return propositions.map((p) => ({ name: p.name, x: r.left + t.x + positions[p.id].x * t.k, y: r.top + t.y + positions[p.id].y * t.k }));
		});
	// Zoom far in (pinch), then double-tap empty space to re-frame.
	const cdp = await context.newCDPSession(page);
	const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
	await touch("touchStart", [[170, 380], [220, 430]]);
	for (let i = 1; i <= 8; i++) await touch("touchMove", [[170 - i * 8, 380 - i * 8], [220 + i * 8, 430 + i * 8]]);
	await touch("touchEnd", []);
	await page.waitForTimeout(300);
	const zoomed = (await camera()).k;
	// Empty space = the grid point farthest from every node (layouts vary).
	const zoomedNodes = await screenNodes();
	let empty = { x: 195, y: 330 };
	let best = -1;
	for (let x = 40; x <= 350; x += 30) {
		for (let y = 90; y <= 500; y += 30) {
			const d = Math.min(...zoomedNodes.map((n) => Math.hypot(n.x - x, n.y - y)));
			if (d > best) [best, empty] = [d, { x, y }];
		}
	}
	await page.touchscreen.tap(empty.x, empty.y);
	await page.waitForTimeout(120);
	await page.touchscreen.tap(empty.x + 2, empty.y + 2);
	await page.waitForTimeout(400);
	const framed = await screenNodes();
	const viewport = page.viewportSize();
	check(
		(await camera()).k < zoomed && framed.every((n) => n.x > 0 && n.x < viewport.width && n.y > 56 && n.y < viewport.height - 140),
		"pinch zooms in; double-tap on empty space re-frames every node between toolbar and composer",
	);
	const target = framed[0];
	await page.touchscreen.tap(target.x, target.y);
	await page.getByText(FINDINGS.propositions.find((p) => p.name === target.name).statement).waitFor({ timeout: 5000 });
	check(true, `tapping a node opens its card ("${target.name}")`);

	// ── 4. drawer ────────────────────────────────────────────────────────
	await page.getByRole("button", { name: "Open sidebar" }).click();
	const listed = page.locator("aside").getByText("Why is the sky blue?");
	await listed.waitFor();
	const drawer = await page.locator("aside.sidebar-motion").evaluate((el) => getComputedStyle(el).position);
	check(drawer === "fixed", `sidebar slides over the page (position: ${drawer})`);
	await page.locator("aside").getByText("Teaching", { exact: false }).first().click();
	await page.waitForURL(/\/chat\/new/);
	await page.waitForTimeout(400);
	check((await page.getByRole("button", { name: "Open sidebar" }).count()) === 1, "drawer closes after navigating");

	// ── 5. backup + restore ──────────────────────────────────────────────
	await page.getByRole("button", { name: "Open sidebar" }).click();
	await page.locator("aside").getByText(/^settings$/i).click();
	await page.locator('[data-testid="settings-nav-phone-data"]').click();
	check((await page.locator('[data-testid="settings-nav-keyboard"]').isVisible()) === false, "desktop-only settings hidden");
	const [download] = await Promise.all([page.waitForEvent("download"), page.locator('[data-testid="phone-backup"]').click()]);
	const backupZip = path.join(scratch, "backup.zip");
	await download.saveAs(backupZip);
	const listing = execFileSync("unzip", ["-Z1", backupZip], { encoding: "utf-8" }).split("\n").filter(Boolean);
	check(listing.some((f) => /^data\/chats\/chat_.*\.json$/.test(f)) && listing.includes("data/settings.json"), `backup zip has the desktop layout (${listing.length} files)`);
	check(!listing.some((f) => f.endsWith("auth.json")), "backup excludes API keys");

	const desktop = path.join(scratch, "desktop");
	fs.mkdirSync(path.join(desktop, "data", "chats"), { recursive: true });
	const now = new Date().toISOString();
	fs.writeFileSync(
		path.join(desktop, "data", "chats", "chat_desktop_1.json"),
		JSON.stringify({ id: "chat_desktop_1", title: "From my desktop", createdAt: now, updatedAt: now, messages: [], version: 1 }),
	);
	execFileSync("zip", ["-qr", "desktop.zip", "data"], { cwd: desktop });
	await page.locator('[data-testid="phone-restore-input"]').setInputFiles(path.join(desktop, "desktop.zip"));
	await page.waitForURL(`${base}/`, { timeout: 15_000 });
	await page.waitForSelector("[contenteditable=true]");

	// ── 6. persistence ───────────────────────────────────────────────────
	await page.reload();
	await page.waitForSelector("[contenteditable=true]");
	const chats = await page.evaluate(async () => (await (await fetch("/api/chats")).json()).chats.map((c) => c.title));
	check(chats.length === 1 && chats[0] === "From my desktop", `after restore + reload, sessions: ${JSON.stringify(chats)}`);
	const keyKept = await page.evaluate(async () => (await (await fetch("/api/keys")).json()).keys.some((k) => k.id === "ANTHROPIC_API_KEY" && k.present));
	check(keyKept, "restore kept the phone's API key");
	const gone = await page.evaluate(async (u) => (await fetch(`/api/chats/${u.split("/").pop()}`)).status, chatUrl);
	check(gone === 404, "restore replaced the phone's previous session");

	// ── 7. offline start ─────────────────────────────────────────────────
	await page.evaluate(async () => {
		const reg = await navigator.serviceWorker.ready;
		return reg.active?.state;
	});
	await context.setOffline(true);
	await page.goto(`${base}/chat/new`);
	const offline = await page.waitForSelector("[contenteditable=true]", { timeout: 15_000 }).then(() => true, () => false);
	check(offline, "offline: the app still starts from the service worker cache");
	await context.setOffline(false);

	check(offPage.length === 0, `no other network requests${offPage.length ? `: ${offPage.join(", ")}` : ""}`);
	check(pageErrors.length === 0, `no page errors${pageErrors.length ? `:\n${pageErrors.join("\n")}` : ""}`);
} finally {
	await browser.close();
	server.close();
	fs.rmSync(scratch, { recursive: true, force: true });
}

if (failures.length) {
	console.error(`[smoke-mobile] ${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("[smoke-mobile] passed");
