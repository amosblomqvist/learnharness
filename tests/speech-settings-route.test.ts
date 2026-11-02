import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

test("confirmed speech settings preserve unknown fields and emit readiness only after persistence",async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),"lh-speech-settings-"));
 const script=path.join(directory,"settings.mjs");
 const route=pathToFileURL(path.resolve("app/api/settings/[section]/route.ts")).href;
 const events=pathToFileURL(path.resolve("src/core/events.ts")).href;
 const loader=pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href;
 await writeFile(path.join(directory,"settings.json"),JSON.stringify({version:1,future:{keep:true}}));
 await writeFile(script,`import fs from 'node:fs';import assert from 'node:assert/strict';\nconst {subscribe}=await import(${JSON.stringify(events)});const {PUT}=await import(${JSON.stringify(route)});let emitted=0;const off=subscribe(event=>{if(event.type==='speech-changed'){emitted++;assert.equal(JSON.parse(fs.readFileSync(process.env.LH_DATA_DIR+'/settings.json','utf8')).speech.automaticReading,true);}});\nconst response=await PUT(new Request('http://localhost/api/settings/speech',{method:'PUT',headers:{'x-learnharness-desktop':process.env.LH_DESKTOP_API_SECRET},body:JSON.stringify({engine:'piper',voice:'en_US-ljspeech-high',automaticReading:true,playbackRate:1.25})}),{params:Promise.resolve({section:'speech'})});assert.equal(response.status,200);assert.equal(emitted,1);off();`);
 try {await promisify(execFile)(process.execPath,["--import",loader,script],{env:{...process.env,NODE_ENV:"test",LH_DATA_DIR:directory,LH_DESKTOP_SERVER:"1",LH_DESKTOP_API_SECRET:"b".repeat(64)},timeout:15000});const saved=JSON.parse(await readFile(path.join(directory,"settings.json"),"utf8"));assert.deepEqual(saved.future,{keep:true});assert.equal(saved.speech.playbackRate,1.25);}finally{await rm(directory,{recursive:true,force:true});}
});
