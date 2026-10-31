/**
 * Mobile visual smoke (mobile-web, 2026-10-29).
 *
 * Drives system Chromium at 390×844 (iPhone 14 logical size) with a signed-in
 * session cookie injected, then captures the surfaces the mobile shell
 * changes: home/graph, a chat, the drawer, the dock sheet and settings.
 *
 * Usage:
 *   LH_COOKIE=$(node scripts/print-session.mjs <email>) \
 *   node scripts/mobile-shots.mjs http://127.0.0.1:3000 /tmp/lh-shots <chatId>
 */

import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const BASE = process.argv[2] ?? "http://127.0.0.1:3000";
const OUT = process.argv[3] ?? "/tmp/lh-shots";
const CHAT = process.argv[4];
const cookie = process.env.LH_COOKIE;
if (!cookie) throw new Error("LH_COOKIE is required (a signed lh_session value)");

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
	executablePath: "/usr/bin/chromium",
	headless: true,
	args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
});

async function page(url) {
	const p = await browser.newPage();
	await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
	await p.setUserAgent(
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
	);
	const { hostname } = new URL(BASE);
	await p.setCookie({ name: "lh_session", value: cookie, domain: hostname, path: "/", httpOnly: true });
	await p.goto(url, { waitUntil: "networkidle2", timeout: 45_000 });
	return p;
}

async function shot(p, name) {
	const file = path.join(OUT, `${name}.png`);
	await p.screenshot({ path: file });
	const metrics = await p.evaluate(() => ({
		scrollW: document.documentElement.scrollWidth,
		innerW: window.innerWidth,
		bodyOverflowX: getComputedStyle(document.body).overflowX,
	}));
	console.log(`${name}: ${file} scrollWidth=${metrics.scrollW} innerWidth=${metrics.innerW}`);
	return { file, metrics };
}

const results = [];

// Home (graph/chain view) at phone width.
const home = await page(`${BASE}/`);
await new Promise((r) => setTimeout(r, 1200));
results.push(await shot(home, "01-home-mobile"));

// Drawer open (hamburger lives in the top bar while the sidebar is closed).
const drawer = await page(`${BASE}/`);
await new Promise((r) => setTimeout(r, 800));
await drawer.click('[aria-label="Open sidebar"]');
await new Promise((r) => setTimeout(r, 450));
results.push(await shot(drawer, "02-drawer"));
const drawerState = await drawer.evaluate(() => {
	const aside = document.querySelector("aside");
	const backdrop = document.querySelector('[data-testid="sidebar-backdrop"]');
	return {
		asideTransform: aside ? getComputedStyle(aside).transform : null,
		asidePosition: aside ? getComputedStyle(aside).position : null,
		backdrop: !!backdrop,
		bodyOverflow: document.body.style.overflow,
	};
});
console.log("drawer state:", JSON.stringify(drawerState));

// Chat + dock sheet.
if (CHAT) {
	const chat = await page(`${BASE}/chat/${CHAT}`);
	await new Promise((r) => setTimeout(r, 1500));
	results.push(await shot(chat, "03-chat"));

	const dock = await chat.evaluate(() => {
		const el = document.querySelector('[data-dock-viewport]');
		const root = el?.closest('div[class*="max-md:fixed"]') ?? el?.closest("div[style]");
		const sheet = el?.closest('div[class*="max-md:rounded-t-2xl"]') ?? root;
		const cs = sheet ? getComputedStyle(sheet) : null;
		return {
			dockPresent: !!el,
			position: root ? getComputedStyle(root).position : null,
			borderTopLeftRadius: cs?.borderTopLeftRadius ?? null,
			paddingBottom: cs?.paddingBottom ?? null,
		};
	});
	console.log("dock state:", JSON.stringify(dock));
}

// Settings full screen.
const settings = await page(`${BASE}/`);
await new Promise((r) => setTimeout(r, 800));
await settings.click('[aria-label="Open sidebar"]').catch(() => null);
await new Promise((r) => setTimeout(r, 400));
await settings.click('[data-testid="settings-entry"]');
await new Promise((r) => setTimeout(r, 600));
results.push(await shot(settings, "04-settings"));
const dialog = await settings.evaluate(() => {
	const el = document.querySelector('[data-testid="settings-dialog"]');
	if (!el) return { present: false };
	const cs = getComputedStyle(el);
	const r = el.getBoundingClientRect();
	return { present: true, width: Math.round(r.width), height: Math.round(r.height), radius: cs.borderTopLeftRadius };
});
console.log("settings dialog:", JSON.stringify(dialog));

// Keyboard hints must be gone on a coarse pointer / phone.
const hints = await settings.evaluate(() => {
	const kbd = document.querySelector("kbd");
	return { kbdVisible: kbd ? getComputedStyle(kbd).display !== "none" : null };
});
console.log("kbd hints:", JSON.stringify(hints));

const overflow = results.filter((r) => r.metrics.scrollW > r.metrics.innerW + 1);
console.log(overflow.length === 0 ? "✓ no horizontal overflow at 390px" : `✗ horizontal overflow: ${overflow.map((o) => o.file).join(", ")}`);

await browser.close();
