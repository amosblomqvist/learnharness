import React, { act, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { SpeechSection } from "../components/settings/speech-section.tsx";
import { SpeechStatusMonitor } from "../components/speech-status.ts";
import { SETTINGS_SAVED_EVENT } from "../components/settings-signal.ts";
import { NarrationSessionProvider, ReadAloud, stopSpeechPreview } from "../components/narration.tsx";
import type { SpeechSettings, SpeechStatus, SpeechVoiceState } from "../src/core/speech.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { setDictationActive } from "../components/dictation-state.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent });
const originalFetch = globalThis.fetch;
const originalAudio = globalThis.Audio;
const originalBroadcastChannel = globalThis.BroadcastChannel;
const roots: { root: Root; host: HTMLElement }[] = [];
function status(state: SpeechVoiceState, error?: string): SpeechStatus {
 const active = ["downloading", "verifying", "removing", "failed"].includes(state);
 return { engines: [{id:"piper",available:state!=="unavailable",...(state==="unavailable"?{reason:"Local speech is unavailable for this desktop build."}:{})}], voices:[{id:"en_US-ljspeech-high",engine:"piper",name:"LJ Speech · English (US)",quality:"high",license:"Public domain dataset",downloadBytes:114204494,state}],operation:active?{id:"op-1",voiceId:"en_US-ljspeech-high",state,downloadedBytes:100,totalBytes:114204494,...(error?{error}:{})}:null };
}
function deferred<T>() { let resolve!:(value:T)=>void; const promise = new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; }
async function mount(element:React.ReactElement) { const host=document.createElement("div");document.body.append(host);const root=createRoot(host);roots.push({root,host});await act(async()=>root.render(element));return host; }
function button(host:HTMLElement,label:string) { const found=[...host.querySelectorAll<HTMLButtonElement>("button")].find(el=>el.textContent===label);assert.ok(found,`Missing ${label}`);return found; }
function iconButton(host:HTMLElement,label:string) { const found=[...host.querySelectorAll<HTMLButtonElement>("button")].find(el=>el.getAttribute("aria-label")===label);assert.ok(found,`Missing ${label}`);return found; }
async function clickIcon(host:HTMLElement,label:string) { await act(async()=>iconButton(host,label).click()); }
const LJ="LJ Speech · English (US)";
async function click(host:HTMLElement,label:string) { await act(async()=>button(host,label).click()); }
afterEach(async()=>{for(const {root,host} of roots.splice(0)){await act(async()=>root.unmount());host.remove();}stopSpeechPreview();setDictationActive(false);globalThis.fetch=originalFetch;globalThis.Audio=originalAudio;globalThis.BroadcastChannel=originalBroadcastChannel;});

function monitorFixture(initial: SpeechStatus[]) {
 const snapshots=[...initial];const timers=new Map<number,()=>void>();let timer=0;let changed=0;const seen:SpeechStatus[]=[];const errors:string[]=[];let calls=0;
 const monitor=new SpeechStatusMonitor({fetch:async()=>{calls++;return Response.json(snapshots.shift()!);},onStatus:s=>seen.push(s),onError:e=>errors.push(e),onAvailabilityChanged:()=>{changed++;},schedule:((callback:()=>void)=>{timers.set(++timer,callback);return timer;}) as unknown as typeof setTimeout,clearSchedule:((id:number)=>{timers.delete(id);}) as unknown as typeof clearTimeout});
 return {monitor,timers,seen,errors,calls:()=>calls,changed:()=>changed,tick:async()=>{const entries=[...timers.values()];timers.clear();for(const run of entries)run();await new Promise(resolve=>setImmediate(resolve));}};
}

test("installation observation polls only while work is active, notifies readiness once and stops on close",async()=>{
 const f=monitorFixture([status("downloading"),status("verifying"),status("ready"),status("not-installed")]);
 await f.monitor.refresh();assert.equal(f.timers.size,1);
 await f.tick();assert.equal(f.seen.at(-1)?.voices[0]?.state,"verifying");assert.equal(f.changed(),0);
 await f.tick();assert.equal(f.seen.at(-1)?.voices[0]?.state,"ready");assert.equal(f.changed(),1);assert.equal(f.timers.size,0);
 await f.monitor.refresh();assert.equal(f.changed(),2);assert.equal(f.timers.size,0);
 f.monitor.stop();await f.monitor.refresh();assert.equal(f.calls(),4);
});

test("streaming and invalid question calls are not mistaken for an existing revealed attachment baseline",()=>{
 const message={id:"native",role:"assistant",stopReason:"pending",content:[{type:"toolCall",id:"call",name:"ask_user_question",arguments:{question:"What do you prefer?"}}]};
});

test("closing observation aborts status reads and ignores stale completion without cancelling installation",async()=>{
 const pending=deferred<Response>();let signal:AbortSignal|undefined;let updates=0;
 const monitor=new SpeechStatusMonitor({fetch:async(_url,init)=>{signal=init?.signal as AbortSignal;return pending.promise;},onStatus:()=>{updates++;},onError:()=>{updates++;},onAvailabilityChanged:()=>{updates++;}});
 const request=monitor.refresh();monitor.stop();assert.equal(signal?.aborted,true);pending.resolve(Response.json(status("ready")));await request;assert.equal(updates,0);
});

test("manual refresh during a pending read is serialized and cannot overwrite newer installation state",async()=>{
 const old=deferred<Response>();let count=0;const seen:string[]=[];
 const monitor=new SpeechStatusMonitor({fetch:async()=>++count===1?old.promise:Response.json(status("ready")),onStatus:s=>seen.push(s.voices[0]!.state),onError:()=>{},onAvailabilityChanged:()=>{}});
 const first=monitor.refresh();const second=monitor.refresh();assert.equal(count,1);old.resolve(Response.json(status("not-installed")));await Promise.all([first,second]);assert.deepEqual(seen,["not-installed","ready"]);assert.equal(count,2);monitor.stop();
});

test("speech settings show verified desktop refusal and unavailable platform reasons",async()=>{
 globalThis.fetch=async()=>Response.json({error:"Speech requires a verified desktop connection."},{status:403});
 const refused=await mount(<SpeechSection onChange={()=>{}}/>);assert.match(refused.querySelector('[role="alert"]')!.textContent!,/verified desktop/);assert.equal(refused.querySelector('button')?.textContent,"");
 globalThis.fetch=async()=>Response.json(status("unavailable"));const unavailable=await mount(<SpeechSection onChange={()=>{}}/>);assert.match(unavailable.textContent!,/unavailable for this desktop build/);assert.ok(![...unavailable.querySelectorAll('button')].some(el=>el.textContent==="Install"));
});

test("failed install displays failure with Retry and no Cancel for settled operation",async()=>{
 globalThis.fetch=async()=>Response.json(status("failed","Download checksum verification failed."));
 const host=await mount(<SpeechSection onChange={()=>{}}/>);assert.match(host.textContent!,/checksum/);assert.ok(button(host,"Retry"));assert.ok(![...host.querySelectorAll('button')].some(el=>el.textContent==="Cancel"));
});

test("admitted install request survives settings closure and starts from explicit catalog ID",async()=>{
 const install=deferred<Response>();let request:RequestInit|undefined;
 globalThis.fetch=async(url,init)=>{if(String(url).endsWith("/install")){request=init;return install.promise;}return Response.json(status("not-installed"));};
 const host=await mount(<SpeechSection onChange={()=>{}}/>);assert.match(host.textContent!,/Not installed/);assert.doesNotMatch(host.textContent!,/not-installed/);await click(host,"Install");assert.equal(request?.signal,undefined);assert.deepEqual(JSON.parse(request!.body as string),{voiceId:"en_US-ljspeech-high"});
 const mounted=roots.pop()!;await act(async()=>mounted.root.unmount());mounted.host.remove();install.resolve(Response.json({operation:{id:"op-1"}}));await act(async()=>{});assert.equal(request?.signal,undefined);
});

test("speech preference writes serialize and preserve the latest confirmed subsection",async()=>{
 globalThis.fetch=async()=>Response.json(status("ready"));const saved:SpeechSettings[]=[];const first=deferred<boolean>();
 function Harness(){const [settings,setSettings]=useState<SpeechSettings>({engine:"piper",voice:"en_US-ljspeech-high",playbackRate:1,future:"keep"} as SpeechSettings);return <SpeechSection settings={settings} onChange={async next=>{saved.push(next);if(saved.length===1)await first.promise;setSettings(next);return true;}}/>;}
 const host=await mount(<Harness/>);await act(async()=>host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());assert.equal(saved.length,1);assert.equal(host.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled,true);
 await act(async()=>{first.resolve(true);});const input=host.querySelector<HTMLInputElement>('[aria-label="Playback speed"]')!;await act(async()=>{input.value="1.5";input.dispatchEvent(new dom.window.Event("pointerup",{bubbles:true}));});
 assert.equal(saved.length,2);assert.equal(saved[1]!.voice,"en_US-ljspeech-high");assert.equal(saved[1]!.automaticReading,true);assert.equal(saved[1]!.playbackRate,1.5);
	assert.equal((saved[1] as SpeechSettings & {future:string}).future,"keep");
});

class FakeAudio {
 static instances:FakeAudio[]=[];onended:(()=>void)|null=null;onerror:(()=>void)|null=null;paused=false;plays=0;
 constructor(public src:string){FakeAudio.instances.push(this);} async play(){this.plays++;this.paused=false;} pause(){this.paused=true;} removeAttribute(){this.src="";}
}

test("voice preview plays, stops on the same control, and replays without stale audio",async()=>{
 FakeAudio.instances=[];globalThis.Audio=FakeAudio as unknown as typeof Audio;
 globalThis.fetch=async(url)=>String(url).startsWith("/speech/samples/")?new Response(new Blob(["audio"],{type:"audio/wav"})):Response.json(status("ready"));
 const host=await mount(<SpeechSection onChange={()=>{}}/>);
 await clickIcon(host,`Play ${LJ} sample`);const audio=FakeAudio.instances[0]!;assert.ok(audio);
 await clickIcon(host,`Stop ${LJ} sample`);assert.equal(audio.paused,true);
 await clickIcon(host,`Play ${LJ} sample`);assert.equal(FakeAudio.instances.length,2);
});

test("stopping a loading preview rejects a late sample response before constructing audio",async()=>{
 FakeAudio.instances=[];globalThis.Audio=FakeAudio as unknown as typeof Audio;const sample=deferred<Response>();
 globalThis.fetch=async(url)=>String(url).startsWith("/speech/samples/")?sample.promise:Response.json(status("ready"));
 const host=await mount(<SpeechSection onChange={()=>{}}/>);await clickIcon(host,`Play ${LJ} sample`);assert.ok(iconButton(host,`Stop ${LJ} sample`));await clickIcon(host,`Stop ${LJ} sample`);
 await act(async()=>{sample.resolve(new Response(new Blob(["late audio"])));});assert.equal(FakeAudio.instances.length,0);assert.ok(iconButton(host,`Play ${LJ} sample`));assert.ok(!host.querySelector('[role="alert"]'));
});

test("late initial settings responses cannot overwrite a newer confirmed narration voice selection",async()=>{
 FakeAudio.instances=[];globalThis.Audio=FakeAudio as unknown as typeof Audio;
 const oldSettings=deferred<Response>();const oldStatus=deferred<Response>();let settingsReads=0;let statusReads=0;let syntheses=0;
 globalThis.fetch=async(url)=>{
  if(String(url)==="/api/settings")return ++settingsReads===1?oldSettings.promise:Response.json({settings:{speech:{voice:"en_US-ljspeech-high",engine:"piper"}}});
  if(String(url)==="/api/speech/status")return ++statusReads===1?oldStatus.promise:Response.json(status("ready"));
  syntheses++;return new Response(new Blob(["audio"]));
 };
 const messages=[{id:"native",role:"assistant",stopReason:"stop",content:[{type:"text",text:"Visible explanation."}]}] as unknown as LhMessage[];
 const host=await mount(<NarrationSessionProvider sessionId="session" messages={messages} running={false}><ReadAloud partId="native-t0"/></NarrationSessionProvider>);
 await act(async()=>window.dispatchEvent(new dom.window.CustomEvent(SETTINGS_SAVED_EVENT,{detail:{section:"speech"}})));
 await act(async()=>{oldSettings.resolve(Response.json({settings:{speech:{}}}));oldStatus.resolve(Response.json(status("not-installed")));});
 await click(host,"Read aloud");assert.equal(syntheses,1);assert.equal(FakeAudio.instances.length,1);
});

test("SSR exposes Read aloud only for learner-visible teacher content and revealed questions",()=>{
 const messages=[{id:"teacher",role:"assistant",stopReason:"stop",content:[{type:"thinking",thinking:"Hidden reasoning"},{type:"text",text:"Visible explanation."}]}] as unknown as LhMessage[];
 const prose=renderToStaticMarkup(<NarrationSessionProvider sessionId="ssr" messages={messages} running={false}><ReadAloud partId="teacher-t0"/><ReadAloud partId="teacher-r0"/><ReadAloud partId="unknown-t0"/></NarrationSessionProvider>);
 assert.equal((prose.match(/Read aloud/g)??[]).length,1);assert.doesNotMatch(prose,/Hidden reasoning/);assert.match(prose,/<button\b[^>]*\btype="button"/);
 const question=(revealed:boolean)=>renderToStaticMarkup(<NarrationSessionProvider sessionId="ssr" messages={[]} running={false}><QuestionDock toolName="ask_user_question" toolCallId="call" input={{question:"Visible question?",options:[{label:"Visible choice",value:"one"},{label:"Another choice",value:"two"}]}} expanded={revealed} reveal={!revealed} revealed={revealed} onExpand={()=>{}} onSubmit={()=>{}}/></NarrationSessionProvider>);
 assert.doesNotMatch(question(false),/Read aloud/);assert.match(question(true),/Read aloud/);
});

test("speech SSE and reconnect refresh narration readiness without an open installation surface",async()=>{
 FakeAudio.instances=[];globalThis.Audio=FakeAudio as unknown as typeof Audio;
 const handlers=new Map<string,(data:string)=>void>();let reopen=()=>{};let installed=false;let statusReads=0;let syntheses=0;
 const connect=():NotifySource=>({close(){},onOpen(callback){reopen=callback;},onEvent(name,callback){handlers.set(name,callback);}});
 globalThis.fetch=async(url)=>{
  if(String(url)==="/api/settings")return Response.json({settings:{speech:{voice:"en_US-ljspeech-high",engine:"piper"}}});
  if(String(url)==="/api/speech/status"){statusReads++;return Response.json(status(installed?"ready":"not-installed"));}
  syntheses++;return new Response(new Blob(["audio"]));
 };
 const messages=[{id:"native",role:"assistant",stopReason:"stop",content:[{type:"text",text:"Visible explanation."}]}] as unknown as LhMessage[];
 const host=await mount(<ServerEventsProvider connect={connect}><NarrationSessionProvider sessionId="session" messages={messages} running={false}><ReadAloud partId="native-t0"/></NarrationSessionProvider></ServerEventsProvider>);
 assert.equal(statusReads,1);await click(host,"Read aloud");assert.equal(syntheses,0);
 installed=true;await act(async()=>handlers.get("speech-changed")!("{}"));assert.equal(statusReads,2);
 await click(host,"Read aloud");assert.equal(syntheses,1);
 const pause=host.querySelector<HTMLButtonElement>('[aria-label="Pause reading"]')!;assert.ok(pause);assert.equal(pause.type,"button");
 await act(async()=>pause.click());assert.ok(host.querySelector('[aria-label="Resume reading"]'));
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Resume reading"]')!.click());
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Stop reading"]')!.click());assert.equal(FakeAudio.instances[0]!.paused,true);
 await act(async()=>reopen());assert.equal(statusReads,3);
});

test("a confirmed voice change from another window invalidates dictation's pending audio resume",async()=>{
 FakeAudio.instances=[];globalThis.Audio=FakeAudio as unknown as typeof Audio;let selected=true;
 const handlers=new Map<string,(data:string)=>void>();const connect=():NotifySource=>({close(){},onOpen(){},onEvent(name,callback){handlers.set(name,callback);}});
 globalThis.fetch=async(url)=>String(url)==="/api/settings"?Response.json({settings:{speech:selected?{voice:"en_US-ljspeech-high"}:{}}}):String(url)==="/api/speech/status"?Response.json(status("ready")):new Response(new Blob(["audio"]));
 const messages=[{id:"native",role:"assistant",stopReason:"stop",content:[{type:"text",text:"Visible explanation."}]}] as unknown as LhMessage[];
 const host=await mount(<ServerEventsProvider connect={connect}><NarrationSessionProvider sessionId="session" messages={messages} running={false}><ReadAloud partId="native-t0"/></NarrationSessionProvider></ServerEventsProvider>);
 await click(host,"Read aloud");const audio=FakeAudio.instances[0]!;assert.equal(audio.plays,1);
 await act(async()=>setDictationActive(true));assert.equal(audio.paused,true);
 selected=false;await act(async()=>handlers.get("speech-changed")!("{}"));
 await act(async()=>setDictationActive(false));assert.equal(audio.plays,1);assert.equal(audio.paused,true);assert.ok(button(host,"Read aloud"));
});

test("another desktop window claiming playback stops local audio and invalidates a pending recording resume",async()=>{
 let receive!:(event:{data:string})=>void;
 class Channel {addEventListener(_name:string,listener:typeof receive){receive=listener;}postMessage(){}close(){}}
 globalThis.BroadcastChannel=Channel as unknown as typeof BroadcastChannel;FakeAudio.instances=[];globalThis.Audio=FakeAudio as unknown as typeof Audio;
 globalThis.fetch=async(url)=>String(url)==="/api/settings"?Response.json({settings:{speech:{voice:"en_US-ljspeech-high"}}}):String(url)==="/api/speech/status"?Response.json(status("ready")):new Response(new Blob(["audio"]));
 const messages=[{id:"native",role:"assistant",stopReason:"stop",content:[{type:"text",text:"Visible explanation."}]}] as unknown as LhMessage[];
 const host=await mount(<NarrationSessionProvider sessionId="session" messages={messages} running={false}><ReadAloud partId="native-t0"/></NarrationSessionProvider>);
 await click(host,"Read aloud");const audio=FakeAudio.instances[0]!;await act(async()=>setDictationActive(true));
 await act(async()=>receive({data:"another-window-owner"}));await act(async()=>setDictationActive(false));
 assert.equal(audio.paused,true);assert.equal(audio.plays,1);assert.ok(button(host,"Read aloud"));
});

test("removal notifies mounted narration readers after confirmed ready to uninstalled transition",async()=>{
 let removed=false;let notified=0;const listener=()=>{notified++;};window.addEventListener(SETTINGS_SAVED_EVENT,listener);
 try{globalThis.fetch=async(url,init)=>{if(init?.method==="DELETE"){removed=true;return Response.json({ok:true});}return Response.json(status(removed?"not-installed":"ready"));};const host=await mount(<SpeechSection onChange={()=>{}}/>);await click(host,"Remove");assert.equal(notified,1);assert.ok(button(host,"Install"));}finally{window.removeEventListener(SETTINGS_SAVED_EVENT,listener);}
});
