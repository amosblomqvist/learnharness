/**
 * The Groq dictation path of useDictation: capture frames, send them to
 * /api/stt/transcribe in chunks while recording, flush the whole transcript
 * once on stop. fetch, the microphone and the audio graph are fakes; no
 * network, no real key. Chunk cutting, ordering, backoff and Retry are tested
 * on their own in dictation-chunks.test.ts and dictation-groq-chunks.test.ts;
 * this file covers how the hook wires them to the UI and the submit paths.
 */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { DictationBar, useDictation, type Dictation } from "../components/dictation.tsx";
import { DraftShell } from "../components/new-session.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { GROQ_DICTATION_KEYLESS } from "../components/dictation-groq.ts";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { isDictationActive, isDictationRetained } from "../components/dictation-state.ts";
import { STOPPED_MESSAGE } from "../components/dictation-groq-chunks.ts";
import { GROQ_DICTATION_HEADER, GROQ_MAX_PCM_BYTES, GROQ_MAX_RECORDING_SECONDS, GROQ_MIN_PCM_BYTES, type QuizToolInput, type UserSettings } from "../src/core/index.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
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

/** `beside` renders next to the hook, which the fixture owns; `standalone`
 * replaces the fixture's hook with a real component that owns its own. */
async function fixture(
	dictation: UserSettings["dictation"] = { provider: "groq", language: "pl" },
	ui: { beside?: React.ReactNode; standalone?: React.ReactNode } = {},
) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const state = {
		record: { version: 1, dictation } as UserSettings,
		tokenCalls: 0,
		ready: () => Promise.resolve(Response.json({ ready: true })) as Promise<Response>,
		readyInits: [] as (RequestInit | undefined)[],
		answer: ((_post: Post) => Promise.resolve(Response.json({ text: "hello world" }))) as (post: Post) => Promise<Response>,
		posts: [] as Post[],
		stops: 0,
		appends: [] as string[],
	};
	Socket.all = [];
	Worklet.all = [];
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { state.stops++; } }] }) } },
		WebSocket: Socket, AudioContext: AudioGraph, AudioWorkletNode: Worklet,
		// DraftShell's conversation pane measures itself; linkedom has neither.
		ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
		getComputedStyle: () => ({ getPropertyValue: () => "", paddingTop: "0px", paddingBottom: "0px" }),
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/stt/token") { state.tokenCalls++; return Response.json({ token: "test-token" }); }
			if (url === "/api/settings") return Response.json({ settings: state.record });
			assert.equal(url, "/api/stt/transcribe");
			if (init?.method === "POST") { const post = { init, form: init.body as FormData }; state.posts.push(post); return state.answer(post); }
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
		return <>{ui.beside}</>;
	}
	const root = createRoot(document.getElementById("root")!);
	dispose = async () => { await act(async () => { root.unmount(); }); };
	await act(async () => { root.render(ui.standalone ?? <Harness />); });
	// Each fixture is a new server record; drop the previous fixture's cached preference.
	await act(async () => { notifySettingsSaved("dictation"); });
	return {
		state,
		host: document.getElementById("root")!,
		get dictation() { return latest; },
		worklet: () => Worklet.all.at(-1)!,
		unmount: () => dispose!(),
		/** Click Dictate and let the mic, readiness check and graph settle. */
		async start() { await act(async () => { latest.toggle(); }); },
		async speak(frames = 4) { await act(async () => { for (let i = 0; i < frames; i++) Worklet.all.at(-1)!.audio(frame()); }); },
	};
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

/** A 429 whose Retry-After is too long to wait out, so it surfaces at once instead of being retried. */
const RATE_LIMIT_LINE = "Groq rate limit reached. Try again in 10 min.";
const rateLimited = () => Promise.resolve(Response.json({ message: RATE_LIMIT_LINE, retryable: true }, { status: 429, headers: { "retry-after": "600" } }));
/** A Groq failure sending the same request again cannot fix. */
const refused = (message: string) => Promise.resolve(Response.json({ message, retryable: false }, { status: 502 }));

const wavHeader = (bytes: Uint8Array) => ({
	riff: String.fromCharCode(...bytes.subarray(0, 4)),
	wave: String.fromCharCode(...bytes.subarray(8, 12)),
	rate: new DataView(bytes.buffer, bytes.byteOffset).getUint32(24, true),
});

test("records without a socket or Deepgram token, sends the audio on stop, flushes the transcript once", async () => {
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

test("a Groq failure is shown in the button, nothing is inserted, and the next click records again", async () => {
	const f = await fixture();
	await f.start();
	await f.speak();
	f.state.answer = rateLimited;
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.error, RATE_LIMIT_LINE);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.transcribing, false);
	assert.deepEqual(f.state.appends, []);
	await f.start();
	assert.equal(f.dictation.error, null, "starting again clears the error");
	assert.equal(f.dictation.phase, "recording");
});

test("a network failure on upload is retried with backoff, then says so instead of throwing", async () => {
	const f = await fixture();
	await f.start();
	await f.speak();
	f.state.answer = () => Promise.reject(new TypeError("fetch failed"));
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		await act(async () => { f.dictation.stop(); });
		assert.equal(f.state.posts.length, 1);
		assert.equal(f.dictation.transcribing, true, "waiting to try again, not failed yet");
		await act(async () => { mock.timers.tick(1000); });
		assert.equal(f.state.posts.length, 2, "the first retry after 1 s");
		await act(async () => { mock.timers.tick(2000); });
		assert.equal(f.state.posts.length, 3, "the second after 2 s more, and the last");
	} finally {
		mock.timers.reset();
	}
	assert.match(f.dictation.error!, /Could not send the recording/);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.retryable, true, "the audio is kept");
});

test("a transient failure that clears on the automatic retry never shows an error", async () => {
	const f = await fixture();
	await f.start();
	await f.speak();
	let calls = 0;
	f.state.answer = () => Promise.resolve(++calls === 1
		? Response.json({ message: "Groq is unavailable (503). Try again shortly.", retryable: true }, { status: 502 })
		: Response.json({ text: "second go" }));
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		await act(async () => { f.dictation.stop(); });
		await act(async () => { mock.timers.tick(1000); });
	} finally {
		mock.timers.reset();
	}
	assert.deepEqual(f.state.appends, ["second go"]);
	assert.equal(f.dictation.error, null);
	assert.equal(f.dictation.retryable, false);
});

test("Esc while finishing stops the waiting but keeps the audio for Retry, and the late transcript is discarded", async () => {
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
	assert.equal(f.dictation.retryable, true, "the user ended the recording; Esc does not throw it away");
	assert.equal(f.dictation.error, STOPPED_MESSAGE);
	await act(async () => { reply.resolve(Response.json({ text: "too late" })); });
	assert.deepEqual(f.state.appends, []);
	f.state.answer = () => Promise.resolve(Response.json({ text: "after esc" }));
	await act(async () => { f.dictation.retry(); });
	assert.deepEqual(f.state.appends, ["after esc"], "Retry finishes it");
	assert.equal(f.state.posts.length, 2);
});

test("Esc while recording discards the audio: nothing is uploaded and nothing is kept", async () => {
	const f = await fixture();
	await f.start();
	await f.speak();
	await act(async () => { f.dictation.cancel(); });
	assert.equal(f.state.posts.length, 0);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.retryable, false);
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
	let finished: boolean | undefined;
	await act(async () => { void f.dictation.finish().then((ok) => { finished = ok; }); });
	assert.equal(f.dictation.transcribing, true);
	assert.equal(finished, undefined);
	await act(async () => { reply.resolve(Response.json({ text: "tail" })); });
	assert.equal(finished, true, "a transcript that landed lets the submit carry on");
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
	let n = 0;
	f.state.answer = () => Promise.resolve(Response.json({ text: `part${++n}` }));
	await act(async () => {
		const worklet = f.worklet();
		worklet.audio(new Int16Array(GROQ_MAX_PCM_BYTES / 2).fill(1000).buffer); // the whole allowance at once
		worklet.audio(frame()); // arrives after the cap: dropped
	});
	assert.equal(f.dictation.error, null);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.posts.length, GROQ_MAX_RECORDING_SECONDS / 15, "twenty minutes in fifteen-second chunks");
	assert.equal(f.state.stops, 1, "the cap stopped the run");
	assert.equal(f.state.appends.length, 1, "one insertion for the whole run");
	assert.equal(f.state.appends[0]!.split(" ").length, GROQ_MAX_RECORDING_SECONDS / 15);
	assert.match(f.state.appends[0]!, /^part1 part2 /);
	const sent = f.state.posts.reduce((total, p) => total + (p.form.get("audio") as File).size - 44, 0);
	assert.equal(sent, GROQ_MAX_PCM_BYTES, "everything up to the cap was sent, and nothing after it");
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

test("the bar shows Finishing transcription… with no meter or Stop while Groq works", () => {
	const dictation: Dictation = {
		phase: "stopping", error: null, levelRef: { current: 0 }, active: true, transcribing: true,
		retryable: false, retry() {}, toggle() {}, stop() {}, finish: async () => true, cancel() {}, clearError() {},
	};
	const html = renderToStaticMarkup(<DictationBar dictation={dictation} />);
	assert.match(html, /Finishing transcription…/);
	assert.match(html, /disabled/);
	assert.doesNotMatch(html, /dictation-meter/);
	assert.doesNotMatch(html, />Stop</);
	const recording = renderToStaticMarkup(<DictationBar dictation={{ ...dictation, phase: "recording", transcribing: false }} />);
	assert.match(recording, /dictation-meter/);
	assert.match(recording, /Stop/);
});

// ---------------------------------------------------------------------------
// A failed Groq upload keeps the recording (S1): Retry re-sends it, and no
// submit path sends a draft that is missing the spoken part.
// ---------------------------------------------------------------------------


/** Record, then stop into an upload that fails: leaves a kept recording. */
async function failedRecording(f: Awaited<ReturnType<typeof fixture>>) {
	await f.start();
	await f.speak();
	f.state.answer = rateLimited;
	await act(async () => { f.dictation.stop(); });
}

const audioBytes = async (post: Post) => new Uint8Array(await (post.form.get("audio") as File).arrayBuffer());

test("a failed upload keeps the recording: Retry is on offer, nothing is inserted, finish() reports it unsent", async () => {
	const f = await fixture();
	await f.start();
	await f.speak();
	f.state.answer = rateLimited;
	let finished: boolean | undefined;
	await act(async () => { void f.dictation.finish().then((ok) => { finished = ok; }); });
	assert.equal(finished, false, "the submit waiting on the finish must abort");
	assert.equal(f.dictation.error, RATE_LIMIT_LINE);
	assert.equal(f.dictation.retryable, true);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(isDictationRetained(), true);
	assert.deepEqual(f.state.appends, []);
	// A later submit attempt, with the recorder idle, is refused the same way.
	let again: boolean | undefined;
	await act(async () => { void f.dictation.finish().then((ok) => { again = ok; }); });
	assert.equal(again, false, "an idle recorder with a kept recording still reports speech unsent");
});

test("Retry re-sends the same recording and inserts the text once it succeeds", async () => {
	const f = await fixture();
	await failedRecording(f);
	const first = await audioBytes(f.state.posts[0]!);
	const reply = deferred<Response>();
	f.state.answer = () => reply.promise;
	await act(async () => { f.dictation.retry(); });
	assert.equal(f.dictation.phase, "stopping");
	assert.equal(f.dictation.transcribing, true);
	assert.equal(isDictationActive(), true);
	assert.equal(f.state.posts.length, 2);
	assert.deepEqual(await audioBytes(f.state.posts[1]!), first, "the very same WAV goes up again");
	assert.equal(f.state.posts[1]!.form.get("language"), "pl");
	assert.deepEqual(f.state.appends, []);
	await act(async () => { f.dictation.retry(); });
	assert.equal(f.state.posts.length, 2, "a second click while uploading sends nothing");
	await act(async () => { reply.resolve(Response.json({ text: "second try" })); });
	assert.deepEqual(f.state.appends, ["second try"]);
	assert.equal(f.dictation.error, null);
	assert.equal(f.dictation.retryable, false, "success drops the recording");
	assert.equal(isDictationRetained(), false);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(isDictationActive(), false);
	let done: boolean | undefined;
	await act(async () => { void f.dictation.finish().then((ok) => { done = ok; }); });
	assert.equal(done, true);
	await act(async () => { f.dictation.retry(); });
	assert.equal(f.state.posts.length, 2, "nothing is left to retry");
});

test("a Retry that fails again keeps the recording for another go", async () => {
	const f = await fixture();
	await failedRecording(f);
	f.state.answer = () => refused("Groq is unavailable (503). Try again shortly.");
	await act(async () => { f.dictation.retry(); });
	assert.equal(f.dictation.error, "Groq is unavailable (503). Try again shortly.");
	assert.equal(f.dictation.retryable, true);
	assert.equal(f.dictation.phase, "idle");
	f.state.answer = () => Promise.resolve(Response.json({ text: "third time" }));
	await act(async () => { f.dictation.retry(); });
	assert.deepEqual(f.state.appends, ["third time"]);
	assert.equal(f.dictation.retryable, false);
	assert.equal(f.state.posts.length, 3);
});

test("Esc during a Retry cancels the request but does not drop the recording", async () => {
	const f = await fixture();
	await failedRecording(f);
	const reply = deferred<Response>();
	f.state.answer = () => reply.promise;
	await act(async () => { f.dictation.retry(); });
	const signal = f.state.posts[1]!.init.signal!;
	await act(async () => { f.dictation.cancel(); });
	assert.equal(signal.aborted, true);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.retryable, true, "only success, dismissal or a new recording drop it");
	assert.equal(f.dictation.error, STOPPED_MESSAGE);
	await act(async () => { reply.resolve(Response.json({ text: "too late" })); });
	assert.deepEqual(f.state.appends, []);
	f.state.answer = () => Promise.resolve(Response.json({ text: "after esc" }));
	await act(async () => { f.dictation.retry(); });
	assert.deepEqual(f.state.appends, ["after esc"]);
});

test("dismissing the error discards the recording", async () => {
	const f = await fixture();
	await failedRecording(f);
	await act(async () => { f.dictation.clearError(); });
	assert.equal(f.dictation.error, null);
	assert.equal(f.dictation.retryable, false);
	assert.equal(isDictationRetained(), false);
	await act(async () => { f.dictation.retry(); });
	assert.equal(f.state.posts.length, 1, "there is nothing left to send");
	let done: boolean | undefined;
	await act(async () => { void f.dictation.finish().then((ok) => { done = ok; }); });
	assert.equal(done, true, "a dismissed recording no longer blocks a submit");
});

test("starting a new recording discards the kept one", async () => {
	const f = await fixture();
	await failedRecording(f);
	assert.equal(f.dictation.retryable, true);
	await f.start();
	assert.equal(f.dictation.phase, "recording");
	assert.equal(f.dictation.error, null);
	assert.equal(f.dictation.retryable, false);
	assert.equal(isDictationRetained(), false);
	await f.speak();
	f.state.answer = () => Promise.resolve(Response.json({ text: "fresh" }));
	await act(async () => { f.dictation.stop(); });
	assert.deepEqual(f.state.appends, ["fresh"], "only the new recording is transcribed");
	assert.equal(f.state.posts.length, 2);
	assert.equal(f.state.posts.filter((p) => p.form.get("audio") !== null).length, 2);
});

test("unmounting drops a kept recording", async () => {
	const f = await fixture();
	await failedRecording(f);
	assert.equal(isDictationRetained(), true);
	await f.unmount();
	assert.equal(isDictationRetained(), false);
	assert.deepEqual(f.state.appends, []);
});

test("unmounting mid-Retry aborts it, drops the recording and neither throws nor appends", async () => {
	const f = await fixture();
	await failedRecording(f);
	const reply = deferred<Response>();
	f.state.answer = () => reply.promise;
	await act(async () => { f.dictation.retry(); });
	const signal = f.state.posts[1]!.init.signal!;
	await f.unmount();
	assert.equal(signal.aborted, true);
	assert.equal(isDictationActive(), false);
	assert.equal(isDictationRetained(), false);
	await act(async () => { reply.resolve(Response.json({ text: "departed" })); });
	assert.deepEqual(f.state.appends, []);
});

test("unmounting mid-upload of a first attempt that then fails keeps nothing", async () => {
	const f = await fixture();
	await f.start();
	await f.speak();
	const reply = deferred<Response>();
	f.state.answer = () => reply.promise;
	await act(async () => { f.dictation.stop(); });
	await f.unmount();
	await act(async () => { reply.resolve(Response.json({ message: "late failure", retryable: true }, { status: 502 })); });
	assert.equal(isDictationRetained(), false, "a recording whose page is gone must not be kept");
});

test("the Deepgram engine never keeps a recording and finish() resolves true", async () => {
	const f = await fixture({ language: "en" });
	await f.start();
	assert.equal(f.dictation.retryable, false);
	let done: boolean | undefined;
	await act(async () => { void f.dictation.finish().then((ok) => { done = ok; }); });
	assert.equal(done, true);
	assert.equal(f.dictation.retryable, false);
	assert.equal(isDictationRetained(), false);
});

const QUIZ = {
	question: "Is seven odd?",
	options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
	correctAnswer: "yes",
	explanation: "Seven is odd.",
} as unknown as QuizToolInput;

const typeInto = (editor: Element, text: string) => {
	editor.textContent = text;
	editor.dispatchEvent(new window.Event("input", { bubbles: true }));
};

test("question dock: a failed upload while submitting keeps the draft and does not submit; Retry then fills the field", async () => {
	const submitted: { thinking?: string }[] = [];
	const f = await fixture(undefined, {
		beside: <QuestionDock toolName="quiz" toolCallId="q1" input={QUIZ} expanded onExpand={() => {}}
			onSubmit={(answer) => { submitted.push(answer); }} dictationClaim />,
	});
	const thinking = () => f.host.querySelector<HTMLElement>('[data-testid="thinking-field"] [data-file-path-input]')!;
	const submit = () => act(async () => {
		f.host.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
	});
	await act(async () => {
		f.host.querySelector<HTMLButtonElement>('[role="radio"]')!.click();
		typeInto(thinking(), "typed so far");
	});
	await f.start();
	await f.speak();
	f.state.answer = rateLimited;

	await submit(); // Enter while still recording: finish, upload fails
	assert.equal(submitted.length, 0, "the answer is not sent without the spoken part");
	assert.equal(f.dictation.error, RATE_LIMIT_LINE);
	assert.equal(f.dictation.retryable, true);
	assert.equal(thinking().textContent, "typed so far", "the draft is untouched");
	assert.ok(f.host.querySelector('[role="radio"][aria-checked="true"]'), "so is the selection");

	await submit(); // Enter again, recorder idle but speech still unsent
	assert.equal(submitted.length, 0, "a second Enter does not slip it through");

	f.state.answer = () => Promise.resolve(Response.json({ text: "and spoken" }));
	await act(async () => { f.dictation.retry(); });
	assert.equal(submitted.length, 0, "Retry never submits by itself");
	assert.equal(thinking().textContent, "typed so far and spoken", "the transcript lands in the dock's field");

	await submit();
	assert.equal(submitted.length, 1);
	assert.equal(submitted[0]!.thinking, "typed so far and spoken");
});

test("question dock: dismissing the failed recording lets the draft submit as typed", async () => {
	const submitted: { thinking?: string }[] = [];
	const f = await fixture(undefined, {
		beside: <QuestionDock toolName="quiz" toolCallId="q1" input={QUIZ} expanded onExpand={() => {}}
			onSubmit={(answer) => { submitted.push(answer); }} dictationClaim />,
	});
	const submit = () => act(async () => {
		f.host.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
	});
	await act(async () => {
		f.host.querySelector<HTMLButtonElement>('[role="radio"]')!.click();
		typeInto(f.host.querySelector('[data-testid="thinking-field"] [data-file-path-input]')!, "just typed");
	});
	await failedRecording(f);
	await submit();
	assert.equal(submitted.length, 0);
	await act(async () => { f.dictation.clearError(); });
	await submit();
	assert.equal(submitted.length, 1);
	assert.equal(submitted[0]!.thinking, "just typed");
});

test("question dock with the Deepgram engine still submits straight away when idle", async () => {
	const submitted: unknown[] = [];
	const f = await fixture({ language: "en" }, {
		beside: <QuestionDock toolName="quiz" toolCallId="q1" input={QUIZ} expanded onExpand={() => {}}
			onSubmit={(answer) => { submitted.push(answer); }} dictationClaim />,
	});
	await act(async () => { f.host.querySelector<HTMLButtonElement>('[role="radio"]')!.click(); });
	await act(async () => {
		f.host.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
	});
	assert.equal(submitted.length, 1);
});

test("composer: a failed upload while sending keeps the draft and sends nothing; Retry fills it; the next send goes through", async () => {
	const sent: string[] = [];
	const changes: string[] = [];
	let draft = "my draft";
	const f = await fixture(undefined, { standalone: <Composing draft={() => draft} changes={changes} sent={sent} /> });
	const send = () => act(async () => {
		f.host.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
	});
	const click = (testid: string) => act(async () => { f.host.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!.click(); });
	await click("dictation-toggle");
	await f.speak();
	f.state.answer = rateLimited;

	await send(); // Enter while still recording
	assert.deepEqual(sent, [], "nothing is sent without the spoken part");
	assert.deepEqual(changes, [], "the draft is not touched");
	assert.match(f.host.textContent!, new RegExp(RATE_LIMIT_LINE));
	assert.ok(f.host.querySelector('[data-testid="dictation-retry"]'), "the bar offers Retry");

	await send(); // and a second Enter
	assert.deepEqual(sent, []);

	f.state.answer = () => Promise.resolve(Response.json({ text: "plus speech" }));
	await click("dictation-retry");
	assert.deepEqual(sent, [], "Retry never sends");
	assert.deepEqual(changes, ["my draft plus speech"], "the transcript joins the draft");
	assert.equal(f.host.querySelector('[data-testid="dictation-retry"]'), null);

	draft = "my draft plus speech";
	await send();
	assert.deepEqual(sent, ["my draft plus speech"]);
});

test("composer: the discard button drops the recording and the draft sends as typed", async () => {
	const sent: string[] = [];
	const f = await fixture(undefined, { standalone: <Composing draft={() => "typed only"} changes={[]} sent={sent} /> });
	const send = () => act(async () => {
		f.host.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
	});
	await act(async () => { f.host.querySelector<HTMLButtonElement>('[data-testid="dictation-toggle"]')!.click(); });
	await f.speak();
	f.state.answer = rateLimited;
	await send();
	assert.deepEqual(sent, []);
	await act(async () => { f.host.querySelector<HTMLButtonElement>('[data-testid="dictation-discard"]')!.click(); });
	assert.equal(f.host.querySelector('[data-testid="dictation-retry"]'), null);
	assert.doesNotMatch(f.host.textContent!, new RegExp(RATE_LIMIT_LINE));
	await send();
	assert.deepEqual(sent, ["typed only"]);
});

/** The draft composer, which owns its own useDictation. */
function Composing({ draft, changes, sent }: { draft: () => string; changes: string[]; sent: string[] }) {
	return <DraftShell busy={false} text={draft()} onChange={(v) => { changes.push(v); }} onSend={() => { sent.push(draft()); }} />;
}

test("the bar offers Retry and Discard only while a recording is kept", () => {
	const idle: Dictation = {
		phase: "idle", error: RATE_LIMIT_LINE, levelRef: { current: 0 }, active: false, transcribing: false,
		retryable: true, retry() {}, toggle() {}, stop() {}, finish: async () => false, cancel() {}, clearError() {},
	};
	const kept = renderToStaticMarkup(<DictationBar dictation={idle} />);
	assert.match(kept, /data-testid="dictation-retry"/);
	assert.match(kept, /data-testid="dictation-discard"/);
	assert.match(kept, new RegExp(RATE_LIMIT_LINE));
	const plain = renderToStaticMarkup(<DictationBar dictation={{ ...idle, retryable: false }} />);
	assert.doesNotMatch(plain, /dictation-retry|dictation-discard/);
	assert.match(plain, new RegExp(RATE_LIMIT_LINE));
	const working = renderToStaticMarkup(<DictationBar dictation={{ ...idle, phase: "stopping", active: true, transcribing: true }} />);
	assert.doesNotMatch(working, /dictation-retry/, "no Retry while an upload is in flight");
});

test("a key that went missing mid-session leaves the kept recording alone when the keyless button opens Settings", async () => {
	const f = await fixture(undefined, { standalone: <Composing draft={() => ""} changes={[]} sent={[]} /> });
	await act(async () => { f.host.querySelector<HTMLButtonElement>('[data-testid="dictation-toggle"]')!.click(); });
	await f.speak();
	f.state.answer = () => Promise.resolve(Response.json({ message: "No GROQ_API_KEY" }, { status: 503 }));
	await act(async () => { f.host.querySelector<HTMLButtonElement>('[data-testid="dictation-toggle"]')!.click(); });
	assert.match(f.host.textContent!, new RegExp(GROQ_DICTATION_KEYLESS));
	assert.ok(f.host.querySelector('[data-testid="dictation-retry"]'));
	await act(async () => { f.host.querySelector<HTMLButtonElement>('[data-testid="dictation-toggle"]')!.click(); });
	assert.ok(f.host.querySelector('[data-testid="dictation-retry"]'), "the recording is still there after the deep link");
	assert.equal(isDictationRetained(), true);
});

// ---------------------------------------------------------------------------
// Chunked transcription: the audio goes up in pieces while the user is still
// talking, nothing shows until the stop, and the whole text lands once, in order.
// ---------------------------------------------------------------------------

/** Frames in a given number of seconds (the worklet posts 128 ms frames). */
const framesFor = (seconds: number) => Math.round(seconds / 0.128);
/** Answer each request with "chunk<n>" in call order. */
const numbered = (f: Awaited<ReturnType<typeof fixture>>) => {
	let n = 0;
	f.state.answer = () => Promise.resolve(Response.json({ text: `chunk${++n}` }));
};

test("chunks are sent while recording continues; nothing shows until the stop, then one ordered insertion", async () => {
	const f = await fixture();
	numbered(f);
	await f.start();
	await f.speak(framesFor(18.1)); // 18 s buffered: the first chunk is cut and sent
	assert.equal(f.state.posts.length, 1, "the first chunk went out during the recording");
	assert.equal(f.dictation.phase, "recording");
	assert.equal(f.dictation.transcribing, false);
	assert.deepEqual(f.state.appends, [], "its text is held back");
	assert.equal(f.dictation.error, null);
	assert.equal(f.state.posts[0]!.form.get("prompt"), null, "the first chunk has nothing to continue from");

	await f.speak(framesFor(21.9)); // about 40 s: the second chunk at ~33 s
	assert.equal(f.state.posts.length, 2);
	assert.equal(f.dictation.phase, "recording");
	assert.deepEqual(f.state.appends, [], "still nothing in the composer");
	assert.equal(f.state.posts[1]!.form.get("prompt"), "chunk1", "the second continues from the first");

	const last = deferred<Response>();
	f.state.answer = () => last.promise;
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.state.posts.length, 3, "stop sends the last, partial chunk");
	assert.equal(f.dictation.phase, "stopping");
	assert.equal(f.dictation.transcribing, true, "waiting only for that last chunk");
	assert.deepEqual(f.state.appends, []);
	await act(async () => { last.resolve(Response.json({ text: "chunk3" })); });
	assert.deepEqual(f.state.appends, ["chunk1 chunk2 chunk3"], "the whole transcript, once, in order");
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.error, null);
	assert.equal(f.dictation.retryable, false);
	const sizes = await Promise.all(f.state.posts.map(async (p) => (await audioBytes(p)).length - 44));
	assert.equal(sizes.reduce((a, b) => a + b, 0), framesFor(18.1) * 4096 + framesFor(21.9) * 4096, "all the audio, once");
});

test("a chunk that fails for good holds back the whole transcript; Retry re-sends only that chunk and inserts everything in order", async () => {
	const f = await fixture();
	const replies = [Promise.resolve(Response.json({ text: "one" })), refused("Groq could not process the audio (400)."), Promise.resolve(Response.json({ text: "three" }))];
	f.state.answer = () => replies.shift() ?? Promise.reject(new Error("unexpected request"));
	await f.start();
	await f.speak(framesFor(40));
	assert.equal(f.state.posts.length, 2, "the failure happened in the background, silently");
	assert.equal(f.dictation.error, null, "nothing is shown until the stop");
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.state.posts.length, 3);
	assert.equal(f.dictation.error, "Groq could not process the audio (400).");
	assert.equal(f.dictation.retryable, true);
	assert.deepEqual(f.state.appends, [], "no partial transcript");
	let finished: boolean | undefined;
	await act(async () => { void f.dictation.finish().then((ok) => { finished = ok; }); });
	assert.equal(finished, false);

	const failedAudio = await audioBytes(f.state.posts[1]!);
	f.state.answer = () => Promise.resolve(Response.json({ text: "two" }));
	await act(async () => { f.dictation.retry(); });
	assert.equal(f.state.posts.length, 4, "exactly one more request: the failed chunk");
	assert.deepEqual(await audioBytes(f.state.posts[3]!), failedAudio);
	assert.equal(f.state.posts[3]!.form.get("prompt"), "one");
	assert.deepEqual(f.state.appends, ["one two three"], "the full transcript, in order, once");
	assert.equal(f.dictation.retryable, false);
	assert.equal(f.dictation.error, null);
	assert.equal(isDictationRetained(), false);
});

test("two stops on the same recording upload one final chunk and keep the transcript", async () => {
	const f = await fixture();
	numbered(f);
	await f.start();
	await f.speak(framesFor(3));
	await act(async () => {
		// Both calls see the same render closure, as the cap callback and a click can.
		f.dictation.stop();
		f.dictation.stop();
	});
	assert.equal(f.state.posts.length, 1, "no second upload");
	assert.ok((await audioBytes(f.state.posts[0]!)).length > 44, "and no empty header-only chunk");
	assert.deepEqual(f.state.appends, ["chunk1"], "the transcript is not dropped");
	assert.equal(f.dictation.error, null);
});

test("stop() followed by finish() in the same tick still ends once, and finish waits for the transcript", async () => {
	const f = await fixture();
	numbered(f);
	await f.start();
	await f.speak(framesFor(3));
	let finished: boolean | undefined;
	await act(async () => {
		f.dictation.stop();
		void f.dictation.finish().then((ok) => { finished = ok; });
	});
	assert.equal(f.state.posts.length, 1);
	assert.deepEqual(f.state.appends, ["chunk1"]);
	assert.equal(finished, true);
});

test("Esc while recording after chunks went out discards them all and keeps nothing", async () => {
	const f = await fixture();
	const reply = deferred<Response>();
	f.state.answer = () => reply.promise; // the first chunk is still in flight
	await f.start();
	await f.speak(framesFor(19));
	const signal = f.state.posts[0]!.init.signal!;
	await act(async () => { f.dictation.cancel(); });
	assert.equal(signal.aborted, true, "the request in flight is aborted");
	assert.equal(f.dictation.retryable, false);
	assert.equal(f.dictation.error, null);
	assert.equal(isDictationRetained(), false);
	await act(async () => { reply.resolve(Response.json({ text: "late" })); });
	assert.deepEqual(f.state.appends, []);
	assert.equal(f.state.posts.length, 1, "nothing queued behind it was sent");
});

test("unmounting mid-run aborts the request in flight, sends nothing queued behind it, and does not throw", async () => {
	const f = await fixture();
	const reply = deferred<Response>();
	f.state.answer = () => reply.promise;
	await f.start();
	await f.speak(framesFor(40)); // two chunks cut; the first is stuck in flight
	assert.equal(f.state.posts.length, 1);
	const signal = f.state.posts[0]!.init.signal!;
	await f.unmount();
	assert.equal(signal.aborted, true);
	assert.equal(isDictationActive(), false);
	assert.equal(isDictationRetained(), false);
	await act(async () => { reply.reject(signal.reason); });
	assert.equal(f.state.posts.length, 1, "the second chunk was never sent");
	assert.deepEqual(f.state.appends, []);
});

test("unmounting while waiting to retry a failed chunk cancels the retry", async () => {
	const f = await fixture();
	f.state.answer = () => Promise.resolve(Response.json({ message: "Groq is unavailable (503).", retryable: true }, { status: 502 }));
	await f.start();
	await f.speak();
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		await act(async () => { f.dictation.stop(); });
		assert.equal(f.state.posts.length, 1);
		await f.unmount();
		await act(async () => { mock.timers.tick(10_000); });
		assert.equal(f.state.posts.length, 1, "the backoff timer was cancelled");
	} finally {
		mock.timers.reset();
	}
	assert.equal(isDictationRetained(), false);
});

test("question dock: a chunk that failed in the background still aborts the submit and keeps the draft; Retry fills the field in order", async () => {
	const submitted: { thinking?: string }[] = [];
	const f = await fixture(undefined, {
		beside: <QuestionDock toolName="quiz" toolCallId="q1" input={QUIZ} expanded onExpand={() => {}}
			onSubmit={(answer) => { submitted.push(answer); }} dictationClaim />,
	});
	const thinking = () => f.host.querySelector<HTMLElement>('[data-testid="thinking-field"] [data-file-path-input]')!;
	const submit = () => act(async () => {
		f.host.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
	});
	await act(async () => {
		f.host.querySelector<HTMLButtonElement>('[role="radio"]')!.click();
		typeInto(thinking(), "typed so far");
	});
	const replies = [refused("Groq is unavailable (500)."), Promise.resolve(Response.json({ text: "the second half" }))];
	f.state.answer = () => replies.shift()!;
	await f.start();
	await f.speak(framesFor(25)); // chunk 1 (cut near 15 s) fails in the background while recording
	assert.equal(f.dictation.error, null);

	await submit(); // Enter while still recording: finish, the first part failed
	assert.equal(submitted.length, 0, "the answer is not sent without the first part of the speech");
	assert.equal(thinking().textContent, "typed so far", "the draft is untouched");
	assert.equal(f.dictation.retryable, true);
	assert.equal(f.dictation.error, "Groq is unavailable (500).");

	f.state.answer = () => Promise.resolve(Response.json({ text: "the first half" }));
	await act(async () => { f.dictation.retry(); });
	assert.equal(f.state.posts.length, 3, "only the failed chunk went again");
	assert.equal(thinking().textContent, "typed so far the first half the second half", "both parts, in order");
	await submit();
	assert.equal(submitted.length, 1);
	assert.equal(submitted[0]!.thinking, "typed so far the first half the second half");
});

test("composer: a chunk that failed in the background aborts the send and keeps the draft", async () => {
	const sent: string[] = [];
	const changes: string[] = [];
	const f = await fixture(undefined, { standalone: <Composing draft={() => "my draft"} changes={changes} sent={sent} /> });
	const send = () => act(async () => {
		f.host.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
	});
	const replies = [refused("Groq is unavailable (500)."), Promise.resolve(Response.json({ text: "tail" }))];
	f.state.answer = () => replies.shift()!;
	await act(async () => { f.host.querySelector<HTMLButtonElement>('[data-testid="dictation-toggle"]')!.click(); });
	await f.speak(framesFor(25));
	await send();
	assert.deepEqual(sent, [], "nothing is sent");
	assert.deepEqual(changes, [], "the draft is not touched");
	assert.ok(f.host.querySelector('[data-testid="dictation-retry"]'));
	assert.match(f.host.textContent!, /Groq is unavailable \(500\)\./);
});

// ---------------------------------------------------------------------------
// The bar: whole errors, and announcements for screen readers.
// ---------------------------------------------------------------------------

const LONG_ERROR = "Groq rejected the API key (401). Check GROQ_API_KEY in Settings → Providers. This message is long on purpose.";
const barOf = (over: Partial<Dictation>): Dictation => ({
	phase: "idle", error: null, levelRef: { current: 0 }, active: false, transcribing: false,
	retryable: false, retry() {}, toggle() {}, stop() {}, finish: async () => true, cancel() {}, clearError() {},
	...over,
});
const region = (html: string, role: string) => new RegExp(`<div role="${role}"[^>]*>([^<]*)</div>`).exec(html)?.[1];

test("a long error is shown in full, wrapped, with Retry and Dismiss still on screen", () => {
	const html = renderToStaticMarkup(<DictationBar dictation={barOf({ error: LONG_ERROR, retryable: true })} />);
	const button = /<button[^>]*data-testid="dictation-toggle"[\s\S]*?<\/button>/.exec(html)![0];
	assert.ok(button.includes(LONG_ERROR), "the whole message is in the button");
	assert.match(button, /whitespace-normal/);
	assert.doesNotMatch(button, /truncate/, "no ellipsis cuts it off");
	assert.match(button, /min-h-7/, "the button grows with the text instead of clipping it");
	assert.match(html, /data-testid="dictation-retry"/);
	assert.match(html, /data-testid="dictation-discard"[^>]*>[\s\S]*?Dismiss/);
	assert.match(html, /shrink-0[^"]*"[^>]*data-testid="dictation-retry"|data-testid="dictation-retry"[^>]*shrink-0/, "Retry never shrinks away");
});

test("an error without a kept recording wraps too, and the idle button keeps its one-line look", () => {
	const failed = renderToStaticMarkup(<DictationBar dictation={barOf({ error: LONG_ERROR })} />);
	assert.match(failed, /whitespace-normal/);
	const idle = renderToStaticMarkup(<DictationBar dictation={barOf({})} />);
	assert.match(idle, /class="flex h-7 w-full[^"]*"/);
	assert.match(idle, /<span class="max-w-full truncate">Dictate<\/span>/);
});

test("screen readers are told about waiting for the transcript (polite) and about a failure (alert)", () => {
	const idle = renderToStaticMarkup(<DictationBar dictation={barOf({})} />);
	assert.match(idle, /role="status" aria-live="polite"/, "the live regions exist before anything happens");
	assert.match(idle, /role="alert"/);
	assert.equal(region(idle, "status"), "");
	assert.equal(region(idle, "alert"), "");

	const finishing = renderToStaticMarkup(<DictationBar dictation={barOf({ phase: "stopping", active: true, transcribing: true })} />);
	assert.equal(region(finishing, "status"), "Finishing transcription…");
	assert.equal(region(finishing, "alert"), "");

	const failed = renderToStaticMarkup(<DictationBar dictation={barOf({ error: LONG_ERROR, retryable: true })} />);
	assert.equal(region(failed, "alert"), LONG_ERROR);
	assert.equal(region(failed, "status"), "");

	const retrying = renderToStaticMarkup(<DictationBar dictation={barOf({ error: LONG_ERROR, retryable: true, phase: "stopping", active: true, transcribing: true })} />);
	assert.equal(region(retrying, "alert"), "", "the old error is not read out again while a retry runs");
	assert.equal(region(retrying, "status"), "Finishing transcription…");
});

test("the announcements are hidden visually and do not change the layout", () => {
	const html = renderToStaticMarkup(<DictationBar dictation={barOf({})} />);
	assert.match(html, /<div role="status" aria-live="polite" class="sr-only"/);
	assert.match(html, /<div role="alert" class="sr-only"/);
});
