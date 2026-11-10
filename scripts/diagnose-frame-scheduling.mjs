// SCRATCH DIAGNOSTIC ONLY, NOT A FIX OR RELEASE GATE.
// EXACTLY2 helpers: stock10s warmup; scratch entry requiring UNCHANGED main.
// ONE default180s screenshot; shamIPC10s, ONE throttling setting20s if ACKed.
// node frame-scheduling.mjs --checkout <a917 source> --runtime <stock Electron>
// [--out <NEW directory>]. frame-entry.cjs must sit beside this file. No force mode.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Export ONLY for a separate PURE-MOCK plumbing test, NOT a CLI/CI mode.
export function createPendingControls({request,emit,clock=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout}){
  let live=false,started=false;const timers=[],tasks=[];
  const state={started:false,originalSettled:false,inconclusive:false,sham:{sent:false,ack:false},transition:{sent:false,ack:false,applied:false}};
  const execute=async(command)=>{
    const phase=state[command];phase.sent=true;phase.sentAt=clock();emit('control-send',{command});
    try{
      const reply=await request(command);phase.ackAt=clock();phase.ackDuringOriginalPending=live;
      if(command==='sham')assert.deepEqual(reply,{ack:'sham'});
      else{assert.deepEqual(reply,{before:true,after:false,transitionApplied:true});phase.applied=true;}
      phase.ack=true;emit('control-ack',{command,reply,ackDuringOriginalPending:live});
    }catch(error){state.inconclusive=true;phase.error=String(error);if(command==='transition')phase.applied=null;emit('control-ack-failed',{command,error:String(error)});}
  };
  return {state,
    start(){assert.equal(started,false);started=true;state.started=true;live=true;
      timers.push(setTimer(()=>{if(live)tasks.push(execute('sham'));},10000));
      timers.push(setTimer(()=>{if(!live)return;if(!state.sham.ack){state.inconclusive=true;emit('transition-skipped',{reason:'no successful sham ACK'});return;}tasks.push(execute('transition'));},20000));
    },
    stop(){if(state.originalSettled)return;live=false;state.originalSettled=true;state.settledAt=clock();for(const timer of timers)clearTimer(timer);emit('unfired-controls-cancelled');},
    async drain(){await Promise.all(tasks);},
  };
}
async function main(){
const args=process.argv.slice(2), options=new Map();
for(let i=0;i<args.length;i+=2){
  assert.ok(['--checkout','--runtime','--out'].includes(args[i]),'unknown option; no synthetic-force mode exists');
  assert.ok(args[i+1]&&!args[i+1].startsWith('--'),'option value required');
  assert.ok(!options.has(args[i]),'duplicate option');options.set(args[i],args[i+1]);
}
const root=fs.realpathSync(options.get('--checkout')||process.cwd());
assert.ok(options.has('--runtime'),'pass an already materialized locked Electron executable');
const runtime=fs.realpathSync(options.get('--runtime'));
let output;
if(options.has('--out')){output=path.resolve(options.get('--out'));assert.ok(!fs.existsSync(output),'never overwrite evidence');fs.mkdirSync(output);}
else output=fs.mkdtempSync(path.join(os.tmpdir(),'lh-frame-scheduling-'));
// Scrub only this child Node process BEFORE importing application modules.
for(const key of Object.keys(process.env)){
  if(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)||/^(AWS_|GOOGLE_|GCLOUD_|CLOUDSDK_|AZURE_|ANTHROPIC_|OPENAI_|OPENROUTER_|GEMINI_|LH_|PI_)/.test(key)||['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key))delete process.env[key];
}
const parent=path.join(output,'parent');fs.mkdirSync(parent);fs.mkdirSync(path.join(parent,'tmp'));fs.mkdirSync(path.join(parent,'data'));
fs.writeFileSync(path.join(parent,'auth.json'),'{}\n',{mode:0o600});
Object.assign(process.env,{HOME:parent,USERPROFILE:parent,APPDATA:path.join(parent,'config'),LOCALAPPDATA:path.join(parent,'local'),XDG_CONFIG_HOME:path.join(parent,'config'),XDG_CACHE_HOME:path.join(parent,'cache'),TMPDIR:path.join(parent,'tmp'),TEMP:path.join(parent,'tmp'),TMP:path.join(parent,'tmp'),LH_DATA_DIR:path.join(parent,'data'),LH_AUTH_FILE:path.join(parent,'auth.json'),LH_IGNORE_ENV_KEYS:'1',NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1'});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function sourceIdentity(relative,expected){
  const bytes=fs.readFileSync(path.join(root,relative));
  const lf=Buffer.from(bytes.toString('utf8').replace(/\r\n/g,'\n'));
  assert.ok(bytes.equals(lf)||bytes.equals(Buffer.from(lf.toString('utf8').replace(/\n/g,'\r\n'))),'only uniform LF/CRLF checkout conversion accepted');
  assert.equal(digest(lf),expected,'exact a917 application source required');
  return {file:relative,rawSHA256:digest(bytes),normalizedLFSHA256:digest(lf)};
}
const entry=fileURLToPath(new URL('./frame-entry.cjs',import.meta.url));
assert.ok(fs.existsSync(entry),'frozen native entry required beside driver');
const headless=sourceIdentity('src/agent/subagents/headless.ts','5d4c01d4fb1ced0694a6b131559c3dc5803c72ccd00f673b4dc6cce78aa76c4b');
const main=sourceIdentity('electron/main.cjs','ccc34cdda5e70e72d07f601aa5ee4c16ec937767895797a01df5d19c13223857');
const require=createRequire(path.join(root,'package.json'));
for(const [name,version] of [['electron','44.9.3'],['puppeteer-core','25.8.0']])assert.equal(JSON.parse(fs.readFileSync(path.join(root,'node_modules',name,'package.json'))).version,version);
// Read path.txt, do not require('electron') or trigger its lazy installer here.
const stockPath=path.join(root,'node_modules/electron/dist',fs.readFileSync(path.join(root,'node_modules/electron/path.txt'),'utf8').trim());
assert.equal(runtime,fs.realpathSync(stockPath),'only stock installed Electron source-helper mode');
const {default:puppeteer}=await import(pathToFileURL(require.resolve('puppeteer-core')).href);
const {tsImport}=await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
const {runDemoOnPage,renderSvgOnPage}=await tsImport(pathToFileURL(path.join(root,headless.file)).href,import.meta.url);
const {probeEnv,stopBrowserService}=await import(pathToFileURL(path.join(root,'scripts/smoke-demo-runtime.mjs')).href);
const metadata={purpose:'SAME pending original: shamIPC then ONE backgroundThrottling transition; diagnosis only, NEVER release clearance',measurementScope:'one-setting rescue, NOT validated constructor-time repair or whole-tool budget',root,runtime,entry,output,node:process.versions.node,sourcePackageVersion:JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version,headless,main,driverSHA256:digest(fs.readFileSync(fileURLToPath(import.meta.url))),entrySHA256:digest(fs.readFileSync(entry)),maximumHelpers:2,retries:false,forcedErrors:false,shamAtMs:10000,transitionAtMs:20000,ackDeadlineMs:1500,shippingDefaultExpectedMs:180000};
fs.writeFileSync(path.join(output,'metadata.json'),JSON.stringify(metadata,null,2)+'\n');
console.log(JSON.stringify({event:'diagnosis-only',...metadata}));
const results=[];
for(const name of ['warmup-10s','observed-default']){
  const home=path.join(output,name);fs.mkdirSync(home);fs.mkdirSync(path.join(home,'tmp'));
  fs.writeFileSync(path.join(home,'auth.json'),'{}\n',{mode:0o600});
  const env={...probeEnv(process.env,home),TMPDIR:path.join(home,'tmp'),TEMP:path.join(home,'tmp'),TMP:path.join(home,'tmp')};delete env.ELECTRON_RUN_AS_NODE;
  const nonce=randomBytes(32).toString('hex');
  if(name==='observed-default')Object.assign(env,{SVG_FRAME_HOME:home,SVG_FRAME_SOURCE_MAIN:path.join(root,main.file),SVG_FRAME_NONCE:nonce});
  const helper=spawn(runtime,[name==='observed-default'?entry:root,'--browser-service',`--user-data-dir=${path.join(home,'profile')}`,'--disable-background-networking','--disable-component-update','--no-proxy-server',...(process.platform==='linux'?['--no-sandbox']:[])],{cwd:home,env,stdio:['ignore','pipe','pipe','ipc']});
  const began=performance.now();
  const result={case:name,helperPid:helper.pid,protocolTimeoutOptionOmitted:name==='observed-default',captureCommands:0,originalCapture:null,originalCaptureError:null,originalSettled:false,libraryCommandsWhileCapturePending:[]};
  const emit=(event,data={})=>console.log(JSON.stringify({case:name,event,ms:performance.now()-began,epochMs:Date.now(),...data}));
  let stdout='',browser,page,pending=false,ipcSequence=0;
  const requests=new Map();
  helper.on('message',message=>{
    if(!message||message.namespace!=='svg-frame-scheduling-v1'||message.nonce!==nonce)return;
    const request=requests.get(message.id);if(!request)return;
    clearTimeout(request.timer);requests.delete(message.id);
    emit('ipc-ack',{id:message.id,command:request.command,success:!message.error,...(message.error?{error:message.error}:{result:message.result})});
    if(message.error)request.reject(Error(message.error));else request.resolve(message.result);
  });
  function native(command){
    if(command==='post-settlement')assert.equal(result.originalSettled,true);
    else assert.equal(pending,true,'never send unfired intervention after settlement');
    const id='request-'+(++ipcSequence);emit('ipc-send',{id,command,originalPending:pending});
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{requests.delete(id);emit('ipc-ack-timeout',{id,command});reject(Error('ownedIPC '+command+' ACKdeadline1500ms; action may already have applied'));},1500);
      requests.set(id,{resolve,reject,timer,command});
      try{helper.send({namespace:'svg-frame-scheduling-v1',nonce,id,command,...(command==='post-settlement'?{originalSettled:true}:{})},error=>{if(!error||!requests.has(id))return;clearTimeout(timer);requests.delete(id);reject(error);})}catch(error){clearTimeout(timer);requests.delete(id);reject(error)}
    });
  }
  const controls=name==='observed-default'?createPendingControls({request:native,emit,clock:()=>performance.now()-began}):null;
  if(controls)result.controls=controls.state;
  helper.stdout.on('data',chunk=>{stdout=(stdout+chunk).slice(-16000);fs.appendFileSync(path.join(home,'helper.stdout.log'),chunk)});
  helper.stderr.on('data',chunk=>fs.appendFileSync(path.join(home,'helper.stderr.log'),chunk));
  try{
    const port=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('helper handshake deadline15000ms')),15000);
      helper.once('error',error=>{clearTimeout(timer);reject(error)});
      helper.once('exit',code=>{clearTimeout(timer);reject(Error('helper exited before handshake '+code))});
      helper.stdout.on('data',()=>{const match=stdout.match(/^BROWSER_SERVICE_CDP (\d+)\r?$/m);if(match){clearTimeout(timer);resolve(Number(match[1]))}});
    });
    const info=await(await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(5000)})).json();
    const connectOptions={browserWSEndpoint:info.webSocketDebuggerUrl,defaultViewport:null};
    if(name==='warmup-10s')connectOptions.protocolTimeout=10000;
    assert.equal(Object.hasOwn(connectOptions,'protocolTimeout'),name==='warmup-10s');
    browser=await puppeteer.connect(connectOptions); // shipping case REALLY omits protocolTimeout
    page=(await browser.pages()).find(candidate=>candidate.target().type()==='page');assert.ok(page);
    const client=page._client(),send=client.send.bind(client);
    result.effectiveProtocolTimeoutMs=client.connection().timeout; // local getter only; no CDP request
    assert.equal(result.effectiveProtocolTimeoutMs,name==='warmup-10s'?10000:180000);
    result.requestListenerBaseline=page.listenerCount('request');
    emit('connected',{browser:info.Browser,protocolTimeoutOptionOmitted:result.protocolTimeoutOptionOmitted,effectiveProtocolTimeoutMs:result.effectiveProtocolTimeoutMs,requestListenerBaseline:result.requestListenerBaseline});
    const observations=[];page.on('console',message=>{if(message.type()==='log')observations.push(message.text())});
    client.send=async(method,...params)=>{
      if(method!=='Page.captureScreenshot'){
        // PASSIVE accounting only: forward ordinary library traffic unchanged.
        // NO added CDP commands/queries; ONLY the declared owned-IPC controls.
        if(pending&&result.libraryCommandsWhileCapturePending.length<16){result.libraryCommandsWhileCapturePending.push(method);emit('library-command-while-pending',{method});}
        return send(method,...params);
      }
      assert.equal(++result.captureCommands,1,'one original screenshot only; no retry');
      assert.deepEqual(observations,['SVG_FILE_READ=false']);
      const listeners=page.listenerCount('request');assert.ok(listeners>result.requestListenerBaseline);
      const start=performance.now();pending=true;
      emit('original-capture-start',{method,params:params[0],requestListeners:listeners,effectiveProtocolTimeoutMs:result.effectiveProtocolTimeoutMs,observations:[...observations]});
      try{
        const original=send(method,...params); // ONE ACTUAL unchanged CDP dispatch
        controls?.start(); // only ownedIPC sham/ONE setting, NOT screenshot retries
        const response=await original;
        result.originalCaptureDurationMs=Math.round(performance.now()-start);
        emit('original-capture-settled',{success:true,duration:result.originalCaptureDurationMs});
        return response;
      }catch(error){
        result.originalCaptureDurationMs=Math.round(performance.now()-start);result.originalCaptureError=String(error);
        emit('original-capture-settled',{success:false,duration:result.originalCaptureDurationMs,error:String(error)});
        throw error; // source finally owns guarded retirement
      }finally{pending=false;result.originalSettled=true;result.originalSettledAtMs=performance.now()-began;controls?.stop();}
    };
    assert.equal((await runDemoOnPage(page,'<p>owned prior document</p>',{settleMs:20})).ok,true);
    const canary=path.join(home,'canary.txt');fs.writeFileSync(canary,'lh-first-capture-canary');
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40" data-frame-probe="${nonce}"><rect width="80" height="40" fill="red"/><script>let read=false;try{const x=new XMLHttpRequest();x.open('GET',${JSON.stringify(pathToFileURL(canary).href)},false);x.send();read=x.responseText.includes('lh-first-capture-canary')}catch{}console.log('SVG_FILE_READ='+read)</script></svg>`;
    const png=await renderSvgOnPage(page,svg);
    assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16),80);assert.equal(png.readUInt32BE(20),40);
    fs.writeFileSync(path.join(home,'original-capture.png'),png);
    result.originalCapture={bytes:png.length,width:80,height:40};
    result.classification=name==='warmup-10s'?'warmup-captured':'pending-postmeasurement-classification';
    emit('source-returned',{capture:result.originalCapture,classification:result.classification});
  }catch(error){
    result.outerError=String(error);
    result.classification=result.originalCaptureError?(name==='warmup-10s'?'warmup-original-failed':'shipping-default-original-failed'):'bootstrap-or-source-operation-failed';
    emit('source-rejected',{error:String(error),classification:result.classification});
  }finally{
    controls?.stop();await controls?.drain();
    if(controls&&result.originalSettled){try{result.postSettlement=await native('post-settlement');assert.equal(result.postSettlement.isVisible,false,'owned helper unexpectedly visible');emit('post-settlement-visibility',result.postSettlement)}catch(error){result.postSettlement={error:String(error)};emit('post-settlement-error',result.postSettlement)}}
    if(page){result.retirement={url:page.url(),requestListeners:page.listenerCount('request'),requestListenerBaseline:result.requestListenerBaseline};result.retirement.normal=result.retirement.url==='about:blank'&&result.retirement.requestListeners===result.requestListenerBaseline;emit('after-source-finally',result.retirement);}
    browser?.disconnect();
    try{result.cleanup=await stopBrowserService(helper);Object.assign(result.cleanup,{actualChildExitCode:helper.exitCode,actualChildSignal:helper.signalCode,notResident:helper.exitCode!==null||helper.signalCode!==null});emit('cleanup',result.cleanup)}
    catch(error){result.cleanup={error:String(error)};emit('cleanup-error',result.cleanup)}
    if(controls){
      const state=controls.state;
      if(state.inconclusive)result.mechanismClassification='inconclusive-control-or-ACK-failure';
      else if(!state.sham.sent)result.mechanismClassification=result.originalCapture?'fast-nonreproducing-no-intervention':'original-failure-before-controls';
      else if(!state.transition.sent)result.mechanismClassification=result.originalCapture?'sham-only-or-pretransition-recovery-NOT-throttling-proof':'no-transition-no-validated-mechanism';
      else if(result.originalCapture&&state.transition.applied&&state.transition.ackDuringOriginalPending)result.mechanismClassification='same-original-recovered-after-transition-SUPPORTS-candidate-NOT-validated-fix';
      else if(result.originalCapture)result.mechanismClassification='recovered-but-transition-timing-or-application-unresolved';
      else result.mechanismClassification='original-not-recovered-NOT-proof-constructor-prevention-impossible';
      const eventsFile=path.join(home,'native-events.ndjson');
      if(fs.existsSync(eventsFile)){
        const events=fs.readFileSync(eventsFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
        result.nativeShowHideEvents=events.filter(event=>['window:show','window:hide'].includes(event.event));
        result.transitionActuallyLogged=events.some(event=>event.event==='transition-applied'&&event.transitionApplied===true);
      }
      if(result.libraryCommandsWhileCapturePending.length||result.nativeShowHideEvents?.some(event=>event.event==='window:show')||result.postSettlement?.error||result.postSettlement?.isVisible!==false)result.mechanismClassification='inconclusive-additional-traffic-or-visibility-validation';
      emit('mechanism-classification',{classification:result.mechanismClassification,transitionActuallyLogged:result.transitionActuallyLogged});
    }
    fs.writeFileSync(path.join(home,'result.json'),JSON.stringify(result,null,2)+'\n');results.push(result);
  }
}
fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify({metadata,results},null,2)+'\n');
console.log(JSON.stringify({event:'diagnosis-complete-not-a-release-gate',output,helpers:results.length}));
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fs.realpathSync(fileURLToPath(import.meta.url))){await main();}
