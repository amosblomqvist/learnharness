// SCRATCH MEASUREMENT, NOT A FIX OR RELEASE GATE. Exactly two source helpers.
// node native-readback.mjs --checkout <a917 source> --runtime <installed Electron>
// [--observer <native-observer.cjs>] [--out <NEW directory>]
// --harness-only-force-controls is LOCAL BRANCH-COVERAGE ONLY, never reproduction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const args = process.argv.slice(2);
const arg = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const root = fs.realpathSync(arg('--checkout', process.cwd()));
const runtime = path.resolve(arg('--runtime', 'MISSING-RUNTIME'));
const observer = fs.realpathSync(arg('--observer', fileURLToPath(new URL('./native-observer.cjs', import.meta.url))));
assert.ok(fs.existsSync(runtime), 'materialize locked Electron outside this script before invocation');
const forced = args.includes('--harness-only-force-controls');
const explicitOut = arg('--out', null);
let output;
if (explicitOut) { output = path.resolve(explicitOut); assert.ok(!fs.existsSync(output), 'never overwrite evidence'); fs.mkdirSync(output); }
else output = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-native-readback-'));
// Scrub this disposable Node process BEFORE importing app source. Never changes Pi's environment.
for (const key of Object.keys(process.env)) {
  if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) || /^(AWS_|GOOGLE_|GCLOUD_|CLOUDSDK_|AZURE_|ANTHROPIC_|OPENAI_|OPENROUTER_|GEMINI_|LH_|PI_)/.test(key) || ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key)) delete process.env[key];
}
const parentHome = path.join(output, 'parent'); fs.mkdirSync(parentHome);
fs.mkdirSync(path.join(parentHome, 'tmp')); fs.mkdirSync(path.join(parentHome, 'data'));
fs.writeFileSync(path.join(parentHome, 'auth.json'), '{}\n', { mode: 0o600 });
Object.assign(process.env, { HOME: parentHome, USERPROFILE: parentHome, APPDATA: path.join(parentHome, 'config'), LOCALAPPDATA: path.join(parentHome, 'local'), XDG_CONFIG_HOME: path.join(parentHome, 'config'), XDG_CACHE_HOME: path.join(parentHome, 'cache'), TMPDIR: path.join(parentHome, 'tmp'), TEMP: path.join(parentHome, 'tmp'), TMP: path.join(parentHome, 'tmp'), LH_DATA_DIR: path.join(parentHome, 'data'), LH_AUTH_FILE: path.join(parentHome, 'auth.json'), LH_IGNORE_ENV_KEYS: '1', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' });
const require = createRequire(path.join(root, 'package.json'));
const readPackage = name => JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json')));
assert.equal(readPackage('electron').version, '44.9.3');
assert.equal(readPackage('puppeteer-core').version, '25.8.0');
const headlessFile = path.join(root, 'src/agent/subagents/headless.ts');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = file => digest(fs.readFileSync(file));
const headlessBytes = fs.readFileSync(headlessFile);
const headlessLF = Buffer.from(headlessBytes.toString('utf8').replace(/\r\n/g,'\n'));
assert.ok(headlessBytes.equals(headlessLF) || headlessBytes.equals(Buffer.from(headlessLF.toString('utf8').replace(/\n/g,'\r\n'))), 'only uniform LF or Windows CRLF checkout conversion is accepted');
assert.equal(digest(headlessLF), '5d4c01d4fb1ced0694a6b131559c3dc5803c72ccd00f673b4dc6cce78aa76c4b');
const { default: puppeteer } = await import(pathToFileURL(require.resolve('puppeteer-core')).href);
const { tsImport } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
const { runDemoOnPage, renderSvgOnPage } = await tsImport(pathToFileURL(headlessFile).href, import.meta.url);
const { probeEnv, stopBrowserService } = await import(pathToFileURL(path.join(root, 'scripts/smoke-demo-runtime.mjs')).href);
const metadata = { purpose: 'bounded native readback diagnostic, NEVER a release gate', root, runtime, observer, output, harnessOnlyForcedControls: forced, node: process.versions.node, sourcePackageVersion: JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version, headlessRawSHA256: sha(headlessFile), headlessNormalizedLFSHA256: digest(headlessLF), realMainRawSHA256: sha(path.join(root,'electron/main.cjs')), realMainNormalizedLFSHA256: digest(fs.readFileSync(path.join(root,'electron/main.cjs'),'utf8').replace(/\r\n/g,'\n')), observerSHA256: sha(observer), driverSHA256: sha(fileURLToPath(import.meta.url)), screenshotDeadlineMs: 10000, nativeIPCDeadlineMs: 1500, maximumHelpers: 2 };
fs.writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
console.log(JSON.stringify({ event: 'diagnosis-only', ...metadata }));
const results = [];
for (const name of ['warmup-unwrapped', 'observed']) {
  const home = path.join(output, name); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'auth.json'), '{}\n', { mode: 0o600 });
  const nonce = randomBytes(16).toString('hex');
  const env = { ...probeEnv(process.env, home), TMPDIR: path.join(home,'tmp'), TEMP: path.join(home,'tmp'), TMP: path.join(home,'tmp') };
  fs.mkdirSync(env.TMPDIR); delete env.ELECTRON_RUN_AS_NODE;
  if (name === 'observed') Object.assign(env, { SVG_DIAG_HOME: home, SVG_DIAG_SOURCE_MAIN: path.join(root,'electron/main.cjs'), SVG_DIAG_NONCE: nonce });
  const helper = spawn(runtime, [name === 'observed' ? observer : root, '--browser-service', `--user-data-dir=${path.join(home,'profile')}`, '--disable-background-networking', '--disable-component-update', '--no-proxy-server', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { cwd: home, env, stdio: ['ignore','pipe','pipe','ipc'] });
  const start = performance.now();
  const result = { case: name, helperPid: helper.pid, harnessOnlyForcedControls: forced, initialScreenshotFailed: false, controlRetry: null, nativeCapture: null, postNativeRetry: null, cleanup: null };
  const emit = (event, data = {}) => console.log(JSON.stringify({ case: name, event, ms: Math.round(performance.now()-start), harnessOnlyForcedControls: forced, ...data }));
  let stdout = '', stderr = '', browser, page, controlStarted = false, ipcSequence = 0;
  const pending = new Map();
  helper.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-16000); fs.appendFileSync(path.join(home,'helper.stdout.log'), chunk); });
  helper.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); fs.appendFileSync(path.join(home,'helper.stderr.log'), chunk); });
  helper.on('message', message => {
    if (!message || message.namespace !== 'svg-native-readback') return;
    const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(Error(message.error)); else request.resolve(message.result);
  });
  function native(command) {
    return new Promise((resolve,reject) => {
      const id = String(++ipcSequence);
      const timer = setTimeout(() => { pending.delete(id); reject(Error('native IPC '+command+' deadline1500ms; native operation may still be pending')); },1500);
      pending.set(id,{resolve,reject,timer});
      helper.send({namespace:'svg-native-readback',id,command}, error => {
        if (!error || !pending.has(id)) return;
        clearTimeout(timer); pending.delete(id); reject(error);
      });
    });
  }
  function savePng(buffer, filename) {
    const png = Buffer.from(buffer);
    assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    fs.writeFileSync(path.join(home,filename), png);
    return { bytes: png.length, width: png.readUInt32BE(16), height: png.readUInt32BE(20), file: filename };
  }
  const guard = phase => {
    const listeners = page.listenerCount('request');
    emit('guard-held',{phase,requestListeners:listeners,requestListenerBaseline:result.requestListenerBaseline,url:page.url()});
    assert.ok(listeners > result.requestListenerBaseline, 'production request guard must remain installed above Puppeteer baseline through controls');
    assert.equal(page.url(),'about:blank');
  };
  try {
    const port = await new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(Error('helper handshake deadline15000ms')),15000);
      helper.once('error',error => {clearTimeout(timer);reject(error)});
      helper.once('exit',code => {clearTimeout(timer);reject(Error('helper exited before handshake '+code))});
      helper.stdout.on('data',() => {const match=stdout.match(/^BROWSER_SERVICE_CDP (\d+)\r?$/m);if(match){clearTimeout(timer);resolve(Number(match[1]))}});
    });
    const version = await(await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(5000)})).json();
    browser = await puppeteer.connect({browserWSEndpoint:version.webSocketDebuggerUrl,defaultViewport:null,protocolTimeout:10000});
    page = (await browser.pages()).find(p=>p.target().type()==='page'); assert.ok(page);
    result.requestListenerBaseline=page.listenerCount('request');
    emit('connected',{browser:version.Browser,observedEntry:name==='observed',requestListenerBaseline:result.requestListenerBaseline});
    const client = page._client(), rawSend = client.send.bind(client);
    const observations = []; page.on('console', message => {if(message.type()==='log')observations.push(message.text())});
    const retry = async (phase, method, params, synthetic = false) => {
      guard(phase);
      const began = performance.now(); emit('identical-raw-retry-start',{phase,method,params,synthetic,deadlineMs:10000});
      try {
        if (synthetic) throw Error('HARNESS-ONLY forced untreated retry failure; CDP command NOT dispatched');
        // Original bound send bypasses both our hook and Puppeteer's held screenshot mutex.
        const response = await rawSend(method,params,{timeout:10000});
        const capture = savePng(Buffer.from(response.data,'base64'),phase+'.png');
        emit('identical-raw-retry-result',{phase,duration:Math.round(performance.now()-began),capture});
        return {success:true,duration:Math.round(performance.now()-began),capture};
      } catch(error) {
        emit('identical-raw-retry-error',{phase,duration:Math.round(performance.now()-began),error:String(error),synthetic});
        return {success:false,duration:Math.round(performance.now()-began),error:String(error),synthetic};
      }
    };
    client.send = async (method, ...params) => {
      if (method !== 'Page.captureScreenshot') return rawSend(method,...params);
      const began = performance.now();
      emit('original-capture-start',{method,params:params[0],observations:[...observations],synthetic:forced&&name==='observed'});
      try {
        if (forced && name==='observed') throw Error('HARNESS-ONLY forced original capture failure; CDP command NOT dispatched');
        const response = await rawSend(method,...params);
        emit('original-capture-result',{duration:Math.round(performance.now()-began)});
        return response;
      } catch(originalError) {
        result.initialScreenshotFailed = true;
        result.originalError = String(originalError);
        emit('original-capture-error',{duration:Math.round(performance.now()-began),error:String(originalError),observations:[...observations],synthetic:forced&&name==='observed'});
        if (name==='observed' && !controlStarted) {
          controlStarted = true;
          try {
            assert.deepEqual(observations,['SVG_FILE_READ=false'],'owned SVG file canary must remain unreadable');
            guard('native-state');
            try { result.nativeState=await native('state'); emit('native-state',{result:result.nativeState}); }
            catch(error) { result.nativeState={error:String(error)}; emit('native-state-error',result.nativeState); }
            result.controlRetry = await retry('untreated-retry',method,params[0],forced);
            if (!result.controlRetry.success) {
              guard('native-capture'); emit('native-capture-request',{stayHidden:true,stayAwake:false,deadlineMs:1500});
              try { result.nativeCapture=await native('capture'); emit('native-capture-result',{result:result.nativeCapture}); }
              catch(error) {
                result.nativeCapture={error:String(error)}; emit('native-capture-error',result.nativeCapture);
                if(String(error).includes('unexpectedly showed window'))throw error;
              }
              result.postNativeRetry = await retry('post-native-retry',method,params[0]);
            } else emit('native-intervention-skipped',{reason:'unchanged retry recovered; no native capture requested'});
          } catch(error) { result.instrumentationError=String(error); emit('instrumentation-error',{error:String(error)}); }
        }
        // NEVER turn a recovered control into a production success. Source finally
        // now performs its normal guarded retirement and interception teardown.
        throw originalError;
      }
    };
    assert.equal((await runDemoOnPage(page,'<p>owned prior document</p>',{settleMs:20})).ok,true);
    const canary=path.join(home,'canary.txt');fs.writeFileSync(canary,'lh-native-canary');
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40" data-native-probe="${nonce}"><rect width="80" height="40" fill="red"/><script>let read=false;try{const x=new XMLHttpRequest();x.open('GET',${JSON.stringify(pathToFileURL(canary).href)},false);x.send();read=x.responseText.includes('lh-native-canary')}catch{}console.log('SVG_FILE_READ='+read)</script></svg>`;
    const png=await renderSvgOnPage(page,svg);
    result.originalCapture=savePng(png,'original-capture.png');
    assert.deepEqual(observations,['SVG_FILE_READ=false']);
    emit('source-returned',{capture:result.originalCapture,observations});
    if(name==='observed')emit('inconclusive-no-original-failure',{reason:'no intervention performed'});
  } catch(error) {
    result.outerError=String(error);
    emit('source-rejected-original-result-preserved',{error:String(error),originalCaptureFailed:result.initialScreenshotFailed});
  } finally {
    if(page){
      result.retirement={url:page.url(),requestListeners:page.listenerCount('request')};
      result.retirement.requestListenerBaseline=result.requestListenerBaseline;
      result.retirement.normal=result.retirement.url==='about:blank'&&result.retirement.requestListeners===result.requestListenerBaseline;
      emit('after-source-finally',result.retirement);
    }
    browser?.disconnect();
    try {
      result.cleanup=await stopBrowserService(helper);
      result.cleanup.actualChildExitCode=helper.exitCode;
      result.cleanup.actualChildSignal=helper.signalCode;
      result.cleanup.notResident=helper.exitCode!==null||helper.signalCode!==null;
      emit('cleanup',result.cleanup);
    }
    catch(error) { result.cleanup={error:String(error)};emit('cleanup-error',result.cleanup); }
    for(const request of pending.values()){clearTimeout(request.timer);request.reject(Error('owned helper cleanup'))}pending.clear();
    fs.writeFileSync(path.join(home,'result.json'),JSON.stringify(result,null,2)+'\n');
    results.push(result);
  }
}
fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify({metadata,results},null,2)+'\n');
console.log(JSON.stringify({event:'diagnosis-complete-not-a-release-gate',output,harnessOnlyForcedControls:forced,helpers:results.length}));
