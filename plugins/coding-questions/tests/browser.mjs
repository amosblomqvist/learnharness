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
const html = `<!doctype html><html><head><link rel="stylesheet" href="/styles.css"><style>:root{--font-ui:ui-monospace,SFMono-Regular,monospace;--foreground:#e6e6e6;--muted-foreground:#8d8d8d}body{margin:30px;background:#141414;color:var(--foreground);font-family:var(--font-ui)}#editor,#answered-card{max-width:800px;margin-bottom:20px}#answered-heading,.practice-heading{display:flex;align-items:center;gap:8px;font-size:11px;margin-bottom:8px}#answered-header{display:inline-flex}#thinking{margin-top:8px;border-left:2px solid #434343;padding-left:14px;font-size:11px}#native-why{margin-top:8px}.native-why{padding:0;border:0;background:transparent;font-family:inherit;font-size:11px;line-height:1.4;font-weight:500;color:var(--muted-foreground);transition:color 150ms}.native-why:hover{color:var(--foreground)}</style></head><body><div id="editor"></div><section id="answered-card"><div id="answered-heading"><span>Coding question</span><span id="answered-header"></span></div><div id="answered"></div><div id="thinking">YOUR THINKING</div><div id="answered-footer"></div></section><div id="practice-history"></div><div id="native-why"><button class="native-why">Why</button></div><script type="module">
import {activate} from '/main.js';
let renderer,problemRenderer,activeBadges=0,activeMarkdown=0,activeQuestions=0;
window.markdownMounts=[];window.questionMounts=[];
Object.defineProperty(window,'activeBadgeCount',{get:()=>activeBadges});
// Track lazy solution widgets separately from always-visible saved prompts.
Object.defineProperty(window,'activeMarkdownCount',{get:()=>activeMarkdown});
Object.defineProperty(window,'activeQuestionCount',{get:()=>activeQuestions});
const ui={mountBadge(container,props,{signal}){
 const node=document.createElement('span');node.dataset.fixtureBadge='';let disposed=false;activeBadges++;
 const update=next=>{node.textContent=next.text;node.style.color=next.color??'';node.dataset.color=next.color??''};
 update(props);container.append(node);
 const dispose=()=>{if(disposed)return;disposed=true;activeBadges--;signal.removeEventListener('abort',dispose);node.remove()};
 if(signal.aborted)dispose();else signal.addEventListener('abort',dispose,{once:true});
 return {update,dispose};
},mountMarkdown(container,props,{signal}){
 const isQuestion=container.classList.contains('lh-coding-prompt');
 const node=document.createElement('div');node.className='lh-prose';node.dataset.fixtureMarkdown='';let disposed=false;
 if(isQuestion)activeQuestions++;else activeMarkdown++;
 (isQuestion?window.questionMounts:window.markdownMounts).push(props.text);
 const update=next=>{node.textContent=next.text};update(props);container.append(node);
 const dispose=()=>{if(disposed)return;disposed=true;if(isQuestion)activeQuestions--;else activeMarkdown--;signal.removeEventListener('abort',dispose);node.remove()};
 if(signal.aborted)dispose();else signal.addEventListener('abort',dispose,{once:true});
 if(window.abortDuringMarkdownMount)window.host.answeredController.abort();
 return {update,dispose};
}};
const cleanup = activate({ui,
 registerQuestionRenderer(value){renderer=value;return ()=>{if(!window.host.practice)window.host.unmount();renderer=null}},
 registerProblemRenderer(value){problemRenderer=value;return ()=>{if(window.host.practice)window.host.unmount();problemRenderer=null}}
});
window.host={answer:{status:'empty'},active:true,publications:[],handle:null,controller:null,submits:0,reserved:[],records:[],
mount({language='python',starterCode,modelSolution,answer={status:'empty'},practice=false,tests}={}){
 this.unmount();this.practice=practice;this.answer=answer;this.active=true;this.publications=[];this.controller=new AbortController();
 const payload={language,...(starterCode===undefined?{}:{starterCode}),...(tests===undefined?{}:{tests})};
 const input=practice?{statement:'Saved practice statement',mode:'composition',modelSolution,payload}:{question:'Test question',type:'predict',nodeId:'fixture',payload:{...payload,...(modelSolution===undefined?{}:{modelSolution})}};
 const props={input,chatId:'fixture',contractVersion:1,signal:this.controller.signal,active:true,
 ...(practice?{problemId:'practice-fixture',submission:answer}:{questionId:'question-'+Math.random(),variant:'teach',answer}),
 onChange:state=>{this.answer=state;this.publications.push(state);if(this.handle)this.update(state,this.active)}};
 this.props=props;this.handle=practice?problemRenderer.mountSubmissionEditor(document.querySelector('#editor'),props):renderer.mountAnswerEditor(document.querySelector('#editor'),props);this.update();return this.answer;
},update(answer=this.answer,active=this.active){this.answer=answer;this.active=active;this.handle.update(this.practice?{submission:answer,active}:{answer,active})},
unmount(){this.controller?.abort();this.handle?.dispose();this.handle?.dispose();this.handle=null},
showAnswered(code,language='python',grading,withHeader=true,modelSolution,withFooter=true){this.answeredCleanup?.();this.answeredController?.abort();this.answeredController=new AbortController();this.answeredCleanup=renderer.mountAnswered(document.querySelector('#answered'),{...this.props,input:{...this.props.input,payload:{language,...(modelSolution===undefined?{}:{modelSolution})}},signal:this.answeredController.signal,answer:code,...(withHeader?{headerContainer:document.querySelector('#answered-header')}:{}),...(withFooter?{footerContainer:document.querySelector('#answered-footer')}:{}),...(grading===undefined?{}:{grading})})},
addSubmitted(submission,processing,withHeader=true,withFooter=true){
 const root=document.createElement('section');root.id='practice-'+this.records.length;
 const heading=document.createElement('div');heading.className='practice-heading';heading.textContent='Coding problem';
 const header=document.createElement('span'),body=document.createElement('div'),thinking=document.createElement('div'),footer=document.createElement('div');
 body.dataset.submissionBody='';thinking.dataset.submissionThinking='';thinking.textContent='YOUR THINKING: captured separately';footer.dataset.submissionFooter='';heading.append(header);root.append(heading,body,thinking,footer);document.querySelector('#practice-history').append(root);
 const controller=new AbortController();const {input,chatId,problemId,contractVersion}=this.props;
 const dispose=problemRenderer.mountSubmitted(body,Object.freeze({input,chatId,problemId,contractVersion,signal:controller.signal,submission,...(processing===undefined?{}:{processing}),...(withHeader?{headerContainer:header}:{}),...(withFooter?{footerContainer:footer}:{})}));
 this.records.push({root,controller,dispose});return root.id;
},
disable(){cleanup();this.answeredCleanup?.();this.answeredController?.abort();for(const record of this.records){record.controller.abort();record.dispose?.();record.root.remove()}}};
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
  const savedQuestion='Implement **example** so it returns $42$.\n\n```javascript\nfunction example() {}\n```\n\nPreserve the requested result.  \n';
  await page.evaluate(({code,question})=>{window.host.props.input={...window.host.props.input,question};window.host.showAnswered(code,'JavaScript')},{code:savedCode,question:savedQuestion});
  await page.waitForFunction(() => document.querySelector('#answered [role="status"]').textContent === "");
  assert.equal(await page.$$eval('#answered [contenteditable="true"]',nodes=>nodes.length),0);
  assert.equal(await page.$$eval('#answered .cm-line',nodes=>nodes.map(node=>node.textContent).join('\n')),savedCode);
  assert.equal(await page.$eval('#answered > .lh-coding-prompt',node=>node.textContent),savedQuestion,'Historical answers display the original saved question, not just the code');
  assert.equal(await page.evaluate(()=>window.questionMounts.at(-1)),savedQuestion,'Prompt goes unchanged to public host Markdown');
  assert.equal(await page.evaluate(()=>window.activeQuestionCount),1);
  await page.screenshot({path:path.join(evidence,'editor-and-saved-answer.png')});
  assert.equal(await page.$$eval('#answered-card .lh-coding-test-result',nodes=>nodes.length),0,'Historical ungraded answers have no invented result');
  const passResult={status:'passed',exitCode:0,stdout:'<script>literal output</script>  \n',stderr:'',stdoutTruncated:false,stderrTruncated:false};
  for(const [grading,label,color] of [
    [{result:passResult},'Tests passed','var(--color-green-500, #22c55e)'],
    [{result:{...passResult,status:'failed',exitCode:1,stderr:'Assertion failed',stdoutTruncated:true,stderrTruncated:true}},'Tests failed','var(--color-red-500, #ef4444)'],
    [{result:{...passResult,status:'error',exitCode:null,message:'Missing installed runtime'}},'Could not run tests',''],
    [{error:'Grading callback failed'},'Could not run tests',''],
    [{result:false},'Could not run tests',''],
  ]) {
    await page.evaluate(({grading,savedCode})=>window.host.showAnswered(savedCode,'JavaScript',grading),{grading,savedCode});
    assert.equal(await page.$eval('#answered-header [data-fixture-badge]',node=>node.textContent),label);
    assert.equal(await page.$eval('#answered-header [data-fixture-badge]',node=>node.dataset.color),color);
    assert.equal(await page.$$eval('#answered [data-fixture-badge]',nodes=>nodes.length),0,'Badge is in the supplied header slot, not the answer body');
    const aligned=await page.$eval('#answered-heading',node=>{const label=node.firstElementChild.getBoundingClientRect(),badge=node.querySelector('[data-fixture-badge]').getBoundingClientRect();return {labelTop:label.top,labelBottom:label.bottom,badgeTop:badge.top,badgeBottom:badge.bottom,badgeLeft:badge.left,labelRight:label.right}});
    assert.ok(Math.abs((aligned.labelTop+aligned.labelBottom)-(aligned.badgeTop+aligned.badgeBottom))<1,'Badge shares the heading row');
    assert.ok(aligned.badgeLeft>=aligned.labelRight,'Badge follows the heading');
    assert.equal(await page.$eval('#answered-footer .lh-coding-test-output > button',node=>node.getAttribute('aria-expanded')),'false');
    assert.equal(await page.$eval('#answered',node=>node.firstElementChild.className),'lh-coding-prompt','The original question precedes submitted code');
    assert.equal(await page.$eval('#answered > .lh-coding-prompt',node=>node.textContent),savedQuestion);
    assert.equal(await page.evaluate(()=>window.activeQuestionCount),1,'Replacing a saved answer disposes the previous question widget');
    assert.equal(await page.$$eval('#answered-card script',nodes=>nodes.length),0,'Process output is never interpreted as HTML');
    assert.equal(await page.$$eval('#answered .lh-coding-test-result',nodes=>nodes.length),0,'Test output uses the footer below thinking, not the answer body');
    const toggle='#answered-footer .lh-coding-test-output > button';
    await page.mouse.move(0,0);
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#answered-footer .lh-coding-test-output > button')).color==='rgb(141, 141, 141)');
    const typography=await page.$eval(toggle,node=>{const properties=['fontFamily','fontSize','lineHeight','fontWeight','letterSpacing','textTransform','color','backgroundColor','paddingTop','paddingLeft'];return Object.fromEntries(properties.map(key=>[key,getComputedStyle(node)[key]]))});
    const why=await page.$eval('.native-why',node=>Object.fromEntries(['fontFamily','fontSize','lineHeight','fontWeight','letterSpacing','textTransform','color','backgroundColor','paddingTop','paddingLeft'].map(key=>[key,getComputedStyle(node)[key]])));
    assert.deepEqual(typography,why,'Test output uses the native Why control typography, not custom row styling');
    assert.equal(await page.$$eval('#answered-card .lh-coding-disclosure svg',nodes=>nodes.length),0,'No chevrons');
    const width=await page.$eval(toggle,node=>({button:node.getBoundingClientRect().width,row:node.parentElement.getBoundingClientRect().width}));
    assert.ok(width.button<width.row/2,'Control hugs its text instead of filling the row');
    await page.hover(toggle);
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#answered-footer .lh-coding-test-output > button')).color==='rgb(230, 230, 230)');
    assert.equal(await page.$eval(toggle,node=>getComputedStyle(node).backgroundColor),'rgba(0, 0, 0, 0)','Only text highlights');
    const row=await page.$eval(toggle,node=>{const r=node.parentElement.getBoundingClientRect();return{x:r.right-4,y:r.top+8}});
    await page.mouse.move(row.x,row.y);
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#answered-footer .lh-coding-test-output > button')).color==='rgb(141, 141, 141)');
    await page.locator(toggle).click();
    assert.equal(await page.$eval(toggle,node=>node.textContent),'Hide test output');
    await page.focus(toggle);
    await page.keyboard.press('Enter');
    assert.equal(await page.$eval(toggle,node=>node.getAttribute('aria-expanded')),'false');
    assert.equal(await page.$$eval('#answered-footer pre',nodes=>nodes.length),0,'Closing removes expanded content');
    await page.keyboard.press('Space');
    assert.equal(await page.$eval(toggle,node=>node.getAttribute('aria-expanded')),'true');
    assert.equal(await page.$eval(toggle,node=>getComputedStyle(node).outlineStyle),'solid','Focused disclosure has visible keyboard focus');
    const framed=await page.$eval('#answered-card',node=>{
      const keys=['backgroundColor','borderTopColor','borderTopWidth','borderRadius'];
      const style=element=>Object.fromEntries(keys.map(key=>[key,getComputedStyle(element)[key]]));
      return {answer:style(node.querySelector('#answered > .lh-coding-question')),outputs:[...node.querySelectorAll('.lh-coding-disclosure__body > .lh-coding-question')].map(style),labels:[...node.querySelectorAll('.lh-coding-disclosure__body .lh-coding-question__header')].map(element=>element.textContent),codeEditors:node.querySelectorAll('.lh-coding-disclosure__body .cm-editor').length};
    });
    const expectedLabels=grading.result&&typeof grading.result==='object'?[...(grading.result.stdout!==''?['Stdout']:[]),...(grading.result.stderr!==''?['Stderr']:[])]:[];
    assert.deepEqual(framed.outputs,expectedLabels.map(()=>framed.answer),'Nonempty streams reuse the code-block frame styling');
    assert.deepEqual(framed.labels,expectedLabels,'Never show empty stream boxes');
    assert.equal(framed.codeEditors,0,'Output needs plain text, not extra editors');
    if(grading.result&&typeof grading.result==='object') {
      assert.deepEqual(await page.$$eval('#answered-footer pre',nodes=>nodes.map(node=>node.textContent)),[grading.result.stdout,grading.result.stderr].filter(text=>text!==''));
      const fonts=await page.$eval('#answered-card',node=>{const keys=['fontFamily','fontSize','lineHeight'];const css=element=>Object.fromEntries(keys.map(key=>[key,getComputedStyle(element)[key]]));return{code:css(node.querySelector('.cm-scroller')),output:css(node.querySelector('pre'))}});
      assert.deepEqual(fonts.output,fonts.code,'Console output matches the submitted code typography');
      if(grading.result.stdoutTruncated) {
        assert.ok(await page.$eval('#answered-footer .lh-coding-test-output',node=>node.textContent.includes('Stdout truncated at 64 KiB.')&&node.textContent.includes('Stderr truncated at 64 KiB.')));
        await page.screenshot({path:path.join(evidence,'failed-tests-and-output.png')});
      }
    } else {
      assert.ok(await page.$eval('#answered-footer .lh-coding-test-output',node=>node.textContent.includes('Grading callback failed')||node.textContent.includes('Saved test result is unavailable.')));
    }
    assert.equal(await page.evaluate(()=>window.activeBadgeCount),1);
  }
  await page.evaluate(({savedCode,passResult})=>window.host.showAnswered(savedCode,'JavaScript',{result:{...passResult,stdout:'captured line\n'.repeat(3000)}}),{savedCode,passResult});
  await page.locator('#answered-footer .lh-coding-test-output > button').click();
  const outputSize=await page.$eval('#answered-footer pre',node=>({maxHeight:parseFloat(getComputedStyle(node).maxHeight),rootFont:parseFloat(getComputedStyle(document.documentElement).fontSize),scrollHeight:node.scrollHeight,clientHeight:node.clientHeight}));
  assert.equal(outputSize.maxHeight,16*outputSize.rootFont,'Keep the 16rem output height cap');
  assert.ok(outputSize.scrollHeight>outputSize.clientHeight,'Large output scrolls inside its code frame');
  await page.evaluate(({savedCode,passResult})=>window.host.showAnswered(savedCode,'JavaScript',{result:passResult},false,undefined,false),{savedCode,passResult});
  assert.equal(await page.$$eval('#answered-header .lh-coding-test-result__badge',nodes=>nodes.length),0);
  assert.equal(await page.$$eval('#answered [data-fixture-badge]',nodes=>nodes.length),1,'Older hosts without a header slot keep the body fallback');
  await page.evaluate(({savedCode,passResult})=>{
    const sentinel=document.createElement('i');sentinel.textContent='host-owned sentinel';document.querySelector('#answered-header').append(sentinel);
    window.host.showAnswered(savedCode,'JavaScript',{result:passResult});
    window.host.answeredController.abort();
  },{savedCode,passResult});
  assert.equal(await page.evaluate(()=>window.activeBadgeCount),0,'Abort disposes a badge outside the body slot');
  assert.equal(await page.$eval('#answered-header',node=>node.textContent),'host-owned sentinel','Cleanup removes only its own header child');
  await page.evaluate(()=>{document.querySelector('#answered-header').textContent='';window.host.showAnswered('historical code','unbundled-language')});
  assert.equal(await page.evaluate(()=>window.activeBadgeCount),0,'Replacing a saved slot disposes its badge');

  const emptyResult={...passResult,stdout:'',stderr:''};
  await page.evaluate(({savedCode,emptyResult})=>window.host.showAnswered(savedCode,'JavaScript',{result:emptyResult}),{savedCode,emptyResult});
  assert.equal(await page.$$eval('#answered-card .lh-coding-test-output',nodes=>nodes.length),0,'Silent runs have no empty Test output control');
  assert.equal(await page.$eval('#answered-header',node=>node.textContent),'Tests passed','A silent run still retains its badge');
  for(const stdout of [' \t\n','']) {
    await page.evaluate(({savedCode,emptyResult,stdout})=>window.host.showAnswered(savedCode,'JavaScript',{result:{...emptyResult,stdout,stdoutTruncated:stdout===''}}),{savedCode,emptyResult,stdout});
    await page.locator('#answered-footer .lh-coding-test-output > button').click();
    assert.deepEqual(await page.$$eval('#answered-footer pre',nodes=>nodes.map(node=>node.textContent)),stdout===''?[]:[stdout],'Preserve whitespace-only output and omit empty boxes');
    if(stdout==='')assert.match(await page.$eval('#answered-footer .lh-coding-test-output',node=>node.textContent),/Stdout truncated at 64 KiB/);
  }

  const modelSolution='  ```javascript\nfunction example() { return 42; }\n```\n\n**Why:** return the requested value. <script>literal model text</script>  \n';
  await page.evaluate(modelSolution=>window.host.mount({language:'javascript',starterCode:'function example() {}',modelSolution}),modelSolution);
  assert.equal(await page.$$eval('#editor .lh-coding-model-solution',nodes=>nodes.length),0,'Pending questions never reveal their model solution');
  assert.equal(await page.evaluate(()=>window.activeMarkdownCount),0);
  await page.evaluate(({savedCode,passResult,modelSolution})=>window.host.showAnswered(savedCode,'JavaScript',{result:passResult},true,modelSolution),{savedCode,passResult,modelSolution});
  const solution='#answered-footer .lh-coding-model-solution > button';
  assert.equal(await page.$eval(solution,node=>node.textContent),'Model solution');
  assert.equal(await page.$eval(solution,node=>node.getAttribute('aria-expanded')),'false');
  assert.equal(await page.$$eval('#answered .lh-coding-model-solution',nodes=>nodes.length),0,'Model solution uses the supplied footer, not the answer body');
  assert.equal(await page.evaluate(()=>window.activeMarkdownCount),0,'Collapsed model solution mounts no Markdown widget');
  const order=await page.evaluate(()=>{
    const question=document.querySelector('#answered > .lh-coding-prompt'),code=document.querySelector('#answered > .lh-coding-question'),output=document.querySelector('#answered-footer .lh-coding-test-output'),thinking=document.querySelector('#thinking'),model=document.querySelector('#answered-footer .lh-coding-model-solution');
    const before=(a,b)=>!!(a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING);
    return[before(question,code),before(code,thinking),before(thinking,output),before(output,model)];
  });
  assert.deepEqual(order,[true,true,true,true],'Order is saved question, code, host thinking, output, model solution');
  await page.mouse.move(0,0);
  const solutionFont=await page.$eval(solution,node=>{const css=getComputedStyle(node);return[css.fontFamily,css.fontSize,css.fontWeight,css.lineHeight,css.backgroundColor,css.textTransform]});
  const whyFont=await page.$eval('.native-why',node=>{const css=getComputedStyle(node);return[css.fontFamily,css.fontSize,css.fontWeight,css.lineHeight,css.backgroundColor,css.textTransform]});
  assert.deepEqual(solutionFont,whyFont,'Both controls match the native Why typography');
  await page.screenshot({path:path.join(evidence,'quiet-disclosures-collapsed.png')});
  await page.locator(solution).click();
  assert.equal(await page.$eval(solution,node=>node.textContent),'Hide model solution');
  assert.equal(await page.evaluate(()=>window.activeMarkdownCount),1);
  assert.equal(await page.evaluate(()=>window.markdownMounts.at(-1)),modelSolution,'Public Markdown helper receives exact authored text');
  assert.equal(await page.$eval('#answered-footer .lh-coding-test-output > button',node=>node.getAttribute('aria-expanded')),'false','Solution and output expand independently');
  await page.locator('#answered-footer .lh-coding-test-output > button').click();
  await page.screenshot({path:path.join(evidence,'quiet-disclosures-expanded.png')});
  await page.focus(solution);await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>window.activeMarkdownCount),0,'Closing disposes the Markdown widget');
  assert.equal(await page.$eval('#answered-footer .lh-coding-test-output > button',node=>node.getAttribute('aria-expanded')),'true');
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(()=>window.activeMarkdownCount),1);
  assert.equal(await page.evaluate(()=>window.markdownMounts.at(-1)),modelSolution,'Reopening preserves original solution text');
  assert.equal(await page.$$eval('#answered-card script',nodes=>nodes.length),0);
  await page.evaluate(()=>{
    const sentinel=document.createElement('i');sentinel.textContent='host footer sentinel';document.querySelector('#answered-footer').append(sentinel);
    window.host.answeredController.abort();
  });
  assert.equal(await page.evaluate(()=>window.activeMarkdownCount),0,'Abort disposes the independently mounted footer widget');
  assert.equal(await page.evaluate(()=>window.activeBadgeCount),0);
  assert.equal(await page.evaluate(()=>window.activeQuestionCount),0,'Abort disposes the saved question widget');
  assert.equal(await page.$$eval('#answered .lh-coding-prompt',nodes=>nodes.length),0,'Abort removes the owned question wrapper');
  assert.equal(await page.$eval('#answered-footer',node=>node.textContent),'host footer sentinel','Only owned footer children are removed');
  assert.equal(await page.$eval('#thinking',node=>node.textContent),'YOUR THINKING','Plugin cleanup never touches host thinking');
  await page.evaluate(()=>document.querySelector('#answered-footer').replaceChildren());

  await page.evaluate(({savedCode,passResult,modelSolution})=>window.host.showAnswered(savedCode,'JavaScript',{result:passResult},true,modelSolution,false),{savedCode,passResult,modelSolution});
  assert.equal(await page.$$eval('#answered .lh-coding-model-solution',nodes=>nodes.length),1,'Older hosts retain a readable body fallback');
  await page.locator('#answered .lh-coding-model-solution > button').click();
  assert.equal(await page.evaluate(()=>window.activeMarkdownCount),1);
  await page.evaluate(()=>window.host.showAnswered('historical code','unbundled-language'));
  assert.equal(await page.evaluate(()=>window.activeMarkdownCount),0,'Slot replacement disposes an open solution');
  assert.equal(await page.$$eval('.lh-coding-model-solution',nodes=>nodes.length),0,'Historical answers have no invented model solution');
  for(const value of [null,'',' \t\n',42]) {
    await page.evaluate(value=>window.host.showAnswered('historical code','unbundled-language',undefined,true,value),value);
    assert.equal(await page.$$eval('.lh-coding-model-solution',nodes=>nodes.length),0,'Malformed or blank historical solutions are not fabricated');
  }
  await page.evaluate(({savedCode,passResult,modelSolution})=>{window.host.showAnswered(savedCode,'JavaScript',{result:passResult},true,modelSolution);window.abortDuringMarkdownMount=true},{savedCode,passResult,modelSolution});
  await page.locator(solution).click();
  assert.equal(await page.evaluate(()=>window.activeMarkdownCount),0,'Abort during a widget mount disposes the just-returned handle');
  assert.equal(await page.$$eval('.lh-coding-model-solution',nodes=>nodes.length),0);
  await page.evaluate(()=>{window.abortDuringMarkdownMount=false;window.host.showAnswered('historical code','unbundled-language')});
  assert.equal(await page.evaluate(()=>window.activeQuestionCount),1);
  await page.evaluate(()=>{window.abortDuringMarkdownMount=true;window.host.showAnswered('cancelled code','unbundled-language')});
  assert.equal(await page.evaluate(()=>window.activeQuestionCount),0,'Abort during the question mount disposes the just-returned widget');
  assert.equal(await page.$$eval('#answered .cm-editor, #answered .lh-coding-prompt',nodes=>nodes.length),0,'An aborted question mount never creates the code view');
  await page.evaluate(()=>{window.abortDuringMarkdownMount=false;window.host.showAnswered('historical code','unbundled-language')});

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
  // Exercise the practice adapter with genuine public problem props (no question
  // identity/answer), retained edits, independent saved attempts and observations.
  const privateSolution='PRIVATE_COMMITTED_PRACTICE_SOLUTION';
  const wrongCode='  function square(x) { return x; }  \n\n';
  const revisedCode='  function square(x) { return x * x; }  \n\n';
  await page.evaluate(({modelSolution,code})=>{
    const h=window.host;h.answeredCleanup?.();h.answeredController?.abort();document.querySelector('#answered-card').hidden=true;
    document.querySelector('#editor').textContent='';h.mount({practice:true,language:'JavaScript',starterCode:code,modelSolution});
    window.practiceEditor=document.querySelector('#editor .cm-editor');
  },{modelSolution:privateSolution,code:wrongCode});
  assert.deepEqual(await state(),{status:'ready',value:wrongCode});
  assert.deepEqual(await page.evaluate(()=>['questionId','answer','variant'].map(key=>key in window.host.props)),[false,false,false]);
  await fillCode(' \t\n');
  assert.deepEqual(await state(),{status:'unready',value:' \t\n'});
  await fillCode(wrongCode);
  await page.keyboard.press('End');await page.keyboard.press('Enter');
  assert.equal((await state()).value,wrongCode+'\n','Practice Enter remains a code newline');
  await fillCode(wrongCode);
  assert.equal(await page.evaluate(()=>window.host.handle.handleKeyDown('Escape')),'pass','Practice Escape is left to the host field-navigation layer');
  const practiceFailed={status:'failed',exitCode:1,stdout:'',stderr:'Expected 9, received <script>literal</script>\n',stdoutTruncated:false,stderrTruncated:false};
  await page.evaluate(result=>{const h=window.host;h.update(undefined,false);h.addSubmitted(h.answer.value,{result})},practiceFailed);
  assert.equal(await page.$eval('#editor .cm-content',node=>node.contentEditable),'false');
  assert.deepEqual(await state(),{status:'ready',value:wrongCode});
  assert.equal(await page.$eval('#practice-0 .practice-heading',node=>node.textContent),'Coding problemTests failed');
  assert.equal(await page.$$eval('#practice-0 .lh-coding-model-solution, #practice-0 .lh-coding-prompt',nodes=>nodes.length),0,'A practice attempt neither duplicates the statement nor reveals the committed solution');
  assert.equal(await page.evaluate(()=>window.activeMarkdownCount),0);
  assert.equal(await page.evaluate(()=>window.activeQuestionCount),0);
  assert.equal(await page.$$eval('#practice-history [contenteditable="true"]',nodes=>nodes.length),0,'Saved attempts are read-only');
  assert.equal(await page.$eval('#practice-0 [data-submission-footer] > .lh-coding-test-result button',node=>node.textContent),'Test output');
  const practiceOrder=await page.$eval('#practice-0',root=>{
    const code=root.querySelector('.lh-coding-question'),thinking=root.querySelector('[data-submission-thinking]'),output=root.querySelector('.lh-coding-test-result');
    const before=(a,b)=>!!(a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING);
    return[before(code,thinking),before(thinking,output)];
  });
  assert.deepEqual(practiceOrder,[true,true]);
  await page.click('#practice-0 button');
  assert.equal(await page.$eval('#practice-0 pre',node=>node.textContent),practiceFailed.stderr);
  assert.equal(await page.$$eval('#practice-0 script',nodes=>nodes.length),0);
  await page.evaluate(()=>window.host.update(undefined,true));
  assert.equal(await page.evaluate(()=>document.querySelector('#editor .cm-editor')===window.practiceEditor),true,'Busy/accepted cycles retain the practice editor generation');
  await fillCode(revisedCode);
  const practicePassed={status:'passed',exitCode:0,stdout:'Observed tests passed\n',stderr:'',stdoutTruncated:false,stderrTruncated:false};
  await page.evaluate(result=>{const h=window.host;h.update(undefined,false);h.addSubmitted(h.answer.value,{result});h.update(undefined,true)},practicePassed);
  assert.deepEqual(await state(),{status:'ready',value:revisedCode});
  assert.equal(await page.$eval('#practice-1 .practice-heading',node=>node.textContent),'Coding problemTests passed');
  assert.equal(await page.$$eval('#practice-0 .cm-line',nodes=>nodes.map(node=>node.textContent).join('\n')),wrongCode,'Later revisions do not rewrite earlier accepted attempts');
  assert.equal(await page.$$eval('#practice-1 .cm-line',nodes=>nodes.map(node=>node.textContent).join('\n')),revisedCode);
  assert.equal(await page.$eval('#practice-0 button',node=>node.getAttribute('aria-expanded')),'true');
  assert.equal(await page.$eval('#practice-1 button',node=>node.getAttribute('aria-expanded')),'false','Attempt disclosures are independent');
  await page.evaluate(()=>window.host.addSubmitted('saved code',{error:'Fixture workspace failure'}));
  assert.equal(await page.$eval('#practice-2 .practice-heading',node=>node.textContent),'Coding problemCould not run tests');
  await page.click('#practice-2 button');
  assert.match(await page.$eval('#practice-2 [data-submission-footer]',node=>node.textContent),/Fixture workspace failure/);
  await page.evaluate(()=>window.host.addSubmitted('historical unprocessed code'));
  assert.equal(await page.$$eval('#practice-3 [data-fixture-badge], #practice-3 button',nodes=>nodes.length),0,'Historical observations are not fabricated');
  await page.evaluate(result=>window.host.addSubmitted('older-host code',{result},false,false),practicePassed);
  assert.equal(await page.$$eval('#practice-4 [data-submission-body] .lh-coding-test-output, #practice-4 [data-submission-body] [data-fixture-badge]',nodes=>nodes.length),2,'Older hosts keep readable body fallbacks without querying host DOM');
  assert.doesNotMatch(await page.$eval('#practice-history',node=>node.textContent),new RegExp(privateSolution));
  await page.screenshot({path:path.join(evidence,'practice-multiple-submissions.png')});
  await page.evaluate(()=>window.host.records[0].controller.abort());
  assert.equal(await page.$$eval('#practice-0 .cm-editor, #practice-0 .lh-coding-test-result, #practice-0 [data-fixture-badge]',nodes=>nodes.length),0);
  assert.equal(await page.$$eval('#practice-1 .cm-editor, #practice-1 [data-fixture-badge]',nodes=>nodes.length),2,'Aborting an old attempt does not dispose its successor');
  // Test approval: the exact recipe is shown as text and gates readiness in both editors.
  const recipe={program:'python3',args:['-','two words',''],code:'import answer\n<script>window.injected=1</script>\n'+Array.from({length:40},(_,i)=>`assert ${i} == ${i}`).join('\n')};
  for(const practice of [false,true]){
    await page.evaluate((recipe,practice)=>window.host.mount({practice,starterCode:'print(1)',modelSolution:'Hidden',tests:recipe}),recipe,practice);
    assert.equal(await page.$eval('#editor .lh-coding-tests__heading',node=>node.textContent),'Tests that will run on this computer');
    assert.equal(await page.$eval('#editor .lh-coding-tests__command',node=>node.textContent),"$ python3 - 'two words' ''");
    assert.equal(await page.$eval('#editor .lh-coding-tests__code',node=>node.textContent),recipe.code);
    assert.equal(await page.$$eval('#editor .lh-coding-tests script',nodes=>nodes.length),0,'Test code is text, never markup');
    assert.ok(await page.$eval('#editor .lh-coding-tests',node=>!!(node.previousElementSibling?.compareDocumentPosition(node)&Node.DOCUMENT_POSITION_FOLLOWING)&&node.previousElementSibling.classList.contains('lh-coding-question')),'The approval sits below the code editor');
    const box=await page.$eval('#editor .lh-coding-tests__code',node=>({scrolls:node.scrollHeight>node.clientHeight,overflow:getComputedStyle(node).overflowY}));
    assert.ok(box.scrolls&&box.overflow==='auto','Long test code scrolls inside a fixed-height box');
    assert.deepEqual(await state(),{status:'unready',value:'print(1)'},'Unticked tests keep the answer unready');
    await page.click('#editor .lh-coding-tests__approval input');
    assert.deepEqual(await state(),{status:'ready',value:'print(1)'});
    await fillCode(' \n');
    assert.equal((await state()).status,'unready','Approval never makes blank code ready');
    await fillCode('print(2)');
    assert.deepEqual(await state(),{status:'ready',value:'print(2)'});
    await page.click('#editor .lh-coding-tests__approval input');
    assert.deepEqual(await state(),{status:'unready',value:'print(2)'},'Unticking makes the answer unready again');
    await page.evaluate(()=>window.host.update(window.host.answer,false));
    assert.equal(await page.$eval('#editor .lh-coding-tests__approval input',node=>node.disabled),true,'Inactive editors cannot approve');
    await page.evaluate(()=>window.host.update(window.host.answer,true));
    assert.equal(await page.$eval('#editor .lh-coding-tests__approval input',node=>node.disabled),false);
    if(!practice)await page.screenshot({path:path.join(evidence,'test-approval.png')});
  }
  await page.evaluate(()=>window.host.mount({starterCode:'print(1)',tests:{program:'python3',args:[],code:' \n'}}));
  assert.equal(await page.$$eval('#editor .lh-coding-tests',nodes=>nodes.length),0,'An invalid recipe never runs, so it needs no approval');
  assert.equal((await state()).status,'ready');
  await page.evaluate(()=>window.host.unmount());
  assert.equal(await page.$$eval('.lh-coding-tests',nodes=>nodes.length),0,'Unmount removes the approval section');
  await page.evaluate(()=>{window.host.mount({practice:true,language:'C++',starterCode:'int main() {}',modelSolution:'Hidden solution'});window.host.disable()});
  await page.waitForNetworkIdle();
  assert.equal(await page.$$eval('.cm-editor',nodes=>nodes.length),0);
  assert.equal(await page.evaluate(()=>window.activeBadgeCount),0);
  assert.equal(await page.evaluate(()=>window.activeMarkdownCount),0);
  assert.equal(await page.evaluate(()=>window.activeQuestionCount),0,'Plugin unload disposes the saved question');
  assert.ok(requests.every(url=>url.startsWith(base + '/') || url.startsWith('data:image/svg+xml,')),"Only local assets and inline CodeMirror diagnostic SVGs may load");
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({passed:true,requests,errors,diagnosticLanguages:diagnosticExamples.map(([name])=>name),diagnosticDelay,practice:{controlledProps:true,retainedEditor:true,multipleAttempts:true,observationsOnly:true,hiddenSolution:true,footerOrder:practiceOrder,bodyFallback:true,abortIsolation:true},disclosures:{transcriptOrder:['question','code','thinking','test-output','model-solution'],whyTypography:true,textOnlyHover:true,silentOutputHidden:true,modelSolutionHelper:'public Markdown spy; real renderer covered by host integration test',independentToggles:true,abortCleanup:true}},null,2));
  console.log(`PASS: built editor, whitespace, highlighting, readiness, keyboard/history, controlled selection/fold, plain fallback, saved read-only code, nine-language diagnostics/hover/debounce/advisory submission, test-result badges/output/history, quiet Why-matched controls, saved-question/code/thinking/output/model-solution order, silent output hiding, lazy exact model-solution Markdown, independent toggles, practice adapter/retained editor/multiple attempts/hidden solution/footer observations, late-load/unload/abort cleanup. Evidence: ${evidence}`);
} finally {
  if(browser)await browser.close();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
