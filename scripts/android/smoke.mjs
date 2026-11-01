/** Runs against a disposable emulator, never a user's configured tablet. */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import puppeteer from "puppeteer-core";

const app = "ar.com.learnharness";
const artifacts = path.resolve("android/.generated/smoke");
await fs.mkdir(artifacts, { recursive: true });
const adb = (...args) => execFileSync("adb", args, { encoding: "utf8", timeout: 20000 });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function tapDocumentUi(attribute, value) {
	for (let i = 0; i < 8; i++) {
		adb("shell", "uiautomator", "dump", "/sdcard/lh-picker.xml");
		const xml = adb("shell", "cat", "/sdcard/lh-picker.xml");
		const node = [...xml.matchAll(/<node\b[^>]*>/g)].map((match) => match[0]).find((node) => node.includes(`${attribute}="${value}"`));
		const bounds = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
		if (bounds) { adb("shell", "input", "tap", String(Math.floor((+bounds[1] + +bounds[3]) / 2)), String(Math.floor((+bounds[2] + +bounds[4]) / 2))); return; }
		await pause(500);
	}
	throw new Error(`Android file picker control unavailable: ${value}`);
}
let forwarding;
let browser;
async function start() {
	adb("shell", "am", "start", "-n", `${app}/.MainActivity`);
	let config;
	for (let i = 0; i < 120; i++) {
		try { config = JSON.parse(adb("shell", "run-as", app, "cat", "no_backup/learnharness/launch.json")); break; } catch { await pause(1000); }
	}
	assert(config?.port && config.secret, "Android runtime must initialize its private storage");
	if (forwarding) adb("forward", "--remove", `tcp:${forwarding}`);
	forwarding = adb("forward", "tcp:0", `tcp:${config.port}`).trim();
	const origin = `http://127.0.0.1:${config.port}`;
	const request = (route, options = {}) => fetch(`http://127.0.0.1:${forwarding}${route}`, {
		...options, headers: { Host: `127.0.0.1:${config.port}`, Cookie: `lh_android=${config.secret}`, Origin: origin, "Content-Type": "application/json", "x-learnharness-subscriptions": "1", ...options.headers }, signal: AbortSignal.timeout(5000),
	});
	let ready = false;
	for (let i = 0; i < 90; i++) {
		try { if ((await request("/api/subscriptions")).status === 200) { ready = true; break; } } catch { /* startup */ }
		await pause(1000);
	}
	assert(ready, "Bundled Android Node must serve the subscription API");
	return { request, origin };
}
try {
	adb("install", "-r", "android/app/build/outputs/apk/debug/app-x86_64-debug.apk");
	adb("shell", "wm", "size", "1600x2560"); adb("shell", "wm", "density", "320");
	adb("shell", "settings", "put", "system", "accelerometer_rotation", "0");
	adb("shell", "settings", "put", "system", "user_rotation", "0");
	let { request, origin } = await start();
	assert.equal((await request("/api/chats", { headers: { Cookie: "" } })).status, 403);
	assert.equal((await request("/", { headers: { Cookie: "" } })).status, 403);
	assert.equal((await request("/api/chats", { method: "POST", body: "{}", headers: { Origin: "https://example.com" } })).status, 403);
	const status = await (await request("/api/subscriptions")).json();
	assert.equal(status.chatgpt.available, true);
	const chat = await (await request("/api/chats", { method: "POST", body: JSON.stringify({ title: "Android persistence check" }) })).json();
	assert(chat.id);

	const pid = adb("shell", "pidof", app).trim().split(" ")[0];
	const debugPort = adb("forward", "tcp:0", `localabstract:webview_devtools_remote_${pid}`).trim();
	browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}` });
	let page;
	for (let i = 0; i < 30; i++) {
		page = (await browser.pages()).find((p) => p.url().startsWith(origin));
		if (page) break;
		await pause(500);
	}
	assert(page, "Native WebView must open the local app");
	await page.waitForFunction(() => document.querySelector("main") || document.querySelector("button"), { timeout: 30000 });
	assert.equal(await page.evaluate(() => document.cookie.includes("lh_android")), false, "Capability must be HttpOnly");
	await page.waitForFunction(() => document.documentElement.classList.contains("lh-android"), { timeout: 30000 });
	// A failed subscription request closes its reserved window. Native cleanup
	// must release the popup slot so the fourth and later attempts still work.
	await page.evaluate(() => {
		const button = document.createElement("button"); button.id = "qa-popup-retry"; button.textContent = "Retry check";
		button.style.cssText = "position:fixed;top:0;right:0;z-index:999999";
		button.onclick = () => { const tab = window.open("about:blank", "_blank"); window.__qaPopupOpened = !!tab; tab?.close(); };
		document.body.appendChild(button);
	});
	for (let i = 0; i < 6; i++) {
		await page.click("#qa-popup-retry");
		assert.equal(await page.evaluate(() => window.__qaPopupOpened), true, `Sign-in popup retry ${i + 1}`);
		await pause(200);
	}
	await page.evaluate(() => document.querySelector("#qa-popup-retry").remove());
	await fs.writeFile(path.join(artifacts, "portrait.png"), execFileSync("adb", ["exec-out", "screencap", "-p"]));
	adb("shell", "settings", "put", "system", "user_rotation", "1");
	await pause(1500);
	await fs.writeFile(path.join(artifacts, "landscape.png"), execFileSync("adb", ["exec-out", "screencap", "-p"]));
	const note = path.join(artifacts, "lh-smoke-notes.txt");
	await fs.writeFile(note, "Android native chooser smoke");
	adb("push", note, "/sdcard/Download/lh-smoke-notes.txt");
	await page.waitForSelector('[data-testid="import-notes"]', { visible: true });
	await page.evaluate(() => {
		const input = document.querySelector('input[type="file"][multiple]');
		input.addEventListener("change", async (event) => {
			event.stopImmediatePropagation(); // Test file bytes without starting paid extraction.
			window.__qaFileText = await input.files[0].text();
		}, { capture: true, once: true });
	});
	await page.click('[data-testid="import-notes"]');
	assert.deepEqual(await page.$$eval('[role="menu"][aria-label="Import notes"] [role="menuitem"]', (items) => items.map((item) => item.textContent)), ["Files"]);
	await page.click('[role="menu"][aria-label="Import notes"] [role="menuitem"]');
	await tapDocumentUi("content-desc", "Show roots");
	await tapDocumentUi("text", "Downloads");
	await tapDocumentUi("text", "lh-smoke-notes.txt");
	await page.waitForFunction(() => window.__qaFileText === "Android native chooser smoke", { timeout: 15000 });

	// Exercise the actual web subscription flow. No account or paid inference
	// is used: merely open the OpenAI authorization page, then cancel.
	const login = await (await request("/api/subscriptions", { method: "POST", body: JSON.stringify({ providerId: "chatgpt", op: "login" }) })).json();
	assert.match(login.browserAction, /^\/api\/subscriptions\/browser\?id=/);
	const external = await request(login.browserAction, { redirect: "manual", headers: { "sec-fetch-site": "same-origin" } });
	assert.equal(external.status, 303);
	const authorization = new URL(external.headers.get("location"));
	assert.equal(authorization.origin, "https://auth.openai.com");
	assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
	assert(authorization.searchParams.get("scope").includes("chatgpt.tokens.use.direct"));
	await request("/api/subscriptions", { method: "POST", body: JSON.stringify({ providerId: "chatgpt", op: "cancel" }) });
	const needsSidebar = await page.$eval("aside.sidebar-motion", (aside) => aside.getBoundingClientRect().width === 0);
	if (needsSidebar) await page.click('[aria-label="Open sidebar"]');
	await page.click('[data-testid="settings-entry"]');
	await page.click('[data-testid="settings-nav-keys"]');
	await page.waitForSelector('[data-testid="chatgpt-login"]:not([disabled])', { visible: true });
	await page.click('[data-testid="chatgpt-login"]');
	await page.waitForSelector('[data-testid="chatgpt-proceed"]:not([disabled])', { visible: true });
	await page.click('[data-testid="chatgpt-proceed"]');
	let launched = false;
	for (let i = 0; i < 15; i++) {
		const activities = adb("shell", "dumpsys", "activity", "activities");
		if (activities.includes("https://auth.openai.com/") && /com\.android\.(chrome|browser)/.test(activities)) { launched = true; break; }
		await pause(500);
	}
	assert(launched, "Continue with ChatGPT must open the Android system browser");
	await request("/api/subscriptions", { method: "POST", body: JSON.stringify({ providerId: "chatgpt", op: "cancel" }) });
	await browser.disconnect(); browser = undefined;
	adb("shell", "am", "force-stop", app);
	adb("shell", "cmd", "connectivity", "airplane-mode", "enable");
	// Old launch configuration exists until the new process writes its own.
	adb("shell", "run-as", app, "rm", "no_backup/learnharness/launch.json");
	({ request } = await start());
	const saved = await (await request("/api/chats")).json();
	assert(saved.chats.some((entry) => entry.id === chat.id), "Learning sessions survive process restart and offline startup");
	console.log("Android smoke passed: native runtime, HTTP boundary, WebView, rotations, repeated popup cleanup, file selection, system-browser Pro sign-in launch, persistent offline sessions.");
} finally {
	if (browser) await browser.disconnect();
	try { adb("shell", "cmd", "connectivity", "airplane-mode", "disable"); } catch { }
	try { await fs.writeFile(path.join(artifacts, "logcat.txt"), adb("logcat", "-d", "-s", "LearnHarness:I", "LearnHarnessNode:I", "AndroidRuntime:E")); } catch { }
}
