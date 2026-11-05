import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const built = path.join(root, "dist");
const chrome = process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(file => fs.existsSync(file));
if (!chrome) throw new Error("Set CHROME_PATH to a local Chrome/Chromium executable.");
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "lh-coding-browser-"));
const html = `<!doctype html><html><head><link rel="stylesheet" href="/styles.css"><style>body{margin:30px;background:#141414;color:#e6e6e6}#editor,#answered{max-width:800px;margin-bottom:20px}</style></head><body><div id="editor"></div><div id="answered"></div><script type="module">
import {activate} from '/main.js';
let renderer;
const cleanup = activate({registerQuestionRenderer(value){renderer=value; return ()=>{window.host.unmount();renderer=null}}});
window.host={answer:{status:'empty'},active:true,publications:[],handle:null,controller:null,submits:0,reserved:[],
mount({language='python',starterCode,answer={status:'empty'}}={}){
 this.unmount(); this.answer=answer; this.active=true; this.publications=[]; this.controller=new AbortController();
 const props={input:{question:'Test question',type:'predict',nodeId:'fixture',payload:{language,...(starterCode===undefined?{}:{starterCode})}},chatId:'fixture',questionId:'question-'+Math.random(),contractVersion:1,variant:'teach',signal:this.controller.signal,active:true,answer,
 onChange:state=>{this.answer=state;this.publications.push(state);if(this.handle)this.handle.update({answer:state,active:this.active})}};
 this.props=props; this.handle=renderer.mountAnswerEditor(document.querySelector('#editor'),props);this.handle.update({answer:this.answer,active:this.active});return this.answer;
},update(answer=this.answer,active=this.active){this.answer=answer;this.active=active;this.handle.update({answer,active})},
unmount(){this.controller?.abort();this.handle?.dispose();this.handle?.dispose();this.handle=null},
showAnswered(code,language='python'){this.answeredCleanup?.();this.answeredController?.abort();this.answeredController=new AbortController();this.answeredCleanup=renderer.mountAnswered(document.querySelector('#answered'),{...this.props,input:{...this.props.input,payload:{language}},signal:this.answeredController.signal,answer:code})},
disable(){cleanup();this.answeredCleanup?.();this.answeredController?.abort()}};
document.addEventListener('keydown',event=>{
 const h=window.host;if(!h.active||!h.handle||!document.querySelector('#editor').contains(event.target)||event.isComposing||event.keyCode===229)return;
 if((event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();event.stopImmediatePropagation();h.submits++;return}
 if(event.shiftKey&&event.key==='Tab'){event.preventDefault();event.stopImmediatePropagation();h.reserved.push('Shift+Tab');return}
 const key=event.key==='Enter'&&event.shiftKey?'Shift+Enter':event.key;
 if(['Tab','Enter','Shift+Enter','Escape'].includes(key)&&h.handle.handleKeyDown?.(key)==='handled'){event.preventDefault();event.stopImmediatePropagation();return}
 if(key==='Enter'&&!event.altKey&&!event.shiftKey){event.preventDefault();event.stopImmediatePropagation();h.submits++}
},true);
window.ready=true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (pathname === "/") { res.setHeader("content-type", "text/html"); res.end(html); return; }
  const file = path.resolve(built, "." + pathname);
  if (!file.startsWith(built + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.setHeader("content-type", file.endsWith(".css") ? "text/css" : "text/javascript");
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: path.join(evidence, "profile"), args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 850 });
  const errors = [], requests = [];
  page.on("pageerror", error => errors.push(String(error)));
  page.on("request", req => requests.push(req.url()));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base);
  await page.waitForFunction(() => window.ready);
  const state = () => page.evaluate(() => window.host.answer);
  const field = '#editor [contenteditable="true"]';
  const fillCode = async value => {
    await page.focus(field);
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.down(mod); await page.keyboard.press('a'); await page.keyboard.up(mod);
    await page.keyboard.sendCharacter(value);
  };
  await page.evaluate(() => window.host.mount({starterCode:"def example():\r\n    return 1  \r\n"}));
  assert.deepEqual(await state(), {status:"ready",value:"def example():\n    return 1  \n"});
  await page.waitForFunction(() => document.querySelector('#editor [role="status"]').textContent === "");
  assert.ok(await page.$$eval('#editor .cm-line span', nodes => nodes.some(node => getComputedStyle(node).color !== 'rgb(230, 230, 230)')));
  assert.equal(await page.$eval(field, node => node.closest('form')), null);
  await fillCode("  exact code  \n\n");
  assert.deepEqual(await state(), {status:"ready",value:"  exact code  \n\n"});
  await fillCode(" \t\n");
  assert.equal((await state()).status,"unready");
  assert.equal((await state()).value," \t\n");
  await fillCode("x");
  const gutter = await page.$eval('#editor .cm-gutters', node => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth] };
  });
  assert.equal(gutter.background, 'rgba(0, 0, 0, 0)');
  assert.deepEqual(gutter.borders, ['0px', '0px', '0px', '0px']);
  const size = await page.$eval('#editor .cm-scroller', node => {
    const style = getComputedStyle(node);
    return { minHeight: parseFloat(style.minHeight), fontSize: parseFloat(style.fontSize), height: node.getBoundingClientRect().height };
  });
  assert.equal(size.minHeight, 8 * size.fontSize, 'Keep the existing 8em minimum height for a one-line answer');
  assert.ok(size.height >= size.minHeight);
  await page.screenshot({path:path.join(evidence,'one-line-quiet-gutter.png')});
  await page.keyboard.press("Home");
  await page.keyboard.press("Tab");
  assert.equal((await state()).value,"    x");
  await fillCode('def example():');
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  assert.equal((await state()).value, 'def example():\n    ', 'Plain Enter inserts an auto-indented code newline');
  assert.equal(await page.evaluate(() => window.host.submits), 0, 'Enter in code never submits');
  const composition = await page.$eval(field, node => [{isComposing:true},{keyCode:229}].map(extra => {
    const event = new KeyboardEvent('keydown', {key:'Enter',code:'Enter',bubbles:true,cancelable:true,...extra});
    node.dispatchEvent(event);
    return {prevented:event.defaultPrevented,isComposing:event.isComposing,keyCode:event.keyCode};
  }));
  assert.deepEqual(composition, [{prevented:false,isComposing:true,keyCode:0},{prevented:false,isComposing:false,keyCode:229}]);
  assert.equal(await page.evaluate(() => window.host.submits), 0, 'Composition-marked Enter never submits');
  assert.equal((await state()).value, 'def example():\n    ');
  await page.keyboard.sendCharacter('return 1');
  await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');
  assert.equal((await state()).value,"def example():\n    return 1\n    ");
  const beforeReserved = await state();
  await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
  await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
  await page.keyboard.press("Enter");
  await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
  await page.keyboard.press("Escape");
  assert.deepEqual(await state(),beforeReserved);
  assert.equal(await page.evaluate(() => window.host.submits),1);
  assert.deepEqual(await page.evaluate(() => window.host.reserved),["Shift+Tab"]);
  await fillCode("history");
  const mod=process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(mod);await page.keyboard.press("z");await page.keyboard.up(mod);
  assert.notEqual((await state()).value,"history");
  await page.keyboard.down(mod);await page.keyboard.down("Shift");await page.keyboard.press("z");await page.keyboard.up("Shift");await page.keyboard.up(mod);
  assert.equal((await state()).value,"history");

  const beforeUpdate = await page.evaluate(() => {
    const h=window.host,field=document.querySelector('#editor .cm-content');h.handle.focus();
    const walker=document.createTreeWalker(field,NodeFilter.SHOW_TEXT);let text;while((text=walker.nextNode())&&text.textContent.length<4){};
    const selection=getSelection();selection.setBaseAndExtent(text,1,text,4);
    const editor=document.querySelector('#editor .cm-editor');window.savedEditor=editor;
    const count=h.publications.length;h.update();return {count,selection:getSelection().toString()};
  });
  assert.equal(await page.evaluate(() => window.host.publications.length),beforeUpdate.count);
  assert.equal(await page.evaluate(() => getSelection().toString()),beforeUpdate.selection);
  await page.evaluate(() => window.host.update(window.host.answer,false));
  assert.equal(await page.$$eval(field,nodes=>nodes.length),0);
  assert.equal(await page.evaluate(() => window.host.handle.handleKeyDown("Tab")),"pass");
  await page.evaluate(() => window.host.update(window.host.answer,true));
  assert.equal(await page.evaluate(() => window.savedEditor === document.querySelector('#editor .cm-editor')),true);
  assert.equal((await state()).value,"history");

  await page.evaluate(() => window.host.mount({language:'SQL',starterCode:'SELECT id FROM example;'}));
  await page.waitForFunction(() => document.querySelector('#editor [role="status"]').textContent === "");
  await page.evaluate(() => window.host.mount({language:'unbundled-language',starterCode:'<script>literal</script>\n'}));
  assert.equal(await page.$eval('#editor [role="status"]',node=>node.textContent),"Plain text");
  assert.equal(await page.$$eval('#editor script',nodes=>nodes.length),0);
  const savedCode="  const value = '<script>';  \n\n";
  await page.evaluate(code=>window.host.showAnswered(code,'JavaScript'),savedCode);
  await page.waitForFunction(() => document.querySelector('#answered [role="status"]').textContent === "");
  assert.equal(await page.$$eval('#answered [contenteditable="true"]',nodes=>nodes.length),0);
  assert.equal(await page.$$eval('#answered .cm-line',nodes=>nodes.map(node=>node.textContent).join('\n')),savedCode);
  await page.screenshot({path:path.join(evidence,'editor-and-saved-answer.png')});

  for (const language of ['HTML', 'XML', 'JSX']) {
    await page.evaluate(language => window.host.mount({language}), language);
    await page.waitForFunction(() => document.querySelector('#editor [role="status"]').textContent === '');
    await page.focus(field);
    await page.keyboard.type('<div>');
    assert.deepEqual(await state(), {status:'ready',value:'<div>'}, `${language} must not enable tag insertion`);
  }
  let held=[],mode='hold',signalHeld;
  const heldRequest=new Promise(resolve=>{signalHeld=resolve});
  await page.setRequestInterception(true);
  const intercept=req=>{
    if(req.url().includes('/assets/')&&mode==='hold'){held.push(req);signalHeld()}
    else if(req.url().includes('/assets/')&&mode==='fail')void req.abort();
    else void req.continue();
  };
  page.on('request',intercept);
  await page.evaluate(() => window.host.mount({language:'Rust',starterCode:'fn main() {}'}));
  let heldTimer;
  try {await Promise.race([heldRequest,new Promise((_,reject)=>{heldTimer=setTimeout(()=>reject(new Error('No lazy Rust module request observed')),10000)})])}
  finally {clearTimeout(heldTimer)}
  assert.equal(await page.$eval('#editor [role="status"]',node=>node.textContent),'Loading highlighting…');
  await page.evaluate(() => {window.host.unmount();document.querySelector('#editor').textContent='sentinel'});
  mode='pass';
  for(const req of held)await req.continue();
  held=[];
  await page.waitForNetworkIdle();
  assert.equal(await page.$eval('#editor',node=>node.textContent),'sentinel');
  mode='fail';
  await page.evaluate(() => {document.querySelector('#editor').textContent='';window.host.mount({language:'Ruby',starterCode:'value = 1'})});
  await page.waitForFunction(() => document.querySelector('#editor [role="status"]').textContent === 'Plain text');
  assert.deepEqual(await state(),{status:'ready',value:'value = 1'});
  await fillCode('still editable');assert.equal((await state()).value,'still editable');
  mode='pass';
  page.off('request',intercept);await page.setRequestInterception(false);

  const marker = '#editor .cm-lintRange-error, #editor .cm-lintPoint-error';
  const diagnosticExamples = [
    ['Python', 'def example():\n    return 1\n', 'def example(:\n    return 1\n'],
    ['JavaScript', 'const value = 1;', 'const value = ;'],
    ['TypeScript', 'const value: number = 1;', 'const value: = 1;'],
    ['C', 'int main() { return 0; }', 'int main( { return 0; }'],
    ['C++', 'int main() { return 0; }', 'int main( { return 0; }'],
    ['Java', 'class Example { int value = 1; }', 'class Example { int value = ; }'],
    ['Rust', 'fn main() {}', 'fn main( {}'],
    ['Go', 'package main\nfunc main() {}', 'package main\nfunc main( {}'],
    ['JSON', '{"value":1}', '{"value":}'],
  ];
  for (const [language, valid, invalid] of diagnosticExamples) {
    await page.evaluate(({language,invalid}) => window.host.mount({language,starterCode:invalid}), {language,invalid});
    await page.waitForSelector(marker);
    assert.deepEqual(await state(), {status:'ready',value:invalid}, `${language}: diagnostics do not alter code or readiness`);
    assert.equal(await page.$$eval('#editor .cm-panel-lint, #editor .cm-gutter-lint', nodes=>nodes.length), 0);
    if (language === 'C') {
      await (await page.$('#editor .cm-lintRange-error')).hover();
      await page.waitForSelector('.cm-tooltip-lint .cm-diagnosticText', {visible:true});
      assert.ok(await page.$$eval('.cm-tooltip-lint .cm-diagnosticText', nodes=>nodes.every(node=>node.textContent==='Syntax problem.')));
      await page.screenshot({path:path.join(evidence,'syntax-diagnostics-hover.png')});
      await page.mouse.move(1050,800);
    }
    if (language === 'Python') {
      const point = await page.$eval('#editor .cm-lintPoint-error', node=>getComputedStyle(node,':after').borderBottomColor);
      assert.equal(point, 'rgb(221, 17, 17)', 'Zero-width syntax problems have a red point marker');
      const submits = await page.evaluate(()=>window.host.submits);
      await page.focus(field);
      await page.keyboard.down(process.platform==='darwin'?'Meta':'Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up(process.platform==='darwin'?'Meta':'Control');
      assert.equal(await page.evaluate(()=>window.host.submits), submits+1, 'Syntax errors never prevent host submission');
      assert.deepEqual(await state(), {status:'ready',value:invalid});
    }
    await fillCode(valid);
    await page.waitForFunction(selector=>!document.querySelector(selector), {}, marker);
    assert.deepEqual(await state(), {status:'ready',value:valid});
  }

  // Measure the scheduled update in browser time rather than relying on Node sleeps.
  await page.evaluate(()=>window.host.mount({language:'js',starterCode:'const value = 1;'}));
  await page.waitForFunction(()=>document.querySelector('#editor [role="status"]').textContent==='');
  await page.evaluate(()=> {
    window.diagnosticDelay=null; const start=performance.now();
    window.diagnosticObserver=new MutationObserver(()=> {
      if(document.querySelector('#editor .cm-lintPoint-error, #editor .cm-lintRange-error')) {
        window.diagnosticDelay=performance.now()-start; window.diagnosticObserver.disconnect();
      }
    });
    window.diagnosticObserver.observe(document.querySelector('#editor'),{childList:true,subtree:true});
    window.host.update({status:'ready',value:'const value = ;'});
  });
  await page.waitForFunction(()=>window.diagnosticDelay!==null);
  const diagnosticDelay=await page.evaluate(()=>window.diagnosticDelay);
  assert.ok(diagnosticDelay>=280, `Diagnostics wait for the configured typing pause (${diagnosticDelay}ms)`);
  await page.evaluate(()=> {
    window.host.update({status:'ready',value:'const value = 1;'});
    window.host.update({status:'ready',value:'const value = ;'});
    window.host.update({status:'ready',value:'const value = 2;'});
  });
  await page.waitForFunction(selector=>!document.querySelector(selector), {}, marker);
  assert.deepEqual(await state(), {status:'ready',value:'const value = 2;'});

  await page.evaluate(()=>window.host.mount({language:'JavaScript',starterCode:'const broken = ;\n'+'let value = 1;\n'.repeat(16000)}));
  await page.waitForSelector(marker);
  assert.equal(await page.$eval('#editor .cm-scroller',node=>node.scrollTop),0);
  assert.ok(await page.$eval('#editor .cm-line',node=>node.textContent.includes('const broken = ;')&&!!node.querySelector('.cm-lintPoint-error, .cm-lintRange-error')),'Early errors appear without scrolling a document beyond the parse-ahead limit');
  await page.screenshot({path:path.join(evidence,'large-answer-diagnostics.png')});
  await page.evaluate(()=>window.host.mount({language:'JavaScript',starterCode:'function example() {\n'+'let value = 1;\n'.repeat(16000)+'}\n'}));
  await new Promise(resolve=>setTimeout(resolve,1000));
  assert.equal(await page.$$eval(marker,nodes=>nodes.length),0,'A valid open construct has no artificial partial-parse boundary error');

  for(const [language,starterCode] of [['TypeScript','const value: number = "not a number";'],['SQL','SELECT FROM WHERE ;'],['HTML','<div>'],['unbundled-language','not code']]) {
    await page.evaluate(({language,starterCode})=>window.host.mount({language,starterCode}), {language,starterCode});
    await page.waitForFunction(()=>document.querySelector('#editor [role="status"]').textContent!=='Loading highlighting…');
    await new Promise(resolve=>setTimeout(resolve,450));
    assert.equal(await page.$$eval(marker,nodes=>nodes.length),0, `${language}: no unsupported or semantic diagnoses`);
    assert.deepEqual(await state(),{status:'ready',value:starterCode});
  }
  await page.evaluate(()=>window.host.showAnswered('const value = ;','JavaScript'));
  await page.waitForFunction(()=>document.querySelector('#answered [role="status"]').textContent==='');
  await new Promise(resolve=>setTimeout(resolve,450));
  assert.equal(await page.$$eval('#answered .cm-lintPoint-error, #answered .cm-lintRange-error',nodes=>nodes.length),0,'Saved answers have no diagnostics');
  assert.equal(await page.$$eval('#answered .cm-line',nodes=>nodes.map(node=>node.textContent).join('\n')),'const value = ;');
  await page.evaluate(()=> {
    window.host.mount({language:'Python',starterCode:'def example(:\n    return 1\n'});
    window.host.unmount();document.querySelector('#editor').textContent='diagnostics-unmounted';
  });
  await new Promise(resolve=>setTimeout(resolve,450));
  assert.equal(await page.$eval('#editor',node=>node.textContent),'diagnostics-unmounted','Pending lint timers cannot resurrect an unmounted editor');
  await page.evaluate(() => {document.querySelector('#editor').textContent='';window.host.mount({language:'C++',starterCode:'int main() {}'});window.host.disable()});
  await page.waitForNetworkIdle();
  assert.equal(await page.$$eval('.cm-editor',nodes=>nodes.length),0);
  assert.ok(requests.every(url=>url.startsWith(base + '/') || url.startsWith('data:image/svg+xml,')),"Only local assets and inline CodeMirror diagnostic SVGs may load");
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({passed:true,requests,errors,diagnosticLanguages:diagnosticExamples.map(([name])=>name),diagnosticDelay},null,2));
  console.log(`PASS: built editor, whitespace, highlighting, readiness, keyboard/history, controlled selection/fold, plain fallback, saved read-only code, nine-language diagnostics/hover/debounce/advisory submission, late-load/unload cleanup. Evidence: ${evidence}`);
} finally {
  if(browser)await browser.close();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
