import { subscribe } from "../src/core/events.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { SpeechService, speechAuthorized } from "../src/server/speech.ts";
import { sanitizeSpeechSettings, SPEECH_DEFAULTS } from "../src/core/speech.ts";
import { parseSpeechSettingsBody } from "../src/server/settings-body.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { wav } from "../src/server/speech-worker.ts";

test("speech desktop authorization refuses browser and unverified development",()=>{
 const token="a".repeat(64); const headers=new Headers({"x-learnharness-desktop":token});
 assert.equal(speechAuthorized(headers,{}),false);
 assert.equal(speechAuthorized(headers,{LH_DESKTOP_API_SECRET:token}),false);
 assert.equal(speechAuthorized(new Headers(),{LH_DESKTOP_SERVER:"1",LH_DESKTOP_API_SECRET:token}),false);
 assert.equal(speechAuthorized(headers,{LH_DESKTOP_SERVER:"1",LH_DESKTOP_API_SECRET:token}),true);
});
test("speech defaults are opt-in and settings keep forward-compatible fields",()=>{
 assert.deepEqual(SPEECH_DEFAULTS,{automaticReading:false,playbackRate:1});
 assert.deepEqual(sanitizeSpeechSettings({playbackRate:99,automaticReading:true,future:3}),{playbackRate:2,automaticReading:true,future:3});
 assert.deepEqual(sanitizeUserSettings({version:1,speech:{engine:"invalid",future:true},future:"keep"})?.speech,{future:true});
 assert.equal(sanitizeUserSettings({version:1,speech:{},future:"keep"})?.future,"keep");
 assert.equal(parseSpeechSettingsBody({playbackRate:0.5}).ok,false);
 assert.equal(parseSpeechSettingsBody({voice:"../../private"}).ok,false);
 assert.deepEqual(parseSpeechSettingsBody({automaticReading:true,playbackRate:1.25}),{ok:true,settings:{automaticReading:true,playbackRate:1.25}});
});
test("unsupported runtimes and arbitrary catalog IDs cannot activate speech",async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),"lh-speech-test-"));
 try {
  const service=new SpeechService(directory);
  const status=await service.status();assert.equal(status.voices.find(v=>v.id==="en_US-ljspeech-high")!.state,"unavailable");
  await assert.rejects(service.install("../../elsewhere"),/Unknown speech voice/);
  await assert.rejects(service.install("en_US-ljspeech-high"),/runtime is unavailable/);
  await assert.rejects(service.synthesize("en_US-ljspeech-high","hello"),/Install/);
 } finally {await rm(directory,{recursive:true,force:true});}
});
test("WAV encoding declares mono signed PCM with exact byte lengths",()=>{
 const result=wav(Buffer.from([0,0,255,127]),22050);
 assert.equal(result.toString("ascii",0,4),"RIFF");assert.equal(result.readUInt32LE(4),40);
 assert.equal(result.readUInt32LE(24),22050);assert.equal(result.readUInt16LE(34),16);
 assert.equal(result.readUInt32LE(40),4);assert.equal(result.length,48);
});

async function installationFixture() {
 const directory=await mkdtemp(path.join(os.tmpdir(),"lh-speech-install-"));
 const resources=path.join(directory,"runtime"); await mkdir(resources);
 await writeFile(path.join(resources,process.platform === "win32" ? "piper-helper.exe" : "piper-helper"),"");
 const data=Buffer.from("verified voice fixture");
 const files=[{name:"fixture.bin",bytes:data.length,sha256:createHash("sha256").update(data).digest("hex")}];
 return {directory,resources,data,files};
}
async function settle(service: SpeechService) {
 for(let count=0;count<200;count++) {const status=await service.status();if(!status.operation || status.operation.state==="failed")return status;await new Promise(resolve=>setTimeout(resolve,5));}
 throw new Error("Installation failed to settle");
}
test("installation serializes admission, verifies files, self-tests and activates atomically",async()=>{
 const f=await installationFixture();let release!:()=>void;
 const wait=new Promise<void>(resolve=>{release=resolve;});let tested=false;
 const service=new SpeechService(path.join(f.directory,"voices"),f.resources,async()=>{await wait;return new Response(f.data);},{files:f.files,selfTest:async()=>{tested=true;}});
 try {
 const first=service.install("en_US-ljspeech-high");
 await assert.rejects(service.install("en_US-ljspeech-high"),/already running/);
 await assert.rejects(service.remove("en_US-ljspeech-high"),/already running/);
 await first;release();const status=await settle(service);assert.equal(status.voices.find(v=>v.id==="en_US-ljspeech-high")!.state,"ready");assert.equal(tested,true);
 assert.deepEqual(await readFile(path.join(f.directory,"voices","en_US-ljspeech-high","fixture.bin")),f.data);
 await service.remove("en_US-ljspeech-high");assert.equal((await service.status()).voices.find(v=>v.id==="en_US-ljspeech-high")!.state,"not-installed");
 }finally{release();service.shutdown();await rm(f.directory,{recursive:true,force:true});}
});
test("checksum failures never activate and verified staging files survive restart",async()=>{
 const f=await installationFixture();const root=path.join(f.directory,"voices");let downloads=0;
 try {
 const broken=new SpeechService(root,f.resources,async()=>new Response(Buffer.alloc(f.data.length)),{files:f.files,selfTest:async()=>{}});
 await broken.install("en_US-ljspeech-high");assert.equal((await settle(broken)).operation?.state,"failed");
 await writeFile(path.join(root,"en_US-ljspeech-high.staging","fixture.bin"),f.data);
 const recovered=new SpeechService(root,f.resources,async()=>{downloads++;return new Response(f.data);},{files:f.files,selfTest:async()=>{}});
 assert.equal((await recovered.status()).voices.find(v=>v.id==="en_US-ljspeech-high")!.state,"not-installed");
 await recovered.install("en_US-ljspeech-high");assert.equal((await settle(recovered)).voices.find(v=>v.id==="en_US-ljspeech-high")!.state,"ready");assert.equal(downloads,0);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
test("cancelled download does not activate or run synthesis self-test",async()=>{
 const f=await installationFixture();let tested=false;
 const service=new SpeechService(path.join(f.directory,"voices"),f.resources,async(_input,init)=>new Promise<Response>((_resolve,reject)=>{init?.signal?.addEventListener("abort",()=>reject(new Error("cancelled")),{once:true});if(init?.signal?.aborted)reject(new Error("cancelled"));}),{files:f.files,selfTest:async()=>{tested=true;}});
 try {const op=await service.install("en_US-ljspeech-high");service.cancel(op!.id);const status=await settle(service);assert.equal(status.operation?.state,"failed");assert.equal(tested,false);}finally{service.shutdown();await rm(f.directory,{recursive:true,force:true});}
});
test("incompatible installed manifests expose a repair state",async()=>{
 const f=await installationFixture();const root=path.join(f.directory,"voices");
 try {const installed=path.join(root,"en_US-ljspeech-high");await mkdir(installed,{recursive:true});await writeFile(path.join(installed,"installed.json"),JSON.stringify({revision:"obsolete",engineVersion:"0"}));const status=await new SpeechService(root,f.resources).status();assert.equal(status.voices.find(v=>v.id==="en_US-ljspeech-high")!.state,"failed");assert.match(status.voices.find(v=>v.id==="en_US-ljspeech-high")!.reason!,/repair/);}finally{await rm(f.directory,{recursive:true,force:true});}
});
test("speech settings route requires desktop capability before parsing or writing",async()=>{
 const {PUT}=await import("../app/api/settings/[section]/route.ts");
 const response=await PUT(new Request("http://localhost/api/settings/speech",{method:"PUT",body:JSON.stringify({automaticReading:true})}),{params:Promise.resolve({section:"speech"})});
 assert.equal(response.status,403);
});
test("speech HTTP rejects oversized bodies before JSON parsing",async()=>{
 const {speechResponse}=await import("../src/server/speech.ts");
 const oldServer=process.env.LH_DESKTOP_SERVER;const oldSecret=process.env.LH_DESKTOP_API_SECRET;
 try {process.env.LH_DESKTOP_SERVER="1";process.env.LH_DESKTOP_API_SECRET="a".repeat(64);
 const response=await speechResponse(new Request("http://localhost/api/speech/install",{method:"POST",headers:{"x-learnharness-desktop":"a".repeat(64)},body:"x".repeat(32769)}),"install");assert.equal(response.status,400);assert.match((await response.json()).error,/too large/);
 }finally{if(oldServer===undefined)delete process.env.LH_DESKTOP_SERVER;else process.env.LH_DESKTOP_SERVER=oldServer;if(oldSecret===undefined)delete process.env.LH_DESKTOP_API_SECRET;else process.env.LH_DESKTOP_API_SECRET=oldSecret;}
});
test("disk write failures leave staging unready and hide private paths",async()=>{
 const f=await installationFixture();const root=path.join(f.directory,"voices");
 try {await mkdir(path.join(root,"en_US-ljspeech-high.staging","fixture.bin.partial"),{recursive:true});const service=new SpeechService(root,f.resources,async()=>new Response(f.data),{files:f.files,selfTest:async()=>{}});await service.install("en_US-ljspeech-high");const status=await settle(service);assert.equal(status.operation?.state,"failed");assert.doesNotMatch(status.operation!.error!,new RegExp(f.directory));assert.match(status.operation!.error!,/disk space/);}finally{await rm(f.directory,{recursive:true,force:true});}
});

test("speech readiness notifications settle after installation and removal with no status polling owner",async()=>{
 const f=await installationFixture();let notifications=0;
 const off=subscribe(event=>{if(event.type === "speech-changed")notifications++;});
 const service=new SpeechService(path.join(f.directory,"voices"),f.resources,async()=>new Response(f.data),{files:f.files,selfTest:async()=>{}});
 try {
 await service.install("en_US-ljspeech-high");await settle(service);
 assert.equal(notifications,2,"start plus durable activation notification");
 await service.remove("en_US-ljspeech-high");assert.equal(notifications,4,"start plus completed removal notification");
 }finally{off();service.shutdown();await rm(f.directory,{recursive:true,force:true});}
});
test("HTTP request cancellation reaches its associated synthesis signal",async()=>{
 const {speechService,speechResponse}=await import("../src/server/speech.ts");
 const oldServer=process.env.LH_DESKTOP_SERVER;const oldSecret=process.env.LH_DESKTOP_API_SECRET;const original=speechService.synthesize;
 let started!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve;});let cancelled=false;
 const abort=new AbortController();
 try {process.env.LH_DESKTOP_SERVER="1";process.env.LH_DESKTOP_API_SECRET="a".repeat(64);
 speechService.synthesize=async(_voice,_text,signal)=>new Promise<Buffer>((_resolve,reject)=>{started();signal!.addEventListener("abort",()=>{cancelled=true;reject(new Error("Speech cancelled"));},{once:true});});
 const pending=speechResponse(new Request("http://localhost/api/speech/synthesize",{method:"POST",headers:{"x-learnharness-desktop":"a".repeat(64)},body:JSON.stringify({voiceId:"en_US-ljspeech-high",text:"Hello"}),signal:abort.signal}),"synthesize");
 await entered;abort.abort();assert.equal((await pending).status,400);assert.equal(cancelled,true);
 }finally{speechService.synthesize=original;if(oldServer===undefined)delete process.env.LH_DESKTOP_SERVER;else process.env.LH_DESKTOP_SERVER=oldServer;if(oldSecret===undefined)delete process.env.LH_DESKTOP_API_SECRET;else process.env.LH_DESKTOP_API_SECRET=oldSecret;}
});
