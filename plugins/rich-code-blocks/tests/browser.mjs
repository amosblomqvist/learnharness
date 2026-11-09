import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";
import katex from "katex";

const root = fileURLToPath(new URL("../", import.meta.url));
const built = path.join(root, "dist");
// Test-only reference: the same pinned KaTeX version used by the app. None of
// these reference assets are included in the plugin's distributable build.
const katexAssets = path.dirname(fileURLToPath(import.meta.resolve("katex")));
assert.ok(fs.readFileSync(path.join(built, 'licenses/GPL-3.0.txt'), 'utf8').split('\n').length > 600, 'Ship the complete GPL text, not just an upstream MIT file.');
assert.ok(fs.readFileSync(path.join(built, 'licenses/Apache-2.0.txt'), 'utf8').split('\n').length > 190, 'Ship the complete Apache text for ColorBrewer.');
assert.match(fs.readFileSync(path.join(built, 'licenses/PyDvi-NOTICE.txt'), 'utf8'), /Fabrice Salvaire/);
const chrome = process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(file => fs.existsSync(file));
if (!chrome) throw new Error("Set CHROME_PATH to a local Chrome/Chromium executable.");
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "lh-rich-browser-"));
console.log(`Disposable browser evidence: ${evidence}`);
const helper = await build({ absWorkingDir: root, stdin: { contents: 'export {sanitizeSvg} from "./src/svg.ts";', resolveDir: root }, bundle: true, format: "esm", platform: "browser", write: false });
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/reference-katex/katex.css"><style>
html{--foreground:#d8dee9;--lh-ink-code:#ff00ff}body{background:#171717;color:var(--foreground);font:16px system-ui;margin:24px}#cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}article{min-width:0}h2{font-size:15px}pre{white-space:pre-wrap}body.light{background:#f7f7f7}
</style></head><body><h1>Rich code blocks — disposable fixture</h1><p id="reference-math">Chat LaTeX size: ${katex.renderToString("N+mg+R+x_1", { output: "html", throwOnError: true })}</p><div id="cards"></div><script type="module">
import {activate} from '/main.js';
import {sanitizeSvg} from '/test-utils.js';
window.sanitizeSvg=sanitizeSvg;
const renders=new Map(), mounts=new Map(), notifications=new Set(), reconnects=new Set();
let settings={version:1,revision:0,chemicalStructures:false,musicalNotation:false,technicalDiagrams:false,inkColor:'black'};let registration, ownedCleanup;
window.host={settings, schema:null, renders, mounts, calls:[],
async enable(family,enabled=true){const row=this.schema.rows.find(row=>row.key===family);await row.onChange(enabled)},
setTextColor(color){document.documentElement.style.setProperty('--foreground',color)},
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
 async call(operation,input){host.calls.push(operation);if(operation==='get-settings')return {...settings};if(operation!=='set-family')throw Error('Unknown fixture operation');const {inkColor:_legacyInk,...current}=settings;settings={...current,revision:settings.revision+1,[input.family]:input.enabled};host.settings=settings;for(const listener of notifications)listener({pluginId:'rich-code-blocks',topic:'settings-changed',data:{...settings}});return {...settings}},
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
  const directory = pathname.startsWith('/reference-katex/') ? katexAssets : built;
  const assetPath = directory === katexAssets ? pathname.slice('/reference-katex'.length) : pathname;
  const file = path.resolve(directory, "." + assetPath);
  if (!file.startsWith(directory + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  const mime = { ".js": "text/javascript", ".css": "text/css", ".gz": "application/octet-stream", ".ttf": "font/ttf", ".woff2": "font/woff2", ".woff": "font/woff" };
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
    window.texPosts = 0;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(data, ...rest) { if (typeof data?.source === 'string') window.texPosts++; return super.postMessage(data, ...rest); }
    };
    const parse = DOMParser.prototype.parseFromString;
    DOMParser.prototype.parseFromString = function(source, type) {
      const document = parse.call(this, source, type);
      if (type === 'image/svg+xml') window.lastSvgParse = { source, error: document.querySelector('parsererror')?.textContent };
      return document;
    };
  });
  await page.goto(base); await page.waitForFunction(() => window.ready);
  assert.equal(await page.evaluate(() => host.renders.size), 0);
  assert.deepEqual(await page.evaluate(() => host.schema.rows.map(row => row.key)), ['chemicalStructures','musicalNotation','technicalDiagrams'], 'The obsolete Ink color setting is absent, including for legacy saved preferences.');
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
  const sizingProof = await page.evaluate(() => {
    function measure() {
      const reference = document.querySelector('#reference-math .katex');
      return { mathFontPx: parseFloat(getComputedStyle(reference).fontSize), posts: window.texPosts,
        diagrams: [...document.querySelectorAll('.rich-code-blocks--rendered[data-language="tikz"]')].map(root => {
          const svg = root.querySelector('svg'), label = [...svg.querySelectorAll('text')].find(text => Math.abs(parseFloat(text.getAttribute('font-size')) - 10) < 0.01);
          const matrix = label.getScreenCTM(), bounds = svg.getBoundingClientRect();
          return { id: root.closest('article').id, fontPx: parseFloat(getComputedStyle(label).fontSize) * Math.hypot(matrix.a, matrix.b),
            width: bounds.width, height: bounds.height, widthAttribute: svg.getAttribute('width'), viewBox: svg.getAttribute('viewBox'),
            padding: ['paddingTop','paddingRight','paddingBottom','paddingLeft'].map(property => getComputedStyle(root)[property]),
          };
        }), otherWidths: ['Chemical structure','Musical notation'].map(id => document.getElementById(id).querySelector('svg').getBoundingClientRect().width) };
    }
    const original = [...document.querySelectorAll('.rich-code-blocks--rendered > svg')];
    const normal = measure(); document.body.style.fontSize = '20px'; const larger = measure();
    const sameSvg = original.every(svg => svg.isConnected); document.body.style.fontSize = '';
    return { normal, larger, restored: measure(), sameSvg };
  });
  assert.equal(sizingProof.normal.diagrams.length, 4);
  for (const state of [sizingProof.normal, sizingProof.larger, sizingProof.restored]) for (const diagram of state.diagrams) {
    assert.ok(Math.abs(diagram.fontPx - state.mathFontPx) < 0.05, `${diagram.id} must match actual KaTeX: ${diagram.fontPx} vs ${state.mathFontPx}`);
    assert.match(diagram.widthAttribute, /em$/);
    assert.deepEqual(diagram.padding, ['12px','12px','12px','12px']);
    const [, , width, height] = diagram.viewBox.split(' ').map(Number);
    assert.ok(Math.abs(diagram.height / diagram.width - height / width) < 0.002, 'Diagram aspect ratio is preserved.');
  }
  assert.ok(sizingProof.larger.mathFontPx > sizingProof.normal.mathFontPx);
  assert.equal(sizingProof.normal.posts, sizingProof.larger.posts); assert.equal(sizingProof.sameSvg, true, 'Font-size changes resize existing SVGs without TeX work.');
  assert.deepEqual(sizingProof.normal.otherWidths, sizingProof.larger.otherWidths, 'Chemistry/music natural sizing stays unchanged.');
  const inkProof = await page.evaluate(() => {
    window.originalSvgs = [...document.querySelectorAll('.rich-code-blocks--rendered > svg')];
    return { posts: window.texPosts, calls: host.calls.length, roots: [...document.querySelectorAll('.rich-code-blocks--rendered')].map(root => ({
      background: getComputedStyle(root).backgroundColor, ink: getComputedStyle(root).color,
      svgBackground: getComputedStyle(root.querySelector('svg')).backgroundColor,
      paints: [...root.querySelectorAll('path,text,line,tspan')].filter(node => !node.closest('mask,defs')).map(node => ({ fill: getComputedStyle(node).fill, stroke: getComputedStyle(node).stroke })),
    })) };
  });
  assert.equal(inkProof.roots.length, 6);
  for (const root of inkProof.roots) {
    assert.equal(root.background, 'rgba(0, 0, 0, 0)'); assert.equal(root.svgBackground, 'rgba(0, 0, 0, 0)');
    assert.equal(root.ink, 'rgb(216, 222, 233)');
    assert.ok(root.paints.some(paint => paint.fill === 'rgb(216, 222, 233)' || paint.stroke === 'rgb(216, 222, 233)'), 'Each family follows theme Text, not legacy black ink or the inline-code token.');
  }
  await page.screenshot({ path: path.join(evidence, "dark-six-formats.png"), fullPage: true });
  await page.evaluate(() => { host.setTextColor('#123456'); document.body.classList.add('light'); });
  const switchedInk = await page.evaluate(() => ({ posts: window.texPosts, calls: host.calls.length,
    sameSvg: window.originalSvgs.every(svg => svg.isConnected),
    roots: [...document.querySelectorAll('.rich-code-blocks--rendered')].map(root => ({ background: getComputedStyle(root).backgroundColor, ink: getComputedStyle(root).color,
      paints: [...root.querySelectorAll('path,text,line,tspan')].filter(node => !node.closest('mask,defs')).map(node => ({ fill: getComputedStyle(node).fill, stroke: getComputedStyle(node).stroke })),
    })) }));
  assert.equal(switchedInk.posts, inkProof.posts, 'Ink switches must not compile TeX.'); assert.equal(switchedInk.sameSvg, true);
  for (const root of switchedInk.roots) {
    assert.equal(root.background, 'rgba(0, 0, 0, 0)'); assert.equal(root.ink, 'rgb(18, 52, 86)');
    assert.ok(root.paints.some(paint => paint.fill === 'rgb(18, 52, 86)' || paint.stroke === 'rgb(18, 52, 86)'), 'Each family follows the new theme Text color.');
  }
  await page.screenshot({ path: path.join(evidence, "light-six-formats.png"), fullPage: true });
  assert.equal(switchedInk.calls, inkProof.calls, 'Theme changes require no backend request.');
  await page.evaluate(() => host.setTextColor('#7c3aed'));
  const overrideInk = await page.evaluate(() => ({ posts: window.texPosts, calls: host.calls.length,
    sameSvg: window.originalSvgs.every(svg => svg.isConnected),
    roots: [...document.querySelectorAll('.rich-code-blocks--rendered')].map(root => ({ ink: getComputedStyle(root).color,
      paints: [...root.querySelectorAll('path,text,line,tspan')].filter(node => !node.closest('mask,defs')).map(node => [getComputedStyle(node).fill,getComputedStyle(node).stroke]).flat(),
    })),
  }));
  assert.equal(overrideInk.posts, inkProof.posts); assert.equal(overrideInk.calls, inkProof.calls); assert.equal(overrideInk.sameSvg, true);
  for (const root of overrideInk.roots) {
    assert.equal(root.ink, 'rgb(124, 58, 237)'); assert.ok(root.paints.includes('rgb(124, 58, 237)'), 'Same-mode text overrides reach every rendering family.');
  }
  await page.screenshot({ path: path.join(evidence, 'text-override-six-formats.png'), fullPage: true });
  await page.evaluate(() => { host.setTextColor('#d8dee9'); document.body.classList.remove('light'); });
  const wide = await render('Wide sizing probe', 'tikz', String.raw`\begin{document}\begin{tikzpicture}\draw[->] (0,0)--(20,0) node[right] {$x_1$};\end{tikzpicture}\end{document}`);
  assert.ok(wide.svg, JSON.stringify(wide));
  const wideProof = await page.evaluate(() => {
    const card = document.getElementById('Wide sizing probe'); card.style.width = '240px';
    const root = card.querySelector('.rich-code-blocks--rendered'), svg = root.querySelector('svg');
    root.scrollLeft = 120;
    return { width: svg.getBoundingClientRect().width, clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, scrollLeft: root.scrollLeft,
      mathFontPx: parseFloat(getComputedStyle(document.querySelector('#reference-math .katex')).fontSize),
      labels: [...svg.querySelectorAll('text')].map(label => { const matrix = label.getScreenCTM(); return { texSize: parseFloat(label.getAttribute('font-size')), fontPx: parseFloat(getComputedStyle(label).fontSize) * Math.hypot(matrix.a, matrix.b) }; }),
      pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
    };
  });
  assert.ok(wideProof.width > wideProof.clientWidth && wideProof.scrollWidth > wideProof.clientWidth && wideProof.scrollLeft > 0, 'Wide TikZ scrolls inside its own wrapper.');
  assert.ok(wideProof.pageWidth <= wideProof.viewportWidth, 'Wide diagrams must not widen the page.');
  for (const label of wideProof.labels) assert.ok(Math.abs(label.fontPx - wideProof.mathFontPx * label.texSize / 10) < 0.05, 'Wide-diagram labels and relative script sizes do not shrink.');
  await page.screenshot({ path: path.join(evidence, 'wide-diagram-scroll.png'), fullPage: true });
  const paletteProof = await page.evaluate(async () => {
    // Rasterize a small, sanitized vector fixture to verify actual mask alpha,
    // including a definition shared between visible ink and a mask, rather than
    // merely checking that the mask's XML still contains black/white attributes.
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="20" viewBox="0 0 60 20"><defs><path id="box" d="M0 0H10V10H0Z" fill="black"/><linearGradient id="fade"><stop offset="0" stop-color="black"/><stop offset="1" stop-color="white"/></linearGradient><mask id="cut"><rect width="20" height="10" fill="white"/><use href="#box" x="10"/></mask><mask id="gradient"><rect y="10" width="20" height="10" fill="url(#fade)"/></mask></defs><rect width="20" height="10" fill="black" mask="url(#cut)"/><use href="#box" x="20"/><rect x="30" width="10" height="10" fill="red"/><rect x="40" width="10" height="10" fill="white"/><rect x="50" width="10" height="10" fill="blue"/><rect y="10" width="20" height="10" fill="black" mask="url(#gradient)"/></svg>';
    const svg = sanitizeSvg(source, 'Ink and mask fixture', 'tikz');
    // This paint/alpha test deliberately rasterizes at fixed pixel dimensions,
    // independently of the renderer's new text-relative TikZ display sizing.
    svg.setAttribute('width','60'); svg.setAttribute('height','20');
    const wrapper = document.createElement('div'); wrapper.className = 'rich-code-blocks rich-code-blocks--rendered';
    wrapper.append(svg); document.body.append(wrapper);
    const canvas = document.createElement('canvas'); canvas.width = 60; canvas.height = 20;
    const context = canvas.getContext('2d');
    async function sample(color) {
      host.setTextColor(color);
      // A data-URI image cannot inherit document CSS. Snapshot only the live
      // root's resolved ink for this raster assertion; keep nested mask/gradient
      // overrides intact. Production SVGs remain inline and need no snapshots.
      const clone = svg.cloneNode(true), computed = getComputedStyle(svg);
      for (const name of ['black','carbon','hydrogen']) {
        const variable = '--rich-code-blocks-' + name;
        clone.style.setProperty(variable, computed.getPropertyValue(variable));
      }
      clone.setAttribute('color', computed.color);
      const image = new Image(); image.src = 'data:image/svg+xml,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
      await image.decode(); context.clearRect(0, 0, 60, 20); context.drawImage(image, 0, 0);
      return [[5,5],[15,5],[25,5],[35,5],[45,5],[55,5],[5,15],[15,15]].map(([x,y]) => [...context.getImageData(x,y,1,1).data]);
    }
    const samples = { white: await sample('#fff'), black: await sample('#000'), themed: await sample('#123456') };
    wrapper.remove(); host.setTextColor('#d8dee9'); return samples;
  });
  assert.deepEqual(paletteProof.white.slice(0,6), [[255,255,255,255],[0,0,0,0],[255,255,255,255],[255,0,0,255],[255,255,255,255],[0,0,255,255]]);
  assert.deepEqual(paletteProof.black.slice(0,6), [[0,0,0,255],[0,0,0,0],[0,0,0,255],[255,0,0,255],[255,255,255,255],[0,0,255,255]]);
  assert.deepEqual(paletteProof.themed.slice(0,6), [[18,52,86,255],[0,0,0,0],[18,52,86,255],[255,0,0,255],[255,255,255,255],[0,0,255,255]]);
  for (const index of [6,7]) for (const color of ['black','themed']) assert.ok(Math.abs(paletteProof.white[index][3] - paletteProof[color][index][3]) <= 1, 'Authored gradient mask alpha must agree within one 8-bit raster rounding step.');
  assert.ok(paletteProof.white[6][3] > 0 && paletteProof.white[6][3] < paletteProof.white[7][3] && paletteProof.white[7][3] < 255);
  const colored = await render('Colored TikZ', 'tikz', String.raw`\begin{document}\begin{tikzpicture}\draw[red,thick] (0,0)--(2,0);\fill[blue] (0,1) rectangle (1,2);\fill[white] (1,1) rectangle (2,2);\draw (0,0)--(0,2);\end{tikzpicture}\end{document}`);
  assert.ok(colored.svg, JSON.stringify(colored));
  const readColors = () => page.evaluate(() => ({
    chemistry: [...document.getElementById('Chemical structure').querySelectorAll('tspan,stop')].filter(node => !node.closest('mask')).map(node => [getComputedStyle(node).fill, getComputedStyle(node).stopColor]),
    tikz: [...document.getElementById('Colored TikZ').querySelectorAll('path')].map(node => [getComputedStyle(node).fill, getComputedStyle(node).stroke]),
  }));
  const initialColors = await readColors(); const postsBeforeColors = await page.evaluate(() => window.texPosts);
  await page.evaluate(() => host.setTextColor('#123456')); const textColors = await readColors();
  for (const color of ['rgb(255, 0, 0)', 'rgb(0, 0, 255)', 'rgb(255, 255, 255)']) {
    assert.ok(initialColors.tikz.flat().includes(color) && textColors.tikz.flat().includes(color), `Authored ${color} must survive theme Text changes.`);
  }
  assert.ok(initialColors.chemistry.flat().includes('rgb(231, 76, 60)') && textColors.chemistry.flat().includes('rgb(231, 76, 60)'), 'Oxygen stays red.');
  assert.ok(initialColors.chemistry.map(paint => paint[1]).includes('rgb(216, 222, 233)'));
  assert.ok(textColors.chemistry.map(paint => paint[1]).includes('rgb(18, 52, 86)'), 'Neutral bond-gradient stops follow theme Text.');
  assert.equal(await page.evaluate(() => window.texPosts), postsBeforeColors);
  const cached = await render("cached", "tikz", examples["Analytic plot"][1]);
  assert.ok(cached.svg);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('cached').querySelector('.rich-code-blocks--rendered')).color), 'rgb(18, 52, 86)', 'New cache mounts use the current theme Text color.');
  assert.equal(await page.evaluate(() => window.texPosts), postsBeforeColors, 'Ink-only changes retain the compiled SVG cache.');
  assert.equal(await page.evaluate(() => new Set([...document.querySelectorAll('svg [id]')].map(node => node.id)).size === document.querySelectorAll('svg [id]').length), true, "Repeated cached SVG must have mount-unique IDs.");
  // Observed authoring failure patterns: each corrected block must pass the
  // real worker and SVG sanitizer; its unsupported variant stays readable.
  const authoringCases = [
    { id: 'commutative-authoring', source: String.raw`\usepackage{tikz-cd}
\begin{document}
\begin{tikzcd}
A \arrow[r,"f"] \arrow[d,"g"'] & B \arrow[d,"h"] \\
C \arrow[r,"k"'] & D
\end{tikzcd}
\end{document}`, invalid: source => source.replace('\\begin{document}', '\\begin{document}\\[').replace('\\end{document}', '\\]\\end{document}') },
    { id: 'free-body-authoring', source: String.raw`\usepackage{tikz}
\usepackage{amsmath}
\begin{document}
\begin{tikzpicture}[>=stealth,thick]
\draw (-0.6,-0.4) rectangle (0.6,0.4);
\node at (0,0) {block};
\draw[->] (0,0.4)--(0,1.4) node[above] {$N$};
\draw[->] (0,-0.4)--(0,-1.4) node[below] {$mg$};
\draw[->] (0.6,0)--(1.6,0) node[right] {$F_{\text{app}}$};
\draw[->] (-0.6,0)--(-1.6,0) node[left] {$f_k$};
\draw (-1.8,-0.55)--(1.8,-0.55);
\end{tikzpicture}
\end{document}`, invalid: source => source.replace('\\usepackage{amsmath}', '') },
    { id: 'plot-authoring', source: String.raw`\usepackage{pgfplots}
\pgfplotsset{compat=1.16}
\begin{document}
\begin{tikzpicture}
\begin{axis}[axis lines=middle,xlabel={$x$},ylabel={$y$},xmin=-2.5,xmax=2.5,ymin=-0.5,ymax=5,domain=-2:2,samples=80]
\addplot[blue,thick] {x^2};
\end{axis}
\end{tikzpicture}
\end{document}`, invalid: source => source.replace('compat=1.16', 'compat=1.18') },
  ];
  const authoringProof = [];
  for (const { id, source, invalid } of authoringCases) {
    const unsupported = invalid(source);
    const failure = await render(id + '-unsupported', 'tikz', unsupported);
    assert.match(failure.error, /TeX engine render failed/, id);
    assert.equal(failure.source, unsupported, 'Failed source stays intact; no automatic repairs.');
    const corrected = await render(id, 'tikz', source);
    assert.ok(corrected.svg && corrected.paths > 0 && corrected.width > 0 && corrected.height > 0, `${id}: ${JSON.stringify(corrected)}`);
    authoringProof.push({ id, failure, corrected });
  }
  await page.screenshot({ path: path.join(evidence, 'tikz-authoring-regressions.png'), fullPage: true });
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
  const report = { timings, authoringProof, chemicalLabels, sizingProof, wideProof, inkProof, switchedInk, overrideInk, paletteProof, initialColors, textColors, referenceProof, cachedMs: cached.ms, timeout, heartbeatTicks: ticks, recoveredMs: recovered.ms, fontProof, requests, network, errors, consoleErrors };
  fs.writeFileSync(path.join(evidence, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, timings: Object.fromEntries(Object.entries(timings).map(([name,result])=>[name,Math.round(result.ms)])), cachedMs: Math.round(cached.ms), timeoutMs: Math.round(timeout.ms), heartbeatTicks: ticks, recoveredMs: Math.round(recovered.ms), bundledFontRequests: fontProof.requests.length, requests: requests.length, pageErrors: errors.length }, null, 2));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
