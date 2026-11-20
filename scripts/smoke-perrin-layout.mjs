/** Local-only browser acceptance. Uses synthetic sessions, no inference.
 * Start a disposable dev server, then set LH_UI_ORIGIN and LH_TEST_CHROME.
 * Optional LH_UI_SCREENSHOTS saves review images outside the repository. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const origin = process.env.LH_UI_ORIGIN;
assert(origin && ["localhost", "127.0.0.1"].includes(new URL(origin).hostname), "Set a local LH_UI_ORIGIN");
const browser = await puppeteer.launch({ executablePath: process.env.LH_TEST_CHROME, headless: true,
	args: ["--disable-background-networking", "--disable-sync", "--no-first-run"] });
const title = "操作系统 死锁之前 简答题加计算题考查 英文题目 — 长标题布局验证";
const shots = process.env.LH_UI_SCREENSHOTS;
if (shots) await fs.mkdir(shots, { recursive: true });
try {
	const page = await browser.newPage();
	page.setDefaultTimeout(45000);
	const errors = [];
	page.on("pageerror", e => errors.push(e.message));
	await page.setViewport({ width: 1440, height: 1000 });
	await page.goto(origin, { waitUntil: "networkidle2" });
	const id = await page.evaluate(async title => {
		const response = await fetch("/api/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
		if (!response.ok) throw new Error("Synthetic session creation failed");
		const { id } = await response.json();
		const renamed = await fetch(`/api/chats/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
		if (!renamed.ok) throw new Error("Synthetic session rename failed");
		return id;
	}, title);
	await page.goto(`${origin}/chat/${id}`, { waitUntil: "networkidle2" });
	await page.waitForSelector("button[data-plugin-chrome-title]");
	const inspectTitle = () => page.$eval("button[data-plugin-chrome-title]", el => ({
		font: getComputedStyle(el).fontSize, width: el.getBoundingClientRect().width,
		parent: el.closest("header").getBoundingClientRect().width, title: el.title,
		truncated: el.scrollWidth > el.clientWidth, translate: getComputedStyle(el).translate, height: el.getBoundingClientRect().height, balance: Math.abs((el.getBoundingClientRect().top-el.closest("header").getBoundingClientRect().top)-(el.closest("header").getBoundingClientRect().bottom-el.getBoundingClientRect().bottom)),
	}));
	const desktop = await inspectTitle();
	assert.equal(desktop.font, "20px"); assert.equal(desktop.title, title);
	assert.equal(desktop.translate, "none"); assert.equal(desktop.height,44); assert(desktop.balance<=1.1);
	const columnGeometry=await page.evaluate(()=>{const col=document.querySelector("[data-session-find-root]"),dock=document.querySelector("[data-attachment-composer]"); const c=col.getBoundingClientRect(),d=dock.getBoundingClientRect(),style=getComputedStyle(col);return {col:{left:c.left,right:c.right,width:c.width},dock:{left:d.left,right:d.right,width:d.width},left:Math.abs(d.left-c.left-parseFloat(style.paddingLeft)),right:Math.abs(c.right-parseFloat(style.paddingRight)-d.right)};});
	console.log("Column geometry",columnGeometry); assert(columnGeometry.left<=1.1 && columnGeometry.right<=1.1);
	assert(desktop.width <= desktop.parent * .71);
	if (shots) await page.screenshot({ path: path.join(shots, "perrin-session-desktop.png") });
	await page.click("button[data-plugin-chrome-title]");
	await page.waitForSelector('input[aria-label="Session title"]');
	await page.keyboard.press("Escape");
	await page.waitForSelector("button[data-plugin-chrome-title]");
	await page.click('[data-testid="settings-entry"]');
	await page.waitForSelector('[data-testid="section-keys"]');
	await page.$eval('[data-testid="settings-dialog"]', async el => {
		await Promise.all(el.getAnimations({ subtree: true }).filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
	});
	assert.equal(await page.$eval('[data-testid="settings-nav-keys"]', el => Math.round(el.getBoundingClientRect().height)), 44);
	await page.click('[data-testid="settings-nav-appearance"]');
	await page.waitForSelector('[data-testid="section-appearance"]');
	if (shots) await page.screenshot({ path: path.join(shots, "perrin-settings-desktop.png") });
	const palette = await page.evaluate(() => Object.fromEntries(["--background", "--foreground", "--card", "--border"].map(k => [k, getComputedStyle(document.documentElement).getPropertyValue(k).trim()])));
	assert.deepEqual(palette, { "--background": "#141414", "--foreground": "#e6e6e6", "--card": "#1c1c1c", "--border": "#434343" });
	await page.setViewport({ width: 390, height: 844 });
	assert.equal(await page.$eval('[data-testid="settings-nav"]', el => getComputedStyle(el).flexDirection), "row");
	const overflow = await page.$eval('[data-testid="settings-dialog"]', el => el.scrollWidth > el.clientWidth);
	assert.equal(overflow, false);
	if (shots) await page.screenshot({ path: path.join(shots, "perrin-settings-mobile.png") });
	await page.click('[data-testid="settings-close"]');
	await page.waitForFunction(() => !document.querySelector('[data-testid="settings-dialog"]'));
	assert.equal((await inspectTitle()).font, "20px");
	assert.deepEqual(errors, []);
	console.log("Perrin browser acceptance passed: title size/truncation/rename, settings navigation/close, narrow layout, unchanged palette; no inference.");
} finally { await browser.close(); }
