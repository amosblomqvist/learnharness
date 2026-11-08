import React, { act } from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { NarrationSessionProvider, useQuestionNarration } from "../components/narration.tsx";
import type { LhMessage } from "../src/core/native-messages.ts";

function Question({revealed}:{revealed:boolean}) {
 useQuestionNarration({id:"question:call",markdown:"Which choice?",complete:true},revealed);
 return null;
}
test("a revealed question effect queues after explanation from the same React snapshot", {timeout:5000}, async()=>{
 const dom=parseHTML("<html><body><div id='root'></div></body></html>");
 const saved=new Map<string,PropertyDescriptor|undefined>();
 const synthesized:string[]=[];
 let questionRequested!:()=>void;const requested=new Promise<void>(resolve=>{questionRequested=resolve;});
 class AudioFake {
  onended:(()=>void)|null=null;onerror:(()=>void)|null=null;
  async play(){queueMicrotask(()=>this.onended?.());}pause(){}removeAttribute(){}
 }
 const replacements={React,IS_REACT_ACT_ENVIRONMENT:true,window:dom.window,document:dom.document,CustomEvent:dom.window.CustomEvent,Audio:AudioFake,BroadcastChannel:undefined,fetch:async(url:string,init?:RequestInit)=>{
  if(url==="/api/settings")return Response.json({settings:{speech:{voice:"en_US-ljspeech-high",automaticReading:true}}});
  if(url==="/api/speech/status")return Response.json({voices:[{id:"en_US-ljspeech-high",state:"ready"}]});
  const text=JSON.parse(init!.body as string).text;synthesized.push(text);if(text === "Which choice?")questionRequested();return new Response(new Blob(["audio"]));
 }};
 for(const [key,value]of Object.entries(replacements)){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const root=createRoot(dom.document.getElementById("root")!);
 try{
  await act(async()=>root.render(<NarrationSessionProvider sessionId="session" messages={[]} running={false}><Question revealed={false}/></NarrationSessionProvider>));
  const messages=[{id:"native",role:"assistant",stopReason:"stop",content:[{type:"text",text:"Final explanation."}]}]as unknown as LhMessage[];
  await act(async()=>root.render(<NarrationSessionProvider sessionId="session" messages={messages} running={false}><Question revealed/></NarrationSessionProvider>));
  await act(async()=>{await requested;});
  assert.deepEqual(synthesized,["Final explanation.","Which choice?"]);
 }finally{await act(async()=>root.unmount());for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});

test("delayed initial preferences read only content generated after attachment, once", {timeout:5000}, async()=>{
 const dom=parseHTML("<html><body><div id='root'></div></body></html>");
 const saved=new Map<string,PropertyDescriptor|undefined>();const synthesized:string[]=[];
 let settingsLoaded!:(response:Response)=>void;const settings=new Promise<Response>(resolve=>{settingsLoaded=resolve;});
 let requested!:()=>void;const speechRequested=new Promise<void>(resolve=>{requested=resolve;});
 class AudioFake {onended:(()=>void)|null=null;onerror:(()=>void)|null=null;async play(){queueMicrotask(()=>this.onended?.());}pause(){}removeAttribute(){}}
 const replacements={React,IS_REACT_ACT_ENVIRONMENT:true,window:dom.window,document:dom.document,CustomEvent:dom.window.CustomEvent,Audio:AudioFake,BroadcastChannel:undefined,fetch:async(url:string,init?:RequestInit)=>{
  if(url==="/api/settings")return settings;
  if(url==="/api/speech/status")return Response.json({voices:[{id:"en_US-ljspeech-high",state:"ready"}]});
  synthesized.push(JSON.parse(init!.body as string).text);requested();return new Response(new Blob(["audio"]));
 }};
 for(const[key,value]of Object.entries(replacements)){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const root=createRoot(dom.document.getElementById("root")!);
 const messages=(text:string)=>[{id:"native",role:"assistant",stopReason:"pending",content:[{type:"text",text}]}]as unknown as LhMessage[];
 try{
  await act(async()=>root.render(<NarrationSessionProvider sessionId="session" messages={messages("Historical.")} running><span/></NarrationSessionProvider>));
  await act(async()=>root.render(<NarrationSessionProvider sessionId="session" messages={messages("Historical. Newly generated. Tail")} running><span/></NarrationSessionProvider>));
  assert.deepEqual(synthesized,[]);
  await act(async()=>{settingsLoaded(Response.json({settings:{speech:{voice:"en_US-ljspeech-high",automaticReading:true}}}));await speechRequested;});
  assert.deepEqual(synthesized,["Newly generated."]);
  await act(async()=>root.render(<NarrationSessionProvider sessionId="session" messages={messages("Historical. Newly generated. Tail")} running><span/></NarrationSessionProvider>));
  assert.deepEqual(synthesized,["Newly generated."]);
 }finally{await act(async()=>root.unmount());for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});
