/**
 * The Groq dictation path of useDictation: capture frames, wrap one WAV on
 * stop, POST it to /api/stt/transcribe, flush the transcript once. fetch,
 * the microphone and the audio graph are fakes; no network, no real key.
 */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { DictationBar, useDictation, type Dictation } from "../components/dictation.tsx";
import { GROQ_DICTATION_KEYLESS } from "../components/dictation-groq.ts";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { isDictationActive } from "../components/dictation-state.ts";
import { GROQ_DICTATION_HEADER, GROQ_MAX_PCM_BYTES, GROQ_MIN_PCM_BYTES, type UserSettings } from "../src/core/index.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

class Socket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static all: Socket[] = [];
	readyState = Socket.CONNECTING;
	constructor(readonly url: string, readonly protocols: string[]) { super(); Socket.all.push(this); }
	send() {}
	close() { this.readyState = 3; }
}

class AudioGraph {
	state = "running";
	sampleRate = 16000;
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}
class Worklet {
	static all: Worklet[] = [];
	port: { onmessage?: (event: { data: unknown }) => void } = {};
	constructor() { Worklet.all.push(this); }
	connect() {}
	disconnect() {}
	audio(buffer: ArrayBuffer) { this.port.onmessage?.({ data: { type: "audio", buffer } }); }
}

/** n 128 ms frames, as the real worklet posts them. */
const frame = () => new Int16Array(2048).fill(1000).buffer;

interface Post { init: RequestInit; form: FormData }
const globals = globalThis as Record<string, unknown>;
let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;

async function fixture(dictation: UserSettings["dictation"] = { provider: "groq", language: "pl" }) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const state = {
		record: { version: 1, dictation } as UserSettings,
		tokenCalls: 0,
		ready: () => Promise.resolve(Response.json({ ready: true })) as Promise<Response>,
		readyInits: [] as (RequestInit | undefined)[],
		answer: () => Promise.resolve(Response.json({ text: "hello world" })) as Promise<Response>,
		posts: [] as Post[],
		stops: 0,
		appends: [] as string[],
	};
	Socket.all = [];
	Worklet.all = [];
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { state.stops++; } }] }) } },
		WebSocket: Socket, AudioContext: AudioGraph, AudioWorkletNode: Worklet,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/stt/token") { state.tokenCalls++; return Response.json({ token: "test-token" }); }
			if (url === "/api/settings") return Response.json({ settings: state.record });
			assert.equal(url, "/api/stt/transcribe");
			if (init?.method === "POST") { state.posts.push({ init, form: init.body as FormData }); return state.answer(); }
			state.readyInits.push(init);
			return state.ready();
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	};
	const { createRoot } = await import("react-dom/client");
	let latest!: Dictation;
	function Harness() {
		latest = useDictation({ append: (text) => state.appends.push(text) });
		return null;
	}
	const root = createRoot(document.getElementById("root")!);
	dispose = async () => { await act(async () => { root.unmount(); }); };
	await act(async () => { root.render(<Harness />); });
	// Each fixture is a new server record; drop the previous fixture's cached preference.
	await act(async () => { notifySettingsSaved("dictation"); });
	return {
		state,
		get dictation() { return latest; },
		worklet: () => Worklet.all.at(-1)!,
		unmount: () => dispose!(),
		/** Click Dictate and let the mic, readiness check and graph settle. */
		async start() { await act(async () => { latest.toggle(); }); },
		async speak(frames = 4) { await act(async () => { for (let i = 0; i < frames; i++) Worklet.all.at(-1)!.audio(frame()); }); },
	};
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

const wavHeader = (bytes: Uint8Array) => ({
	riff: String.fromCharCode(...bytes.subarray(0, 4)),
	wave: String.fromCharCode(...bytes.subarray(8, 12)),
	rate: new DataView(bytes.buffer, bytes.byteOffset).getUint32(24, true),
});

test("records without a socket or Deepgram token, uploads one WAV on stop, flushes the transcript once", async () => {
	const f = await fixture({ provider: "groq", language: "pl", groqModel: "whisper-large-v3" });
	// Deliberately the first test in the file: the window-lifetime preference
	// store is still empty, so mounting reads this Groq record before deciding
	// whether a Deepgram token is worth warming.
	assert.equal(f.state.tokenCalls, 0, "mounting for a Groq user pre-mints no Deepgram token");
	await f.start();
	assert.equal(f.dictation.phase, "recording");
	assert.equal(Socket.all.length, 0, "Groq never opens a WebSocket");
	assert.equal(f.state.tokenCalls, 0, "a Groq user mints no Deepgram token, at mount or at start");
	assert.equal(f.state.readyInits.length, 1, "the key is checked once, before the user has spoken");
	assert.deepEqual(f.state.readyInits[0]?.headers, { [GROQ_DICTATION_HEADER]: "1" });

	await f.speak(4);
	assert.equal(f.state.posts.length, 0, "nothing is sent while dictating");
	assert.deepEqual(f.state.appends, []);

	const reply = deferred<Response>();
	f.state.answer = () => reply.promise;
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.phase, "stopping");
	assert.equal(f.dictation.transcribing, true);
	assert.equal(isDictationActive(), true, "the settings controls stay locked while transcribing");
	assert.equal(f.state.stops, 1, "the mic dies first");
	assert.equal(f.state.posts.length, 1);

	const { init, form } = f.state.posts[0]!;
	assert.deepEqual(init.headers, { [GROQ_DICTATION_HEADER]: "1" });
	assert.equal(form.get("model"), "whisper-large-v3");
	assert.equal(form.get("language"), "pl");
	const audio = form.get("audio") as File;
	assert.equal(audio.type, "audio/wav");
	assert.equal(audio.size, 44 + 4 * 4096, "the header plus exactly the captured frames");
	assert.deepEqual(wavHeader(new Uint8Array(await audio.arrayBuffer())), { riff: "RIFF", wave: "WAVE", rate: 16000 });
	assert.deepEqual(f.state.appends, [], "the transcript is not inserted until it arrives");

	await act(async () => { reply.resolve(Response.json({ text: "Cześć świecie" })); });
	assert.deepEqual(f.state.appends, ["Cześć świecie"]);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.transcribing, false);
	assert.equal(f.dictation.error, null);
	assert.equal(isDictationActive(), false);
	assert.equal(f.state.tokenCalls, 0, "ending a Groq run does not warm a Deepgram token either");
});

test("the default model is sent when the record names none, and 'multi' goes up for the server to auto-detect", async () => {
	const f = await fixture({ provider: "groq", language: "multi" });
	await f.start();
	await f.speak(4);
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.state.posts[0]!.form.get("model"), "whisper-large-v3-turbo");
	assert.equal(f.state.posts[0]!.form.get("language"), "multi");
});

test("a missing key refuses before any speech is recorded for upload and keeps the line the keys row deep-links from", async () => {
	const f = await fixture();
	f.state.ready = () => Promise.resolve(Response.json({ message: "No GROQ_API_KEY — add it to auth.json" }, { status: 503 }));
	await f.start();
	assert.equal(f.dictation.error, GROQ_DICTATION_KEYLESS);
	assert.equal(GROQ_DICTATION_KEYLESS, "Dictation needs a Groq key");
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.stops, 1, "the mic is released");
	assert.equal(f.state.posts.length, 0);
	assert.equal(isDictationActive(), false);
});

test("a recording too short to mean anything is dropped without a request or an error", async () => {
	const f = await fixture();
	await f.start();
	await f.speak(1);
	assert.ok(4096 < GROQ_MIN_PCM_BYTES, "one frame is under the minimum");
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.state.posts.length, 0);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.error, null);
	assert.deepEqual(f.state.appends, []);
});

test("silence comes back as an empty transcript and inserts nothing", async () => {
	const f = await fixture();
	await f.start();
	await f.speak();
	f.state.answer = () => Promise.resolve(Response.json({ text: "" }));
	await act(async () => { f.dictation.stop(); });
	assert.deepEqual(f.state.appends, []);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.error, null);
});

test("a Groq failure is shown in the button, nothing is inserted, and the next click retries", async () => {
	const f = await fixture();
	await f.start();
	await f.speak();
	f.state.answer = () => Promise.resolve(Response.json({ message: "Groq rate limit reached. Try again in 12 s." }, { status: 429 }));
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.error, "Groq rate limit reached. Try again in 12 s.");
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.transcribing, false);
	assert.deepEqual(f.state.appends, []);
	await f.start();
	assert.equal(f.dictation.error, null, "starting again clears the error");
	assert.equal(f.dictation.phase, "recording");
});

test("a network failure on upload says so instead of throwing", async () => {
	const f = await fixture();
	await f.start();
	await f.speak();
	f.state.answer = () => Promise.reject(new TypeError("fetch failed"));
	await act(async () => { f.dictation.stop(); });
	assert.match(f.dictation.error!, /Could not send the recording/);
	assert.equal(f.dictation.phase, "idle");
});

test("Esc while transcribing aborts the upload and discards the late transcript", async () => {
	const f = await fixture();
	await f.start();
	await f.speak();
	const reply = deferred<Response>();
	f.state.answer = () => reply.promise;
	await act(async () => { f.dictation.stop(); });
	const signal = f.state.posts[0]!.init.signal!;
	assert.equal(signal.aborted, false);
	await act(async () => { f.dictation.cancel(); });
	assert.equal(signal.aborted, true);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(isDictationActive(), false);
	await act(async () => { reply.resolve(Response.json({ text: "too late" })); });
	assert.deepEqual(f.state.appends, []);
});

test("Esc while recording discards the audio: nothing is uploaded", async () => {
	const f = await fixture();
	await f.start();
	await f.speak();
	await act(async () => { f.dictation.cancel(); });
	assert.equal(f.state.posts.length, 0);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.stops, 1);
	assert.deepEqual(f.state.appends, []);
});

test("unmounting while recording releases the mic and uploads nothing", async () => {
	const f = await fixture();
	await f.start();
	await f.speak();
	await f.unmount();
	assert.equal(f.state.stops, 1);
	assert.equal(f.state.posts.length, 0);
	assert.equal(isDictationActive(), false);
	assert.deepEqual(f.state.appends, []);
});

test("unmounting mid-upload aborts it and never appends into another page", async () => {
	const f = await fixture();
	await f.start();
	await f.speak();
	const reply = deferred<Response>();
	f.state.answer = () => reply.promise;
	await act(async () => { f.dictation.stop(); });
	const signal = f.state.posts[0]!.init.signal!;
	await f.unmount();
	assert.equal(signal.aborted, true);
	assert.equal(isDictationActive(), false);
	await act(async () => { reply.resolve(Response.json({ text: "departed" })); });
	assert.deepEqual(f.state.appends, []);
});

test("finish() waits for the transcript, so a submit never loses the spoken tail", async () => {
	const f = await fixture();
	await f.start();
	await f.speak();
	const reply = deferred<Response>();
	f.state.answer = () => reply.promise;
	let finished = false;
	await act(async () => { void f.dictation.finish().then(() => { finished = true; }); });
	assert.equal(f.dictation.transcribing, true);
	assert.equal(finished, false);
	await act(async () => { reply.resolve(Response.json({ text: "tail" })); });
	assert.equal(finished, true);
	assert.deepEqual(f.state.appends, ["tail"]);
});

test("pressing stop while the key check is still in flight keeps the run stopping, not recording", async () => {
	const f = await fixture();
	const ready = deferred<Response>();
	f.state.ready = () => ready.promise;
	await f.start();
	assert.equal(f.dictation.phase, "connecting");
	await f.speak();
	const reply = deferred<Response>();
	f.state.answer = () => reply.promise;
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.phase, "stopping");
	await act(async () => { ready.resolve(Response.json({ ready: true })); });
	assert.equal(f.dictation.phase, "stopping", "a late ready answer must not revive the run");
	await act(async () => { reply.resolve(Response.json({ text: "ok" })); });
	assert.deepEqual(f.state.appends, ["ok"]);
	assert.equal(f.dictation.phase, "idle");
});

test("reaching the recording cap stops and transcribes what was captured, dropping what trails it", async () => {
	const f = await fixture();
	await f.start();
	const reply = deferred<Response>();
	f.state.answer = () => reply.promise;
	await act(async () => {
		const worklet = f.worklet();
		worklet.audio(new ArrayBuffer(GROQ_MAX_PCM_BYTES));
		worklet.audio(frame()); // arrives after the cap: dropped
	});
	assert.equal(f.dictation.phase, "stopping");
	assert.equal(f.dictation.transcribing, true);
	assert.equal(f.state.posts.length, 1, "the cap triggers exactly one upload");
	assert.equal((f.state.posts[0]!.form.get("audio") as File).size, 44 + GROQ_MAX_PCM_BYTES);
	await act(async () => { reply.resolve(Response.json({ text: "long dictation" })); });
	assert.deepEqual(f.state.appends, ["long dictation"]);
	assert.equal(f.dictation.error, null);
});

test("the Deepgram engine is untouched: it streams over a socket and never calls the Groq route", async () => {
	const f = await fixture({ language: "en" });
	await f.start();
	assert.equal(Socket.all.length, 1);
	assert.match(Socket.all[0]!.url, /^wss:\/\/api\.deepgram\.com\/v1\/listen\?model=nova-3/);
	assert.deepEqual(Socket.all[0]!.protocols, ["bearer", "test-token"], "Deepgram still authenticates with a minted token");
	assert.equal(f.state.readyInits.length, 0);
	assert.equal(f.state.posts.length, 0);
	assert.equal(f.dictation.transcribing, false);
	await act(async () => { f.dictation.cancel(); });
});

test("the bar shows Transcribing… with no meter or Stop while Groq works", () => {
	const dictation: Dictation = {
		phase: "stopping", error: null, levelRef: { current: 0 }, active: true, transcribing: true,
		toggle() {}, stop() {}, finish: async () => {}, cancel() {}, clearError() {},
	};
	const html = renderToStaticMarkup(<DictationBar dictation={dictation} />);
	assert.match(html, /Transcribing…/);
	assert.match(html, /disabled/);
	assert.doesNotMatch(html, /dictation-meter/);
	assert.doesNotMatch(html, />Stop</);
	const recording = renderToStaticMarkup(<DictationBar dictation={{ ...dictation, phase: "recording", transcribing: false }} />);
	assert.match(recording, /dictation-meter/);
	assert.match(recording, /Stop/);
});
