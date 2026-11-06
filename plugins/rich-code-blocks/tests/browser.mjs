import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const built = path.join(root, "dist");
assert.ok(fs.readFileSync(path.join(built, 'licenses/GPL-3.0.txt'), 'utf8').split('\n').length > 600, 'Ship the complete GPL text, not just an upstream MIT file.');
assert.ok(fs.readFileSync(path.join(built, 'licenses/Apache-2.0.txt'), 'utf8').split('\n').length > 190, 'Ship the complete Apache text for ColorBrewer.');
assert.match(fs.readFileSync(path.join(built, 'licenses/PyDvi-NOTICE.txt'), 'utf8'), /Fabrice Salvaire/);
const chrome = process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(file => fs.existsSync(file));
if (!chrome) throw new Error("Set CHROME_PATH to a local Chrome/Chromium executable.");
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "lh-rich-browser-"));
console.log(`Disposable browser evidence: ${evidence}`);
const helper = await build({ absWorkingDir: root, stdin: { contents: 'export {sanitizeSvg} from "./src/svg.ts";', resolveDir: root }, bundle: true, format: "esm", platform: "browser", write: false });
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/styles.css"><style>
body{background:#171717;color:#eee;font:16px system-ui;margin:24px}#cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}article{min-width:0}h2{font-size:15px}pre{white-space:pre-wrap}body.light{background:#f7f7f7;color:#222}
</style></head><body><h1>Rich code blocks — disposable fixture</h1><div id="cards"></div><script type="module">
import {activate} from '/main.js';
import {sanitizeSvg} from '/test-utils.js';
window.sanitizeSvg=sanitizeSvg;
const renders=new Map(), mounts=new Map(), notifications=new Set(), reconnects=new Set();
let settings={version:1,revision:0,chemicalStructures:false,musicalNotation:false,technicalDiagrams:false};let registration, ownedCleanup;
window.host={settings, schema:null, renders, mounts,
async enable(family,enabled=true){const row=this.schema.rows.find(row=>row.key===family);await row.onChange(enabled)},
abort(id){const mount=mounts.get(id);mount?.controller.abort();mount?.dispose?.();mounts.delete(id)},
async render(id,language,source,incomplete=false){this.abort(id);document.getElementById(id)?.remove();const card=document.createElement('article');card.id=id;const title=document.createElement('h2');title.textContent=id;const body=document.createElement('div');card.append(title,body);document.querySelector('#cards').append(card);
 const renderer=renders.get(language);if(!renderer){body.textContent=source;return {raw:true}};
 const controller=new AbortController(), mount={controller,language};mounts.set(id,mount);const started=performance.now();
 try{const dispose=await renderer.mount(body,{language,source,meta:'',incomplete,signal:controller.signal});mount.dispose=dispose;if(controller.signal.aborted){dispose?.();return {aborted:true,ms:performance.now()-started}};
 const svg=body.querySelector('svg');return {ms:performance.now()-started,source:body.querySelector('pre')?.textContent,svg:!!svg,paths:svg?.querySelectorAll('path,line,rect,circle').length,text:svg?.textContent,viewBox:svg?.getAttribute('viewBox'),width:svg?.getBoundingClientRect().width,height:svg?.getBoundingClientRect().height};
 }catch(error){if(controller.signal.aborted)return {aborted:true};const message=document.createElement('p');message.setAttribute('role','alert');message.textContent=error.message;const raw=document.createElement('pre');raw.textContent=source;body.replaceChildren(message,raw);return {error:error.message,source:raw.textContent,ms:performance.now()-started}}},
disable(){ownedCleanup?.();for(const id of mounts.keys())this.abort(id)}
};
ownedCleanup=await activate({signal:new AbortController().signal,cleanup(fn){ownedCleanup=fn},
 registerCodeBlock(renderer){renders.set(renderer.language,renderer);return ()=>{renders.delete(renderer.language);for(const [id,mount] of mounts)if(mount.language===renderer.language)host.abort(id)}},
 registerSettings(schema){host.schema=schema;return {update(next){host.schema=next},dispose(){host.schema=null}}},
 async call(operation,input){if(operation==='get-settings')return {...settings};if(operation!=='set-family')throw Error('Unknown fixture operation');settings={...settings,revision:settings.revision+1,[input.family]:input.enabled};host.settings=settings;for(const listener of notifications)listener({pluginId:'rich-code-blocks',topic:'settings-changed',data:{...settings}});return {...settings}},
 onNotification(fn){notifications.add(fn);return ()=>notifications.delete(fn)},onResync(fn){reconnects.add(fn);return ()=>reconnects.delete(fn)}
});
window.ready=true;
</script></body></html>`;
const requests = [];
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  requests.push(pathname);
  if (pathname === "/") { res.setHeader("content-type", "text/html"); res.end(html); return; }
  if (pathname === "/test-utils.js") { res.setHeader("content-type", "text/javascript"); res.end(helper.outputFiles[0].text); return; }
  const file = path.resolve(built, "." + pathname);
  if (!file.startsWith(built + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  const mime = { ".js": "text/javascript", ".css": "text/css", ".gz": "application/octet-stream", ".ttf": "font/ttf" };
  res.setHeader("content-type", mime[path.extname(file)] ?? "application/octet-stream");
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: path.join(evidence, "profile"), args: ["--no-sandbox"] });
  const page = await browser.newPage(); await page.setViewport({ width: 1200, height: 1000 });
  const errors = [], network = [], consoleErrors = [];
  page.on("pageerror", error => errors.push(String(error)));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("request", request => network.push(request.url()));
  await page.evaluateOnNewDocument(() => {
    const parse = DOMParser.prototype.parseFromString;
    DOMParser.prototype.parseFromString = function(source, type) {
      const document = parse.call(this, source, type);
      if (type === 'image/svg+xml') window.lastSvgParse = { source, error: document.querySelector('parsererror')?.textContent };
      return document;
    };
  });
  await page.goto(base); await page.waitForFunction(() => window.ready);
  assert.equal(await page.evaluate(() => host.renders.size), 0);
  assert.ok(!requests.some(url => /tex-worker|core.dump|tex.wasm|smiles-drawer|abc_tunebook/.test(url)), "All-off activation must not load render engines.");
  const render = (id, language, source, incomplete = false) => page.evaluate((...args) => host.render(...args), id, language, source, incomplete);
  assert.equal((await render("disabled", "smiles", "CCO")).raw, true);
  for (const family of ["chemicalStructures", "musicalNotation", "technicalDiagrams"]) await page.evaluate(family => host.enable(family), family);
  assert.deepEqual(await page.evaluate(() => [...host.renders.keys()]), ["smiles", "abc", "tikz"]);
  const incomplete = await render("incomplete", "tikz", "\\begin{", true);
  assert.equal(incomplete.source, "\\begin{"); assert.equal(incomplete.svg, false);
  assert.ok(!requests.some(url => /tex-worker|core.dump|tex.wasm/.test(url)), "Incomplete TeX must not start the worker.");
  const examples = {
    "Chemical structure": ["smiles", "CC(=O)Oc1ccccc1C(=O)O"],
    "Musical notation": ["abc", "X:1\nT:Scale\nM:4/4\nL:1/4\nK:C\nC D E F | G A B c |]"],
    "Physics / geometry": ["tikz", String.raw`\begin{document}\begin{tikzpicture}\draw (0,0) rectangle (1,1);\draw[->] (0.5,0.5)--(0.5,2) node[above] {$N$};\draw[->] (0.5,0.5)--(0.5,-1) node[below] {$mg$};\end{tikzpicture}\end{document}`],
    "CircuitikZ": ["tikz", String.raw`\usepackage{circuitikz}\begin{document}\begin{circuitikz}\draw (0,0) to[R=$R$] (3,0);\end{circuitikz}\end{document}`],
    "Commutative diagram": ["tikz", String.raw`\usepackage{tikz-cd}\begin{document}\begin{tikzcd} A\arrow[r,"f"] & B\end{tikzcd}\end{document}`],
    "Analytic plot": ["tikz", String.raw`\usepackage{pgfplots}\pgfplotsset{compat=1.16}\begin{document}\begin{tikzpicture}\begin{axis}[xlabel={$x$},ylabel={$f(x)$}]\addplot[domain=-2:2,samples=25]{x^2};\end{axis}\end{tikzpicture}\end{document}`],
  };
  const timings = {};
  await page.evaluate(() => { document.querySelector('#cards').replaceChildren(); });
  for (const [id, [language, source]] of Object.entries(examples)) {
    const result = await render(id, language, source); timings[id] = result;
    if (!result.svg) fs.writeFileSync(path.join(evidence, 'failed-svg.json'), JSON.stringify(await page.evaluate(() => window.lastSvgParse), null, 2));
    assert.ok(result.svg, `${id}: ${JSON.stringify(result)}`); assert.ok(result.paths > 0, `${id} has geometry`);
    assert.ok(result.width > 0 && result.height > 0, `${id} has painted dimensions`);
    fs.writeFileSync(path.join(evidence, id.replaceAll(/[^a-z0-9]/gi, '-') + '.svg'), await page.evaluate(id => document.getElementById(id).querySelector('svg').outerHTML, id));
  }
  const chemicalLabels = await page.evaluate(() => {
    const svg = document.getElementById('Chemical structure').querySelector('svg');
    const bounds = svg.getBoundingClientRect();
    return [...svg.querySelectorAll('text')].map(text => {
      const box = text.getBoundingClientRect();
      return { text: text.textContent, visible: box.width > 0 && box.height > 0 && box.right > bounds.left && box.left < bounds.right && box.bottom > bounds.top && box.top < bounds.bottom };
    });
  });
  assert.ok(chemicalLabels.length > 0 && chemicalLabels.every(label => label.visible), `Chemical labels must retain their positioning: ${JSON.stringify(chemicalLabels)}`);
  await page.evaluate(async () => { await document.fonts.ready; });
  const fontProof = await page.evaluate(() => ({ requests: performance.getEntriesByType('resource').filter(entry => entry.name.includes('.ttf')).map(entry => entry.name), families: [...document.querySelectorAll('svg text[font-family]')].map(node => ({family:node.getAttribute('font-family'),computed:getComputedStyle(node).fontFamily})) }));
  assert.ok(fontProof.requests.length > 0, "Bundled TeX fonts must actually load.");
  await page.screenshot({ path: path.join(evidence, "dark-six-formats.png"), fullPage: true });
  await page.evaluate(() => document.body.classList.add('light'));
  await page.screenshot({ path: path.join(evidence, "light-six-formats.png"), fullPage: true });
  const cached = await render("cached", "tikz", examples["Analytic plot"][1]);
  assert.ok(cached.svg);
  assert.equal(await page.evaluate(() => new Set([...document.querySelectorAll('svg [id]')].map(node => node.id)).size === document.querySelectorAll('svg [id]').length), true, "Repeated cached SVG must have mount-unique IDs.");
  const dirty = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" onload="window.pwned=1"><script>window.pwned=2</script><style>@import url(https://example.invalid/a.css);</style><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">bad</div></foreignObject><image href="https://example.invalid/x.png"/><a href="javascript:alert(1)"><text>link</text></a><animate attributeName="x"/><defs><path id="shape" d="M0 0L10 10"/></defs><use xlink:href="#shape"/><use href="https://example.invalid/a.svg#x"/><path d="M0 0L2 2" onclick="window.pwned=3" style="fill:url(https://example.invalid/f);stroke:red;filter:url(https://example.invalid/filter)"/><text font-family="cmr10" style="font-size:12px;position:fixed">safe &lt;script&gt;</text></svg>`;
  const sanitized = await page.evaluate(dirty => {
    const svg=sanitizeSvg(dirty,'Safety fixture');document.body.append(svg);
    return {html:svg.outerHTML,text:svg.textContent,pwned:window.pwned,local:svg.querySelector('use').getAttribute('href'),id:svg.querySelector('path[id]').id};
  }, dirty);
  assert.equal(sanitized.pwned, undefined); assert.match(sanitized.text, /safe <script>/);
  assert.ok(!/example\.invalid|onload|onclick|<script|<style|<foreignObject|<image|<a |<animate|position:|filter:/.test(sanitized.html));
  assert.equal(sanitized.local, '#' + sanitized.id);
  const declaration = await page.evaluate(() => { try { sanitizeSvg('<!DOCTYPE svg [<!ENTITY a "x">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>','Bad'); return false; } catch { return true; } });
  assert.equal(declaration, true);
  for (const [id, label, expected] of [['ampersand-label', String.raw`A\&B`, 'A&B'], ['less-than-label', String.raw`$x<y$`, '<']]) {
    const result = await render(id, 'tikz', String.raw`\begin{document}\begin{tikzpicture}\node {${label}};\end{tikzpicture}\end{document}`);
    assert.ok(result.svg && result.text.includes(expected), `${id}: ${JSON.stringify(result)}`);
  }
  const referenceProof = await page.evaluate(() => {
    const wrap = body => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'+body+'</svg>';
    let defs='<path id="a0" d="M0 0L1 1"/>';
    for(let i=1;i<=20;i++)defs+='<g id="a'+i+'"><use href="#a'+(i-1)+'"/><use href="#a'+(i-1)+'"/></g>';
    const sources=[wrap('<defs>'+defs+'</defs><use href="#a20"/>'),wrap('<g id="cycle"><use href="#cycle"/></g>'),'<svg xmlns="http://www.w3.org/2000/svg" id="root" viewBox="0 0 1 1"><use href="#root"/></svg>'];
    return sources.map(source=>{try{sanitizeSvg(source,'Reference safety');return 'unexpected admission'}catch(error){return error.message}});
  });
  assert.match(referenceProof[0], /2 MiB expanded/); assert.match(referenceProof[1], /Cyclic/); assert.match(referenceProof[2], /Cyclic/);
  let amplifiedDefs = '<path id="a0" d="M0 0L1 1"/>';
  for (let i=1;i<=20;i++) amplifiedDefs += `<g id="a${i}"><use href="\\string#a${i-1}"/><use href="\\string#a${i-1}"/></g>`;
  const amplified = await render('amplified-tex', 'tikz', String.raw`\begin{document}\begin{tikzpicture}\draw (0,0) rectangle (1,1);\special{dvisvgm:raw <defs>${amplifiedDefs}</defs><use href="\string#a20"/>}\end{tikzpicture}\end{document}`);
  assert.match(amplified.error, /2 MiB expanded/);
  const hostileTex = await render("hostile-tex", "tikz", String.raw`\begin{document}\begin{tikzpicture}\draw (0,0)--(1,1);\special{dvisvgm:raw <script>window.pwned=99</script><image href="https://example.invalid/tex.png" width="10" height="10"/>}\end{tikzpicture}\end{document}`);
  assert.ok(hostileTex.svg, JSON.stringify(hostileTex));
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.equal(await page.evaluate(() => document.getElementById('hostile-tex').querySelectorAll('script,image').length), 0);
  assert.equal(await page.evaluate(() => window.SmilesDrawer ?? window.SmiDrawer), undefined, "Module import must not leave vendor globals on the host window.");
  const badSmiles = await render("invalid-smiles", "smiles", "this is prose"); assert.ok(badSmiles.error); assert.equal(badSmiles.source, "this is prose");
  const badAbc = await render("invalid-abc", "abc", "C D E F"); assert.ok(badAbc.error); assert.equal(badAbc.source, "C D E F");
  const blankAbcHeader = await render('blank-abc-header', 'abc', 'X:\nM:4/4\nL:1/4\nK:C\nC D E F|');
  assert.ok(blankAbcHeader.error, 'An empty header cannot consume the next line as its value.');
  const capped = await render("oversize", "tikz", "x".repeat(32 * 1024 + 1)); assert.match(capped.error, /32 KiB/);
  // A genuinely nonterminating TeX macro must not block the page event loop.
  const endless = String.raw`\begin{document}\def\spin{\spin}\spin\end{document}`;
  await page.evaluate(source => { window.pending=host.render('cancelled','tikz',source); }, endless);
  await page.waitForFunction(() => document.querySelector('#cancelled pre'));
  await page.evaluate(() => host.abort('cancelled'));
  assert.equal((await page.evaluate(() => window.pending)).aborted, true);
  await page.evaluate(source => { window.ticks=0;window.tickTimer=setInterval(()=>window.ticks++,20);window.pending=host.render('timeout','tikz',source); }, endless);
  const timeout = await page.evaluate(() => window.pending);
  const ticks = await page.evaluate(() => { clearInterval(window.tickTimer);return window.ticks; });
  assert.match(timeout.error, /exceeded 10 seconds/); assert.ok(ticks > 100, `UI heartbeat continued (${ticks} ticks)`);
  const recovered = await render("after-timeout", "tikz", String.raw`\begin{document}\begin{tikzpicture}\draw (0,0) circle (1);\end{tikzpicture}\end{document}`);
  assert.ok(recovered.svg, JSON.stringify(recovered));
  await page.evaluate(() => host.enable('technicalDiagrams', false));
  assert.equal((await render("disabled-tikz", "tikz", examples.CircuitikZ[1])).raw, true);
  await page.evaluate(() => host.disable()); assert.equal(await page.evaluate(() => host.renders.size), 0);
  assert.equal(await page.evaluate(() => host.mounts.size), 0);
  assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
  assert.ok(network.every(url => url.startsWith(base + '/') || url.startsWith('data:')), `Unexpected network: ${network.filter(url => !url.startsWith(base + '/'))}`);
  const report = { timings, chemicalLabels, referenceProof, cachedMs: cached.ms, timeout, heartbeatTicks: ticks, recoveredMs: recovered.ms, fontProof, requests, network, errors, consoleErrors };
  fs.writeFileSync(path.join(evidence, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, timings: Object.fromEntries(Object.entries(timings).map(([name,result])=>[name,Math.round(result.ms)])), cachedMs: Math.round(cached.ms), timeoutMs: Math.round(timeout.ms), heartbeatTicks: ticks, recoveredMs: Math.round(recovered.ms), bundledFontRequests: fontProof.requests.length, requests: requests.length, pageErrors: errors.length }, null, 2));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
