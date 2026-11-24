/** Production UI checks with throwaway data/auth and an installed browser.
 * No provider calls. Exercises phone layouts, real uploads, shared sessions,
 * settings, graph/plan controls, and desktop layout in the same app build. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "..");
const development = process.argv.includes("--dev");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "lh-mobile-ui-"));
const data = path.join(temporary, "data");
await fs.cp(path.join(root, "tests/fixtures/golden-data"), data, { recursive: true });
const teachFile = path.join(data, "chats/chat_mv27rrra_feff23b6.json");
const teach = JSON.parse(await fs.readFile(teachFile, "utf8"));
const assistant = [...teach.messages].reverse().find(message => message.role === "assistant");
teach.messages.push({ ...assistant, id: "mobile-pending-question", stopReason: "toolUse", timestamp: Date.now(), content: [{ type: "toolCall", id: "mobile-q1", name: "quiz", arguments: {
	question: "Does this question remain usable on a narrow phone?", options: [{ label: "Yes, with the same answer controls", value: "yes" }, { label: "No", value: "no" }], correctAnswer: "yes", explanation: "The phone uses the same question form.",
} }] });
await fs.writeFile(teachFile, JSON.stringify(teach));
await fs.writeFile(path.join(temporary, "auth.json"), "{}");
const listener = net.createServer().listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: temporary, TMP: temporary, HOME: temporary, USERPROFILE: temporary,
	NODE_ENV: development ? "development" : "production", ...(development ? { LH_MOBILE_SMOKE: "1" } : {}), LH_DATA_DIR: data, LH_AUTH_FILE: path.join(temporary, "auth.json") };
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", development ? "dev" : "start", "-H", "127.0.0.1", "-p", String(port)], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let logs = ""; server.stdout.on("data", value => logs += value); server.stderr.on("data", value => logs += value);
let browser, desktop, desktopBrowser;
const screenshotDirectory = process.env.LH_MOBILE_SCREENSHOTS;
const errors = [];
const summary = [];
let sidebar;
try {
	const deadline = Date.now() + 60000;
	while (true) {
		try { if ((await fetch(origin)).ok) break; } catch { /* Server startup. */ }
		if (Date.now() > deadline || server.exitCode !== null) throw new Error(`Server startup failed: ${logs.slice(-3000)}`);
		await new Promise(resolve => setTimeout(resolve, 300));
	}
	browser = await puppeteer.launch({ executablePath: process.env.LH_TEST_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, userDataDir: path.join(temporary, "browser"), args: ["--disable-background-networking", "--disable-sync", "--no-first-run"] });
	const page = await browser.newPage();
	page.on("pageerror", error => errors.push(error.message));
	await page.setRequestInterception(true);
	page.on("request", request => {
		const url = new URL(request.url());
		if (url.origin === origin || ["data:", "blob:", "about:"].includes(url.protocol)) void request.continue();
		else void request.abort();
	});
	const open = async url => {
		await page.goto(url, { waitUntil: "domcontentloaded" });
		if (development) await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
		if (await page.evaluate(() => innerWidth < 768 || matchMedia("(pointer: coarse)").matches && innerWidth < 1024)) await page.waitForSelector("html[data-lh-mobile]");
	};
	if (!process.argv.includes("--desktop-only")) {
	for (const [width, height] of [[320, 568], [390, 844], [430, 932], [844, 390]]) {
		await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
		await open(origin);
		await page.waitForSelector("html[data-lh-mobile]");
		const geometry = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, width: innerWidth, shell: document.querySelector(".lh-app-shell").getBoundingClientRect().width }));
		assert.ok(geometry.document <= geometry.width + 1, `No page overflow at ${width}: ${JSON.stringify(geometry)}`);
		await page.click('button[aria-label="Open sidebar"]');
		await page.waitForSelector('.lh-mobile-drawer [data-testid="session-row"]');
		await page.$eval(".lh-mobile-drawer", async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
		const drawer = await page.$eval(".lh-mobile-drawer", element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, hidden: !!element.closest("[inert]"), focus: element.contains(document.activeElement) }));
		assert.ok(Math.abs(drawer.width - Math.min(width * .86, 360)) <= 1); assert.equal(drawer.hidden, false);
		await page.click('.lh-mobile-drawer .lh-mobile-row-action');
		await page.waitForSelector('[data-testid="session-context-menu"]');
		assert.ok(await page.$('[data-testid="ctx-rename"]'));
		assert.ok(await page.$('[data-testid="ctx-export-md"]'));
		await page.keyboard.press("Escape");
		await page.click('[data-testid="settings-entry"]');
		await page.waitForSelector('[data-testid="settings-dialog"]');
		await page.waitForFunction(() => Math.abs(document.querySelector('[data-testid="settings-dialog"]').getBoundingClientRect().width - innerWidth) <= 1);
		const settings = await page.$eval('[data-testid="settings-dialog"]', element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
		assert.ok(Math.abs(settings.width - width) <= 1, `Settings fills ${width}`);
		await page.click('[data-testid="settings-nav-general"]');
		await page.waitForSelector('[data-testid="mobile-access-settings"]');
		await page.click('[data-testid="settings-close"]');
		await page.waitForSelector('[data-testid="settings-dialog"]', { hidden: true });
		if (screenshotDirectory) { await fs.mkdir(screenshotDirectory, { recursive: true }); await page.screenshot({ path: path.join(screenshotDirectory, `home-${width}.png`) }); }
		summary.push({ width, height, drawer: true, settings: true, actions: true, noPageOverflow: true });
	}
	await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
	await open(origin);
	const file = path.join(temporary, "phone-notes.txt"); await fs.writeFile(file, "Notes uploaded from a phone smoke test.");
	await page.click('[data-testid="attach-files"]');
	await page.waitForSelector('[data-testid="attachment-popup"]');
	const input = await page.$('[data-testid="attach-files-input"]');
	const uploaded = page.waitForResponse(response => response.url().endsWith("/api/attachments") && response.request().method() === "POST");
	await input.uploadFile(file);
	const uploadResult = await (await uploaded).json();
	assert.ok(uploadResult.paths?.[0]?.startsWith(path.join(data, "attachments")));
	assert.equal(await fs.readFile(uploadResult.paths[0], "utf8"), "Notes uploaded from a phone smoke test.");
	await page.waitForFunction(() => document.querySelector('[contenteditable]')?.textContent?.includes("phone-notes.txt"));
	const created = await page.evaluate(async () => { const reply = await fetch("/api/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Mobile parity smoke session" }) }); return reply.json(); });
	await open(`${origin}/chat/${created.id}`);
	await page.waitForSelector('[data-testid="composer"]');
	const sessionGeometry = await page.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth, composer: document.querySelector('[data-testid="composer"]').getBoundingClientRect().toJSON() }));
	assert.ok(sessionGeometry.overflow <= sessionGeometry.width + 1);
	assert.ok(sessionGeometry.composer.right <= 390 && sessionGeometry.composer.bottom <= 844);
	if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, "session-390.png") });
	await open(`${origin}/chat/chat_mv27rrra_feff23b6`);
	await page.waitForSelector('[data-testid="plan-chip"]');
	await page.click('[data-testid="plan-chip"]');
	await page.waitForSelector('[data-testid="plan-popup"]');
	await page.click('[data-testid="plan-popup-close"]');
	await page.waitForSelector('[data-testid="question-dock"]');
	// Teach-phase checks arrive collapsed behind their reveal button.
	if (await page.$('[data-testid="teach-check-reveal"]')) await page.click('[data-testid="teach-check-reveal"]');
	await page.waitForSelector('[data-testid="question-dock"] [role="radio"]', { visible: true });
	await page.click('[data-testid="question-dock"] [role="radio"]');
	const question = await page.$eval('[data-testid="question-dock"]', element => ({ width: element.getBoundingClientRect().width, selected: !!element.querySelector('[aria-checked="true"]') }));
	assert.ok(question.width <= 390); assert.equal(question.selected, true);
	await page.$eval('[data-testid="side-conversation-button"]', element => element.click());
	await page.waitForSelector('[data-testid="side-thread-popover"]');
	const side = await page.$eval('[data-testid="side-thread-popover"]', element => element.getBoundingClientRect().toJSON());
	assert.ok(Math.abs(side.width - 390) <= 1 && Math.abs(side.height - 844) <= 1);
	await page.type('[data-testid="side-thread-input"]', "A saved side-question draft");
	await page.click('[aria-label="Close side conversation"]');
	if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, "question-390.png") });
	await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
	await open(origin);
	await page.waitForFunction(() => !document.documentElement.hasAttribute("data-lh-mobile"));
	await page.waitForFunction(() => Math.abs(document.querySelector("aside").getBoundingClientRect().width - 288) <= 1);
	sidebar = await page.$eval("aside", element => ({ width: element.getBoundingClientRect().width, mobile: element.classList.contains("lh-mobile-drawer") }));
	assert.equal(sidebar.mobile, false); assert.ok(Math.abs(sidebar.width - 288) <= 1);
	assert.deepEqual(errors, []);
	}
	let nativeViewport = false;
	if (process.argv.includes("--desktop") || process.argv.includes("--desktop-only")) {
		const require = createRequire(import.meta.url);
		const launcher = path.join(temporary, "desktop-smoke.cjs");
		await fs.writeFile(launcher, `const {app}=require('electron'); app.setPath('userData',${JSON.stringify(path.join(temporary, "desktop-profile"))}); app.commandLine.appendSwitch('remote-debugging-port','0'); require(${JSON.stringify(path.join(root, "electron/main.cjs"))});`);
		desktop = spawn(require("electron"), [launcher], { cwd: root, env: { ...env, LH_DEV_URL: origin }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let desktopLogs = "";
		desktop.stdout.on("data", value => desktopLogs += value); desktop.stderr.on("data", value => desktopLogs += value);
		const deadline = Date.now() + 45000;
		while (!/DevTools listening on (ws:\/\/[^\s]+)/.test(desktopLogs)) {
			if (desktop.exitCode !== null || Date.now() > deadline) throw new Error(`Desktop startup failed: ${desktopLogs.slice(-2000)}`);
			await new Promise(resolve => setTimeout(resolve, 200));
		}
		desktopBrowser = await puppeteer.connect({ browserWSEndpoint: desktopLogs.match(/DevTools listening on (ws:\/\/[^\s]+)/)[1], defaultViewport: null });
		const main = await desktopBrowser.waitForTarget(target => target.type() === "page" && target.url().startsWith(origin)).then(target => target.page());
		await main.waitForFunction(() => !!window.lh?.mobile, { polling: 200 });
		assert.equal((await main.evaluate(() => window.lh.mobile.status())).enabled, false);
		await main.evaluate(() => window.lh.mobile.preview("phone"));
		const phone = await desktopBrowser.waitForTarget(target => target.type() === "page" && target.url().startsWith("http://127.0.0.1:") && !target.url().startsWith(origin)).then(target => target.page());
		phone.on("pageerror", error => errors.push(`viewport: ${error.message}`));
		phone.on("console", message => { if (["error", "warn"].includes(message.type())) console.log("Phone console", message.text()); });
		phone.on("requestfailed", request => console.log("Phone request failed", new URL(request.url()).pathname, request.failure()?.errorText));
		phone.on("response", response => { if (response.status() >= 400) console.log("Phone HTTP error", new URL(response.url()).pathname, response.status()); });
		await phone.reload({ waitUntil: "domcontentloaded" });
		await phone.waitForSelector("html[data-lh-mobile]");
		await phone.waitForFunction(() => !!window.lh?.mobileRemote, { polling: 200 });
		const phoneState = await phone.evaluate(async () => ({ width: innerWidth, nativePaths: !!window.lh?.getPathForFile, status: await (await fetch("/api/mobile-access")).json(), update: await window.lh.getUpdateState() }));
		assert.equal(phoneState.width, 390); assert.equal(phoneState.nativePaths, false); assert.equal(phoneState.status.remote, true); assert.equal(phoneState.status.enabled, false); assert.equal(phoneState.update.status, "disabled");
		await main.evaluate(() => window.lh.mobile.preview("compact"));
		await phone.waitForFunction(() => innerWidth === 320, { polling: 200 });
		nativeViewport = true;
	}
	console.log(JSON.stringify({ ok: true, layouts: summary, phoneUpload: !!summary.length, sessionComposer: !!summary.length, planAndQuestion: !!summary.length, sideConversation: !!summary.length, desktopSidebar: sidebar, nativeViewport, pageErrors: errors }, null, 2));
} catch (error) {
	console.error(error); console.error(logs.slice(-3000));
	if (desktopBrowser) { for (const page of await desktopBrowser.pages()) { console.error("Desktop diagnostic", await page.evaluate(async () => ({ url: location.origin, width: innerWidth, title: document.title, platform: window.lh?.platform, mobile: document.documentElement.hasAttribute("data-lh-mobile"), remote: !!window.lh?.mobileRemote,
				gateway: await fetch("/api/mobile-access", { cache: "no-store" }).then(async reply => `${reply.status} ${await reply.text()}`).catch(error => String(error)) })).catch(() => ({}))); if (screenshotDirectory && page.url() !== "about:blank") await page.screenshot({ path: path.join(screenshotDirectory, `desktop-failure-${(await page.evaluate(() => innerWidth))}.png`) }).catch(() => {}); } }
	if (browser && screenshotDirectory) { await fs.mkdir(screenshotDirectory, { recursive: true }); const pages = await browser.pages(); await pages.at(-1)?.screenshot({ path: path.join(screenshotDirectory, "failure.png") }); }
	process.exitCode = 1;
} finally {
	await browser?.close();
	if (desktopBrowser) { try { await desktopBrowser.close(); } catch { desktop?.kill(); } } else desktop?.kill();
	server.kill();
	if (server.exitCode === null) await Promise.race([once(server, "exit"), new Promise(resolve => setTimeout(resolve, 5000))]);
	await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

