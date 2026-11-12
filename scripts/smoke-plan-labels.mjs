/** Real-browser proof that plan map labels fit their boxes (#671) in any
 * reading font, label size or script.
 *
 * Run: npm run build && node scripts/smoke-plan-labels.mjs [--out <dir>]
 *
 * - Starts `next start` on the existing production build (it never builds)
 *   with disposable copies of tests/fixtures/golden-data, plus one seeded chat
 *   whose 14-node plan carries hard titles (CJK, Korean, Arabic, emoji, long
 *   words, wide capitals). Stops only the server it started.
 * - Drives headless Chrome (CHROME_PATH overrides the installed channel).
 * - For every label line in every plan diagram: rendered width ≤ box width
 *   minus 16px padding on each side, and the line's ink stays inside the box
 *   vertically. Per node, the browser's line breaks keep the whole title,
 *   split no word, and start no line with closing punctuation. Runs those
 *   checks for 8 fonts × 4 label sizes on both chats,
 *   in the popup, after a live font switch through Settings (no reload), and
 *   after a cold reload in that font — which must also log no hydration
 *   error.
 * - Evidence (screenshots + results.json) stays in the out dir.
 *
 * Fonts the OS lacks fall back to another font; the check still runs on what
 * actually renders. Does not cover the Electron shell.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "..");
const outArg = process.argv.indexOf("--out");
const out = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), "lh-plan-labels-"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-plan-labels-home-"));
const PAD_X = 16; // components/plan-layout.ts
const SLACK = 0.5; // px: sub-pixel rounding between measure and render
const FIXTURE_CHAT = "chat_mv27rrra_feff23b6";
const HARD_CHAT = "chat_smoke671_hardtitles";
const PENDING_CHAT = "chat_smoke671_pending";
const HARD_TITLES = [
	"傅里叶变换的直观理解与实际应用",
	"フーリエ変換、直感的な理解。応用編",
	"「直感」で理解するフーリエ変換",
	"한국어 제목도 상자 안에 들어가야 합니다",
	"مرحبا بالعالم: عنوان عربي طويل جدا",
	"🚀 Launch 🎯 targets 📈 growth 👨‍👩‍👧‍👦 family",
	"Antidisestablishmentarianism and supercalifragilisticexpialidocious",
	"INTRODUCTION TO EIGENVALUES AND EIGENVECTORS",
	"WWWWWWWWWW MMMMMMMMMM mmmmmmmmmm",
	"Ünïcödé àccénts — naïve café façade",
	"Item response theory (IRT) vs BKT, explained",
	"Two noise numbers: slip, guess",
	"x",
	"One very long title that keeps going and going well past any sensible length for one plan step",
];
// Reading-font stacks, set the way the Appearance provider sets them
// (components/settings/appearance.tsx appearanceVars): one setProperty of
// --font-prose on <html>. JetBrains Mono rides its bundled face.
const FONTS = [
	["default (Source Sans 3)", null],
	["JetBrains Mono", '"JetBrains Mono", var(--font-jetbrains)'],
	["Georgia", '"Georgia"'],
	["Verdana", '"Verdana"'],
	["Courier New", '"Courier New"'],
	["Comic Sans MS", '"Comic Sans MS"'],
	["Impact", '"Impact"'],
	["missing font", '"No Such Font 671"'],
];
// Label sizes. text-xs is 11px and the build bakes it into the CSS (setting
// --text-xs at runtime changes nothing), so other sizes come from one injected
// rule on the plan's .text-xs — the hidden measuring probe carries that class
// too. check() asserts the size really applied.
const SIZES = [null, "7px", "16px", "24px"];

const results = [];
const failures = [];
/** Every plan title the run can show: fixture titles + HARD_TITLES. */
const knownTitles = new Set();
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const strip = (s) => s.replace(/\s+/g, "");
const consoleErrors = [];
let server;
let serverLogs = "";

async function freePort() {
	const listener = net.createServer();
	listener.listen(0, "127.0.0.1");
	await once(listener, "listening");
	const port = listener.address().port;
	await new Promise((resolve) => listener.close(resolve));
	return port;
}

function seedData() {
	const data = path.join(home, "data");
	fs.cpSync(path.join(root, "tests/fixtures/golden-data"), data, { recursive: true });
	// The hard-titles chat: the fixture teaching chat with every plan title
	// swapped (same ids, same edges — the real 14-node shape).
	const chat = JSON.parse(fs.readFileSync(path.join(data, "chats", `${FIXTURE_CHAT}.json`), "utf8"));
	const ids = [];
	for (const m of chat.messages) {
		const nodes = m.role === "toolResult" && m.toolName === "plan_init" ? m.details?.tree?.nodes : m.customType === "plan-block" ? m.details?.block?.nodes : null;
		if (!nodes) continue;
		for (const n of nodes) {
			if (!ids.includes(n.id)) ids.push(n.id);
			knownTitles.add(n.title);
		}
	}
	for (const t of HARD_TITLES) knownTitles.add(t);
	assert.equal(ids.length, HARD_TITLES.length, "one hard title per fixture plan node");
	const titleOf = new Map(ids.map((id, i) => [id, HARD_TITLES[i]]));
	for (const m of chat.messages) {
		for (const nodes of [m.details?.tree?.nodes, m.details?.block?.nodes]) for (const n of nodes ?? []) if (titleOf.has(n.id)) n.title = titleOf.get(n.id);
	}
	for (const n of chat.tree?.nodes ?? []) if (titleOf.has(n.id)) n.title = titleOf.get(n.id);
	chat.id = HARD_CHAT;
	chat.title = "Plan label smoke (#671)";
	fs.writeFileSync(path.join(data, "chats", `${HARD_CHAT}.json`), JSON.stringify(chat));
	// Same chat ending on one unanswered ask_user_question: the dock band then
	// shows the plan marginalia beside the pending question.
	const ask = chat.messages.find((m) => m.role === "assistant" && m.content?.some((p) => p.type === "toolCall" && p.name === "ask_user_question"));
	assert.ok(ask, "fixture has an ask_user_question call to copy");
	const pending = structuredClone(ask);
	pending.content = pending.content.filter((p) => p.type === "toolCall" && p.name === "ask_user_question").map((p) => ({ ...p, id: "call_smoke671_pending" }));
	pending.timestamp = (chat.messages.at(-1)?.timestamp ?? Date.now()) + 1;
	chat.messages.push(pending);
	chat.id = PENDING_CHAT;
	chat.title = "Plan label smoke, pending question (#671)";
	fs.writeFileSync(path.join(data, "chats", `${PENDING_CHAT}.json`), JSON.stringify(chat));
	return data;
}

async function startServer(data) {
	if (!fs.existsSync(path.join(root, ".next", "BUILD_ID"))) throw new Error("No production build: run `npm run build` first.");
	const port = await freePort();
	const env = { ...process.env, NODE_ENV: "production", LH_DATA_DIR: data, LH_AUTH_FILE: path.join(home, "auth.json"), LH_IGNORE_ENV_KEYS: "1", NEXT_TELEMETRY_DISABLED: "1" };
	server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
	server.stdout.on("data", (d) => (serverLogs += d));
	server.stderr.on("data", (d) => (serverLogs += d));
	const origin = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 90_000;
	for (;;) {
		if (server.exitCode !== null) throw new Error(`Server exited: ${serverLogs}`);
		try {
			if ((await fetch(`${origin}/api/chats`)).ok) return origin;
		} catch {}
		if (Date.now() > deadline) throw new Error(`Server never answered: ${serverLogs}`);
		await new Promise((r) => setTimeout(r, 500));
	}
}

async function stopServer() {
	if (!server || server.exitCode !== null) return;
	const exited = once(server, "exit");
	server.kill("SIGTERM");
	const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
	await exited;
	clearTimeout(timer);
}

/** Two frames + a beat: the ResizeObserver re-measure commits before paint. */
async function settle(page) {
	await page.evaluate(() => document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))));
	await new Promise((r) => setTimeout(r, 150));
}

/** Every label line of every plan diagram under `scope`: width + vertical ink vs its box. */
async function measureLabels(page, scope) {
	return page.evaluate((scopeSel) => {
		const rows = [];
		document.querySelectorAll(`${scopeSel} svg[aria-label="Plan diagram"]`).forEach((svg, diagram) => {
			for (const g of svg.querySelectorAll("[data-testid^=plan-node-]")) {
				const rect = g.querySelector("rect");
				const W = Number(rect.getAttribute("width"));
				const H = Number(rect.getAttribute("height"));
				for (const t of g.querySelectorAll("text")) {
					const box = t.getBBox();
					rows.push({ diagram, node: g.dataset.testid, text: t.textContent, font: getComputedStyle(t).fontFamily.slice(0, 40), size: getComputedStyle(t).fontSize, W, H, width: t.getComputedTextLength(), top: box.y, bottom: box.y + box.height });
				}
			}
		});
		return rows;
	}, scope);
}

function check(label, rows, size = null) {
	assert.ok(rows.length > 0, `${label}: no plan labels found`);
	const wrongSize = rows.filter((r) => r.size !== (size ?? "11px"));
	if (wrongSize.length) {
		failures.push({ label, bad: [`label size ${wrongSize[0].size}, expected ${size ?? "11px"}: the size override did not apply`] });
		console.log(`FAIL ${label}: labels render at ${wrongSize[0].size}, not ${size ?? "11px"}`);
		return;
	}
	const bad = rows.filter((r) => r.width > r.W - 2 * PAD_X + SLACK || r.top < -SLACK || r.bottom > r.H + SLACK);
	bad.push(...lineBreakProblems(rows));
	results.push({ label, labels: rows.length, failing: bad.length, worst: bad.slice(0, 5) });
	if (bad.length) failures.push({ label, bad: bad.slice(0, 5) });
	console.log(`${bad.length ? "FAIL" : "ok  "} ${label}: ${rows.length} label lines${bad.length ? `, ${bad.length} problems, e.g. ${JSON.stringify(bad[0])}` : ""}`);
}

/** Line breaks the browser chose, per node: no text lost or reordered, no
 *  word split (in spaced scripts every token is one whole word of the
 *  title), no line starting with closing punctuation or ending with an
 *  opening mark. */
function lineBreakProblems(rows) {
	const problems = [];
	const byNode = new Map();
	for (const r of rows) {
		const key = `${r.diagram}/${r.node}`;
		byNode.set(key, [...(byNode.get(key) ?? []), r.text]);
	}
	for (const [node, lines] of byNode) {
		const title = [...knownTitles].find((t) => strip(t) === strip(lines.join("")));
		if (title === undefined) {
			problems.push({ node, lines, problem: "text lost or changed" });
			continue;
		}
		const words = new Set(title.split(/\s+/));
		for (const line of lines) {
			for (const token of line.split(/\s+/).filter(Boolean)) {
				if (!NO_SPACE_SCRIPT.test(token) && !words.has(token)) problems.push({ node, lines, problem: `word split: "${token}"` });
			}
			if (/^[,.;:!?)\]}、。」』）’”]/u.test(line)) problems.push({ node, lines, problem: `line starts with closing punctuation: "${line}"` });
			if (/[([{「『（‘“]$/u.test(line)) problems.push({ node, lines, problem: `line ends with opening mark: "${line}"` });
		}
	}
	return problems;
}

async function setFont(page, stack, size) {
	await page.evaluate(
		(s, z) => {
			const style = document.documentElement.style;
			if (s) style.setProperty("--font-prose", `${s}, var(--font-sans3), ui-sans-serif, system-ui, sans-serif`);
			else style.removeProperty("--font-prose");
			let rule = document.getElementById("smoke-label-size");
			if (!rule) {
				rule = document.createElement("style");
				rule.id = "smoke-label-size";
				document.head.appendChild(rule);
			}
			rule.textContent = z ? `svg[aria-label="Plan diagram"] .text-xs { font-size: ${z} !important; }` : "";
		},
		stack,
		size,
	);
	await settle(page);
}

/** Element screenshot after scrolling it to the top and letting layout settle. */
async function shoot(page, selector, file) {
	await page.$eval(selector, (el) => el.scrollIntoView({ block: "start" }));
	await settle(page);
	await (await page.$(selector)).screenshot({ path: path.join(out, file) });
}

/** Load a chat and wait until its plans are final: React has hydrated the
 *  diagrams (the server HTML is the chart's rough first paint, by design),
 *  the reading font matches `font` when given (Settings applies it after its
 *  own fetch), and box widths hold still for three polls in a row. */
async function openChat(page, origin, id, font) {
	await page.goto(`${origin}/chat/${id}`, { waitUntil: "load", timeout: 120_000 });
	await page.waitForSelector("[data-testid=plan-block-full] svg", { timeout: 60_000 });
	await page.waitForFunction(
		(fontPattern) => {
			const svg = document.querySelector("[data-testid=plan-block-full] svg[aria-label='Plan diagram']");
			const hydrated = svg && Object.keys(svg).some((k) => k.startsWith("__reactFiber"));
			return hydrated && (!fontPattern || new RegExp(fontPattern).test(getComputedStyle(svg).fontFamily));
		},
		{ timeout: 30_000 },
		font ?? null,
	);
	let last = "";
	for (let same = 0, tries = 0; same < 3 && tries < 40; tries++) {
		await settle(page);
		const now = await page.$$eval("[data-testid^=plan-node-] rect", (rects) => rects.map((r) => r.getAttribute("width")).join());
		same = now === last ? same + 1 : 0;
		last = now;
	}
}

async function main() {
	fs.mkdirSync(out, { recursive: true });
	const origin = await startServer(seedData());
	const browser = await puppeteer.launch({
		headless: true,
		...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }),
		defaultViewport: { width: 1600, height: 2400 },
		// Ubuntu 24.04 runners block Chrome's user-namespace sandbox (same flag
		// as scripts/smoke-demo-runtime.mjs); the page is our own local server.
		args: process.platform === "linux" ? ["--no-sandbox"] : [],
	});
	try {
		const page = await browser.newPage();
		page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
		page.on("pageerror", (e) => consoleErrors.push(e.message));

		// 1. Font × size matrix, live (no reload), on both chats.
		for (const chat of [FIXTURE_CHAT, HARD_CHAT]) {
			await openChat(page, origin, chat);
			for (const [name, stack] of FONTS) {
				for (const size of SIZES) {
					await setFont(page, stack, size);
					check(`${chat === HARD_CHAT ? "hard titles" : "fixture plan"} · ${name} · ${size ?? "11px"}`, await measureLabels(page, "[data-testid=plan-block-full]"), size);
				}
				await setFont(page, stack, null);
				await shoot(page, "[data-testid=plan-block-full]", `${chat === HARD_CHAT ? "hard" : "fixture"}-${name.replace(/\W+/g, "_")}.png`);
			}
			await setFont(page, null, null);
		}

		// 2. Popup (the live plan) on the hard titles, default + mono + big.
		await openChat(page, origin, HARD_CHAT);
		await page.click("[data-testid=plan-chip]");
		await page.waitForSelector("[data-testid=plan-popup] svg[aria-label='Plan diagram']");
		for (const [name, stack, size] of [["default", null, null], ["JetBrains Mono", FONTS[1][1], null], ["JetBrains Mono", FONTS[1][1], "24px"]]) {
			await setFont(page, stack, size);
			check(`popup · hard titles · ${name} · ${size ?? "11px"}`, await measureLabels(page, "[data-testid=plan-popup]"), size);
		}
		await (await page.$("[data-testid=plan-popup]")).screenshot({ path: path.join(out, "popup-hard-mono-24px.png") });
		await setFont(page, null, null);
		await page.click("[data-testid=plan-popup-close]");

		// 2b. Dock band marginalia beside a pending question.
		await openChat(page, origin, PENDING_CHAT);
		await page.waitForSelector("[data-testid=plan-marginalia] svg[aria-label='Plan diagram']", { visible: true, timeout: 30_000 });
		for (const [name, stack, size] of [["default", null, null], ["JetBrains Mono", FONTS[1][1], null], ["JetBrains Mono", FONTS[1][1], "16px"]]) {
			await setFont(page, stack, size);
			check(`dock marginalia · hard titles · ${name} · ${size ?? "11px"}`, await measureLabels(page, "[data-testid=plan-marginalia]"), size);
		}
		await (await page.$("[data-testid=plan-marginalia]")).screenshot({ path: path.join(out, "marginalia-hard-mono-16px.png") });
		await setFont(page, null, null);

		// 3. The real user path: pick JetBrains Mono in Settings, no reload.
		await openChat(page, origin, FIXTURE_CHAT);
		const click = async (sel) => (await page.waitForSelector(sel, { visible: true, timeout: 30_000 })).click();
		await click("[data-testid=settings-entry]");
		await click("[data-testid=settings-nav-appearance]");
		await click("[data-testid=font-trigger]");
		await page.waitForSelector("[data-testid=font-search]", { visible: true });
		await page.type("[data-testid=font-search]", "JetBrains Mono");
		await new Promise((r) => setTimeout(r, 500));
		await page.keyboard.press("Enter");
		await new Promise((r) => setTimeout(r, 3000)); // the settings PUT
		await page.keyboard.press("Escape");
		await settle(page);
		const live = await measureLabels(page, "[data-testid=plan-block-full]");
		assert.match(live[0].font, /JetBrains Mono/, "Settings switched the plan labels to JetBrains Mono");
		check("Settings → JetBrains Mono, no reload", live);
		await (await page.$("[data-testid=plan-block-full]")).screenshot({ path: path.join(out, "settings-switch-mono.png") });

		// 4. Cold load in that font (server HTML first, then measured) — no hydration errors.
		consoleErrors.length = 0;
		for (const chat of [FIXTURE_CHAT, HARD_CHAT]) {
			await openChat(page, origin, chat, "JetBrains Mono");
			check(`cold load in JetBrains Mono · ${chat === HARD_CHAT ? "hard titles" : "fixture plan"}`, await measureLabels(page, "[data-testid=plan-block-full]"));
		}
		// Production React minifies its hydration errors (#418 text, #423
		// recoverable, #425 text content…), so match the codes too.
		const hydration = consoleErrors.filter((e) => /hydrat|Minified React error #(418|419|421|422|423|425)\b/i.test(e));
		results.push({ label: "hydration errors on cold load", errors: hydration });
		console.log(`${hydration.length ? "FAIL" : "ok  "} hydration errors on cold load: ${hydration.length}`);
		if (hydration.length) failures.push({ label: "hydration", bad: hydration });
	} finally {
		await browser.close();
		await stopServer();
		fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ failures, results, consoleErrors }, null, 2));
		fs.rmSync(home, { recursive: true, force: true });
	}
	console.log(`\n${failures.length ? `FAILED: ${failures.length} checks` : "All plan label checks passed"}. Evidence: ${out}`);
	process.exitCode = failures.length ? 1 : 0;
}

main().catch(async (error) => {
	console.error(error);
	await stopServer();
	process.exitCode = 1;
});
