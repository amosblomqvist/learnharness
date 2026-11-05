/** Product-only packaged-host proof. Never builds or imports host implementation.
 * Run: LH_STANDALONE=/absolute/verified/.next/standalone node plugins/coding-questions/tests/native.mjs
 * All runtime writes are confined to a disposable /tmp copy; evidence is retained.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const checkout = path.resolve(pluginRoot, "../..");
assert.ok(process.env.LH_STANDALONE, "Supply LH_STANDALONE pointing to the existing verified payload; this smoke never builds.");
const source = fs.realpathSync(process.env.LH_STANDALONE);
assert.ok(fs.statSync(path.join(source, "server.js")).isFile());
const built = path.join(pluginRoot, "dist");
const manifest = JSON.parse(fs.readFileSync(path.join(built, "manifest.json"), "utf8"));
assert.equal(manifest.id, "coding-questions");
const runtime = path.join(checkout, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
for (const file of [runtime, chrome]) fs.accessSync(file, fs.constants.X_OK);
const scratch = fs.realpathSync(fs.mkdtempSync("/tmp/lh-coding-native-"));
const home = path.join(scratch, "home"), standalone = path.join(scratch, "standalone");
const data = path.join(home, "data"), auth = path.join(home, "auth.json");
const chatId = "chat_coding_native_smoke", model = "coding-native-fixture", route = `/api/chats/${chatId}`;
const starter = "def example():\n    pass  \n";
const reviewText = "Offline teacher reviewed the learner code and separate thinking. No execution or automatic grading occurred.";
const dock = '[data-testid="plugin-question-dock"]';
const editor = `${dock} [contenteditable="true"][aria-label="Code answer"]`;
const thinking = `${dock} [contenteditable="true"][aria-label="Your thinking"]`;
const mod = process.platform === "darwin" ? "Meta" : "Control";
const evidence = { scratch, source, runtime, chrome, manifest, stage: "prepare", assertions: [], requests: [], responses: [], failedRequests: [], blockedRequests: [], pageErrors: [], console: [], providerRequests: [], streams: [], screenshots: [] };
let child, browser, page, failure, sourceDigest;
const streams = new Map(), streamReads = [], pending = new Map();
let fixtureError, poseCount = 0;
const cleanEnv = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8",
  HOME: home, USERPROFILE: home, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
  APPDATA: path.join(home, "config"), LOCALAPPDATA: path.join(home, "local"),
  XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"),
  LH_DATA_DIR: data, LH_AUTH_FILE: auth, LH_IGNORE_ENV_KEYS: "1", NODE_ENV: "production",
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fixtureError) throw fixtureError;
    if (await test()) return;
    await delay(75);
  }
  throw new Error(`Timed out: ${label}`);
}
function digestTree(root) {
  const hash = crypto.createHash("sha256");
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      hash.update(path.relative(root, file) + "\0");
      if (stat.isSymbolicLink()) hash.update("link:" + fs.readlinkSync(file));
      else if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) hash.update(fs.readFileSync(file));
    }
  }
  visit(root); return hash.digest("hex");
}
function verifyCopyLinks(directory) {
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      const target = fs.realpathSync(file);
      assert.ok(target.startsWith(standalone + path.sep), `Payload symlink escapes disposable copy: ${file} -> ${target}`);
    } else if (stat.isDirectory()) verifyCopyLinks(file);
  }
}
async function listen(server) { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); return server.address().port; }
async function freePort() { const server = http.createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; }
async function screenshot(name) {
  const file = path.join(scratch, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true }); evidence.screenshots.push(file);
}
async function chord(key) { await page.keyboard.down(mod); try { await page.keyboard.press(key); } finally { await page.keyboard.up(mod); } }
const snapshots = record => record.messages.flatMap(message => Object.values(message.lhQuestions ?? {})).filter(entry => entry.questionId);
const streamSnapshots = () => [...streams.values()].map(({ buffered, chunks, ...entry }) => ({ ...entry, text: Buffer.concat([buffered ?? Buffer.alloc(0), ...chunks]).toString("utf8") }));

// Loopback OpenAI protocol fixture, not a replacement plugin or host module.
// Responses stay held until the real app has subscribed to its native stream.
const mock = http.createServer((req, res) => {
  const fail = error => { fixtureError = error; res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: String(error) } })); };
  try {
    assert.ok([undefined, "Bearer not-needed"].includes(req.headers.authorization), "No real provider credentials may reach fixture");
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model", owned_by: "loopback-fixture" }] })); return;
    }
    assert.equal(req.method, "POST"); assert.equal(req.url, "/v1/chat/completions");
    let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const input = JSON.parse(body);
        assert.equal(input.model, model); assert.equal(input.stream, true);
        assert.ok(!JSON.stringify(input.messages).includes('"lhQuestions"'));
        const last = input.messages.at(-1);
        const review = last?.role === "tool" && /^coding_(predict|check)_live_\d+$/.test(last.tool_call_id);
        const lastUser = input.messages.filter(message => message.role === "user").at(-1);
        const check = !review && JSON.stringify(lastUser?.content).includes("CODING_NATIVE_CHECK");
        const fallback = check && JSON.stringify(lastUser?.content).includes("CODING_NATIVE_CHECK_FALLBACK");
        const phase = review ? (last.tool_call_id.includes("_check_") ? "check review" : "predict review") : fallback ? "check fallback" : check ? "check" : "predict";
        const toolCallId = review ? undefined : `coding_${check ? "check" : "predict"}_live_${++poseCount}`;
        assert.ok(input.tools?.some(tool => tool.function?.name === "coding_question"), "Real teacher must receive built plugin native tool");
        evidence.providerRequests.push({ phase, keylessPlaceholder: req.headers.authorization === "Bearer not-needed", ...input });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "chatcmpl-coding-" + evidence.providerRequests.length, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        chunk({ role: "assistant" }); res.flushHeaders();
        pending.set(res, () => {
          if (review) { chunk({ content: reviewText }); chunk({}, "stop"); }
          else {
            chunk({ tool_calls: [{ index: 0, id: toolCallId, type: "function", function: { name: "coding_question", arguments: JSON.stringify({ type: check ? "check" : "predict", nodeId: "coding_node", question: check ? "Read the coding check, then reveal and edit the function." : "Predict by editing this Python function.", payload: { language: "python", starterCode: starter } }) } }] }); chunk({}, "tool_calls");
          }
          res.end("data: [DONE]\n\n");
        });
        res.once("close", () => pending.delete(res));
      } catch (error) { fail(error); }
    });
  } catch (error) { fail(error); }
});
async function release() {
  await until(() => pending.size === 1, "exactly one held loopback response");
  const [response, finish] = pending.entries().next().value; pending.delete(response); finish();
}

try {
  console.log(`Native coding smoke evidence: ${scratch}`);
  sourceDigest = digestTree(source);
  if (process.env.LH_STANDALONE_SHA256) assert.equal(sourceDigest, process.env.LH_STANDALONE_SHA256, "Use the exact newly approved question-UI payload");
  // cpSync preserves relative package links without rewriting them to source.
  assert.ok(!standalone.startsWith(source + path.sep));
  fs.cpSync(source, standalone, { recursive: true, verbatimSymlinks: true });
  verifyCopyLinks(standalone);
  fs.mkdirSync(path.join(data, "plugins", manifest.id), { recursive: true });
  fs.cpSync(built, path.join(data, "plugins", manifest.id, "dist"), { recursive: true, dereference: true });
  fs.writeFileSync(auth, "{}\n", { flag: "wx" });
  const tree = { nodes: [{ id: "coding_node", title: "Offline code node" }], edges: [], version: 1 };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (id, content) => ({ id, role: "assistant", api: "openai-completions", provider: "custom", model, content, stopReason: "toolUse", timestamp: 2, usage });
  const result = (id, toolCallId, toolName, details) => ({ id, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "Offline prerequisite completed." }], details, isError: false, timestamp: 3 });
  const seeded = {
    version: 1, id: chatId, title: "Coding native proof", tree, createdAt: new Date(0).toISOString(), updatedAt: new Date().toISOString(), settings: { model: { provider: "custom", id: model } },
    messages: [
      { id: "seed_user", role: "user", content: "Offline code teaching proof.", timestamp: 1 },
      assistant("seed_probe", [{ type: "toolCall", id: "seed_probe_call", name: "probe_done", arguments: { assessment: { strands: [{ strand: "Code", assessment: "Ready for teaching." }] } } }]),
      result("seed_probe_result", "seed_probe_call", "probe_done", { ok: true }),
      assistant("seed_plan", [{ type: "toolCall", id: "seed_plan_call", name: "plan_init", arguments: { mermaid: "graph TD\n  coding_node[Offline code node]" } }]),
      result("seed_plan_result", "seed_plan_call", "plan_init", { ok: true, tree }),
      { ...assistant("seed_notes", [{ type: "text", text: Array.from({ length: 80 }, (_, index) => `Offline lesson paragraph ${index}: preserve code whitespace and keep thinking separate.`).join("\n\n") }]), stopReason: "stop" },
    ],
  };
  assert.deepEqual(snapshots(seeded), []);
  fs.mkdirSync(path.join(data, "chats"));
  fs.writeFileSync(path.join(data, "chats", `${chatId}.json`), JSON.stringify(seeded, null, 2), { flag: "wx" });
  const mockBase = `http://127.0.0.1:${await listen(mock)}/v1`;
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  evidence.origin = base; evidence.mockBase = mockBase;
  // Runtime imports must stay inside the copied payload or installed product.
  const guard = path.join(scratch, "imports.mjs");
  fs.writeFileSync(guard, `import {registerHooks} from 'node:module';import {realpathSync} from 'node:fs';import {fileURLToPath} from 'node:url';import path from 'node:path';\nconst roots=${JSON.stringify([standalone, path.join(data, "plugins")])};registerHooks({resolve(specifier,context,next){const result=next(specifier,context);if(result.url.startsWith('file:')){const file=realpathSync(fileURLToPath(result.url));if(!roots.some(root=>file===root||file.startsWith(root+path.sep)))throw Error('Import escaped disposable payload: '+file)}return result}});\n`);
  const serverLog = fs.openSync(path.join(scratch, "server.log"), "w");
  child = spawn(runtime, ["--import", guard, path.join(standalone, "server.js")], { cwd: standalone, env: { ...cleanEnv, ELECTRON_RUN_AS_NODE: "1", HOSTNAME: "127.0.0.1", PORT: String(port) }, stdio: ["ignore", serverLog, serverLog] });
  fs.closeSync(serverLog);
  child.on("error", error => { fixtureError = error; });
  await until(async () => {
    assert.equal(child.exitCode, null, "Packaged server exited; inspect server.log");
    try { return (await fetch(base, { signal: AbortSignal.timeout(1000) })).status === 200; } catch { return false; }
  }, "packaged server boot");
  const api = async (url, method = "GET", body, headers = {}) => {
    assert.equal(new URL(base + url).origin, base);
    const response = await fetch(base + url, { method, headers: { "content-type": "application/json", Origin: base, "Sec-Fetch-Site": "same-origin", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const text = await response.text(); assert.equal(response.status, 200, `${method} ${url}: ${text}`);
    return { response, payload: JSON.parse(text) };
  };
  const read = async () => (await api(route)).payload;
  const listing = (await api("/api/plugins")).payload;
  const discovered = listing.plugins.find(plugin => plugin.id === manifest.id);
  assert.equal(discovered?.enabled, false); assert.equal(discovered.status, "disabled");
  const enabled = (await api(`/api/plugins/${manifest.id}`, "PUT", { enabled: true })).payload.plugins.find(plugin => plugin.id === manifest.id);
  assert.equal(enabled.status, "active");
  const beforeProvider = await api("/api/custom-provider");
  const etag = beforeProvider.response.headers.get("etag"); assert.ok(etag);
  const configured = await api("/api/custom-provider", "POST", { baseUrl: mockBase, authMode: "keyless" }, { "If-Match": etag });
  assert.ok(configured.payload.models.some(entry => entry.id === model));
  assert.equal((await api("/api/custom-provider")).payload.authMode, "keyless");
  evidence.assertions.push("Public discovery defaults disabled; built product enabled; ETag/keyless provider uses loopback models endpoint only.");
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: path.join(scratch, "chrome-profile"), env: cleanEnv, args: ["--disable-background-networking", "--disable-sync", "--no-first-run", "--no-default-browser-check"] });
  page = await browser.newPage(); page.setDefaultTimeout(30_000);
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  // Passive tripwire only: never click a microphone, acquire media, or exercise IME.
  await page.evaluateOnNewDocument(() => {
    const attempts = []; Object.defineProperty(window, "__nativeMicAttempts", { value: attempts });
    const deny = name => function () { attempts.push(name); throw new Error(`Native proof forbids recording: ${name}`); };
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = deny("getUserMedia");
    if (navigator.getUserMedia) navigator.getUserMedia = deny("legacy getUserMedia");
    for (const name of ["MediaRecorder", "SpeechRecognition", "webkitSpeechRecognition"]) {
      if (window[name]) window[name] = deny(name);
    }
  });
  page.on("pageerror", error => evidence.pageErrors.push(String(error)));
  page.on("console", entry => evidence.console.push({ type: entry.type(), text: entry.text(), location: entry.location(), stage: evidence.stage }));
  page.on("response", response => evidence.responses.push({ url: response.url(), method: response.request().method(), status: response.status(), stage: evidence.stage }));
  page.on("requestfailed", request => evidence.failedRequests.push({ url: request.url(), method: request.method(), failure: request.failure(), stage: evidence.stage }));
  const cdp = await page.createCDPSession(); await cdp.send("Network.enable");
  cdp.on("Network.responseReceived", event => {
    if (new URL(event.response.url).pathname !== route + "/stream") return;
    const stream = { url: event.response.url, status: event.response.status, stage: evidence.stage, chunks: [] }; streams.set(event.requestId, stream);
    streamReads.push(cdp.send("Network.streamResourceContent", { requestId: event.requestId }).then(result => { stream.buffered = Buffer.from(result.bufferedData, "base64"); }, error => { stream.captureError = String(error); }));
  });
  cdp.on("Network.dataReceived", event => { if (event.data && streams.has(event.requestId)) streams.get(event.requestId).chunks.push(Buffer.from(event.data, "base64")); });
  cdp.on("Network.loadingFailed", event => { if (streams.has(event.requestId)) streams.get(event.requestId).failure = event.errorText; });
  await page.setRequestInterception(true);
  page.on("request", request => {
    const target = new URL(request.url()), external = ["http:", "https:", "ws:", "wss:"].includes(target.protocol) && target.origin !== base;
    evidence.requests.push({ url: request.url(), method: request.method(), type: request.resourceType(), stage: evidence.stage });
    if (external) evidence.blockedRequests.push(request.url());
    void (external ? request.abort("blockedbyclient") : request.continue()).catch(error => { fixtureError = error; });
  });
  assert.equal((await page.goto(base + `/chat/${chatId}`, { waitUntil: "domcontentloaded" })).status(), 200);
  const initial = await read(); assert.deepEqual(snapshots(initial), []);
  const post = predicate => page.waitForResponse(response => new URL(response.url()).pathname === "/api/chat" && response.request().method() === "POST" && predicate(JSON.parse(response.request().postData()).input));
  async function send(text) {
    const sent = post(input => input?.text === text);
    const subscribed = page.waitForResponse(response => new URL(response.url()).pathname === route + "/stream");
    await page.locator('[data-testid="composer"] [contenteditable="true"]').fill(text);
    await page.locator('[data-testid="composer"] button[aria-label="Send"]').click();
    assert.equal((await sent).status(), 200); assert.equal((await subscribed).status(), 200); await release();
  }
  const code = selector => page.$$eval(`${selector} .cm-line`, lines => lines.map(line => line.textContent).join("\n"));
  const fillCode = async value => { await page.focus(editor); await chord("a"); await page.keyboard.sendCharacter(value); };
  const waitSettled = () => until(async () => !(await read()).turnInFlight, "canonical terminal settlement");
  const assertNoMic = async () => {
    const attempts = await page.evaluate(() => window.__nativeMicAttempts);
    assert.deepEqual(attempts, [], "No recording/recognition was started");
    (evidence.micTripwire ??= []).push({ stage: evidence.stage, attempts });
  };
  async function assertCompositionGuard(selector, phase) {
    // Synthetic guard probes only, not an OS IME or trusted composition session.
    const posts = () => evidence.requests.filter(request => new URL(request.url).pathname === "/api/chat" && request.method === "POST").length;
    const beforePosts = posts(), beforeProvider = evidence.providerRequests.length;
    const result = await page.$eval(selector, field => {
      const before = field.textContent;
      const events = [{ isComposing: true }, { keyCode: 229 }].map(extra => {
        const event = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, ...extra });
        field.dispatchEvent(event);
        return { prevented: event.defaultPrevented, isComposing: event.isComposing, keyCode: event.keyCode };
      });
      return { events, unchanged: before === field.textContent };
    });
    assert.deepEqual(result.events, [{ prevented: false, isComposing: true, keyCode: 0 }, { prevented: false, isComposing: false, keyCode: 229 }]);
    assert.equal(result.unchanged, true);
    await delay(150);
    assert.equal(posts(), beforePosts, "Composition-marked Enter must not send an answer");
    assert.equal(evidence.providerRequests.length, beforeProvider);
    (evidence.compositionGuards ??= []).push({ phase, ...result, noSubmission: true });
  }
  async function assertHealthyFrame(phase) {
    await page.evaluate(() => document.activeElement?.blur());
    await delay(250); // Let the native focus-within border transition settle.
    const result = await page.$eval(`${dock} [data-testid="thinking-field"]`, frame => {
      // Canonical native QuestionDock classes, not an imported host implementation.
      const canonical = "rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50";
      const probe = document.createElement("div"); probe.className = canonical; frame.parentElement.append(probe);
      const keys = ["backgroundColor", "borderTopColor", "borderTopWidth", "borderTopStyle", "borderRadius", "transitionProperty"];
      const style = node => Object.fromEntries(keys.map(key => [key, getComputedStyle(node)[key]]));
      const actual = style(frame), expected = style(probe); probe.remove();
      const input = frame.querySelector('[contenteditable="true"]');
      return { canonical, classes: frame.className, actual, expected, form: frame.closest("form").className,
        inputClasses: input.className, inputBackground: getComputedStyle(input).backgroundColor, inputMinHeight: getComputedStyle(input).minHeight,
        labelClasses: frame.firstElementChild.className, actionsClasses: frame.lastElementChild.className,
        hint: frame.lastElementChild.querySelector('span[aria-hidden]')?.textContent.trim(),
        submitLabel: frame.querySelector('button[type="submit"]')?.textContent.trim(),
        dismiss: [...frame.closest('[data-testid="plugin-question-dock"]').querySelectorAll("button")].some(button => button.textContent.trim() === "Dismiss question") };
    });
    assert.equal(result.classes, result.canonical);
    assert.deepEqual(result.actual, result.expected, "Pending field matches the canonical native frame's computed styles");
    assert.equal(result.actual.borderTopWidth, "1px"); assert.equal(result.actual.borderTopStyle, "solid");
    assert.equal(result.actual.borderRadius, "10px");
    assert.ok(!["transparent", "rgba(0, 0, 0, 0)"].includes(result.actual.backgroundColor), "Native thinking frame paints its background");
    assert.equal(result.form, "border-t border-border/60 p-1.5");
    for (const token of ["field-sizing-content", "lh-input", "max-h-48", "w-full", "resize-none", "bg-transparent", "px-2.5", "py-2", "outline-none", "placeholder:text-muted-foreground/70", "min-h-10"]) assert.ok(result.inputClasses.split(" ").includes(token), token);
    assert.equal(result.inputBackground, "rgba(0, 0, 0, 0)");
    assert.equal(result.inputMinHeight, "40px", "Thinking uses the native one-line minimum");
    assert.equal(result.hint, "↵ submits · ⇧↵ newline");
    assert.equal(result.submitLabel, "Submit answer");
    assert.equal(result.labelClasses, "px-2.5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground");
    assert.equal(result.actionsClasses, "flex items-center justify-between gap-2 p-1");
    assert.equal(result.dismiss, false, "Healthy questions never expose recovery Dismiss");
    (evidence.pendingFrames ??= []).push({ phase, ...result });
  }
  async function assertAnsweredThinking(index, text, readingText) {
    const cards = await page.$$('[data-testid="plugin-question-answered"]'); assert.equal(cards.length, index + 1);
    const card = cards[index], block = await card.$('[data-testid="your-thinking"]'); assert.ok(block);
    const trigger = await block.$('[data-testid="your-thinking-trigger"]');
    assert.equal(await trigger.evaluate(node => node.textContent.trim()), "YOUR THINKING");
    assert.equal(await trigger.evaluate(node => node.getAttribute("aria-expanded")), "false", "Answer thinking defaults closed");
    assert.equal(await block.evaluate(node => node.classList.contains("bg-card")), false, "inCard thinking has no separate background band");
    assert.equal(await block.$(".lh-prose"), null);
    const readings = await page.$$('[data-testid="reading-thinking-block"]');
    if (readingText === undefined) assert.equal(readings.length, 0, "Prediction has no reading block");
    else {
      assert.equal(readings.length, 1);
      const reading = readings[0];
      assert.equal(await reading.evaluate(node => node.querySelector("button").textContent.trim()), "YOUR THINKING");
      assert.equal(await reading.evaluate(node => node.querySelector("button").getAttribute("aria-expanded")), "true", "Reading thinking defaults open");
      assert.equal(await reading.$eval(".lh-prose", node => node.textContent), readingText);
      assert.equal(await card.evaluate((node, preceding) => node.previousElementSibling === preceding && !node.contains(preceding), reading), true, "Reading thinking sits above/outside the answered card");
      assert.equal(await reading.evaluate(node => node.classList.contains("bg-card")), true);
    }
    await screenshot(`${index === 0 ? "predict" : "check"}-thinking-defaults`);
    await trigger.click(); // Trusted Puppeteer click, not a synthetic DOM event.
    assert.equal(await trigger.evaluate(node => node.getAttribute("aria-expanded")), "true");
    assert.equal(await block.$eval(".lh-prose", node => node.textContent), text);
    const quoteStyle = await block.$eval(".lh-prose", node => ({ fontStyle: getComputedStyle(node).fontStyle, color: getComputedStyle(node).color }));
    assert.equal(quoteStyle.fontStyle, "italic");
    (evidence.answeredThinking ??= []).push({ index, text, readingText, readingDefaultOpen: readingText !== undefined, answerDefaultClosed: true, answerInCard: true, quoteStyle });
  }

  evidence.stage = "predict";
  await send("CODING_NATIVE_PREDICT");
  await page.waitForSelector(editor, { visible: true }); await waitSettled();
  await assertHealthyFrame("predict");
  const predictRecord = await read(), predict = snapshots(predictRecord).at(-1);
  assert.equal(predict.pluginId, manifest.id); assert.equal(predict.typeId, "code"); assert.equal(predict.contractVersion, 1);
  assert.equal(predict.input.type, "predict"); assert.equal(predict.input.nodeId, "coding_node");
  assert.deepEqual(predict.input.payload, { language: "python", starterCode: starter }); assert.equal(predict.showThinking, true);
  assert.equal(predictRecord.messages.some(message => message.role === "toolResult" && message.toolCallId === predict.occurrence.toolCallId), false, "No fake execution result or temporary pose acknowledgment");
  assert.equal(await code(dock), starter, "Built CodeMirror editor receives starterCode");
  assert.equal(await page.$eval(editor, node => !!node.closest("form")), false);
  // Editing and submission use trusted browser input, not imported editor handles.
  // Only composition-suppression guard probes below dispatch synthetic key events.
  await fillCode("x"); await page.keyboard.press("Home"); await page.keyboard.press("Tab");
  assert.equal(await code(dock), "    x", "Host routes Tab to product handle exactly once");
  assert.equal(await page.$eval(editor, node => node.contains(document.activeElement)), true);
  await assertCompositionGuard(editor, "prediction code editor");
  await fillCode("def example():"); await page.keyboard.press("End");
  const postsBeforeCodeEnter = evidence.requests.filter(request => new URL(request.url).pathname === "/api/chat" && request.method === "POST").length;
  await page.keyboard.press("Enter");
  assert.equal(await code(dock), "def example():\n    ", "Code Enter inserts a newline with language indentation");
  assert.equal(evidence.requests.filter(request => new URL(request.url).pathname === "/api/chat" && request.method === "POST").length, postsBeforeCodeEnter, "Enter in code must not submit an answer");
  await page.keyboard.sendCharacter("return 1"); await page.keyboard.down("Shift"); await page.keyboard.press("Enter"); await page.keyboard.up("Shift");
  assert.equal(await code(dock), "def example():\n    return 1\n    ");
  const exactAnswer = "  # verbatim learner code\n\tvalue = '<script> literal & code'  \n\n";
  await fillCode(exactAnswer); assert.equal(await code(dock), exactAnswer);
  const thinkingText = "Host prediction thinking, not part of the code string.";
  await page.locator(thinking).fill(thinkingText);
  const editorElement = await page.$(`${dock} .cm-editor`);
  await page.focus(editor);
  for (let line = 0; line < 3; line++) await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Home"); await page.keyboard.down("Shift");
  for (let character = 0; character < 3; character++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  const selectionBefore = await page.evaluate(() => getSelection().toString());
  assert.equal(selectionBefore.length, 3, "Retain a meaningful real keyboard selection across natural folding");
  // Natural transcript blank-margin wheel; the ordinary prose wrapper can own wheels.
  await delay(2250);
  const point = await page.$eval('[role="log"]', node => { const rect = node.getBoundingClientRect(); return { x: rect.x + 12, y: Math.max(80, Math.max(0, rect.y) + 100) }; });
  await page.mouse.click(point.x, point.y);
  for (const deltaY of [-420, -420, -840, -420, -420]) {
    await page.mouse.wheel({ deltaY }); await delay(150);
    if (await page.$('[data-testid="question-dock-bar"]')) break;
  }
  await page.waitForSelector('[data-testid="question-dock-bar"]', { visible: true, timeout: 5000 });
  assert.equal(await editorElement.evaluate(node => node.isConnected), true);
  assert.equal(await code(dock), exactAnswer);
  await page.locator('[data-testid="question-dock-bar"]').click(); await page.waitForSelector(editor, { visible: true });
  assert.equal(await editorElement.evaluate(node => node === document.querySelector('[data-testid="plugin-question-dock"] .cm-editor')), true);
  assert.equal(await code(dock), exactAnswer);
  await page.focus(editor);
  // CodeMirror restores the DOM selection during its focus/update cycle. Wait
  // for that observable state rather than sampling before the focus work settles.
  await page.waitForFunction(selection => getSelection()?.toString() === selection, {}, selectionBefore);
  const selectionAfter = await page.evaluate(() => getSelection().toString());
  assert.equal(selectionAfter, selectionBefore, "Natural fold/reopen retains the CodeMirror selection");
  evidence.fold = { sameEditor: true, exactDraft: true, selectionBefore, selectionAfter };
  await screenshot("predict-draft");
  assert.equal(evidence.providerRequests.length, 1, "Unanswered prediction stops native turn");
  evidence.stage = "predict review";
  const answered = post(input => input?.type === "plugin-question-answer");
  const subscribed = page.waitForResponse(response => new URL(response.url()).pathname === route + "/stream");
  await page.focus(editor); await chord("Enter");
  const answerResponse = await answered; assert.equal(answerResponse.status(), 200);
  const submitted = JSON.parse(answerResponse.request().postData()).input;
  assert.deepEqual(submitted, { type: "plugin-question-answer", questionId: predict.questionId, occurrence: predict.occurrence, answer: exactAnswer, thinking: thinkingText });
  assert.equal((await subscribed).status(), 200);
  await until(() => pending.size === 1, "teacher review waiting");
  const beforeReview = await read();
  assert.equal(beforeReview.messages.at(-1).details.answer, exactAnswer, "Canonical native result saved before teacher emits review");
  const reviewRequest = evidence.providerRequests.at(-1); assert.equal(reviewRequest.phase, "predict review");
  const modelResult = reviewRequest.messages.at(-1);
  assert.equal(modelResult.role, "tool"); assert.equal(modelResult.tool_call_id, predict.occurrence.toolCallId);
  assert.ok(modelResult.content.includes(JSON.stringify(exactAnswer))); assert.ok(modelResult.content.includes(thinkingText));
  await release(); await waitSettled();
  await page.waitForSelector(dock, { hidden: true });
  await page.waitForFunction(text => document.querySelector("main")?.textContent.includes(text), {}, reviewText);
  const answeredRecord = await read(), answers = answeredRecord.messages.filter(message => message.details?.kind === "plugin-question");
  assert.equal(answers.length, 1);
  assert.deepEqual({ ...answers[0].details, answeredAt: "timestamp" }, { kind: "plugin-question", questionId: predict.questionId, pluginId: manifest.id, typeId: "code", contractVersion: 1, answer: exactAnswer, thinking: thinkingText, answeredAt: "timestamp" });
  assert.ok(Number.isFinite(Date.parse(answers[0].details.answeredAt)));
  assert.deepEqual(answers[0].lhQuestionOccurrence, predict.occurrence);
  const saved = '[aria-label="Submitted code"]';
  await page.waitForSelector(saved);
  assert.equal(await page.$eval(saved, node => node.getAttribute("contenteditable")), "false");
  assert.equal(await page.$$eval(`${saved} .cm-line`, lines => lines.map(line => line.textContent).join("\n")), exactAnswer);
  await assertAnsweredThinking(0, thinkingText);
  evidence.predict = { snapshot: predict, submitted, result: answers[0], modelResult };
  evidence.assertions.push("Native built-plugin predict snapshot; no pose result; starterCode; real Tab indentation and Enter/Shift+Enter auto-indented code newlines without submission; natural fold retains editor/draft; Cmd/Ctrl+Enter from the code editor saves the exact string and separate thinking; actual next model request reviews the genuine result; read-only saved code. Synthetic composing/229 Enter guard probes do not submit.");
  await screenshot("predict-reviewed");

  evidence.stage = "check";
  await send("CODING_NATIVE_CHECK");
  await page.waitForSelector('[data-testid="teach-check-reveal"]', { visible: true });
  await page.waitForSelector('[data-testid="reading-thinking-field"]', { visible: true });
  assert.equal(await page.$$eval(editor, nodes => nodes.some(node => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden")), false);
  const readingText = "Separate host reading thoughts before seeing the coding check.";
  await page.locator('[data-testid="reading-thinking-field"] [contenteditable="true"]').fill(readingText);
  await page.locator('[data-testid="teach-check-reveal"]').click();
  await page.waitForSelector(editor, { visible: true }); await waitSettled();
  assert.equal(await page.$eval('[data-testid="reading-thinking-field"] [contenteditable="true"]', node => node.textContent), readingText);
  assert.equal(await code(dock), starter);
  await assertHealthyFrame("check");
  const checkAnswer = "  # exact TEACH CHECK code\n\treturn '<tag> & literal'  \n\n";
  const checkThinkingFirst = "Separate after-reveal host thinking, never mixed into the answer.";
  const checkThinkingLast = "Shift+Enter keeps this second line in the thinking channel.  ";
  const checkThinking = `${checkThinkingFirst}\n${checkThinkingLast}`;
  await fillCode(checkAnswer); assert.equal(await code(dock), checkAnswer);
  await page.locator(thinking).fill(checkThinkingFirst);
  await page.focus(thinking); await page.keyboard.press("End");
  await page.keyboard.down("Shift"); await page.keyboard.press("Enter"); await page.keyboard.up("Shift");
  await page.keyboard.sendCharacter(checkThinkingLast);
  assert.equal(await page.$eval(thinking, node => node.textContent), checkThinking, "Shift+Enter inserts a thinking newline without submitting");
  await assertCompositionGuard(thinking, "check host thinking");
  const check = snapshots(await read()).at(-1);
  assert.equal(check.input.type, "check"); assert.equal(check.variant, "teach"); assert.notEqual(check.questionId, predict.questionId);
  assert.notEqual(check.occurrence.toolCallId, predict.occurrence.toolCallId);
  await screenshot("check-revealed");
  evidence.stage = "check review";
  const checkAnswered = post(input => input?.type === "plugin-question-answer" && input.questionId === check.questionId);
  const checkSubscribed = page.waitForResponse(response => new URL(response.url()).pathname === route + "/stream");
  await page.focus(thinking); await page.keyboard.press("Enter");
  const checkResponse = await checkAnswered; assert.equal(checkResponse.status(), 200);
  const checkSubmitted = JSON.parse(checkResponse.request().postData()).input;
  assert.deepEqual(checkSubmitted, { type: "plugin-question-answer", questionId: check.questionId, occurrence: check.occurrence, answer: checkAnswer, thinking: checkThinking, readingThinking: readingText });
  assert.equal((await checkSubscribed).status(), 200);
  await until(() => pending.size === 1, "check teacher review waiting");
  const checkBeforeReview = await read(), checkResult = checkBeforeReview.messages.at(-1);
  assert.deepEqual({ ...checkResult.details, answeredAt: "timestamp" }, { kind: "plugin-question", questionId: check.questionId, pluginId: manifest.id, typeId: "code", contractVersion: 1, answer: checkAnswer, thinking: checkThinking, readingThinking: readingText, answeredAt: "timestamp" });
  assert.ok(Number.isFinite(Date.parse(checkResult.details.answeredAt)));
  assert.deepEqual(checkResult.lhQuestionOccurrence, check.occurrence);
  const checkReview = evidence.providerRequests.at(-1); assert.equal(checkReview.phase, "check review");
  const checkModelResult = checkReview.messages.at(-1);
  assert.equal(checkModelResult.role, "tool"); assert.equal(checkModelResult.tool_call_id, check.occurrence.toolCallId);
  const checkModelAnswer = JSON.parse(checkModelResult.content);
  assert.equal(checkModelAnswer.answer, checkAnswer);
  assert.equal(checkModelAnswer.thinking, checkThinking);
  assert.equal(checkModelAnswer.readingThinking, readingText);
  await release(); await waitSettled(); await page.waitForSelector(dock, { hidden: true });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="plugin-question-answered"]').length === 2);
  const checkSaved = (await page.$$(saved))[1]; assert.ok(checkSaved);
  assert.equal(await checkSaved.evaluate(node => node.getAttribute("contenteditable")), "false");
  assert.equal(await checkSaved.$$eval(".cm-line", lines => lines.map(line => line.textContent).join("\n")), checkAnswer);
  await assertAnsweredThinking(1, checkThinking, readingText);
  const priorAnswers = (await read()).messages.filter(message => message.details?.kind === "plugin-question");
  assert.equal(priorAnswers.length, 2);
  assert.deepEqual(priorAnswers[0], answers[0]); assert.deepEqual(priorAnswers[1], checkResult);
  evidence.check = { snapshot: check, submitted: checkSubmitted, result: checkResult, modelResult: checkModelResult, readingText, checkThinking };
  evidence.assertions.push("Plain Enter from host thinking submits the native TEACH CHECK with exact code plus separate reading/multiline answer thinking; Shift+Enter inserts a thinking newline, while synthetic composing/229 Enter guard probes do not submit. Raw canonical envelope and next teacher request preserve all three channels. Reading is above the answered card, labeled YOUR THINKING and default-open; answer thinking is inside the card, inCard/default-closed, and a trusted click reveals its exact text. Prediction has no reading block. Pending fields match canonical native computed frame styles and healthy questions have no Dismiss.");
  await screenshot("check-reviewed");
  await assertNoMic();

  evidence.stage = "check fallback";
  await send("CODING_NATIVE_CHECK_FALLBACK");
  await page.waitForSelector('[data-testid="teach-check-reveal"]', { visible: true });
  await page.locator('[data-testid="teach-check-reveal"]').click();
  await page.waitForSelector(editor, { visible: true }); await waitSettled();
  await assertHealthyFrame("fresh fallback check before disable");
  const fallbackCheck = snapshots(await read()).at(-1);
  assert.equal(fallbackCheck.input.type, "check");
  assert.notEqual(fallbackCheck.questionId, check.questionId); assert.notEqual(fallbackCheck.questionId, predict.questionId);
  assert.notEqual(fallbackCheck.occurrence.toolCallId, check.occurrence.toolCallId);
  assert.equal(await code(dock), starter);
  evidence.fallback = { snapshot: fallbackCheck };
  await screenshot("fresh-check-before-disable");
  evidence.stage = "disabled fallback and dismissal";
  const requestCount = evidence.providerRequests.length;
  assert.equal(requestCount, 5);
  await api(`/api/plugins/${manifest.id}`, "PUT", { enabled: false });
  await assertNoMic();
  // Public navigation reloads registrations; no private runtime hook/notification.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(dock, { visible: true });
  const reveal = await page.$('[data-testid="teach-check-reveal"]');
  if (reveal && await reveal.evaluate(node => node.getClientRects().length > 0)) await reveal.click();
  await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes("Question unavailable"), {}, dock);
  assert.equal(await page.$$eval(editor, nodes => nodes.length), 0);
  assert.ok((await page.$eval(dock, node => node.textContent)).includes(fallbackCheck.input.question));
  assert.equal(await page.$$eval(`${dock} button`, buttons => buttons.filter(button => button.textContent.trim() === "Dismiss question").length), 1, "Unavailable renderer exposes exactly one recovery Dismiss");
  const disabledRecord = await read();
  assert.equal(snapshots(disabledRecord).at(-1).questionId, fallbackCheck.questionId);
  assert.deepEqual(disabledRecord.messages.filter(message => message.details?.kind === "plugin-question"), priorAnswers, "Disabling must preserve both earlier answers verbatim");
  assert.equal(disabledRecord.messages.some(message => message.details?.kind === "plugin-question-cancelled"), false);
  assert.equal(evidence.providerRequests.length, requestCount, "Disable does not continue or auto-cancel");
  const turnsBefore = disabledRecord.turns?.length ?? 0;
  const postsBefore = evidence.requests.filter(request => new URL(request.url).pathname === "/api/chat" && request.method === "POST").length;
  await screenshot("disabled-fallback");
  const dismissed = page.waitForResponse(response => new URL(response.url()).pathname === route + "/dismiss" && response.request().method() === "POST");
  // Use the visible recovery button through the browser's trusted input path.
  await page.locator(`${dock} button::-p-text(Dismiss question)`).click();
  assert.equal((await dismissed).status(), 200);
  await page.waitForSelector(dock, { hidden: true }); await delay(350);
  const finalRecord = await read();
  assert.equal(finalRecord.turnInFlight, false); assert.equal(finalRecord.turns?.length ?? 0, turnsBefore);
  assert.equal(evidence.providerRequests.length, requestCount);
  assert.equal(evidence.requests.filter(request => new URL(request.url).pathname === "/api/chat" && request.method === "POST").length, postsBefore);
  const cancellations = finalRecord.messages.filter(message => message.details?.kind === "plugin-question-cancelled");
  assert.equal(cancellations.length, 1); assert.equal(cancellations[0].details.questionId, fallbackCheck.questionId);
  assert.equal(cancellations[0].details.reason, "dismissed"); assert.deepEqual(cancellations[0].details.occurrence, fallbackCheck.occurrence);
  assert.deepEqual(finalRecord.messages.filter(message => message.details?.kind === "plugin-question"), priorAnswers, "Recovery dismissal cannot alter either earlier answer");
  await assertNoMic();
  evidence.cancellation = cancellations[0]; evidence.finalRecord = finalRecord;
  evidence.assertions.push("A second fresh native check has a unique tool-call/occurrence identity; disabling preserves that pending identity and both earlier answers, exposing only recovery Dismiss. Explicit occurrence-bound dismissal silently cancels only the fresh check with no extra learner answer, chat POST, turn, or teacher request. Passive media tripwires remain untouched; no recording/IME flow was exercised.");
  await screenshot("dismissed");
  await Promise.all(streamReads); evidence.streams = streamSnapshots();
  assert.deepEqual(evidence.providerRequests.map(request => request.phase), ["predict", "predict review", "check", "check review", "check fallback"]);
  assert.equal(evidence.streams.length, 5);
  assert.deepEqual(evidence.streams.map(stream => stream.stage), ["predict", "predict review", "check", "check review", "check fallback"]);
  for (const stream of evidence.streams) {
    assert.equal(stream.status, 200); assert.equal(stream.captureError, undefined); assert.ok(stream.text.includes("data: [DONE]"));
    assert.ok(!stream.text.includes("Question posed — the turn ends here"), "Temporary native pose acknowledgment must not leak");
  }
  assert.deepEqual(evidence.pageErrors, []); assert.deepEqual(evidence.blockedRequests, []);
  const expectedResponse = entry => {
    const url = new URL(entry.url);
    return url.origin === base && entry.method === "GET" && ((url.pathname === "/api/stt/token" && entry.status === 503) || (url.pathname === "/favicon.ico" && entry.status === 404));
  };
  evidence.expectedBaselineResponses = evidence.responses.filter(expectedResponse);
  assert.deepEqual(evidence.responses.filter(entry => entry.status >= 400 && !expectedResponse(entry)), []);
  const expectedAbort = entry => {
    const url = new URL(entry.url);
    return entry.method === "GET" && entry.failure?.errorText === "net::ERR_ABORTED" && url.origin === base && (
      (url.pathname === route + "/stream" && evidence.streams.some(stream => stream.url === entry.url && stream.stage === entry.stage && stream.status === 200 && stream.failure === "net::ERR_ABORTED" && stream.text.includes("data: [DONE]"))) ||
      (url.searchParams.has("_rsc") && !url.pathname.startsWith("/api/") && evidence.responses.some(response => response.url === entry.url && response.status === 200)));
  };
  evidence.expectedAborts = evidence.failedRequests.filter(expectedAbort);
  assert.deepEqual(evidence.failedRequests.filter(entry => !expectedAbort(entry)), []);
  assert.deepEqual(evidence.console.filter(entry => ["error", "assert"].includes(entry.type) && !evidence.expectedBaselineResponses.some(response => entry.location.url === response.url && entry.text === `Failed to load resource: the server responded with a status of ${response.status} (${response.status === 503 ? "Service Unavailable" : "Not Found"})`)), []);
  assert.equal(fixtureError, undefined);
  evidence.stage = "passed"; evidence.passed = true;
} catch (error) {
  failure = error; evidence.failure = { message: String(error), stack: error.stack };
  if (page && !page.isClosed()) {
    try { await screenshot("failure"); fs.writeFileSync(path.join(scratch, "failure.html"), await page.content()); } catch (captureError) { evidence.captureError = String(captureError); }
  }
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM");
    });
  }
  for (const response of pending.keys()) response.destroy();
  mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
  evidence.streams = streamSnapshots();
  if (sourceDigest) {
    evidence.sourceDigestBefore = sourceDigest; evidence.sourceDigestAfter = digestTree(source);
    if (sourceDigest !== evidence.sourceDigestAfter) { failure ??= new Error("Verified source payload changed during smoke"); evidence.passed = false; evidence.sourceChanged = true; }
  }
  fs.writeFileSync(path.join(scratch, "evidence.json"), JSON.stringify(evidence, null, 2));
}
if (failure) { console.error(`FAIL at ${evidence.stage}. Evidence: ${scratch}`); throw failure; }
console.log(`PASS: ${evidence.assertions.join("\n")}\nEvidence: ${scratch}`);
