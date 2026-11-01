import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { useCodexDictation } from "../components/codex-dictation.ts";
import type { Dictation } from "../components/dictation.tsx";

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const { window, document } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window, document });
let root: Root | undefined;
let dictation: Dictation;
let stopped = 0;
let worklet: FakeWorklet;
let appended: string[] = [];
let active = false;
const stream = { getTracks: () => [{ stop: () => { stopped++; } }] };
const originalFetch = globalThis.fetch;
class FakeWorklet {
	port = { onmessage: null as ((event: unknown) => void) | null, postMessage: () => {
		queueMicrotask(() => { this.audio(256); this.port.onmessage?.({ data: { type: "flushed" } }); });
	} };
	constructor() { worklet = this; }
	audio(length: number) { this.port.onmessage?.({ data: { type: "audio", buffer: new ArrayBuffer(length) } }); }
	connect() {}
	disconnect() {}
}
class FakeContext {
	state = "running";
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
	close() { return Promise.resolve(); }
}
async function mount(getUserMedia = async () => stream, getLanguage?: () => Promise<string>) {
	stopped = 0; appended = []; active = false;
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia } } });
	Object.assign(globalThis, { AudioContext: FakeContext, AudioWorkletNode: FakeWorklet });
	function Harness() { dictation = useCodexDictation({ append: text => appended.push(text), onActive: value => { active = value; }, getLanguage }); return null; }
	const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
	await act(async () => root!.render(<Harness />));
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; globalThis.fetch = originalFetch; });

test("finish includes the final partial audio frame and resolves after inserting the transcript", async () => {
	await mount(); let sent = 0;
	globalThis.fetch = async (url, init) => {
		assert.equal(url, "/api/stt/transcribe"); assert.equal(init?.method, "POST");
		sent = (init!.body as Blob).size;
		assert.equal(stopped, 1, "microphone must stop before upload");
		return Response.json({ text: "A complete sentence." });
	};
	await act(async () => dictation.toggle());
	assert.equal(dictation.phase, "recording");
	worklet.audio(8192);
	await act(async () => { await dictation.finish(); assert.deepEqual(appended, ["A complete sentence."]); });
	assert.equal(sent, 8192 + 256); assert.equal(dictation.phase, "idle"); assert.equal(active, false);
});

test("cancel aborts in-flight transcription and releases finish without inserting text", async () => {
	await mount(); let aborted = false;
	globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
		init!.signal!.addEventListener("abort", () => { aborted = true; reject(new DOMException("Cancelled", "AbortError")); });
	});
	await act(async () => dictation.toggle()); worklet.audio(8192);
	let finished: Promise<void>;
	await act(async () => { finished = dictation.finish(); await new Promise(resolve => setTimeout(resolve, 0)); });
	await act(async () => { dictation.cancel(); await finished!; });
	assert.equal(aborted, true); assert.deepEqual(appended, []); assert.equal(dictation.phase, "idle"); assert.equal(active, false);
});

test("cancelling a pending microphone request stops tracks when permission eventually resolves", async () => {
	let release!: (value: typeof stream) => void;
	await mount(() => new Promise(resolve => { release = resolve; }));
	await act(async () => dictation.toggle());
	assert.equal(dictation.phase, "connecting");
	await act(async () => dictation.cancel());
	await act(async () => release(stream));
	assert.equal(stopped, 1); assert.equal(active, false); assert.deepEqual(appended, []);
});

test("the capture worklet flushes samples shorter than a frame before acknowledging stop", () => {
	let Processor: new () => { process(inputs: Float32Array[][]): boolean; port: { onmessage: (event: unknown) => void } };
	const events: Array<{ type: string; buffer?: ArrayBuffer }> = [];
	runInNewContext(readFileSync(new URL("../public/worklets/codex-pcm-capture.js", import.meta.url), "utf8"), {
		AudioWorkletProcessor: class { port = { postMessage: (value: { type: string; buffer?: ArrayBuffer }) => events.push(value) }; },
		registerProcessor: (_name: string, cls: typeof Processor) => { Processor = cls; },
	});
	const capture = new Processor!(); capture.process([[new Float32Array([0.5, -0.5, 1])]]);
	capture.port.onmessage({ data: { type: "flush" } });
	assert.deepEqual(events.map(e => e.type), ["level", "audio", "flushed"]);
	assert.equal(events[1]!.buffer!.byteLength, 6);
	assert.deepEqual(Array.from(new Int16Array(events[1]!.buffer!)), [16383, -16384, 32767]);
});

test("Codex transcription uses the saved dictation language", async () => {
 await mount(undefined, async () => "ro"); let language:string|null=null;
 globalThis.fetch = async (_url,init) => {language=new Headers(init?.headers).get("x-lh-dictation-language");return Response.json({text:"Un răspuns în română."});};
 await act(async()=>dictation.toggle());worklet.audio(8192);
 await act(async()=>{await dictation.finish();});
 assert.equal(language,"ro");assert.deepEqual(appended,["Un răspuns în română."]);
});
test("cancel during language loading cannot upload a departing recording", async () => {
 let release!:(language:string)=>void;let posts=0;
 await mount(undefined,()=>new Promise(resolve=>{release=resolve;}));
 globalThis.fetch=async()=>{posts++;return Response.json({text:"Must not appear"});};
 await act(async()=>dictation.toggle());worklet.audio(8192);
 let finished!:Promise<void>;
 await act(async()=>{finished=dictation.finish();await new Promise(resolve=>setTimeout(resolve,0));});
 await act(async()=>{dictation.cancel();release("ro");await finished;});
 assert.equal(posts,0);assert.deepEqual(appended,[]);assert.equal(dictation.phase,"idle");
});

test("the composer selects signed-in Codex and its keyboard shortcut starts only one recording", async () => {
	const { useDictation } = await import("../components/dictation.tsx");
	let captures = 0;
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => { captures++; return stream; } } } });
	Object.assign(globalThis, { AudioContext: FakeContext, AudioWorkletNode: FakeWorklet });
	globalThis.fetch = async (url) => {
		if (url === "/api/stt/transcribe") return Response.json({ available: true });
		if (url === "/api/stt/token") return Response.json({}, { status: 503 });
		throw new Error(`Unexpected request ${url}`);
	};
	function Harness() { dictation = useDictation({ append: text => appended.push(text) }); return null; }
	const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
	await act(async () => { root!.render(<Harness />); await new Promise(resolve => setTimeout(resolve, 0)); });
	await act(async () => { window.dispatchEvent(new window.Event("lh:kbd-toggle-dictation")); });
	assert.equal(captures, 1);
	assert.equal(dictation.phase, "recording");
	await act(async () => dictation.cancel());
});


test("a failed language read does not upload the recording", async () => {
 await mount(undefined, async () => { throw new Error("Could not load dictation language. Try again."); });
 let uploaded = false;
 globalThis.fetch = async () => { uploaded = true; return Response.json({ text: "" }); };
 await act(async () => dictation.toggle());
 worklet.audio(8192);
 await act(async () => { await dictation.finish(); });
 assert.equal(uploaded, false);
 assert.match(dictation.error ?? "", /Could not load dictation language/);
 assert.deepEqual(appended, []);
});
