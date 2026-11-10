// Diagnosis only. No product edits, builds, installs, releases, or model calls.
// node svg-matrix.mjs --checkout <trusted checkout> --runtime <packaged Electron>
// Optional --app-entry <checkout> uses installed, unpackaged Electron instead.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const args=process.argv.slice(2);
const arg=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
const root=fs.realpathSync(arg('--checkout',process.cwd()));
const runtime=path.resolve(arg('--runtime','missing-runtime'));
assert.ok(fs.existsSync(runtime));
const entry=arg('--app-entry',null);
const require=createRequire(path.join(root,'package.json'));
const {default:puppeteer}=await import(pathToFileURL(require.resolve('puppeteer-core')).href);
const {tsImport}=await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
const {renderSvgOnPage,loadIsolatedPage,runDemoOnPage}=await tsImport(path.join(root,'src/agent/subagents/headless.ts'),import.meta.url);
const {probeEnv,stopBrowserService}=await import(pathToFileURL(path.join(root,'scripts/smoke-demo-runtime.mjs')).href);
const base=fs.mkdtempSync(path.join(os.tmpdir(),'lh-svg-matrix-'));
console.log(JSON.stringify({event:'diagnosis-only',root,runtime,entry,home:base,node:process.versions.node,puppeteer:JSON.parse(fs.readFileSync(path.join(root,'node_modules/puppeteer-core/package.json'))).version}));
const passive='<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="red"/></svg>';
const knownCases=['production-script','production-passive','old-file-passive','memory-no-viewport','memory-view-capture','memory-no-fullpage','memory-bounded-fullpage'];
const cases=arg('--cases',knownCases.join(',')).split(',');
assert.ok(cases.every(name=>knownCases.includes(name)));
for(const name of cases){
 const home=path.join(base,name);fs.mkdirSync(home);fs.writeFileSync(path.join(home,'auth.json'),'{}\n',{mode:0o600});
 const env={...probeEnv(process.env,home)};delete env.ELECTRON_RUN_AS_NODE;
 const helper=spawn(runtime,[...(entry?[path.resolve(entry)]:[]),'--browser-service',`--user-data-dir=${path.join(home,'profile')}`,'--disable-background-networking','--disable-component-update','--no-proxy-server',...(process.platform==='linux'?['--no-sandbox']:[])],{cwd:home,env,stdio:['ignore','pipe','pipe','ipc']});
 let stdout='',stderr='',browser;const observations=[];const started=performance.now();
 const emit=(event,data={})=>console.log(JSON.stringify({case:name,event,ms:Math.round(performance.now()-started),...data}));
 helper.stderr.on('data',x=>stderr=(stderr+x).slice(-8000));
 try{
  const port=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('CDP handshake deadline')),15000);
   helper.once('error',e=>{clearTimeout(timer);reject(e)});
   helper.once('exit',code=>{clearTimeout(timer);reject(Error('early helper exit '+code))});
   helper.stdout.on('data',x=>{stdout=(stdout+x).slice(-8000);const m=stdout.match(/^BROWSER_SERVICE_CDP (\d+)\r?$/m);if(m){clearTimeout(timer);resolve(Number(m[1]))}});
  });
  const version=await(await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(5000)})).json();
  browser=await puppeteer.connect({browserWSEndpoint:version.webSocketDebuggerUrl,defaultViewport:null,protocolTimeout:10000});
  const page=(await browser.pages()).find(p=>p.target().type()==='page');assert.ok(page);
  emit('connected',{browser:version.Browser});
  const client=page._client(),send=client.send.bind(client);
  client.send=async(method,...params)=>{
   const trace=['Page.captureScreenshot','Emulation.setDeviceMetricsOverride'].includes(method),t=performance.now();
   if(trace)emit('cdp-send',{method,params:params[0],...(method==='Page.captureScreenshot'?{observations:[...observations]}:{})});
   try{const r=await send(method,...params);if(trace)emit('cdp-ok',{method,duration:Math.round(performance.now()-t)});return r}
   catch(e){
    if(trace)emit('cdp-error',{method,duration:Math.round(performance.now()-t),error:String(e)});
    if(method==='Page.captureScreenshot'){
     // Read-only snapshots AFTER the original failure, BEFORE guarded cleanup.
     // Each side probe is bounded to 1.5s; the screenshot deadline stays 10s.
     const snapshots=await Promise.allSettled([
      send('Runtime.evaluate',{expression:'({ready:document.readyState,visibility:document.visibilityState,origin:location.origin,width:innerWidth,height:innerHeight,svg:!!document.querySelector("svg")})',returnByValue:true},{timeout:1500}),
      send('Page.getLayoutMetrics',{}, {timeout:1500}),
      fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1500)}).then(r=>({status:r.status}))
     ]);
     emit('after-capture-failure',{observations:[...observations],snapshots:snapshots.map((x,i)=>({probe:['renderer-evaluate','layout','devtools-http'][i],...(x.status==='fulfilled'?{value:x.value}:{error:String(x.reason)})}))});
    }
    throw e;
   }
  };
  // Exercise real guarded retirement/reuse before the independent SVG case.
  assert.equal((await runDemoOnPage(page,'<p>owned prior document</p>',{settleMs:20})).ok,true);
  emit('before',{state:await page.evaluate(()=>({origin:location.origin,ready:document.readyState,visibility:document.visibilityState,width:innerWidth,height:innerHeight})),layout:await client.send('Page.getLayoutMetrics')});
  const canary=path.join(home,'canary.txt');fs.writeFileSync(canary,'lh-svg-canary');
  page.on('console',m=>{if(m.type()==='log')observations.push(m.text())});
  const scripted=passive.replace('</svg>',`<script>let read=false;try{const x=new XMLHttpRequest();x.open('GET',${JSON.stringify(pathToFileURL(canary).href)},false);x.send();read=x.responseText.includes('lh-svg-canary')}catch{}console.log('SVG_FILE_READ='+read)</script></svg>`);
  let png;
  if(name==='old-file-passive'){
   // v0.5.0 fallback recipe, NOT a proposed return to file-origin documents.
   // Passive, hardcoded SVG only: never untrusted markup or the file canary.
   const file=path.join(home,'figure.html');fs.writeFileSync(file,`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}svg{display:block}</style></head><body>${passive}</body></html>`);
   await page.setViewport({width:80,height:40});await page.goto(pathToFileURL(file).href,{waitUntil:'load',timeout:30000});
   png=await page.screenshot({fullPage:true,type:'png'});await page.goto('about:blank');
  }else{
   const owned=new Proxy(page,{get(target,key){
    if(key==='setViewport'&&name==='memory-no-viewport')return async()=>{};
    if(key==='screenshot')return async options=>{
     if(name==='memory-view-capture')return target.screenshot({...options,fromSurface:false});
     if(name==='memory-no-fullpage')return target.screenshot({...options,fullPage:false});
     if(name==='memory-bounded-fullpage')return target.screenshot({...options,captureBeyondViewport:false});
     return target.screenshot(options);
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
   }});
   png=await renderSvgOnPage(owned,name==='production-script'?scripted:passive);
  }
  assert.equal(Buffer.from(png).subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  if(name==='production-script')assert.deepEqual(observations,['SVG_FILE_READ=false']);
  assert.equal(page.url(),'about:blank');
  fs.writeFileSync(path.join(home,'capture.png'),png);
  emit('capture-result',{bytes:png.length,width:Buffer.from(png).readUInt32BE(16),height:Buffer.from(png).readUInt32BE(20),observations});
 }catch(e){emit('failure',{error:String(e),cause:String(e.cause??''),observations,helperStdout:stdout,helperStderr:stderr});}
 finally{
  browser?.disconnect();
  try{emit('cleanup',await stopBrowserService(helper));}catch(e){emit('cleanup-error',{error:String(e)});}
 }
}
console.log(JSON.stringify({event:'diagnosis-complete-not-a-release-gate',home:base}));
