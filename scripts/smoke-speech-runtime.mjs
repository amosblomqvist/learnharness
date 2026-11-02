import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const [worker,model,config,data] = process.argv.slice(2);
if (!data) throw new Error('Usage: node scripts/smoke-speech-runtime.mjs WORKER MODEL CONFIG ESPEAK_DATA');
// A truncated request and an oversized frame must fail closed without synthesis.
for (const invalid of [Buffer.from([1,0]), Buffer.from([255,255,255,127])]) {
 const result=spawnSync(worker,[model,config,data],{input:invalid,timeout:30000});
 assert.equal(result.status,4);assert.equal(result.stdout.length,0);
}
const unsupported=Buffer.alloc(10);unsupported.writeUInt32LE(6);unsupported[4]=9;unsupported[5]=1;unsupported.writeUInt32LE(42,6);
const rejected=spawnSync(worker,[model,config,data],{input:unsupported,timeout:30000});
assert.equal(rejected.status,0);assert.equal(rejected.stdout[5],4);assert.equal(rejected.stdout.readUInt32LE(6),42);assert.equal(rejected.stdout.subarray(10).toString(),'unsupported_protocol');
const child=spawn(worker,[model,config,data],{stdio:['pipe','pipe','inherit']});
const timer=setTimeout(()=>{child.kill(); throw new Error('Speech smoke timed out');},30000);
let pending=Buffer.alloc(0), samples=0, completed=0;
child.stdout.on('data',chunk=>{
 pending=Buffer.concat([pending,chunk]);
 while(pending.length>=4 && pending.length>=4+pending.readUInt32LE(0)) {
 const size=pending.readUInt32LE(0); assert(size>=6 && size<20000004);
 const frame=pending.subarray(4,4+size);pending=pending.subarray(4+size);
 assert.equal(frame[0],1); assert.equal(frame.readUInt32LE(2),completed+1);
 if(frame[1]===2) {assert.equal(frame.readUInt32LE(6),22050); samples+=(frame.length-10)/2;}
 else if(frame[1]===3) {completed++; if(completed===2) child.stdin.end();}
 else throw new Error(`Worker error ${frame.subarray(6)}`);
 }
});
child.stdin.on('error',error=>{clearTimeout(timer);child.kill();throw error;});
child.on('error',error=>{clearTimeout(timer);throw error;});
child.on('exit',code=>{clearTimeout(timer);assert.equal(code,0);assert.equal(completed,2);assert(samples>22050);assert.equal(pending.length,0);console.log(`Persistent worker synthesized two requests, ${samples} samples.`);});
for(let id=1;id<=2;id++) {
 const text=Buffer.from('Welcome to your lesson.');
 const frame=Buffer.alloc(10+text.length);frame.writeUInt32LE(6+text.length);frame[4]=1;frame[5]=1;frame.writeUInt32LE(id,6);text.copy(frame,10);child.stdin.write(frame);
}
