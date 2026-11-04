/** Native Electron workspace regression with synthetic sessions and empty credentials.
 * Run: node scripts/smoke-workspace.mjs [--app /path/to/custom/executable]
 * Uses an isolated profile and a private Next development server. No provider calls.
 * This proves UI and transport isolation. It does not prove real model generation.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-workspace-smoke-"));
const profile = path.join(home, "profile");
const data = path.join(home, "data");
const evidenceDir = process.env.LH_WORKSPACE_EVIDENCE_DIR || path.join(os.tmpdir(), "lh-workspace-evidence");
fs.mkdirSync(evidenceDir, { recursive: true });
const evidence = path.join(evidenceDir, "results.json");
const checks = [], failures = [], children = [];
let browser, serverLogs = "", shellLogs = "", shell, proxy;
const model = { id: "synthetic", name: "Synthetic offline", provider: "fixture", input: ["text"], reasoning: false, supportedLevels: ["off"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
const slot = { model: { provider: "fixture", id: "synthetic" }, thinkingLevel: "off" };
const catalog = { models: [model], providers: [{ id: "fixture", label: "Fixture", keyPresent: true }], defaults: null, slots: { strong: slot, cheap: slot, vision: slot }, rolePins: {} };
const posts = [];
const nativeStreams = new Map();
const running = new Set();
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const syntheticMessage = id => ({ role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "synthetic", timestamp: 2, stopReason: "stop", usage, content: [{ type: "text", text: `Live synthetic reply for ${id}.` }] });
const sockets = new Set();
async function port() {
 const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
 const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function until(check, message, timeout = 60000) {
 const start = Date.now();
 while (Date.now() - start < timeout) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
 throw new Error(message);
}
async function stop(child) {
 if (!child || child.exitCode !== null || child.signalCode !== null) return;
 const finished = once(child, "exit"); child.kill("SIGTERM");
 const timer = setTimeout(() => child.kill("SIGKILL"), 5000); timer.unref(); await finished; clearTimeout(timer);
}
function seed() {
 fs.mkdirSync(path.join(data, "chats"), { recursive: true }); fs.mkdirSync(profile, { recursive: true });
 fs.writeFileSync(path.join(home, "auth.json"), "{}\n");
 fs.writeFileSync(path.join(data, "settings.json"), JSON.stringify({ models: { strong: slot, cheap: slot, vision: slot } }));
 const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
 for (const id of ["workspace_a", "workspace_b", "workspace_c", "workspace_d", "workspace_e"]) {
  const text = Array.from({ length: 60 }, (_, i) => `${id} synthetic lesson paragraph ${i}: one plus one equals two.`).join("\n\n");
  const messages = [{ id: "learner", role: "user", content: `Teach ${id}.`, timestamp: 0 }, { id: "teacher", role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "synthetic", timestamp: 1, stopReason: "stop", usage, content: [{ type: "text", text }] }];
  fs.writeFileSync(path.join(data, "chats", `${id}.json`), JSON.stringify({ version: 1, id, title: `Synthetic ${id}`, createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z", messages }));
 }
}
async function pages() { return (await browser.pages()).filter(page => /^http/.test(page.url())); }
async function ready(page) { page.on("pageerror", error => failures.push(error.message)); page.on("console", message => { if(message.type() === "error") console.error("renderer:", message.text()); }); page.setDefaultTimeout(60000); await page.waitForFunction(() => Boolean(window.lh?.workspace)); await page.waitForSelector('[data-testid="session-workspace"]'); return page; }
async function state(page) { return page.evaluate(() => window.lh.workspace.get()); }
async function open(page, id, mode) { await page.evaluate((id, mode) => window.lh.workspace.open(id, mode), id, mode); }
async function fill(page, paneId, text) {
 const selector = `[data-workspace-pane="${paneId}"] [data-testid="composer"] [data-file-path-input]`;
 await page.waitForSelector(selector);
 await page.$eval(selector, (input, text) => { input.focus(); input.textContent = text; input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" })); }, text);
 await until(async () => (await state(page)).views?.[(await state(page)).panes.find(p => p.id === paneId).sessionId]?.draft === text, "Draft did not reach durable workspace.");
}
async function launch(origin) {
 shellLogs = ""; const debug = await port();
 const appArg = process.argv.indexOf("--app");
 const executable = appArg < 0 ? require("electron") : process.argv[appArg + 1];
 const args = appArg < 0 ? [root] : [];
 shell = spawn(executable, [...args, `--remote-debugging-port=${debug}`, "--disable-background-networking", "--disable-sync", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-background-timer-throttling"], { cwd: root, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, LH_PROFILE_DIR: profile, LH_DEV_URL: origin, LH_IGNORE_ENV_KEYS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
 children.push(shell); const capture = value => { shellLogs = (shellLogs + value).slice(-20000); }; shell.stdout.on("data", capture); shell.stderr.on("data", capture);
 const endpoint = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${debug}/json/version`)).json()).webSocketDebuggerUrl; } catch { if (shell.exitCode !== null) throw new Error(shellLogs); } }, "Electron debug endpoint did not start.");
 browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
 const list = await until(async () => (await pages()).length && await pages(), "No app window.");
 return ready(list[0]);
}
async function resize(page, width, height = 860) {
 await page.bringToFront(); await page.setViewport({ width, height, deviceScaleFactor: 1 }); await page.screenshot();
}
try {
 seed();
 const { getFontAxes } = require("next/dist/compiled/@next/font/dist/google/get-font-axes.js");
 const { getGoogleFontsUrl } = require("next/dist/compiled/@next/font/dist/google/get-google-fonts-url.js");
 const fonts = Object.fromEntries(["JetBrains Mono", "Source Sans 3"].map(family => [getGoogleFontsUrl(family, getFontAxes(family, ["variable"], ["normal"]), "swap"), `@font-face {font-family:'${family}';src:local('Arial');font-weight:100 900;}`]));
 fs.writeFileSync(path.join(home, "fonts.cjs"), `module.exports=${JSON.stringify(fonts)};\n`);
 const nextPort = await port();
 const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(nextPort)], { cwd: root, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, NODE_ENV: "development", LH_DATA_DIR: data, LH_AUTH_FILE: path.join(home, "auth.json"), LH_IGNORE_ENV_KEYS: "1", NEXT_TELEMETRY_DISABLED: "1", NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(home, "fonts.cjs") }, stdio: ["ignore", "pipe", "pipe"] });
 children.push(next); const capture = text => { serverLogs = (serverLogs + text).slice(-20000); }; next.stdout.on("data", capture); next.stderr.on("data", capture);
 await until(() => serverLogs.includes("Ready in"), "Next did not start.");
 // The proxy owns synthetic SSE sockets. All other requests reach the real app.
 proxy = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");
  const json = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (url.pathname === "/api/models") return json(catalog);
  if (url.pathname === "/api/events") { res.writeHead(204); return res.end(); }
  const chatMatch = /^\/api\/chats\/([^/]+)$/.exec(url.pathname);
  const streamMatch = /^\/api\/chats\/([^/]+)\/stream$/.exec(url.pathname);
  if (chatMatch && req.method === "GET") {
   const id = chatMatch[1], file = path.join(data, "chats", `${id}.json`);
   if (!fs.existsSync(file)) return json({ error: "Not found" }, 404);
   return json({ ...JSON.parse(fs.readFileSync(file, "utf8")), turnInFlight: running.has(id), compacting: false });
  }
  if (streamMatch && running.has(streamMatch[1])) {
   const id = streamMatch[1]; res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); res.flushHeaders();
   nativeStreams.set(id, res); res.write(`data: ${JSON.stringify({ type: "agent_start" })}\n\n`); res.write(`data: ${JSON.stringify({ type: "message_start", message: syntheticMessage(id) })}\n\n`);
   req.on("close", () => { if (nativeStreams.get(id) === res) nativeStreams.delete(id); }); return;
  }
  if (req.method === "POST" && url.pathname === "/api/chat") {
   let body = ""; req.on("data", chunk => { body += chunk; }); req.on("end", () => {
    const parsed = JSON.parse(body); posts.push({ pathname: url.pathname, body: parsed });
    const id = parsed.chatId, file = path.join(data, "chats", `${id}.json`), record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed.input.text === "REFUSE synthetic submission") return json({ error: "Synthetic failed submission" }, 503);
    record.messages.push({ id: `submitted_${posts.length}`, role: "user", content: parsed.input.text, timestamp: Date.now() }); fs.writeFileSync(file, JSON.stringify(record)); running.add(id); json({ ok: true });
   }); return;
  }
  if (req.method === "POST" && /\/(answer|turn|retry)$/.test(url.pathname)) return json({ error: "Unexpected action in synthetic test" }, 503);
  const upstream = http.request({ hostname: "127.0.0.1", port: nextPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${nextPort}` } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
  upstream.on("error", error => { if (!res.headersSent) res.writeHead(502); res.end(error.message); }); req.pipe(upstream); res.on("close", () => upstream.destroy());
 });
 proxy.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(nextPort, "127.0.0.1", () => {
   upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${Object.entries({ ...req.headers, host: `127.0.0.1:${nextPort}` }).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
   if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy()); socket.on("close", () => upstream.destroy());
 });
 proxy.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); }); proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
 const origin = `http://127.0.0.1:${proxy.address().port}`;
 let first = await launch(origin);
 await open(first, "workspace_a", "active"); await open(first, "workspace_b", "beside");
 await first.waitForFunction(() => document.querySelectorAll('[data-workspace-pane]').length === 2);
 let one = await state(first); assert.deepEqual(one.panes.map(p => p.sessionId), ["workspace_a", "workspace_b"]);
 await open(first, "workspace_c", "window");
 let second = await until(async () => { const list = await pages(); return list.find(p => p !== first); }, "Second native window did not open."); await ready(second);
 await open(second, "workspace_d", "beside");
 await second.waitForFunction(() => document.querySelectorAll('[data-workspace-pane]').length === 2);
 for (const page of [first, second]) { await resize(page, 2000); await page.waitForSelector('[role="separator"][aria-label="Resize session panes"]', { visible: true }); }
 checks.push("Two native windows contain four distinct synthetic session views. Wide layout uses simulated 2000-pixel renderer geometry.");
 // Submit four ordinary Chat composer messages. The deterministic fixture
 // acknowledges each POST and keeps its native replay stream open.
 for (const page of [first, second]) {
  const current = await state(page);
  for (const pane of current.panes) {
   await page.evaluate(id => window.lh.workspace.save({ activePaneId: id }), pane.id);
   await fill(page, pane.id, `Generate synthetic reply for ${pane.sessionId}`);
   await page.$eval(`[data-workspace-pane="${pane.id}"] [data-testid="composer"] button[aria-label="Send"]`, button => { if (button.disabled) throw new Error("Composer Send is disabled"); button.click(); });
  }
 }
 await until(() => nativeStreams.size === 4, "Four Chat replay streams did not remain open.");
 for (const page of [first, second]) {
  const current = await state(page);
  for (const pane of current.panes) await page.waitForFunction((id, text) => document.querySelector(`[data-workspace-pane="${id}"]`)?.textContent.includes(text), {}, pane.id, `Live synthetic reply for ${pane.sessionId}.`);
  assert.equal(await page.evaluate(async () => (await fetch("/api/chats")).status), 200);
  await page.evaluate(() => { for (const pane of document.querySelectorAll('[data-workspace-pane]')) { const reply = [...pane.querySelectorAll('p')].find(element => element.textContent.startsWith('Live synthetic reply for ')); reply?.scrollIntoView({ block: 'center' }); } });
  await page.screenshot({ path: path.join(evidenceDir, `${current.id}-four-live-sessions.png`) });
 }
 checks.push("Four actual Chat sends receive distinct native agent replay events across two windows while session-list requests remain responsive. The provider is deterministic and local.");
 // Settle and persist the fixture turns before draft/reload checks.
 for (const [id, response] of nativeStreams) {
  const file = path.join(data, "chats", `${id}.json`), record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.messages.push({ ...syntheticMessage(id), id: `live_${id}` }); fs.writeFileSync(file, JSON.stringify(record)); running.delete(id);
  response.write(`data: ${JSON.stringify({ type: "message_end", message: syntheticMessage(id) })}\n\ndata: [DONE]\n\n`); response.end();
 }
 await until(() => nativeStreams.size === 0, "Synthetic streams did not settle.");
 const a = one.panes[0], b = one.panes[1];
 await first.evaluate(id => window.lh.workspace.save({ activePaneId: id }), a.id); await fill(first, a.id, "Draft A survives restart");
 await first.evaluate(id => window.lh.workspace.save({ activePaneId: id }), b.id); await fill(first, b.id, "Draft B remains separate");
 one = await state(first); assert.equal(one.views.workspace_a.draft, "Draft A survives restart"); assert.equal(one.views.workspace_b.draft, "Draft B remains separate");
 checks.push("Typed composer drafts remain separate and reach the main-process workspace file.");
 await first.evaluate(id => window.lh.workspace.save({ activePaneId: id }), a.id);
 await open(first, "workspace_e", "beside");
 assert.deepEqual((await state(first)).panes.map(p => p.sessionId), ["workspace_a", "workspace_e"]);
 assert.equal((await state(first)).views.workspace_b.draft, "Draft B remains separate");
 await first.evaluate(id => window.lh.workspace.save({ activePaneId: id }), a.id);
 await open(first, "workspace_b", "beside");
 await first.waitForFunction(id => document.querySelector(`[data-workspace-pane="${id}"] [data-file-path-input]`)?.textContent === "Draft B remains separate", {}, b.id);
 checks.push("Open Beside replaces the inactive full pane and restores its saved draft when reopened.");
 await fill(first, b.id, "REFUSE synthetic submission");
 await first.$eval(`[data-workspace-pane="${b.id}"] [data-testid="composer"] button[aria-label="Send"]`, button => button.click());
 await until(() => posts.length === 5, "Failed synthetic send did not reach the fixture.");
 await first.waitForFunction(id => document.querySelector(`[data-workspace-pane="${id}"] [data-file-path-input]`)?.textContent === "REFUSE synthetic submission", {}, b.id);
 assert.equal((await state(first)).views.workspace_b.draft, "REFUSE synthetic submission");
 assert.equal((await state(first)).views.workspace_a.draft, "Draft A survives restart");
 await fill(first, b.id, "Draft B remains separate");
 checks.push("A refused composer submission preserves its draft and leaves the other pane's draft unchanged.");

 await first.evaluate(id => window.lh.workspace.save({ activePaneId: id }), a.id);
 await first.evaluate(() => window.dispatchEvent(new CustomEvent("lh:kbd-find")));
 await first.waitForSelector(`[data-workspace-pane="${a.id}"] [data-testid="session-find"]`);
 assert.equal(await first.$$eval('[data-testid="session-find"]', elements => elements.length), 1);
 await first.keyboard.press("Escape");
 await first.waitForFunction(() => !document.querySelector('[data-testid="session-find"]'));
 checks.push("Find opens only in the active pane and Escape closes that pane's Find bar.");
 await resize(first, 900);
 await first.waitForSelector('[data-testid="pane-switcher"]'); assert.equal(await first.$$eval('[data-workspace-pane]', panes => panes.length), 2);
 await first.locator('[data-testid="pane-switcher"] button:first-child').click();
 await until(async () => (await state(first)).activePaneId === a.id, "Narrow pane switch failed.");
 checks.push("A simulated narrow native window keeps both panes mounted and switches the active pane.");
 await open(second, "workspace_a", "window"); assert.equal((await pages()).length, 2); assert.equal((await state(first)).activePaneId, a.id);
 checks.push("Opening an assigned session focuses its existing view without a duplicate window.");
 await first.evaluate(() => window.lh.workspace.save({ split: .63 }));
 await first.reload({ waitUntil: "domcontentloaded" }); await ready(first);
 one = await state(first); assert.equal(one.split, .63); assert.equal(one.views.workspace_a.draft, "Draft A survives restart");
 checks.push("Renderer reload retains assignments, split size, and drafts.");
 await first.evaluate(id => window.lh.workspace.move(id), b.id);
 const third = await until(async () => { const list = await pages(); return list.find(p => p !== first && p !== second); }, "Pane transfer did not create a window."); await ready(third);
 assert.equal((await state(third)).panes[0].sessionId, "workspace_b"); assert.equal((await state(first)).panes.length, 1);
 assert.equal((await state(third)).views.workspace_b.draft, "Draft B remains separate");
 checks.push("Move to New Window transfers a pane and its draft without a duplicate assignment.");
 await third.evaluate(() => window.close());
 await until(async () => (await pages()).length === 2, "Closed transfer window remains open.");
 const savedBefore = JSON.parse(fs.readFileSync(path.join(profile, "workspace-v1.json"), "utf8")); assert.equal(savedBefore.windows.length, 2);
 checks.push("A deliberately closed native window is removed from the saved layout.");
 await browser.close(); browser = null; await stop(shell);
 first = await launch(origin);
 const restored = await until(async () => { const list = await pages(); return list.length === 2 ? list : null; }, "Quit/restart did not restore two windows.");
 await Promise.all(restored.map(ready));
 const restoredStates = await Promise.all(restored.map(state)); assert.equal(restoredStates.flatMap(s => s.panes).length, 3); assert.equal(restoredStates[0].views.workspace_a.draft, "Draft A survives restart");
 checks.push("Native quit and restart restore open windows, session assignments, and drafts. Deliberately closed windows stay closed.");
 assert.equal(posts.length, 5, "Navigation/restoration submitted an additional turn.");
 checks.push("Navigation and restoration submit no additional turn beyond four accepted sends and one refused send.");
 assert.deepEqual(failures, [], "Renderer raised an uncaught exception.");
 console.log(JSON.stringify({ ok: true, checks, limitations: ["Synthetic HTTP streams do not prove model generation.", "Physical second display, microphone dictation, completed demo retry, and PNG rendering require separate checks."] }, null, 2));
} catch (error) {
 failures.push(error.stack || String(error)); console.error(JSON.stringify({ ok: false, checks, failures, serverLogs, shellLogs }, null, 2)); process.exitCode = 1;
} finally {
 if (browser) await browser.close().catch(() => {});
 for (const response of nativeStreams.values()) response.end();
 for (const child of children.reverse()) await stop(child);
 for (const socket of sockets) socket.destroy(); if (proxy) await new Promise(resolve => proxy.close(resolve));
 fs.writeFileSync(evidence, JSON.stringify({ date: new Date().toISOString(), ok: failures.length === 0, checks, failures, synthetic: true }, null, 2));
 fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
