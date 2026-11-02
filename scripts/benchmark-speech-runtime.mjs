import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
const [worker,model,config,data]=process.argv.slice(2);
if(!data)throw new Error('Usage: benchmark-speech-runtime.mjs WORKER MODEL CONFIG DATA');
const child=spawn(worker,[model,config,data],{stdio:['pipe','pipe','inherit']});
let pending=Buffer.alloc(0),start=performance.now(),first=null,samples=0,rate=0,peak=0,id=1;
const results=[];
const timeout=setTimeout(()=>child.kill(),60000);
const memory=setInterval(()=>{try{peak=Math.max(peak,Number(readFileSync(`/proc/${child.pid}/status`,'utf8').match(/VmHWM:\s+(\d+)/)?.[1]??0));}catch{}},10);
function request(){const text=Buffer.from('Welcome to your lesson. Read the question carefully.');const f=Buffer.alloc(10+text.length);f.writeUInt32LE(6+text.length);f[4]=1;f[5]=1;f.writeUInt32LE(id,6);text.copy(f,10);child.stdin.write(f);}
child.stdout.on('data',data=>{pending=Buffer.concat([pending,data]);while(pending.length>=4&&pending.length>=4+pending.readUInt32LE(0)){const n=pending.readUInt32LE(0),f=pending.subarray(4,4+n);pending=pending.subarray(4+n);if(f[1]===2){first??=performance.now();rate=f.readUInt32LE(6);samples+=(f.length-10)/2;}else if(f[1]===3){const elapsed=performance.now()-start;results.push({kind:id===1?'cold':'warm',firstAudioMs:first-start,synthesisMs:elapsed,audioSeconds:samples/rate,realTimeFactor:elapsed/1000/(samples/rate)});if(id===2)child.stdin.end();else{id++;start=performance.now();first=null;samples=0;request();}}else throw new Error('Worker synthesis failed');}});
child.on('exit',code=>{clearTimeout(timeout);clearInterval(memory);if(code!==0||results.length!==2)throw new Error('Benchmark failed');console.log(JSON.stringify({results,peakRssKiB:peak},null,2));if(results[1].realTimeFactor>=1)throw new Error('Warm synthesis is slower than real time');});
request();
