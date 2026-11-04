import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { SpeechWorker } from "../src/server/speech-worker.ts";
function fixture(deadline=1000) {
 const children: Array<EventEmitter & {stdin:PassThrough;stdout:PassThrough;stderr:PassThrough;kill:()=>boolean}> = [];
 const launch = (()=>{const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{child.emit("exit",null,"SIGKILL");return true;}});children.push(child);return child;}) as unknown as typeof spawn;
 return {children,worker:new SpeechWorker("/resources","/voice","en_US-ljspeech-high",launch,deadline)};
}
function frame(type:number,id:number,payload=Buffer.alloc(0)) {const data=Buffer.alloc(10+payload.length);data.writeUInt32LE(data.length-4);data[4]=1;data[5]=type;data.writeUInt32LE(id,6);payload.copy(data,10);return data;}
test("persistent speech worker correlates fragmented PCM frames and ignores stale child exits",async()=>{
 const f=fixture();
 try {
 const pending=f.worker.synthesize("Hello");const child=f.children[0]!;const pcm=Buffer.alloc(8);pcm.writeUInt32LE(22050);
 const output=Buffer.concat([frame(2,1,pcm),frame(3,1)]);child.stdout.write(output.subarray(0,3));child.stdout.write(output.subarray(3));
 assert.equal((await pending).length,48);
 const again=f.worker.synthesize("Again");child.stdout.write(frame(2,2,pcm));child.stdout.write(frame(3,2));await again;
 assert.equal(f.children.length,1);
 }finally{f.worker.stop();}
});
test("worker crash rejects active synthesis and next request starts lazily",async()=>{
 const f=fixture();try {const first=f.worker.synthesize("Hello");f.children[0]!.emit("exit",1);await assert.rejects(first,/cancelled/);const second=f.worker.synthesize("Next");assert.equal(f.children.length,2);f.worker.stop();await assert.rejects(second,/cancelled/);}finally{f.worker.stop();}
});
test("invalid framing or mismatched identity destroys the worker",async()=>{
 for(const output of [Buffer.from([255,255,255,127]),frame(3,99)]) {
 const f=fixture();try{const pending=f.worker.synthesize("Hello");f.children[0]!.stdout.write(output);await assert.rejects(pending,/cancelled/);}finally{f.worker.stop();}
 }
});
test("abort cancels synthesis and removes its listener before a replacement",async()=>{
 const f=fixture();const abort=new AbortController();
 try {const first=f.worker.synthesize("Hello",abort.signal);abort.abort();await assert.rejects(first,/cancelled/);const second=f.worker.synthesize("Replacement");f.worker.stop();await assert.rejects(second,/cancelled/);assert.equal(f.children.length,2);}finally{f.worker.stop();}
});
test("inference deadline rejects a worker that never completes",async()=>{
 const f=fixture(5);const keepAlive=setTimeout(()=>{},100);
 try{await assert.rejects(f.worker.synthesize("Hello"),/cancelled/);}finally{clearTimeout(keepAlive);f.worker.stop();}
});
