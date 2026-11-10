// q28: ONE source helper; actual public API, no retry/force flag/manual page.
// Plain Node26: --checkout <a917 tree> --runtime <installed Electron> --out <NEW dir>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {createRequire,registerHooks,syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const opts=new Map(),args=process.argv.slice(2);
for(let i=0;i<args.length;i+=2){assert.ok(['--checkout','--runtime','--out'].includes(args[i])&&args[i+1]&&!opts.has(args[i]));opts.set(args[i],args[i+1]);}
assert.equal(opts.size,3);assert.equal(process.versions.electron,undefined,'plain Node, NOT bare Electron RUN_AS_NODE');
const root=fs.realpathSync(opts.get('--checkout')),runtime=fs.realpathSync(opts.get('--runtime')),out=path.resolve(opts.get('--out'));
assert.ok(!fs.existsSync(out),'NEW output directory required');fs.mkdirSync(out);fs.mkdirSync(path.join(out,'tmp'));
const {probeEnv,stopBrowserService}=await import(pathToFileURL(path.join(root,'scripts/smoke-demo-runtime.mjs')).href);
const safe=probeEnv(process.env,out);
for(const key of Object.keys(safe))if(/^PI_/.test(key)||(/^LH_/.test(key)&&!['LH_DATA_DIR','LH_AUTH_FILE','LH_IGNORE_ENV_KEYS'].includes(key))||key==='NODE_PATH')delete safe[key];
for(const key of Object.keys(process.env))delete process.env[key];
Object.assign(process.env,safe,{TMPDIR:path.join(out,'tmp'),TMP:path.join(out,'tmp'),TEMP:path.join(out,'tmp')});
fs.mkdirSync(process.env.LH_DATA_DIR);fs.writeFileSync(process.env.LH_AUTH_FILE,'{}\n',{mode:0o600});
const sha=data=>createHash('sha256').update(data).digest('hex'),pins={};
for(const [file,pin]of Object.entries({'src/agent/subagents/headless.ts':'5d4c01d4fb1ced0694a6b131559c3dc5803c72ccd00f673b4dc6cce78aa76c4b','electron/main.cjs':'ccc34cdda5e70e72d07f601aa5ee4c16ec937767895797a01df5d19c13223857'})){
  const bytes=fs.readFileSync(path.join(root,file)),lf=bytes.toString('utf8').replace(/\r\n/g,'\n');assert.equal(sha(lf),pin);pins[file]={raw:sha(bytes),normalizedLF:sha(lf)};
}
const require=createRequire(path.join(root,'package.json'));
assert.equal(require('electron/package.json').version,'44.9.3');assert.equal(require('puppeteer-core/package.json').version,'25.8.0');
assert.equal(runtime,fs.realpathSync(path.join(root,'node_modules/electron/dist',fs.readFileSync(path.join(root,'node_modules/electron/path.txt'),'utf8').trim())));
const puppetURL=pathToFileURL(require.resolve('puppeteer-core')).href;
const puppeteer=(await import(puppetURL)).default;
assert.equal(require('puppeteer-core').default,puppeteer,'ESM/require SAME live instance');
// Global installed-tsx registration (no per-import namespace). Import production
// definitions BEFORE spawn recording; any existing esbuild compiler is NOT a browser.
const unregister=(await import(pathToFileURL(require.resolve('tsx/esm/api')).href)).register();
const {realHeadless,browserServiceBinary}=await import(pathToFileURL(path.join(root,'src/agent/subagents/headless.ts')).href);
assert.equal(fs.realpathSync(browserServiceBinary()),runtime);
const metadata={purpose:'q28 PUBLIC-PRODUCTION-ENTRY-POINT test, NOT fix validation',root,runtime,out,node:process.versions.node,packageVersion:require('./package.json').version,pins,driverSHA256:sha(fs.readFileSync(fileURLToPath(import.meta.url))),maxSourceHelpers:1,noWarmup:true,noRetry:true,protocolTimeoutOptionOmitted:true,puppeteerDefaultBudgetMs:180000};
const result={errors:[],spawns:[],connections:[],forbiddenLaunches:0,resolutionChecks:0};
const started=performance.now(),emit=(event,data={})=>console.log(JSON.stringify({event,ms:performance.now()-started,epochMs:Date.now(),...data}));
const fail=(stage,error)=>{result.errors.push({stage,error:String(error)});emit('FAIL',{stage,error:String(error)});};
const originalSpawn=childProcess.spawn,originalLaunch=puppeteer.launch,originalConnect=puppeteer.connect,browsers=[];
let helper;
// Only observe/forward the exact normal production spawn; never change args/env.
childProcess.spawn=function(...params){
  assert.equal(result.spawns.length,0,'NO second helper/Chrome/other process');
  assert.equal(fs.realpathSync(params[0]),runtime);assert.deepEqual(params[1],[root,'--browser-service']);
  assert.deepEqual(params[2].stdio,['ignore','pipe','pipe','ipc']);
  helper=Reflect.apply(originalSpawn,this,params);result.spawns.push({pid:helper.pid,binary:params[0],args:params[1]});
  helper.stdout.on('data',bytes=>fs.appendFileSync(path.join(out,'helper.stdout.log'),bytes));
  helper.stderr.on('data',bytes=>fs.appendFileSync(path.join(out,'helper.stderr.log'),bytes));
  helper.once('error',error=>fail('child-process',error));emit('normal-source-helper-spawn',result.spawns[0]);return helper;
};syncBuiltinESMExports();
puppeteer.launch=function(){result.forbiddenLaunches++;throw Error('test forbids system-Chrome fallback');};
puppeteer.connect=async function(options){
  assert.equal(Object.hasOwn(options,'protocolTimeout'),false,'NO CDP budget override');
  const url=new URL(options.browserWSEndpoint);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
  result.connections.push(options.browserWSEndpoint);emit('real-connect',{endpoint:options.browserWSEndpoint,protocolTimeoutOptionOmitted:true});
  const browser=await Reflect.apply(originalConnect,this,[options]);browsers.push(browser);return browser;
};
// Fail closed if headless resolves a second/namespaced puppeteer instance.
const resolutionGuard=registerHooks({resolve(specifier,context,next){const resolved=next(specifier,context);if(specifier==='puppeteer-core'){assert.equal(resolved.url,puppetURL);result.resolutionChecks++;}return resolved;}});
const control='<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="red"/></svg>';
const svg=control.replace(' xmlns="http://www.w3.org/2000/svg"','');
emit('metadata',metadata);
try{
  await assert.rejects(realHeadless.renderSvg(svg,{nativeOnly:true}),/document does not have a root node/);
  assert.equal(result.spawns.length,0);result.nativeOnlyRejectedWithoutHelper=true;emit('nativeOnly-rejected-without-helper');
  const before=performance.now();
  try{
    const png=await realHeadless.renderSvg(svg);result.renderDurationMs=performance.now()-before;result.rawPNGBytes=png.length;
    fs.writeFileSync(path.join(out,'actual-public-result.png'),png);
    assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(png.readUInt32BE(16),80);assert.equal(png.readUInt32BE(20),40);
    // Existing application Photon WASM decoder, NOT a custom PNG decoder or
    // rerender/substitution. Mac display-profile PNGs need not encode255,0,0.
    const decoded=require('@silvia-odwyer/photon-node').PhotonImage.new_from_byteslice(png);
    try{
      const pixels=decoded.get_raw_pixels(),rgba=Array.from(pixels.subarray(0,4));assert.equal(pixels.length,80*40*4);
      const [r,g,b,a]=rgba;assert.ok(r>=200&&g<=100&&b<=100&&r-g>=100&&r-b>=100&&a===255,'solid strongly-red opaque output, not white/blank/other primary');
      for(let i=0;i<pixels.length;i++)assert.equal(pixels[i],rgba[i%4],`nonuniform actual PNG channel ${i}`);
      result.render={width:80,height:40,uniformOpaqueRed:true,decodedRGBA:rgba,colorCriterion:'R>=200,G/B<=100,R-G/B>=100,A255; all3200pixels identical; allows device/profile encoding, NOT colorimetric equivalence'};
    }finally{decoded.free();}
    assert.ok(result.connections.length>0);emit('public-SVG-PASS',{durationMs:result.renderDurationMs,...result.render});
  }catch(error){result.renderDurationMs=performance.now()-before;fail('public-renderSvg',error);}
  if(helper&&helper.exitCode===null&&helper.signalCode===null&&!helper.killed){
    const canary=path.join(out,'owned-canary.txt');fs.writeFileSync(canary,'q28-owned-file-canary');
    const html=`<script>window.q28Guard={attempted:false,read:null,origin:location.origin};try{q28Guard.attempted=true;const x=new XMLHttpRequest();x.open('GET',${JSON.stringify(pathToFileURL(canary).href)},false);x.send();q28Guard.read=x.responseText.includes('q28-owned-file-canary')}catch{q28Guard.read=false}</script>`;
    try{
      result.security=await realHeadless.runDemo(html,{settleMs:20,probe:'window.q28Guard'});
      // Blocked-file diagnostics may make ok=false; do not pretend those mean
      // the ACTIVE canary did not run. Assert its actual returned probe instead.
      assert.deepEqual(result.security.probeResult,{attempted:true,read:false,origin:'null'});emit('active-file-guard-PASS',result.security);
    }catch(error){fail('public-active-file-guard',error);}
    try{
      result.cleanNext=await realHeadless.runDemo('<p>owned clean next job</p>',{settleMs:20,probe:'({prior:typeof window.q28Guard,origin:location.origin})'});
      assert.equal(result.cleanNext.ok,true);assert.deepEqual(result.cleanNext.probeResult,{prior:'undefined',origin:'null'});emit('clean-next-job-PASS',result.cleanNext);
    }catch(error){fail('public-next-job-clean-state',error);}
  }else{fail('security/clean-next-skipped','normal helper not alive; NO replacement helper allowed');}
  assert.equal(result.spawns.length,1);assert.equal(result.forbiddenLaunches,0);assert.ok(result.connections.length>=1);
  assert.equal(new Set(result.connections).size,1,'all actual connections reuse same owned helper endpoint');
}catch(error){fail('precondition-or-invariants',error);}
finally{
  for(const browser of browsers)browser.disconnect();
  if(helper){try{result.cleanup=await stopBrowserService(helper);Object.assign(result.cleanup,{actualExitCode:helper.exitCode,actualSignal:helper.signalCode,notResident:helper.exitCode!==null||helper.signalCode!==null});assert.equal(result.cleanup.requested,true);assert.equal(helper.exitCode,0);assert.equal(helper.signalCode,null);assert.equal(result.cleanup.notResident,true);emit('real-child-cleanup-PASS',result.cleanup);}catch(error){fail('real-child-cleanup',error);}}
  resolutionGuard.deregister();childProcess.spawn=originalSpawn;syncBuiltinESMExports();puppeteer.launch=originalLaunch;puppeteer.connect=originalConnect;await unregister();
}
result.passed=result.errors.length===0;fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify({metadata,result},null,2)+'\n');
emit('public-entrypoint-test-complete',{passed:result.passed,out});process.exitCode=result.passed?0:1;
