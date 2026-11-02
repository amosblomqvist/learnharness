import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

test("speech shutdown IPC and signal hooks preserve the server's graceful handler", {skip:process.platform === "win32"}, async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),"lh-speech-shutdown-"));
 const marker=path.join(directory,"closed");
 const script=path.join(directory,"server.mjs");
 const moduleUrl=pathToFileURL(path.resolve("src/server/speech.ts")).href;
 const tsxUrl=pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href;
 await writeFile(script,`import fs from 'node:fs';\nglobalThis.lessonSpeech={shutdown(){fs.writeFileSync(${JSON.stringify(marker)},'closed')}};\nprocess.once('SIGTERM',()=>{process.send?.({channel:'graceful'});process.exit(0)});\nawait import(${JSON.stringify(moduleUrl)});\nprocess.send?.({channel:'ready'});\nsetInterval(()=>{},1000);`);
 const child=spawn(process.execPath,["--import",tsxUrl,script],{stdio:["ignore","ignore","pipe","ipc"],env:{...process.env,NODE_ENV:"test"}});
 const timer=setTimeout(()=>child.kill("SIGKILL"),15000);
 try {
  while(true){const [message]=await once(child,"message");if(message.channel==="ready")break;}
  const reply=once(child,"message");child.send({channel:"lh:speech-shutdown"});
  assert.equal((await reply)[0].channel,"lh:speech-shutdown-complete");assert.equal(await readFile(marker,"utf8"),"closed");
  const exited=once(child,"exit");child.kill("SIGTERM");const [code]=await exited;assert.equal(code,0);
 }finally{clearTimeout(timer);if(child.exitCode===null)child.kill("SIGKILL");await rm(directory,{recursive:true,force:true});}
});
