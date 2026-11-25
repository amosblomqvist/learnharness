// Phone-emulation and desktop checks of the real frontend in headless Chrome,
// with a mocked backend. Run: npm run test:browser (CHROME_PATH overrides Chrome).
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pronunciation-browser-"));
const defaultChrome = { win32: "C:/Program Files/Google/Chrome/Application/chrome.exe", darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }[process.platform] ?? "/usr/bin/google-chrome";
const chrome = process.env.CHROME_PATH ?? defaultChrome;
const PREPARING = "Preparing audio…", BLOCKED = "The browser blocked audio. Tap the text again.";
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/plugin.css"><style>
:root{--background:#141414;--foreground:#e6e6e6;--border:#434343;--popover:#1c1c1c;--popover-foreground:#e6e6e6;--muted-foreground:#8d8d8d}
body{margin:0;background:var(--background);color:var(--foreground);font-family:sans-serif}
main{padding:16px;font-size:22px;line-height:1.7} button,input{font-size:22px}
</style></head><body><main>
<p id="latin-first">Say <span id="p1">你好世界</span> please</p>
<p id="p2">我们一起去银行吧</p>
<p id="p3">他长大了</p>
<p><button id="b1">银行</button> <input id="i1" value="银行"></p>
<p id="p4">研究生命的起源</p>
<div style="height:1600px"></div>
</main><script type="module" src="/fixture.js"></script></body></html>`;

let browser, server, failures = 0;
const pass = label => console.log(`PASS ${label}`);
async function check(label, body) {
  try { await body(); pass(label); }
  catch (error) { failures++; console.log(`FAIL ${label}\n  ${error.message.split("\n").join("\n  ")}`); }
}
try {
  await build({ absWorkingDir: root, entryPoints: ["tests/browser-fixture.mjs"], outfile: path.join(evidence, "fixture.js"), bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "warning" });
  server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://fixture");
    const files = { "/fixture.js": [path.join(evidence, "fixture.js"), "text/javascript"], "/plugin.css": [path.join(root, "src/styles.css"), "text/css"] };
    if (pathname === "/") { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(html); return; }
    const file = files[pathname];
    if (!file) { response.writeHead(404).end(); return; }
    response.setHeader("content-type", file[1]); response.end(fs.readFileSync(file[0]));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: path.join(evidence, "profile"), args: ["--no-sandbox"] });

  async function open(viewport) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.setViewport(viewport);
    await page.goto(origin, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => window.fixtureReady || window.fixtureError);
    assert.equal(await page.evaluate(() => window.fixtureError ?? null), null);
    const center = (selector, character) => page.evaluate((selector, character) => {
      const element = document.querySelector(selector);
      const node = [...element.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.data.includes(character)) ?? element.firstChild;
      const index = node.data.indexOf(character);
      const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + character.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, selector, character);
    const fixture = () => page.evaluate(() => structuredClone(window.fixture));
    const speaks = async () => (await fixture()).calls.filter(call => call.operation === "speak").map(call => call.input.text);
    const notice = () => page.evaluate(() => document.querySelector(".lh-pronounce-notice")?.textContent ?? null);
    const settle = (ms = 600) => new Promise(resolve => setTimeout(resolve, ms));
    /** Speak requests made by `action`, after letting any double-tap window pass. */
    const spoken = async action => { await settle(450); const before = (await speaks()).length; await action(); await settle(); return (await speaks()).slice(before); };
    const setMode = mode => page.evaluate(mode => { window.fixture.mode = mode; }, mode);
    /** Wait until the notice is `expected`: exact text, a RegExp, or null for none. */
    const noticeBecomes = async (expected, timeout = 5000) => {
      const kind = expected === null ? "none" : expected instanceof RegExp ? "pattern" : "text";
      const value = expected instanceof RegExp ? expected.source : expected;
      try {
        await page.waitForFunction((kind, value) => {
          const text = document.querySelector(".lh-pronounce-notice")?.textContent ?? null;
          return kind === "none" ? text === null : kind === "text" ? text === value : text !== null && new RegExp(value).test(text);
        }, { timeout, polling: 50 }, kind, value);
      } catch { assert.fail(`notice never became ${String(expected)}; it is ${JSON.stringify(await notice())}`); }
    };
    return { page, errors, center, fixture, speaks, notice, settle, spoken, setMode, noticeBecomes };
  }

  // ---- Phone ----------------------------------------------------------------
  const phone = await open({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const cdp = await phone.page.createCDPSession();
  const touch = (type, point) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: point ? [point] : [] });
  const tap = point => phone.page.touchscreen.tap(point.x, point.y);

  await check("phone: a tap plays the whole phrase once, unlocking audio inside the tap", async () => {
    const before = (await phone.fixture()).plays.length;
    assert.deepEqual(await phone.spoken(async () => tap(await phone.center("#p1", "世"))), ["你好世界"]);
    await phone.settle(400);
    const plays = (await phone.fixture()).plays.slice(before);
    assert.equal(plays[0]?.kind, "unlock", "the silent unlock play runs first, inside the tap");
    assert.deepEqual(plays.filter(entry => entry.kind === "clip").map(entry => entry.result), ["played"]);
    assert.equal(await phone.notice(), null);
  });
  await check("phone: taps play even when the browser sends no click (iPhone Safari)", async () => {
    await phone.page.evaluate(() => { window.blockClicks = event => event.stopImmediatePropagation(); window.addEventListener("click", window.blockClicks, true); });
    try { assert.deepEqual(await phone.spoken(async () => tap(await phone.center("#p2", "银"))), ["我们一起去银行吧"]); }
    finally { await phone.page.evaluate(() => window.removeEventListener("click", window.blockClicks, true)); }
  });
  await check("phone: a swipe across Chinese (scrolling) plays nothing", async () => {
    assert.deepEqual(await phone.spoken(async () => {
      const start = await phone.center("#p3", "长");
      await touch("touchStart", start);
      for (let step = 1; step <= 6; step++) await touch("touchMove", { x: start.x + step * 3, y: start.y - step * 9 });
      await touch("touchEnd");
    }), []);
  });
  await check("phone: a long press plays nothing", async () => {
    assert.deepEqual(await phone.spoken(async () => {
      const point = await phone.center("#p3", "大");
      await touch("touchStart", point); await phone.settle(700); await touch("touchEnd");
    }), []);
    await phone.page.evaluate(() => document.getSelection()?.removeAllRanges());
  });
  await check("phone: a double tap plays once", async () => {
    assert.deepEqual(await phone.spoken(async () => {
      const point = await phone.center("#p4", "命");
      await tap(point); await phone.settle(120); await tap(point);
    }), ["研究生命的起源"]);
  });
  await check("phone: taps on a button, an input or Latin text play nothing", async () => {
    assert.deepEqual(await phone.spoken(async () => tap(await phone.center("#b1", "银"))), []);
    assert.deepEqual(await phone.spoken(async () => { const box = await phone.page.$eval("#i1", element => { const rect = element.getBoundingClientRect(); return { x: rect.left + 20, y: rect.top + rect.height / 2 }; }); await tap(box); }), []);
    await phone.page.evaluate(() => document.activeElement?.blur());
    assert.deepEqual(await phone.spoken(async () => tap(await phone.center("#latin-first", "S"))), []);
  });
  await check("phone: a slow clip shows 'Preparing audio…' until it plays", async () => {
    await phone.setMode("slow");
    try {
      await phone.settle(450);
      await tap(await phone.center("#p3", "他"));
      await phone.noticeBecomes(PREPARING, 2500);
      const box = await phone.page.$eval(".lh-pronounce-notice", element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; });
      assert.ok(box.left >= 16 && box.right <= 390 - 16 && box.top >= 0 && box.bottom <= 844, `notice fits the phone screen: ${JSON.stringify(box)}`);
      await phone.noticeBecomes(null, 6000);
      await phone.settle(200);
      assert.equal((await phone.fixture()).plays.filter(entry => entry.kind === "clip").at(-1)?.result, "played");
    } finally { await phone.setMode("ok"); }
  });
  await check("phone: a quick clip shows no preparing notice", async () => {
    await phone.settle(450);
    await tap(await phone.center("#p3", "了"));
    await phone.settle(700);
    assert.equal(await phone.notice(), null);
  });
  await check("phone: a backend error appears next to the tapped text", async () => {
    await phone.setMode("error");
    try {
      await phone.settle(450);
      await tap(await phone.center("#p2", "我"));
      await phone.noticeBecomes(/GPU \(DirectML\) unavailable: fixture/);
    } finally { await phone.setMode("ok"); }
  });
  await check("phone: refused playback asks for another tap", async () => {
    await phone.setMode("block");
    try {
      await phone.settle(450);
      await tap(await phone.center("#p4", "研"));
      await phone.noticeBecomes(BLOCKED);
    } finally { await phone.setMode("ok"); }
  });
  await check("phone: no page errors", async () => assert.deepEqual(phone.errors, []));

  // ---- Desktop ----------------------------------------------------------------
  const desktop = await open({ width: 1280, height: 860, deviceScaleFactor: 1 });
  await check("desktop: a mouse click still plays once", async () => {
    assert.deepEqual(await desktop.spoken(async () => { const point = await desktop.center("#p2", "去"); await desktop.page.mouse.click(point.x, point.y); }), ["我们一起去银行吧"]);
    await desktop.settle(300);
    assert.deepEqual((await desktop.fixture()).plays.filter(entry => entry.kind === "clip").map(entry => entry.result), ["played"]);
  });
  await check("desktop: no page errors", async () => assert.deepEqual(desktop.errors, []));
} finally {
  await browser?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  fs.rmSync(evidence, { recursive: true, force: true, maxRetries: 3 });
}
if (failures) { console.log(`${failures} browser check(s) failed.`); process.exitCode = 1; }
else console.log("All browser checks passed.");
