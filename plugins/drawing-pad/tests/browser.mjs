import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";

const root = fileURLToPath(new URL("../", import.meta.url)), repo = path.resolve(root, "../..");
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "lh-drawing-pad-browser-"));
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const errors = [], denied = [], groups = [], requests = [];
let browser, server, page;
function group(label) { groups.push(label); console.log(`PASS ${label}`); }
try {
  await build({ absWorkingDir: root, entryPoints: ["tests/browser-fixture.mjs"], outfile: path.join(evidence, "fixture.js"), bundle: true,
    format: "esm", platform: "browser", target: "es2022", jsx: "automatic", alias: { "@": repo },
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning",
    banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "production" } };' },
    plugins: [{ name: "discard-unused-node-only-barrel-import", setup(builder) {
      builder.onResolve({ filter: /^node:crypto$/ }, args => ({ path: args.path, external: true, sideEffects: false }));
    } }] });
  assert.doesNotMatch(fs.readFileSync(path.join(evidence, "fixture.js"), "utf8"), /(?:from\s*|import\s*)["']node:/, "the fixture must not retain any Node runtime import");
  const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/plugin.css"><link rel="stylesheet" href="/katex/katex.min.css"><link rel="stylesheet" href="/styles/capture-parent.css"><style>
    *{box-sizing:border-box} body{margin:0;background:#141414;color:#e6e6e6;font-family:monospace} #bar{height:48px;display:flex;gap:12px;padding:8px 240px;background:#1c1c1c} button{font:inherit;font-size:12px;padding:6px 10px;background:#1c1c1c;color:#e6e6e6;border:1px solid #434343;border-radius:6px;cursor:pointer} button[data-variant=secondary]{background:#434343}button:disabled{opacity:.4}button svg{display:block;width:16px;height:16px}
    #sidebar{position:fixed;left:0;top:48px;width:220px;bottom:0;background:#1c1c1c}#pad{position:fixed;left:220px;top:48px;right:0;bottom:0;background:#141414}#close-pad{position:absolute;right:12px;top:10px;z-index:10}#settings{position:fixed;inset:150px 300px;background:#1c1c1c;z-index:50;padding:24px}.lh-prose{font-family:serif;font-size:16px;line-height:1.5}.lh-prose p{margin:0 0 8px}#settings[hidden]{display:none}
    </style></head><body><div id="bar"><button id="draw">Loading</button><button id="settings-open">Settings</button></div><aside id="sidebar">Fixture sidebar</aside><div id="settings" hidden><label>Ink color <input id="ink"></label><label>Image scale (%) <input id="image-scale" type="number"></label><p id="setting-error"></p><button id="blur-target">Done editing</button></div><script type="module" src="/fixture.js"></script></body></html>`;
  server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://fixture");
    let file, type;
    if (url.pathname === "/") { response.setHeader("content-type", "text/html"); response.end(html); return; }
    if (url.pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
    if (url.pathname === "/styles/capture-parent.css") { response.setHeader("content-type", "text/css"); response.end('@import url("./nested/fonts.css");'); return; }
    if (url.pathname === "/styles/nested/fonts.css") { response.setHeader("content-type", "text/css"); response.end('@import url("./deeper.css"); .drawing-pad-reference{font-family:"Drawing Fixture, Nested",serif} @font-face{font-family:UnusedReference;src:url(../../forbidden-unused-font.woff2)}'); return; }
    if (url.pathname === "/styles/nested/deeper.css") { response.setHeader("content-type", "text/css"); response.end('@supports (font-family:serif){@media screen{@font-face{font-family:"Drawing Fixture, Nested";font-display:swap;src:url("../../fonts/cmunbx.ttf") format("truetype")}}}'); return; }
    if (url.pathname === "/fixture.js") { file = path.join(evidence, "fixture.js"); type = "text/javascript"; }
    else if (url.pathname === "/plugin.css") { file = path.join(root, "src/styles.css"); type = "text/css"; }
    else if (url.pathname === "/fonts/cmunbx.ttf") { file = path.join(repo, "public/fonts/cmunbx.ttf"); type = "font/ttf"; }
    else if (url.pathname.startsWith("/katex/")) {
      const suffix = decodeURIComponent(url.pathname.slice(7));
      file = path.resolve(repo, "node_modules/katex/dist", suffix);
      if (!file.startsWith(path.join(repo, "node_modules/katex/dist") + path.sep)) { response.writeHead(403).end(); return; }
      type = file.endsWith(".css") ? "text/css" : "font/woff2";
    }
    if (!file || !fs.existsSync(file)) { response.writeHead(404).end(); return; }
    response.setHeader("content-type", type); response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  if (process.argv.includes("--serve")) {
    console.log(`Drawing Pad interactive fixture: ${origin}`);
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } else {
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: path.join(evidence, "profile"), args: ["--no-sandbox"] });
  page = await browser.newPage(); await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  page.on("pageerror", error => errors.push(error.stack ?? String(error)));
  page.on("console", message => { if (message.type() === "error" && !message.text().includes("favicon.ico")) errors.push(message.text()); });
  await page.setRequestInterception(true);
  page.on("request", request => {
    const url = request.url(); requests.push(url);
    if (/^(data:|blob:)/.test(url) || (url.startsWith(origin + "/") && !url.includes("/api/"))) void request.continue();
    else { denied.push(url); void request.abort(); }
  });
  await page.goto(origin, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => window.fixtureReady);
  const run = fn => page.evaluate(fn);
  const call = (method, ...args) => page.evaluate((method, args) => window.fixture[method](...args), method, args);
  const button = label => page.evaluate(label => [...document.querySelectorAll(".drawing-pad-tools button")].find(button => (button.getAttribute("aria-label") ?? button.textContent) === label)?.click(), label);
  const waitForSheet = () => page.waitForFunction(() => {
    const paper = document.querySelector(".drawing-pad-paper"), status = document.querySelector(".drawing-pad-status");
    if (status?.getAttribute("role") === "alert") throw new Error(status.textContent);
    return paper && !paper.hidden && status.hidden;
  }, { timeout: 30000 });
  const open = async () => { await page.click("#draw"); await waitForSheet(); };
  const close = () => page.keyboard.press("Escape");
  const ink = () => run(() => {
    const canvas = document.querySelector(".drawing-pad-ink"); if (!canvas) return 0;
    return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data.filter((value, index) => index % 4 === 3 && value > 0).length;
  });
  const bg = () => run(() => document.querySelector(".drawing-pad-background")?.src);
  const stroke = async (offset = 0) => {
    const box = await (await page.$(".drawing-pad-ink")).boundingBox();
    await page.mouse.move(box.x + box.width * .3, box.y + box.height * (.7 + offset)); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .5, box.y + box.height * (.75 + offset), { steps: 8 }); await page.mouse.up();
  };
  const label = () => run(() => document.querySelector("#draw").textContent);
  const setScale = async value => {
    await call("showSettings"); await page.$eval("#image-scale", field => { field.focus(); field.select(); });
    await page.keyboard.type(String(value)); await page.click("#blur-target");
    await page.waitForFunction(value => window.fixture.saved().imageScale === value, {}, value); await page.keyboard.press("Escape");
  };
  const images = result => result?.content?.images ?? result?.answer?.images ?? result?.answerImages ?? result?.submissionImages ?? [];
  const pngSize = data => page.evaluate(async data => { const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode(); return [image.naturalWidth, image.naturalHeight]; }, data);
  const pose = (id, custom = false) => [{ role: "assistant", id: `m-${id}`, content: [{ type: "toolCall", id, name: custom ? "code_problem" : "problem", arguments: { modelSolution: "NEVER CAPTURE SOLUTION" } }] },
    { role: "toolResult", toolCallId: id, toolName: custom ? "code_problem" : "problem", ...(custom ? { details: { pluginProblem: { protocolVersion: 1, problemId: id, pluginId: "code", typeId: "example" } } } : {}) }];
  const occurrence = (id, custom = false) => ({ messageId: `m-${id}`, contentIndex: 0, toolCallId: id, toolName: custom ? "code_problem" : "problem" });
  const question = { type: "answer", available: true, revealed: true, expanded: true,
    question: { id: "q", kind: "quiz", question: "Find $x^2$ when $x=3$.", context: "A **read-only** reference.", mode: "single-select",
      options: [{ value: "b", label: "$9$" }, { value: "a", label: "$6$" }], occurrence: { messageId: "mq", contentIndex: 0, toolCallId: "q", toolName: "quiz" } },
    draft: { text: "NEVER CAPTURE LEARNER DRAFT", values: ["a"], thinking: "private thinking" } };
  assert.deepEqual(await run(() => window.fixture.placement.sessions), ["teaching", "practice"]); assert.equal(await label(), "Draw");
  assert.equal(await run(() => window.fixture.saved().imageScale), 50);
  await setScale(100);
  group("public action placement, default 50 percent scale, and accepted scale preference changes");
  const pageStyles = () => run(() => {
    const seen = new Set(), sheets = [];
    const visit = sheet => {
      if (seen.has(sheet)) return; seen.add(sheet);
      sheets.push({ href: sheet.href, rules: [...sheet.cssRules].map(rule => rule.cssText) });
      for (const rule of sheet.cssRules) if (rule.type === CSSRule.IMPORT_RULE && rule.styleSheet) visit(rule.styleSheet);
    };
    for (const sheet of document.styleSheets) visit(sheet);
    return { sheets, body: getComputedStyle(document.body).backgroundColor, bar: getComputedStyle(document.querySelector("#bar")).backgroundColor };
  });
  const stylesBefore = await pageStyles();

  await call("navigate", "teach", "teaching", question); await open();
  assert.equal(await run(() => window.fixture.mathSeen), true); assert.equal(await ink(), 0);
  const texts = await run(() => window.fixture.markdownLog);
  assert.deepEqual(texts.slice(-4), [question.question.question, question.question.context, "$9$", "$6$"]);
  assert.equal(texts.join(" ").includes("NEVER CAPTURE"), false);
  const initialBackground = await bg(); assert.ok(initialBackground.startsWith("data:image/png;base64,"));
  const referenceMetrics = () => run(() => {
    const image = document.querySelector(".drawing-pad-background").getBoundingClientRect(), view = document.querySelector(".drawing-pad-ink").getBoundingClientRect();
    return { width: image.width, height: image.height, centerOffset: image.x + image.width / 2 - view.x - view.width / 2, bottomGap: view.bottom - image.bottom };
  });
  const initialReference = await referenceMetrics();
  assert.equal(initialReference.width, 670); assert.equal(initialReference.centerOffset, 0); assert.equal(initialReference.bottomGap, 24);
  group("normal native question-content width and a 24px bottom-center anchor");
  await page.screenshot({ path: path.join(evidence, "question-sheet.png") });
  group("real host Markdown/KaTeX reference, exact option order, no learner drafts");
  assert.deepEqual(await pageStyles(), stylesBefore);
  const embeddedFonts = await call("fontCssProbe");
  assert.match(embeddedFonts, /Drawing Fixture, Nested/); assert.match(embeddedFonts, /data:font\/ttf;base64,/);
  assert.match(embeddedFonts, /font-display: swap/); assert.doesNotMatch(embeddedFonts, /UnusedReference|https?:|\.\.\//);
  assert.equal(requests.some(url => url.endsWith("/nested/fonts.css") && !url.includes("/styles/")), false);
  assert.equal(requests.some(url => url.endsWith("/forbidden-unused-font.woff2")), false);
  assert.deepEqual(await pageStyles(), stylesBefore);
  group("nested relative imports embed only used fonts without changing live CSS or dark page colors");
  const iconButtons = await run(() => [...document.querySelectorAll(".drawing-pad-tools button[aria-label]")].map(button => ({ name: button.getAttribute("aria-label"), title: button.title, text: button.textContent, svg: !!button.querySelector("svg") })));
  for (const name of ["Pen", "Eraser", "Hand", "Undo"]) assert.deepEqual(iconButtons.find(button => button.name === name), { name, title: name, text: "", svg: true });
  assert.equal(await run(() => [...document.querySelectorAll(".drawing-pad-tools button")].find(button => button.textContent === "Clear")?.querySelector("svg") === null), true);
  group("Pen/Eraser/Hand/Undo are accessible icon-only controls; Clear remains text");

  await stroke(); const inkBefore = await ink(); assert.ok(inkBefore > 100); assert.equal(await label(), "Draw (unsent)");
  await close(); assert.equal(await page.$("#pad"), null); assert.equal(await run(() => window.fixture.attempts.length), 0);
  await open(); assert.equal(await bg(), initialBackground); assert.equal(await ink(), inkBefore);
  await page.click("#draw"); assert.equal(await page.$("#pad"), null); await open();
  group("mouse ink and button/Escape close preserve work without sending");

  const refused = await call("submit", { accept: false }); assert.equal(images(refused).length, 1); assert.equal(await ink(), inkBefore);
  assert.equal(await label(), "Draw (unsent)");
  const cancelled = await call("submit", { cancel: true }); assert.match(cancelled.error, /cancel/i); assert.equal(await ink(), inkBefore);
  const accepted = await call("submit"); assert.equal(images(accepted).length, 1); assert.equal(accepted.answer.text, "fixture answer");
  assert.match(images(accepted)[0].data, /^iVBORw0KGgo/); assert.equal(await ink(), 0); assert.equal(await label(), "Draw");
  const bitmap = await page.evaluate(async data => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
    const c = canvas.getContext("2d"); c.drawImage(image, 0, 0); const p = c.getImageData(0, 0, canvas.width, canvas.height).data;
    let referencePixels = 0, yellowPixels = 0, toolbarPixels = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4, nonBackground = p[i] !== 20 || p[i + 1] !== 20 || p[i + 2] !== 20;
      if (y < 24 && nonBackground) toolbarPixels++;
      if (y >= 24 && nonBackground && !(p[i] === 250 && p[i + 1] === 204 && p[i + 2] === 21)) referencePixels++;
      if (p[i] === 250 && p[i + 1] === 204 && p[i + 2] === 21 && p[i + 3] === 255) yellowPixels++;
    }
    return { referencePixels, yellowPixels, toolbarPixels };
  }, images(accepted)[0].data);
  assert.ok(bitmap.referencePixels > 100); assert.ok(bitmap.yellowPixels > 100); assert.equal(bitmap.toolbarPixels, 0);
  group("teaching refusal/cancel retention, real PNG export, acceptance clears");

  await stroke(); await call("submit", { defer: true }); await stroke(-.2); const newer = await ink(); await call("ack");
  assert.equal(await ink(), newer); assert.equal(await label(), "Draw (unsent)");
  await call("navigate", "other", "teaching"); assert.equal(await label(), "Draw"); await open(); assert.equal(await ink(), 0); await stroke();
  await call("navigate", "teach", "teaching", question); assert.equal(await label(), "Draw (unsent)"); await open(); assert.equal(await ink(), newer);
  group("late acknowledgments cannot erase newer work; navigation isolates sessions");

  await button("Clear"); assert.equal(await ink(), 0); await stroke();
  await button("Eraser"); await stroke(); assert.equal(await ink(), 0); assert.equal(await label(), "Draw");
  const empty = await call("submit", { accept: false }); assert.equal(images(empty).length, 0);
  await button("Undo"); assert.ok(await ink() > 0);
  await page.focus(".drawing-pad-viewport"); await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control"); assert.equal(await ink(), 0);
  group("whole-stroke erase, full erasure sends nothing, Undo and local keyboard Undo");

  await button("Pen"); const beforeTouch = await ink();
  await run(() => { const canvas = document.querySelector(".drawing-pad-ink"), rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 900, pointerType: "touch", button: 0, buttons: 1, pressure: .8, clientX: rect.x + 100, clientY: rect.y + 100 })); });
  assert.equal(await ink(), beforeTouch);
  await page.mouse.click(700, 700, { button: "right" }); assert.equal(await ink(), beforeTouch);
  const cdp = await page.createCDPSession(); const box = await (await page.$(".drawing-pad-ink")).boundingBox();
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + 150, y: box.y + 300, pointerType: "pen", force: 0 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x + 150, y: box.y + 300, button: "left", buttons: 1, pointerType: "pen", force: .8 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + 350, y: box.y + 350, buttons: 1, pointerType: "pen", force: .8 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x + 350, y: box.y + 350, button: "left", pointerType: "pen", force: 0 });
  assert.ok(await ink() > beforeTouch); await cdp.detach();
  group("touch/right-click ignored and browser-generated pressure-pen input draws");

  await button("Clear"); await stroke(); const originalPen = await ink();
  await run(() => document.querySelector(".drawing-pad-ink").addEventListener("pointerdown", event => { window.fixture.lastPenId = event.pointerId; }, { once: true }));
  const stylus = await page.createCDPSession(), penBox = await (await page.$(".drawing-pad-ink")).boundingBox();
  await stylus.send("Input.dispatchMouseEvent", { type: "mousePressed", x: penBox.x + penBox.width * .3, y: penBox.y + penBox.height * .7, button: "left", buttons: 1, pointerType: "pen", force: 0 });
  assert.equal(await ink(), originalPen, "zero-pressure contact is hover");
  await run(() => {
    const canvas = document.querySelector(".drawing-pad-ink"), r = canvas.getBoundingClientRect(), pointerId = window.fixture.lastPenId;
    canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId, pointerType: "pen", pressure: .8, buttons: 32, button: 5, clientX: r.x + r.width * .4, clientY: r.y + r.height * .725 }));
  });
  assert.equal(await ink(), 0, "held eraser bit removes the entire intersected stroke");
  await run(() => {
    const canvas = document.querySelector(".drawing-pad-ink"), r = canvas.getBoundingClientRect(), pointerId = window.fixture.lastPenId;
    canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId, pointerType: "pen", pressure: .8, buttons: 1, button: 5, clientX: r.x + r.width * .7, clientY: r.y + r.height * .3 }));
  });
  assert.ok(await ink() > 0, "releasing the held eraser returns to Pen despite button=5");
  const beforeHover = await ink();
  await run(() => {
    const canvas = document.querySelector(".drawing-pad-ink"), r = canvas.getBoundingClientRect(), pointerId = window.fixture.lastPenId;
    canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId, pointerType: "pen", pressure: 0, buttons: 1, clientX: r.x + r.width * .9, clientY: r.y + r.height * .3 }));
  });
  assert.equal(await ink(), beforeHover, "hover never joins distant pen points");
  await stylus.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: penBox.x + penBox.width * .9, y: penBox.y + penBox.height * .3, button: "left", pointerType: "pen", force: 0 });
  await stylus.detach(); await button("Undo"); assert.equal(await ink(), 0); await button("Undo"); assert.equal(await ink(), originalPen);
  group("zero-pressure hover and held/released stylus eraser preserve complete-stroke Undo");

  await call("setHistory", "practice", pose("p1"));
  const problem = { type: "thinking", expanded: true, problem: { statement: "Compute $\\frac{1}{2}+\\frac{1}{2}$.", occurrence: occurrence("p1") }, draft: { thinking: "" } };
  await call("navigate", "practice", "practice", problem); await open(); await stroke(); const practiceInk = await ink();
  let result = await call("submit"); assert.equal(images(result).length, 1); assert.equal(await ink(), practiceInk); assert.equal(await label(), "Draw");
  result = await call("submit"); assert.equal(images(result).length, 0); assert.equal(await ink(), practiceInk);
  await stroke(-.2); result = await call("submit"); assert.equal(images(result).length, 1); assert.ok(await ink() > practiceInk);
  result = await call("submit"); assert.equal(images(result).length, 0);
  group("practice retains board/undo across submissions and sends only changed images");

  const retained = await ink(), history = [...pose("p1"), { role: "assistant", id: "mc", content: [{ type: "toolCall", id: "c", name: "conclude", arguments: { outcome: "correct" } }] },
    { role: "toolResult", toolCallId: "c", toolName: "conclude" }];
  await call("setHistory", "practice", history); await call("setInput", { type: "text" }); await call("event", "turn-settled");
  await page.waitForNetworkIdle(); assert.equal(await ink(), retained); assert.ok(await page.$("#pad"));
  history.push({ role: "custom", customType: "problem-dismissed" }); await call("setHistory", "practice", history); await call("event", "record-changed");
  await page.waitForNetworkIdle(); assert.equal(await ink(), retained);
  await stroke(-.4); result = await call("submit"); assert.equal(images(result).length, 1); assert.ok(await ink() > retained);
  await call("event", "turn-settled"); await page.waitForNetworkIdle(); assert.ok(await page.$("#pad"));
  group("conclusion/dismissal/settlement retain the sheet; post-problem chat can send changes");

  const failed = [...history, ...pose("bad")]; failed.at(-1).isError = true;
  await call("setHistory", "practice", failed); await call("event", "turn-settled"); await page.waitForNetworkIdle(); assert.ok(await page.$("#pad"));
  const p2 = { ...problem, problem: { statement: "A genuinely new problem $2+2$.", occurrence: occurrence("p2") } };
  await call("setHistory", "practice", [...history, ...pose("p2")]); await call("setInput", p2); await call("event", "turn-settled");
  await page.waitForFunction(() => !document.querySelector("#pad")); assert.equal(await label(), "Draw");
  await open(); assert.equal(await ink(), 0); assert.ok((await run(() => window.fixture.markdownLog)).includes(p2.problem.statement));
  group("failed poses retain work; an accepted new problem closes/resets and reopens fresh");

  await stroke(); await call("submit"); await call("showSettings"); await page.$eval("#ink", field => { field.focus(); field.select(); }); await page.keyboard.type("#FFFFFF"); await page.click("#blur-target");
  await page.waitForFunction(() => window.fixture.saved().inkColor === "#ffffff"); await page.keyboard.press("Escape");
  assert.equal(await label(), "Draw (unsent)");
  const white = await run(() => { const c = document.querySelector(".drawing-pad-ink"), p = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < p.length; i += 4) if (p[i + 3] === 255) return [p[i], p[i + 1], p[i + 2]]; return []; });
  assert.deepEqual(white, [255, 255, 255]);
  await call("showSettings"); await page.$eval("#ink", field => { field.focus(); field.select(); }); await page.keyboard.type("#abc"); await page.click("#blur-target");
  assert.equal(await run(() => window.fixture.saved().inkColor), "#ffffff"); assert.match(await run(() => document.querySelector("#setting-error").textContent), /six-digit/);
  await call("notifySettings", { revision: 0, inkColor: "#facc15" }); assert.equal(await run(() => window.fixture.saved().inkColor), "#ffffff");
  await page.keyboard.press("Escape");
  group("hex setting validates, normalizes and recolors retained ink as a new practice change");

  const bgBeforeResize = await bg();
  const referenceSize = () => run(() => { const r = document.querySelector(".drawing-pad-background").getBoundingClientRect(); return [r.width, r.height]; });
  const referenceDimensions = await referenceSize();
  await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: 1 });
  await page.waitForFunction(() => document.querySelector(".drawing-pad-ink").width === document.querySelector(".drawing-pad-viewport").clientWidth);
  assert.equal(await bg(), bgBeforeResize); assert.deepEqual(await referenceSize(), referenceDimensions);
  assert.equal((await referenceMetrics()).bottomGap, 24); assert.equal((await referenceMetrics()).centerOffset, 0);
  assert.deepEqual(await run(() => { const c = document.querySelector(".drawing-pad-ink"), r = c.getBoundingClientRect(), v = document.querySelector(".drawing-pad-viewport"); return [r.width / c.width, r.height / c.height, r.width === v.clientWidth, r.height === v.clientHeight]; }), [1, 1, true, true]);
  await stroke(-.2);
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  await page.waitForFunction(() => document.querySelector(".drawing-pad-ink").width === document.querySelector(".drawing-pad-viewport").clientWidth);
  assert.deepEqual(await referenceSize(), referenceDimensions); assert.equal(await bg(), bgBeforeResize);
  assert.equal((await referenceMetrics()).bottomGap, 24);
  group("narrowing and widening resize only the viewport bitmap, retaining the bottom anchor without scaling");

  await page.setViewport({ width: 700, height: 650, deviceScaleFactor: 1 });
  await call("navigate", "fixed-width-narrow", "teaching", question); await open();
  const narrowReference = await referenceMetrics();
  assert.deepEqual(narrowReference, initialReference, "even a new sheet in a narrower-than-reference viewport has identical wrapping and height");
  assert.equal(await bg(), initialBackground);
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  await call("navigate", "practice", "practice", p2); await open();
  group("new sheets use the same native content width and full reference at small and large window sizes");

  await close();
  const p3 = { ...problem, problem: { statement: "New after a missed notification $3+3$.", occurrence: occurrence("p3") } };
  await call("setHistory", "practice", [...history, ...pose("p2"), { role: "assistant", id: "mc2", content: [{ type: "toolCall", id: "c2", name: "conclude", arguments: {} }] },
    { role: "toolResult", toolCallId: "c2", toolName: "conclude" }, ...pose("p3")]);
  await call("setInput", p3); await call("resync"); await page.waitForNetworkIdle(); await open(); assert.equal(await ink(), 0);
  assert.ok((await run(() => window.fixture.markdownLog)).includes(p3.problem.statement));
  group("resync observes new accepted problems while the pad is closed");

  await call("navigate", "hidden", "teaching", { ...question, revealed: false }); const logBefore = (await run(() => window.fixture.markdownLog)).length;
  await open(); assert.equal((await run(() => window.fixture.markdownLog)).length, logBefore); await stroke();
  const blankBackground = await bg(); await close(); await call("setInput", question); await open(); assert.equal(await bg(), blankBackground);
  await button("Clear"); await close(); await open(); assert.ok((await run(() => window.fixture.markdownLog)).length > logBefore);
  group("unrevealed checks start blank; existing ink freezes the original blank reference");

  await call("navigate", "custom", "teaching", { type: "plugin-question-answer", question: { occurrence: occurrence("q-custom"), questionId: "custom" } });
  await open(); await stroke(); result = await call("submit"); assert.equal(result.answer, false); assert.equal(result.answerImages.length, 1); assert.equal(await ink(), 0);
  const customPose = pose("pc", true); await call("setHistory", "custom-practice", customPose);
  await call("navigate", "custom-practice", "practice", { type: "plugin-problem-submission", problem: { problemId: "pc", occurrence: occurrence("pc", true) } });
  await open(); await stroke(); result = await call("submit"); assert.equal(result.submission, 0); assert.equal(result.submissionImages.length, 1); assert.ok(await ink() > 0);
  result = await call("submit"); assert.equal(result.submissionImages.length, 0);
  group("custom questions/problems stay blank and preserve falsy JSON with native image channels");

  await stroke(-.2); await run(() => { window.fixture.failLifecycle = true; });
  const syncFailure = await call("submit"); assert.match(syncFailure.error, /lifecycle/); assert.equal(await label(), "Draw (unsent)");
  await run(() => { window.fixture.failLifecycle = false; }); await call("submit"); assert.equal(await label(), "Draw");
  group("lifecycle read refusal fails closed and retains pending practice changes");

  await call("setHistory", "export-race", pose("race1"));
  await call("navigate", "export-race", "practice", { ...problem, problem: { statement: "Export race $1+1$.", occurrence: occurrence("race1") } });
  await open(); await stroke(-.35); await run(() => { window.fixture.holdDecode = true; window.fixture.pendingSubmission = window.fixture.submit(); });
  await page.waitForFunction(() => window.fixture.pendingDecodes() > 0);
  await call("setHistory", "export-race", [...pose("race1"), { role: "assistant", id: "mcc", content: [{ type: "toolCall", id: "cc", name: "conclude", arguments: {} }] },
    { role: "toolResult", toolCallId: "cc", toolName: "conclude" }, ...pose("race2")]);
  await call("setInput", { ...problem, problem: { statement: "Next problem $2+2$.", occurrence: occurrence("race2") } });
  await call("event", "turn-settled"); await page.waitForFunction(() => !document.querySelector("#pad"));
  await run(() => { window.fixture.holdDecode = false; window.fixture.releaseDecodes(); });
  const staleExport = await run(() => window.fixture.pendingSubmission); assert.match(staleExport.error, /sheet was reset/);
  await open(); assert.equal(await ink(), 0); await stroke(); result = await call("submit"); assert.equal(images(result).length, 1);
  group("a new accepted problem during async export cannot deliver the previous problem's drawing");

  await page.screenshot({ path: path.join(evidence, "retained-practice-sheet.png") });

  await call("navigate", "pending-capture", "teaching", question); await run(() => { window.fixture.holdMarkdown = true; });
  await page.click("#draw"); await page.waitForFunction(() => document.querySelector('.drawing-pad-reference [aria-busy="true"]'));
  assert.equal(await run(() => document.querySelector(".drawing-pad-paper").hidden), true);
  await close(); await run(() => { window.fixture.holdMarkdown = false; window.fixture.releaseMarkdown(); });
  await run(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.$("#pad"), null); await open(); assert.equal(await ink(), 0);
  group("closing a pending capture cancels readiness observers and cannot resurrect the pad");

  const diagram = { ...question, question: { ...question.question, kind: "explain", mode: "text", context: undefined, options: [],
    question: "Read this diagram.\\n\\n```mermaid\\ngraph TD; A[ORANGE_NODE]-->B[APPLE_NODE];\\n```".replaceAll("\\n", "\n") } };
  await call("navigate", "diagram", "teaching", diagram); await open(); assert.equal(await run(() => window.fixture.diagramSeen), true);
  await page.screenshot({ path: path.join(evidence, "diagram-sheet.png") });
  group("capture waits for the actual asynchronous host Mermaid renderer");

  await call("navigate", "mount-replay", "teaching", question);
  await run(() => { window.fixture.replayOnOpen = true; });
  const mountsBefore = await run(() => window.fixture.contentMounts);
  await page.click("#draw");
  await run(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.ok(await page.$("#pad"), "late cleanup from the first mount must not close its synchronous replacement");
  await waitForSheet(); await run(() => { window.fixture.replayOnOpen = false; });
  assert.equal(await run(() => window.fixture.contentMounts), mountsBefore + 2);
  assert.equal(await run(() => document.querySelectorAll(".drawing-pad-root").length), 1);
  group("initial development-mode mount/abort/remount survives delayed cleanup registration");

  await stroke(); const replayInk = await ink(), replayBackground = await bg();
  await call("replayContent"); await waitForSheet();
  assert.equal(await ink(), replayInk); assert.equal(await bg(), replayBackground); assert.equal(await label(), "Draw (unsent)");
  await button("Undo"); assert.equal(await ink(), 0);
  group("replaying a mounted sheet preserves frozen reference, ink and editable Undo history");

  const activeBox = await (await page.$(".drawing-pad-ink")).boundingBox();
  await page.mouse.move(activeBox.x + activeBox.width * .3, activeBox.y + activeBox.height * .7); await page.mouse.down();
  await page.mouse.move(activeBox.x + activeBox.width * .5, activeBox.y + activeBox.height * .75, { steps: 8 });
  await call("replayContent"); await page.mouse.up(); await waitForSheet(); assert.ok(await ink() > 100);
  await page.click("#close-pad"); assert.equal(await page.$("#pad"), null); await open(); assert.ok(await ink() > 100);
  await call("navigate", "after-replay", "teaching", question); await open();
  await close(); assert.equal(await page.$("#pad"), null); await open(); assert.equal(await ink(), 0);
  assert.equal(await run(() => document.querySelectorAll(".drawing-pad-root").length), 1);
  group("active-stroke replay flushes work while real X/Escape/navigation still close and reopen cleanly");

  await call("navigate", "unbounded-world", "teaching", question); await open(); await stroke();
  const initialWorldImage = images(await call("submit", { accept: false }))[0].data;
  const panBy = async (dx, dy) => {
    const box = await (await page.$(".drawing-pad-ink")).boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 6 }); await page.mouse.up();
  };
  const refPosition = () => run(() => { const r = document.querySelector(".drawing-pad-background").getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  const worldReference = await refPosition(); await button("Hand"); await panBy(200, -100);
  const movedReference = await refPosition();
  assert.deepEqual(movedReference, [worldReference[0] + 200, worldReference[1] - 100, worldReference[2], worldReference[3]]);
  await page.setViewport({ width: 1400, height: 800, deviceScaleFactor: 1 });
  await page.waitForFunction(() => document.querySelector(".drawing-pad-ink").width === document.querySelector(".drawing-pad-viewport").clientWidth);
  assert.deepEqual(await refPosition(), [movedReference[0] - 100, movedReference[1] - 100, movedReference[2], movedReference[3]]);
  assert.equal((await referenceMetrics()).centerOffset, 200); assert.equal((await referenceMetrics()).bottomGap, 124);
  assert.equal(images(await call("submit", { accept: false }))[0].data, initialWorldImage);
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  await page.waitForFunction(() => document.querySelector(".drawing-pad-ink").width === document.querySelector(".drawing-pad-viewport").clientWidth);
  assert.deepEqual(await refPosition(), movedReference);
  group("bottom-center resize preserves the exact Hand-pan offset and exported content");
  assert.equal(images(await call("submit", { accept: false }))[0].data, initialWorldImage);
  await close(); await open(); assert.deepEqual(await refPosition(), movedReference);
  await call("replayContent"); await waitForSheet(); assert.deepEqual(await refPosition(), movedReference);
  assert.equal(images(await call("submit", { accept: false }))[0].data, initialWorldImage);
  await panBy(-200, 100);
  for (let i = 0; i < 4; i++) await panBy(400, 0);
  assert.equal(await ink(), 0); assert.equal(await label(), "Draw (unsent)");
  assert.equal(images(await call("submit", { accept: false }))[0].data, initialWorldImage, "off-screen ink is still exported");
  await button("Pen"); await stroke();
  const expandedImage = images(await call("submit", { accept: false }))[0].data; assert.notEqual(expandedImage, initialWorldImage);
  const expandedSize = await pngSize(expandedImage);
  assert.equal(Math.max(...expandedSize), 2000); assert.ok(Math.min(...expandedSize) > 0);
  await button("Eraser"); await stroke(); assert.equal(images(await call("submit", { accept: false }))[0].data, initialWorldImage);
  await button("Undo"); assert.equal(images(await call("submit", { accept: false }))[0].data, expandedImage);
  group("remote ink erases/undoes at fixed scale and a large complete crop downsamples to 2000 pixels");
  await button("Hand"); for (let i = 0; i < 4; i++) await panBy(-400, 0);
  assert.ok(await ink() > 0); assert.equal(images(await call("submit", { accept: false }))[0].data, expandedImage);
  await button("Clear"); assert.equal(await ink(), 0); assert.equal(images(await call("submit", { accept: false })).length, 0);
  await button("Pen");
  group("Hand translates reference and ink together; camera survives close/remount without changing exported bytes");
  group("work beyond the original window remains editable/exportable and crop is independent of the camera");

  await call("navigate", "minimal-blank", "teaching", { type: "text" }); await open(); await page.click(".drawing-pad-ink");
  const dotImage = images(await call("submit", { accept: false }))[0].data;
  assert.deepEqual(await pngSize(dotImage), [52, 52], "one dot plus the existing 24px padding, not a viewport-sized PNG");
  await call("submit", { defer: true }); await button("Hand"); await panBy(400, 100);
  assert.equal(images(await call("submit", { accept: false }))[0].data, dotImage);
  await call("ack"); assert.equal(await ink(), 0); assert.equal(await label(), "Draw");
  group("blank sheets export only ink bounds; panning cannot invalidate a pending teaching acceptance");

  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
  await call("navigate", "retina-world", "teaching", question); await open();
  assert.deepEqual(await run(() => { const c = document.querySelector(".drawing-pad-ink"), r = c.getBoundingClientRect(), b = document.querySelector(".drawing-pad-background"); return [c.width / r.width, c.height / r.height, b.naturalWidth / b.getBoundingClientRect().width]; }), [2, 2, 2]);
  await stroke(); const retinaImage = images(await call("submit", { accept: false }))[0].data;
  assert.ok((await pngSize(retinaImage)).every(size => size > 0 && size <= 2000));
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  group("retina density increases bitmap detail without changing CSS-pixel geometry or export limits");

  await setScale(50); await call("navigate", "scale-preference", "practice", { type: "text" }); await open(); await page.click(".drawing-pad-ink");
  assert.deepEqual(await pngSize(images(await call("submit"))[0].data), [26, 26]);
  const preferenceInk = await ink(); await setScale(25);
  assert.equal(await ink(), preferenceInk); assert.equal(await label(), "Draw"); assert.equal(images(await call("submit")).length, 0);
  await stroke(); const scaled25 = await pngSize(images(await call("submit", { accept: false }))[0].data);
  const inkAt25 = await ink(); await setScale(50); const scaled50 = await pngSize(images(await call("submit", { accept: false }))[0].data);
  assert.ok(scaled50.every((size, index) => Math.abs(size - scaled25[index] * 2) <= 1)); assert.equal(await ink(), inkAt25);
  await call("showSettings"); await page.$eval("#image-scale", field => { field.focus(); field.select(); }); await page.keyboard.type("0"); await page.click("#blur-target");
  assert.equal(await run(() => window.fixture.saved().imageScale), 50); assert.match(await run(() => document.querySelector("#setting-error").textContent), /greater than 0/);
  await page.keyboard.press("Escape"); await setScale(100);
  group("scale preference changes only PNG resolution, validates percentages, and never resends unchanged practice ink");

  await call("navigate", "font-response-failure", "teaching", question); await run(() => { window.fixture.fontFetchMode = "html"; });
  await page.click("#draw"); await page.waitForFunction(() => document.querySelector('.drawing-pad-status[role="alert"]'));
  assert.match(await run(() => document.querySelector(".drawing-pad-status").textContent), /Could not load a reference font/);
  assert.deepEqual(await pageStyles(), stylesBefore); await close();
  await run(() => { window.fixture.fontFetchMode = "normal"; }); await open();
  assert.deepEqual(await pageStyles(), stylesBefore);
  group("HTML font responses fail closed instead of being inserted as live CSS or silently skipping fonts");

  await call("navigate", "font-fetch-cancel", "teaching", question); await run(() => { window.fixture.fontFetchMode = "hold"; });
  await page.click("#draw"); await page.waitForFunction(() => window.fixture.pendingFontFetches > 0); await close();
  assert.equal(await run(() => window.fixture.pendingFontFetches), 0); assert.ok(await run(() => window.fixture.abortedFontFetches) > 0);
  await run(() => { window.fixture.fontFetchMode = "normal"; }); await open();
  assert.deepEqual(await pageStyles(), stylesBefore);
  group("closing during font embedding aborts font fetches and reopening recovers without stylesheet mutation");
  assert.deepEqual(await run(() => window.fixture.errors), []); assert.deepEqual(denied, []); assert.deepEqual(errors, []);
  await call("dispose"); assert.equal(await page.$("#pad"), null);
  await page.reload({ waitUntil: "networkidle0" }); await page.waitForFunction(() => window.fixtureReady); await open(); assert.equal(await ink(), 0);
  group("disable/reload cleanup, no persistent drafts, no forbidden requests or page errors");
  fs.writeFileSync(path.join(evidence, "results.json"), JSON.stringify({ groups, errors, denied, requests }, null, 2));
  console.log(`Drawing Pad browser proof: ${groups.length} groups; evidence ${evidence}`);
  }
} catch (error) {
  console.error(`Drawing Pad browser proof failed; evidence ${evidence}`, { errors, denied });
  fs.writeFileSync(path.join(evidence, "failure.json"), JSON.stringify({ groups, errors, denied, error: String(error) }, null, 2));
  if (page) { fs.writeFileSync(path.join(evidence, "failure.html"), await page.content()); await page.screenshot({ path: path.join(evidence, "failure.png") }); }
  throw error;
} finally { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); }
