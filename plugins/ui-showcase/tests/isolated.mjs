/** Disposable packaged-host runner. No host source/runtime modules are imported. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { surfaceProofFixture } from "./surface-fixture.mjs";

export const fixture = Object.freeze({ chatId: "chat_ui_showcase_offline", chatTitle: "Offline UI Showcase session", practiceChatId: "chat_ui_showcase_practice", practiceTitle: "Offline UI Showcase practice", model: "ui-showcase-offline", premiseId: "prop_ui_premise", conclusionId: "prop_ui_conclusion", chainId: "chain_ui_showcase", sourceId: "notes_ui_showcase", sourceLabel: "Synthetic showcase knowledge" });
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(test, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await test()) return; await delay(75); }
  throw new Error(`Timed out: ${label}`);
}
export function digestTree(root) {
  const hash = crypto.createHash("sha256");
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      hash.update(path.relative(root, file) + "\0");
      if (stat.isSymbolicLink()) hash.update("link:" + fs.readlinkSync(file));
      else if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) hash.update(fs.readFileSync(file));
    }
  }
  visit(root); return hash.digest("hex");
}
function verifyLinks(root, directory = root) {
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) assert.ok(fs.realpathSync(file).startsWith(root + path.sep), `Copy symlink escapes isolation: ${file}`);
    else if (stat.isDirectory()) verifyLinks(root, file);
  }
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server.address().port;
}
async function freePort() { const s = http.createServer(); const p = await listen(s); await new Promise(resolve => s.close(resolve)); return p; }
function seed(data) {
  const write = (relative, value) => { const file = path.join(data, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value, { flag: "wx" }); };
  const createdAt = "2026-11-01T00:00:00.000Z", provenance = [{ chatId: fixture.sourceId, messageId: "" }];
  // Explicit reversible rendering state plus a settled positions ledger allow
  // both Home variants without weakening the original graph/settings hashes.
  write("settings.json", JSON.stringify({ version: 1, graph: { rendering: true } }) + "\n");
  write("graph/positions.json", JSON.stringify({ positions: {
    [fixture.premiseId]: { x: -30, y: 0 }, [fixture.conclusionId]: { x: 30, y: 0 },
  }, updatedAt: createdAt }) + "\n");
  write("graph/nodes.jsonl", [
    { id: fixture.premiseId, name: "Synthetic premise", statement: "The offline showcase has local state.", aliases: [], createdAt, provenance },
    { id: fixture.conclusionId, name: "Synthetic conclusion", statement: "Picker changes need no generation.", aliases: [], createdAt, provenance },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  write("graph/chains.jsonl", JSON.stringify({ id: fixture.chainId, premises: [fixture.premiseId], conclusion: fixture.conclusionId, createdAt, provenance }) + "\n");
  write("graph/sources.json", JSON.stringify({ [fixture.sourceId]: { id: fixture.sourceId, filePath: fixture.sourceLabel + ".md", importedAt: createdAt } }) + "\n");
  const tree = { nodes: [{ id: "showcase_node", title: "Synthetic showcase lesson" }], edges: [], version: 1 };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (id, content) => ({ id, role: "assistant", api: "openai-completions", provider: "custom", model: fixture.model, content, stopReason: "toolUse", timestamp: 2, usage });
  const result = (id, toolCallId, toolName, details) => ({ id, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "Synthetic prerequisite completed." }], details, isError: false, timestamp: 3 });
  write(`chats/${fixture.chatId}.json`, JSON.stringify({ version: 1, id: fixture.chatId, title: "Offline UI Showcase session", tree, createdAt, updatedAt: createdAt, settings: { model: { provider: "custom", id: fixture.model } }, messages: [
    { id: "seed_user", role: "user", content: "Synthetic settled teaching history; no generation.", timestamp: 1 },
    assistant("seed_probe", [{ type: "toolCall", id: "seed_probe_call", name: "probe_done", arguments: { assessment: { strands: [{ strand: "UI", assessment: "Ready." }] } } }]),
    result("seed_probe_result", "seed_probe_call", "probe_done", { ok: true }),
    assistant("seed_plan", [{ type: "toolCall", id: "seed_plan_call", name: "plan_init", arguments: { mermaid: "graph TD\nshowcase_node[Synthetic showcase lesson]" } }]),
    result("seed_plan_result", "seed_plan_call", "plan_init", { ok: true, tree }),
    { ...assistant("seed_notes", [{ type: "text", text: "This synthetic session exists only to obtain the host-created native session toolbar surface target." }]), stopReason: "stop" },
  ] }, null, 2));
  write(`chats/${fixture.practiceChatId}.json`, JSON.stringify({ version: 1, id: fixture.practiceChatId,
    title: fixture.practiceTitle, kind: "practice", tree: { nodes: [], edges: [], version: 1 },
    createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z",
    settings: { model: { provider: "custom", id: fixture.model } }, messages: [
      { id: "seed_practice_user", role: "user", content: "Synthetic settled practice history; no generation.", timestamp: 1 },
      { ...assistant("seed_practice_complete", [{ type: "text", text: "Settled offline practice fixture. No active problem or opening prompt." }]), stopReason: "stop" },
    ],
  }, null, 2));
}

export async function runPackagedProof(verify) {
  assert.equal(process.env.LH_POLISH_BUILD_READY, "1", "Wait for NEWBUILDREADY (updated host and plugin), then set LH_POLISH_BUILD_READY=1.");
  assert.ok(process.env.LH_APPROVED_HOST_DIGEST, "Supply the newly approved standalone tree digest; old UI-showcase payloads are forbidden.");
  assert.ok(process.env.LH_STANDALONE, "Supply the newly approved standalone payload; this runner never builds the host.");
  const source = fs.realpathSync(process.env.LH_STANDALONE);
  assert.ok(fs.statSync(path.join(source, "server.js")).isFile());
  const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
  const built = path.join(pluginRoot, "dist");
  const manifest = JSON.parse(fs.readFileSync(path.join(built, "manifest.json"), "utf8"));
  assert.equal(manifest.id, "ui-showcase"); assert.equal(manifest.backend, undefined, "Frontend-only package");
  const runtime = process.env.LH_NODE_RUNTIME ?? path.resolve(pluginRoot, "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  for (const file of [runtime, chrome]) fs.accessSync(file, fs.constants.X_OK);
  const scratch = fs.realpathSync(fs.mkdtempSync("/tmp/lh-ui-showcase-native-"));
  const home = path.join(scratch, "home"), data = path.join(home, "data"), standalone = path.join(scratch, "standalone");
  const cleanEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", HOME: home, USERPROFILE: home, TMPDIR: scratch, TMP: scratch, TEMP: scratch, APPDATA: path.join(home, "config"), LOCALAPPDATA: path.join(home, "local"), XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"), LH_DATA_DIR: data, LH_AUTH_FILE: path.join(home, "auth.json"), LH_IGNORE_ENV_KEYS: "1", NODE_ENV: "production" };
  const evidence = { scratch, source, manifest, builtDigest: digestTree(built), stage: "prepare", assertions: [], requests: [], responses: [], failedRequests: [], blockedRequests: [], microphoneRequests: [], webSockets: [], pageErrors: [], console: [], catalogRequests: [], forbiddenProviderRequests: [], screenshots: [] };
  let browser, child, failure;
  const sourceDigest = digestTree(source);
  assert.notEqual(sourceDigest, "1c44203f4d406ea3cf6c8eb7459cabbb1f8827298f4e1d5aaa9980807060ab18", "Reject old 99373a1 packaged payload: polish requires the updated host.");
  assert.equal(sourceDigest, process.env.LH_APPROVED_HOST_DIGEST, "Run only the exact newly approved standalone bytes");
  evidence.mode = "approved-polish";
  evidence.sourceDigest = sourceDigest;
  evidence.builtMainBytes = fs.statSync(path.join(built, "main.js")).size;
  // Catalog only: a request to generate a single token is an immediate failure.
  const catalog = http.createServer((req, res) => {
    evidence.catalogRequests.push({ method: req.method, url: req.url });
    if (![undefined, "Bearer not-needed"].includes(req.headers.authorization)) {
      failure = new Error("Unexpected credential reached offline catalog"); res.writeHead(403); res.end(); return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [fixture.model, fixture.model + "-alternative"].map(id => ({ id, object: "model", owned_by: "offline-fixture", reasoning: true })) }));
    } else { evidence.forbiddenProviderRequests.push({ method: req.method, url: req.url }); res.writeHead(503); res.end("Generation is prohibited in this proof."); }
  });
  try {
    console.log(`UI Showcase evidence: ${scratch}`);
    fs.cpSync(source, standalone, { recursive: true, verbatimSymlinks: true }); verifyLinks(standalone);
    fs.mkdirSync(path.join(data, "plugins", manifest.id), { recursive: true });
    fs.cpSync(built, path.join(data, "plugins", manifest.id, "dist"), { recursive: true, dereference: true });
    evidence.installedDigest = digestTree(path.join(data, "plugins", manifest.id, "dist"));
    assert.equal(evidence.installedDigest, evidence.builtDigest, "Install exact handed-off plugin bytes");
    // The second package is an explicit, separately fingerprinted TEST fixture,
    // never a replacement for or addition to the frozen product distribution.
    const fixtureDirectory = path.join(data, "plugins", surfaceProofFixture.id, "dist");
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    const fixtureHash = crypto.createHash("sha256");
    for (const name of Object.keys(surfaceProofFixture.files).sort()) {
      const contents = surfaceProofFixture.files[name];
      fixtureHash.update(name + "\0"); fixtureHash.update(contents);
      fs.writeFileSync(path.join(fixtureDirectory, name), contents, { flag: "wx" });
    }
    evidence.testFixture = { id: surfaceProofFixture.id, expectedDigest: fixtureHash.digest("hex"), installedDigest: digestTree(fixtureDirectory),
      helperSha256: crypto.createHash("sha256").update(fs.readFileSync(new URL("./surface-fixture.mjs", import.meta.url))).digest("hex") };
    assert.equal(evidence.testFixture.installedDigest, evidence.testFixture.expectedDigest);
    fs.writeFileSync(cleanEnv.LH_AUTH_FILE, "{}\n", { flag: "wx" }); seed(data);
    assert.deepEqual(fs.readdirSync(path.join(data, "plugins")).sort(), ["surface-proof", "ui-showcase"], "Install only the exact product and approved test fixture");
    const graphBefore = digestTree(path.join(data, "graph"));
    const base = `http://127.0.0.1:${await freePort()}`, port = new URL(base).port;
    evidence.origin = base;
    const guard = path.join(scratch, "imports.mjs");
    fs.writeFileSync(guard, `import {registerHooks} from 'node:module';import {realpathSync} from 'node:fs';import {fileURLToPath} from 'node:url';import path from 'node:path';const roots=${JSON.stringify([standalone, path.join(data, "plugins")])};registerHooks({resolve(s,c,n){const r=n(s,c);if(r.url.startsWith('file:')){const f=realpathSync(fileURLToPath(r.url));if(!roots.some(root=>f===root||f.startsWith(root+path.sep)))throw Error('Import escaped disposable payload: '+f)}return r}});`);
    const log = fs.openSync(path.join(scratch, "server.log"), "w");
    child = spawn(runtime, ["--import", guard, path.join(standalone, "server.js")], { cwd: standalone, env: { ...cleanEnv, ELECTRON_RUN_AS_NODE: "1", HOSTNAME: "127.0.0.1", PORT: port }, stdio: ["ignore", log, log] }); fs.closeSync(log);
    child.on("error", error => { failure = error; });
    await until(async () => { if (failure) throw failure; assert.equal(child.exitCode, null, "Packaged server exited; inspect server.log"); try { return (await fetch(base, { signal: AbortSignal.timeout(1000) })).status === 200; } catch { return false; } }, "packaged server boot");
    const api = async (route, method = "GET", body, headers = {}) => {
      assert.equal(new URL(base + route).origin, base);
      const response = await fetch(base + route, { method, headers: { "content-type": "application/json", Origin: base, "Sec-Fetch-Site": "same-origin", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
      const text = await response.text(); assert.equal(response.status, 200, `${method} ${route}: ${text}`);
      return { response, payload: JSON.parse(text) };
    };
    const plugins = (await api("/api/plugins")).payload.plugins;
    assert.deepEqual(plugins.map(value => value.id).sort(), ["surface-proof", "ui-showcase"], "No unexpected plugin is discovered");
    for (const id of [manifest.id, surfaceProofFixture.id]) {
      assert.equal(plugins.find(value => value.id === id)?.enabled, false);
      assert.equal((await api(`/api/plugins/${id}`, "PUT", { enabled: true })).payload.plugins.find(value => value.id === id)?.status, "active");
    }
    const provider = await api("/api/custom-provider");
    await api("/api/custom-provider", "POST", { baseUrl: `http://127.0.0.1:${await listen(catalog)}/v1`, authMode: "keyless" }, { "If-Match": provider.response.headers.get("etag") });
    const settingsBefore = (await api("/api/settings")).payload;
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: path.join(scratch, "chrome-profile"), env: cleanEnv, args: ["--disable-background-networking", "--disable-sync", "--no-first-run", "--no-default-browser-check"] });
    const page = await browser.newPage(); page.setDefaultTimeout(30_000);
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    // Passive safety tripwire: no test starts dictation. An unexpected request
    // is counted and rejected before the OS can open a microphone.
    await page.exposeFunction("__showcaseMicTripwire", () => evidence.microphoneRequests.push({ stage: evidence.stage }));
    await page.evaluateOnNewDocument(() => {
      if (!navigator.mediaDevices) return;
      navigator.mediaDevices.getUserMedia = async () => {
        await window.__showcaseMicTripwire();
        throw new DOMException("Microphone prohibited by showcase verification", "NotAllowedError");
      };
    });
    const network = await page.createCDPSession(); await network.send("Network.enable");
    network.on("Network.webSocketCreated", event => evidence.webSockets.push(event.url));
    page.on("pageerror", error => evidence.pageErrors.push(String(error)));
    page.on("console", item => evidence.console.push({ type: item.type(), text: item.text(), stage: evidence.stage }));
    page.on("requestfailed", request => evidence.failedRequests.push({ url: request.url(), method: request.method(), type: request.resourceType(), requestHeaders: Object.fromEntries(Object.entries(request.headers()).filter(([key]) => ['rsc', 'purpose', 'sec-purpose', 'next-router-prefetch', 'next-router-segment-prefetch'].includes(key))), failure: request.failure(), stage: evidence.stage }));
    page.on("response", response => evidence.responses.push({ url: response.url(), status: response.status(), stage: evidence.stage }));
    await page.setRequestInterception(true);
    page.on("request", request => {
      const target = new URL(request.url()), external = ["http:", "https:", "ws:", "wss:"].includes(target.protocol) && target.origin !== base;
      evidence.requests.push({ method: request.method(), url: request.url(), stage: evidence.stage });
      if (external) evidence.blockedRequests.push(request.url());
      void (external ? request.abort("blockedbyclient") : request.continue()).catch(error => { failure = error; });
    });
    const screenshot = async (name, { fullPage = true } = {}) => { const file = path.join(scratch, `${name}.png`); await page.screenshot({ path: file, fullPage }); evidence.screenshots.push(file); };
    try { await verify({ page, api, base, fixture, evidence, screenshot, scratch }); }
    catch (error) {
      await screenshot("failure").catch(() => {});
      fs.writeFileSync(path.join(scratch, "failure.html"), await page.content().catch(() => "Page unavailable"));
      throw error;
    }
    assert.deepEqual((await api("/api/settings")).payload, settingsBefore, "Gallery interactions must not alter global/default settings");
    evidence.settingsUnchanged = true;
    evidence.graphBefore = graphBefore;
    evidence.graphAfter = digestTree(path.join(data, "graph"));
    assert.equal(evidence.graphAfter, graphBefore, "Automated selection-only proof must not mutate synthetic knowledge");
    evidence.graphUnchanged = true;
    assert.deepEqual(evidence.forbiddenProviderRequests, []); assert.deepEqual(evidence.blockedRequests, []);
    assert.deepEqual(evidence.microphoneRequests, [], "Dictation must never auto-start");
    assert.deepEqual(evidence.webSockets, [], "No dictation/provider websocket may open");
    assert.equal(evidence.requests.filter(request => new URL(request.url).pathname === "/api/chat" && request.method === "POST").length, 0, "No real or fixture generation");
    assert.deepEqual(evidence.pageErrors, []);
    // Closing the real picker aborts its outstanding, read-only source fetch.
    // Do not suppress arbitrary network failures or unexpected HTTP errors.
    evidence.expectedCanceledReads = evidence.failedRequests.filter(request => ["real pickers", "knowledge origin scopes", "native session surface", "disable cleanup"].includes(request.stage) && request.failure?.errorText === "net::ERR_ABORTED" && new URL(request.url).pathname === "/api/graph/sources");
    // Navigation can cancel a completed, read-only Next router prefetch. Require
    // positive prefetch headers and its matching successful response. Stages are
    // limited to the original cases and the two observed native-page matrix cases;
    // API reads, page loads, provider requests and all other failures remain strict.
    const expectedCanceledPrefetchRequests = evidence.failedRequests.filter(request =>
      request.method === "GET" && request.type === "fetch" && new URL(request.url).origin === base &&
      !/^\/api(?:\/|$)/.test(new URL(request.url).pathname) && new URL(request.url).searchParams.has("_rsc") &&
      request.requestHeaders.rsc === "1" && request.requestHeaders["next-router-prefetch"] === "1" &&
      request.failure?.errorText === "net::ERR_ABORTED" &&
      (["native session surface", "public Surface matrix: native-teach", "public Surface matrix: native-practice"].includes(request.stage) || (request.stage === "gallery" && request.requestHeaders["next-router-segment-prefetch"] === "/_tree")) &&
      evidence.responses.some(response => response.url === request.url && response.status === 200 && response.stage === request.stage)
    );
    evidence.expectedCanceledPrefetches = expectedCanceledPrefetchRequests.map(request => ({ ...request,
      matchingResponse: evidence.responses.find(response => response.url === request.url && response.status === 200 && response.stage === request.stage),
    }));
    assert.deepEqual(evidence.failedRequests.filter(request => !evidence.expectedCanceledReads.includes(request) && !expectedCanceledPrefetchRequests.includes(request)), []);
    evidence.expectedHttpErrors = evidence.responses.filter(response => response.status === 404 && new URL(response.url).pathname === "/favicon.ico" || response.status === 503 && new URL(response.url).pathname === "/api/stt/token");
    assert.deepEqual(evidence.responses.filter(response => response.status >= 400 && !evidence.expectedHttpErrors.includes(response)), []);
    if (failure) throw failure;
    evidence.passed = true;
  } catch (error) { failure = error; evidence.error = String(error?.stack ?? error); }
  finally {
    if (browser) await browser.close();
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(5000)]); if (child.exitCode === null) child.kill("SIGKILL"); }
    catalog.closeAllConnections(); await new Promise(resolve => catalog.close(resolve));
    try { assert.equal(digestTree(source), sourceDigest, "Verified source payload must remain byte-identical"); evidence.sourceUnchanged = true; } catch (error) { failure ??= error; evidence.sourceUnchanged = false; }
    try {
      assert.equal(digestTree(built), evidence.builtDigest, "Frozen product distribution must remain byte-identical");
      assert.equal(digestTree(path.join(data, "plugins", manifest.id, "dist")), evidence.builtDigest, "Installed product bytes must remain exact");
      evidence.builtUnchanged = true;
      if (evidence.testFixture) {
        evidence.testFixture.finalDigest = digestTree(path.join(data, "plugins", surfaceProofFixture.id, "dist"));
        assert.equal(evidence.testFixture.finalDigest, evidence.testFixture.expectedDigest, "Test fixture package must remain byte-identical");
        assert.equal(crypto.createHash("sha256").update(fs.readFileSync(new URL("./surface-fixture.mjs", import.meta.url))).digest("hex"), evidence.testFixture.helperSha256);
      }
    } catch (error) { failure ??= error; evidence.builtUnchanged = false; }
    fs.writeFileSync(path.join(scratch, "result.json"), JSON.stringify(evidence, null, 2));
    console.log(`${evidence.passed && !failure ? "PASS" : "FAIL"}: UI Showcase packaged proof. Evidence: ${scratch}`);
  }
  if (failure) throw failure;
}
