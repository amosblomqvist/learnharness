import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { STOP_QUIET_MS, useDictation, type Dictation } from "../components/dictation.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { useDictationLanguage } from "../components/dictation-preference.ts";
import { isDictationActive, useDictationActive } from "../components/dictation-state.ts";
import type { UserSettings } from "../src/core/index.ts";

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
	sent: unknown[] = [];
	constructor(readonly url: string, readonly protocols: string[]) { super(); Socket.all.push(this); }
	get language() { return new URL(this.url).searchParams.get("language"); }
	send(data: unknown) { this.sent.push(data); }
	close() { this.readyState = 3; }
	open() { this.readyState = Socket.OPEN; this.dispatchEvent(new Event("open")); }
	end(code = 1000) { this.close(); this.dispatchEvent(Object.assign(new Event("close"), { code })); }
	committed(text: string) {
		this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify({ message_type: "committed_transcript", text }) }));
	}
	final(text: string) {
		this.dispatchEvent(Object.assign(new Event("message"), {
			data: JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: text }] } }),
		}));
	}
}

class AudioGraph {
	state = "running";
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}
class Worklet {
	static last: Worklet | undefined;
	port: { onmessage?: (e: { data: unknown }) => void } = {};
	constructor() { Worklet.last = this; }
	connect() {}
	disconnect() {}
}

const globals = globalThis as Record<string, unknown>;
let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;

async function fixture(language: "pl" | "en" = "pl", delayedRead?: Promise<Response>) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const state = {
		record: { version: 1, dictation: { language } } as UserSettings,
		nextRead: delayedRead,
		nextWrite: undefined as Promise<Response> | undefined,
		nextMic: undefined as Promise<{ getTracks: () => { stop: () => void }[] }> | undefined,
		readFails: false,
		reads: 0,
		active: false,
		captures: 0,
		stops: 0,
		appends: [] as string[],
		/** What the token route answers: the provider it resolved, or a keyless 503. */
		token: { provider: "deepgram" } as { provider: "deepgram" | "elevenlabs" } | { keyless: string },
		mints: 0,
	};
	Socket.all = [];
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => {
			state.captures++;
			if (state.nextMic) return state.nextMic;
			return { getTracks: () => [{ stop() { state.stops++; } }] };
		} } },
		WebSocket: Socket, AudioContext: AudioGraph, AudioWorkletNode: Worklet,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/stt/token") {
				state.mints++;
				if ("keyless" in state.token) return Response.json({ message: "no key", keyless: state.token.keyless }, { status: 503 });
				return Response.json({ provider: state.token.provider, token: "test-token" });
			}
			if (url === "/api/settings") {
				state.reads++;
				if (state.nextRead) { const response = state.nextRead; state.nextRead = undefined; return response; }
				return state.readFails ? Response.json({}, { status: 500 }) : Response.json({ settings: state.record });
			}
			assert.equal(url, "/api/settings/dictation");
			assert.equal(init?.method, "PUT");
			if (state.nextWrite) { const response = state.nextWrite; state.nextWrite = undefined; return response; }
			state.record = { ...state.record, dictation: JSON.parse(init.body as string) };
			return Response.json({ settings: state.record });
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
	let setting!: ReturnType<typeof useDictationLanguage>;
	function Harness() {
		latest = useDictation({ append: (text) => state.appends.push(text) });
		setting = useDictationLanguage();
		state.active = useDictationActive();
		return null;
	}
	let root = createRoot(document.getElementById("root")!);
	let firstMount = true;
	const mount = async () => {
		await act(async () => { root.render(<Harness />); });
		// Each fixture is a new server record. Explicitly invalidate a prior
		// fixture's window-lifetime cache, but do not refetch on remounts.
		if (firstMount && setting.language !== undefined) {
			await act(async () => { notifySettingsSaved("dictation"); });
		}
		firstMount = false;
	};
	dispose = async () => { await act(async () => { root.unmount(); }); };
	return {
		state,
		get dictation() { return latest; },
		get setting() { return setting; },
		mount,
		unmount: () => dispose!(),
		remount: async () => {
			await dispose!();
			root = createRoot(document.getElementById("root")!);
			await mount();
		},
	};
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("waits for the saved language; reconnect preserves it and finals still flush exactly once", async () => {
	const read = deferred<Response>();
	const f = await fixture("pl", read.promise);
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "connecting");
	assert.equal(f.state.active, true, "the settings row locks while connecting");
	assert.equal(f.state.captures, 0);
	assert.equal(Socket.all.length, 0, "must not open a default-English socket before settings arrive");
	await act(async () => { read.resolve(Response.json({ settings: f.state.record })); });
	const first = Socket.all[0]!;
	assert.equal(first.language, "pl");
	await act(async () => { first.open(); first.final("Cześć"); });
	assert.deepEqual(f.state.appends, []);
	// A preference refresh during capture affects the next run only.
	f.state.record.dictation = { language: "multi" };
	await act(async () => { notifySettingsSaved("dictation"); });
	await act(async () => { first.end(1006); });
	const second = Socket.all[1]!;
	assert.equal(second.language, "pl");
	assert.deepEqual(second.protocols, ["bearer", "test-token"]);
	await act(async () => { second.open(); second.final("świecie"); });
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.phase, "stopping");
	assert.equal(f.state.active, true, "the settings row remains locked while stopping");
	assert.equal(second.sent.at(-1), JSON.stringify({ type: "CloseStream" }));
	await act(async () => { second.end(); });
	assert.deepEqual(f.state.appends, ["Cześć świecie"]);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.active, false);
	await act(async () => { f.dictation.toggle(); });
	assert.equal(Socket.all[2]!.language, "multi");
});

test("a failed save keeps the previous language, including a shortcut pressed while saving", async () => {
	const f = await fixture();
	await f.mount();
	const write = deferred<Response>();
	f.state.nextWrite = write.promise;
	let saved!: Promise<boolean>;
	await act(async () => { saved = f.setting.save("multi"); });
	assert.equal(f.setting.saving, true);
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.state.captures, 0);
	await act(async () => { write.resolve(Response.json({}, { status: 500 })); await saved; });
	assert.equal(await saved, false);
	assert.equal(f.setting.language, "pl");
	assert.match(f.setting.error!, /Could not save/);
	assert.equal(Socket.all[0]!.language, "pl");
});

test("confirmed choices stay cached across navigation; failed explicit refreshes block capture", async () => {
	const f = await fixture();
	await f.mount();
	await act(async () => { assert.equal(await f.setting.save("multi"), true); });
	const reads = f.state.reads;
	f.state.readFails = true;
	await f.remount();
	assert.equal(f.setting.language, "multi");
	assert.equal(f.state.reads, reads, "navigation must not reread a confirmed preference");
	await act(async () => { notifySettingsSaved("dictation"); });
	await act(async () => { f.dictation.toggle(); });
	assert.match(f.dictation.error!, /Could not load/);
	assert.equal(f.state.captures, 0);
	assert.equal(Socket.all.length, 0);
	f.state.readFails = false;
	await act(async () => { f.dictation.toggle(); });
	assert.equal(Socket.all[0]!.language, "multi");
});

test("a shortcut waits for a language save made by the separate settings control", async () => {
	const f = await fixture();
	await f.mount();
	const write = deferred<Response>();
	f.state.nextWrite = write.promise;
	let saved!: Promise<boolean>;
	await act(async () => { saved = f.setting.save("multi"); });
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.state.captures, 0);
	f.state.record.dictation = { language: "multi" };
	await act(async () => { write.resolve(Response.json({ settings: f.state.record })); await saved; });
	assert.equal(Socket.all[0]!.language, "multi");
});

test("a saved-language refresh gates capture even when an older choice is cached", async () => {
	const f = await fixture();
	await f.mount();
	const read = deferred<Response>();
	f.state.nextRead = read.promise;
	f.state.record.dictation = { language: "multi" };
	await act(async () => { notifySettingsSaved("dictation"); });
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.state.captures, 0);
	assert.equal(Socket.all.length, 0);
	await act(async () => { read.resolve(Response.json({ settings: f.state.record })); });
	assert.equal(Socket.all[0]!.language, "multi");
});

test("a stale settings refresh cannot overwrite a newer confirmed choice", async () => {
	const f = await fixture();
	await f.mount();
	const read = deferred<Response>();
	f.state.nextRead = read.promise;
	await act(async () => { notifySettingsSaved("dictation"); });
	await act(async () => { await f.setting.save("multi"); });
	await act(async () => { read.resolve(Response.json({ settings: { version: 1, dictation: { language: "pl" } } })); });
	assert.equal(f.setting.language, "multi");
	await act(async () => { f.dictation.toggle(); });
	assert.equal(Socket.all[0]!.language, "multi");
});

test("cancel while settings load does not open a microphone or socket later", async () => {
	const read = deferred<Response>();
	const f = await fixture("pl", read.promise);
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { f.dictation.cancel(); });
	await act(async () => { read.resolve(Response.json({ settings: f.state.record })); });
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.captures, 0);
	assert.equal(Socket.all.length, 0);
});

test("reopening settings during a save shares its busy state and rejects a competing selection", async () => {
	const f = await fixture();
	await f.mount();
	const write = deferred<Response>();
	f.state.nextWrite = write.promise;
	let first!: Promise<boolean>;
	await act(async () => { first = f.setting.save("multi"); });
	await f.remount();
	assert.equal(f.setting.saving, true);
	assert.equal(await f.setting.save("en"), false, "a different selection cannot inherit another write's success");
	f.state.record.dictation = { language: "multi" };
	await act(async () => { write.resolve(Response.json({ settings: f.state.record })); await first; });
	assert.equal(f.setting.saving, false);
	assert.equal(f.setting.language, "multi");
});

test("a confirmed save applies to capture even when subsequent settings GET requests would fail", async () => {
	const f = await fixture();
	await f.mount();
	f.state.readFails = true;
	await act(async () => { assert.equal(await f.setting.save("multi"), true); });
	assert.equal(f.state.record.dictation?.language, "multi");
	await act(async () => { f.dictation.toggle(); });
	assert.equal(Socket.all[0]!.language, "multi");
});

test("unmount during a pending language read prevents orphaned capture", async () => {
	const read = deferred<Response>();
	const f = await fixture("pl", read.promise);
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	await f.unmount();
	await act(async () => { read.resolve(Response.json({ settings: f.state.record })); });
	assert.equal(f.state.captures, 0);
	assert.equal(Socket.all.length, 0);
	assert.equal(isDictationActive(), false);
});

test("unmount during recording stops resources and discards the departing page's buffered text", async () => {
	const f = await fixture();
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	const socket = Socket.all[0]!;
	await act(async () => { socket.open(); socket.final("do not append into another page"); });
	await f.unmount();
	assert.equal(f.state.stops, 1);
	assert.equal(socket.readyState, 3);
	assert.equal(isDictationActive(), false);
	assert.deepEqual(f.state.appends, []);
	await act(async () => { socket.final("late event"); socket.end(1006); });
	assert.equal(Socket.all.length, 1);
	assert.deepEqual(f.state.appends, []);
});

test("microphone permission resolving after unmount immediately stops the late stream", async () => {
	const f = await fixture();
	await f.mount();
	const mic = deferred<{ getTracks: () => { stop: () => void }[] }>();
	f.state.nextMic = mic.promise;
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.state.captures, 1);
	await f.unmount();
	await act(async () => { mic.resolve({ getTracks: () => [{ stop() { f.state.stops++; } }] }); });
	assert.equal(f.state.stops, 1);
	assert.equal(Socket.all.length, 0);
	assert.equal(isDictationActive(), false);
});

const frame = (...bytes: number[]) => new Uint8Array(bytes).buffer;
const sendFrame = (buffer: ArrayBuffer) => Worklet.last!.port.onmessage!({ data: { type: "audio", buffer } });

test("ElevenLabs: queued frames flush as JSON on open, finals defer, Stop commits and the quiet window after the Stop commit lands the text and closes the socket", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = await fixture();
	f.state.token = { provider: "elevenlabs" };
	await f.mount();
	await act(async () => { notifySettingsSaved("dictation"); }); // drops the warm token minted for the default provider
	await act(async () => { f.dictation.toggle(); });
	const ws = Socket.all[0]!;
	assert.match(ws.url, /^wss:\/\/api\.elevenlabs\.io\/v1\/speech-to-text\/realtime\?/);
	assert.equal(new URL(ws.url).searchParams.get("token"), "test-token");
	assert.deepEqual(ws.protocols, []);
	await act(async () => { sendFrame(frame(1, 2)); sendFrame(frame(3)); });
	assert.deepEqual(ws.sent, [], "nothing is sent, or dropped, before the socket opens");
	await act(async () => { ws.open(); });
	assert.deepEqual(ws.sent.map((s) => JSON.parse(s as string)), [
		{ message_type: "input_audio_chunk", audio_base_64: "AQI=", commit: false, sample_rate: 16000 },
		{ message_type: "input_audio_chunk", audio_base_64: "Aw==", commit: false, sample_rate: 16000 },
	]);
	await act(async () => { ws.committed("first phrase"); ws.committed("second phrase"); });
	assert.deepEqual(f.state.appends, [], "transcripts stay deferred during the run");
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.phase, "stopping");
	assert.equal(JSON.parse(String(ws.sent.at(-1))).commit, true);
	await act(async () => { ws.committed("last words"); });
	assert.deepEqual(f.state.appends, [], "the Stop commit starts the quiet window, it does not end the run");
	await act(async () => { t.mock.timers.tick(STOP_QUIET_MS); });
	assert.deepEqual(f.state.appends, ["first phrase second phrase last words"], "one flush, after the quiet window");
	assert.equal(f.dictation.phase, "idle");
	assert.equal(ws.readyState, 3, "the client closes the socket");
});

/** An ElevenLabs run that is recording on an open socket. */
async function elevenLabsRun(t: { mock: { timers: { enable: (o: { apis: ["setTimeout"] }) => void } } }) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = await fixture();
	f.state.token = { provider: "elevenlabs" };
	await f.mount();
	await act(async () => { notifySettingsSaved("dictation"); });
	await act(async () => { f.dictation.toggle(); });
	const ws = Socket.all[0]!;
	await act(async () => { ws.open(); });
	return { f, ws };
}

test("ElevenLabs: a late VAD commit before the Stop commit does not lose the Stop commit's words", async (t) => {
	const { f, ws } = await elevenLabsRun(t);
	await act(async () => { f.dictation.stop(); });
	await act(async () => { ws.committed("earlier phrase"); });
	assert.deepEqual(f.state.appends, [], "the first commit after Stop does not end the run");
	await act(async () => { t.mock.timers.tick(STOP_QUIET_MS - 1); ws.committed("trailing words"); });
	await act(async () => { t.mock.timers.tick(STOP_QUIET_MS - 1); });
	assert.deepEqual(f.state.appends, [], "each message restarts the quiet window");
	await act(async () => { t.mock.timers.tick(1); });
	assert.deepEqual(f.state.appends, ["earlier phrase trailing words"], "both texts, one flush");
	assert.equal(f.dictation.phase, "idle");
	assert.equal(ws.readyState, 3);
});

test("ElevenLabs: a single commit after Stop finalizes once the quiet window passes", async (t) => {
	const { f, ws } = await elevenLabsRun(t);
	await act(async () => { f.dictation.stop(); });
	await act(async () => { ws.committed("only words"); });
	await act(async () => { t.mock.timers.tick(STOP_QUIET_MS - 1); });
	assert.equal(f.dictation.phase, "stopping");
	await act(async () => { t.mock.timers.tick(1); });
	assert.deepEqual(f.state.appends, ["only words"]);
	assert.equal(f.dictation.phase, "idle");
});

test("ElevenLabs: Esc during the quiet window discards the transcript and the timer never fires later", async (t) => {
	const { f, ws } = await elevenLabsRun(t);
	await act(async () => { ws.committed("spoken earlier"); });
	await act(async () => { f.dictation.stop(); });
	await act(async () => { ws.committed("stop words"); });
	await act(async () => { f.dictation.cancel(); });
	assert.equal(f.dictation.phase, "idle");
	await act(async () => { t.mock.timers.tick(STOP_QUIET_MS * 10); });
	assert.deepEqual(f.state.appends, []);
});

test("ElevenLabs: with no commit at all the 3 s safety net still ends the run", async (t) => {
	const { f } = await elevenLabsRun(t);
	await act(async () => { f.dictation.stop(); });
	await act(async () => { t.mock.timers.tick(2999); });
	assert.equal(f.dictation.phase, "stopping");
	await act(async () => { t.mock.timers.tick(1); });
	assert.equal(f.dictation.phase, "idle");
});

test("ElevenLabs: a quiet window already running is cut off by unmount", async (t) => {
	const { f, ws } = await elevenLabsRun(t);
	await act(async () => { f.dictation.stop(); });
	await act(async () => { ws.committed("departing"); });
	await f.unmount();
	await act(async () => { t.mock.timers.tick(STOP_QUIET_MS * 10); });
	assert.deepEqual(f.state.appends, []);
});

test("ElevenLabs: the saved language reaches the socket URL as language_code", async (t) => {
	const { ws } = await elevenLabsRun(t);
	assert.equal(new URL(ws.url).searchParams.get("language_code"), "pl");
});

test("ElevenLabs: a dropped connection reconnects once with a FRESH token, then reports the provider by name", async () => {
	const f = await fixture();
	f.state.token = { provider: "elevenlabs" };
	await f.mount();
	await act(async () => { notifySettingsSaved("dictation"); });
	await act(async () => { f.dictation.toggle(); });
	const mintsAtStart = f.state.mints;
	await act(async () => { Socket.all[0]!.open(); Socket.all[0]!.end(1006); });
	assert.equal(f.state.mints, mintsAtStart + 1, "single-use tokens: the reconnect mints again");
	const second = Socket.all[1]!;
	assert.match(second.url, /elevenlabs/);
	await act(async () => { second.open(); second.end(1006); });
	assert.equal(f.dictation.error, "ElevenLabs connection lost (1006)");
	assert.equal(f.dictation.phase, "idle");
});

test("ElevenLabs: a provider error ends the run with a short message and keeps buffered text", async () => {
	const f = await fixture();
	f.state.token = { provider: "elevenlabs" };
	await f.mount();
	await act(async () => { notifySettingsSaved("dictation"); });
	await act(async () => { f.dictation.toggle(); });
	const ws = Socket.all[0]!;
	await act(async () => {
		ws.open();
		ws.committed("kept");
		ws.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify({ message_type: "quota_exceeded", error: "x" }) }));
	});
	assert.equal(f.dictation.error, "ElevenLabs quota exceeded");
	assert.deepEqual(f.state.appends, ["kept"]);
});

test("Deepgram keeps a provider-named connection error", async () => {
	const f = await fixture();
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { Socket.all[0]!.open(); Socket.all[0]!.end(1006); });
	await act(async () => { Socket.all[1]!.open(); Socket.all[1]!.end(1006); });
	assert.equal(f.dictation.error, "Deepgram connection lost (1006)");
});

test("a keyless route names the provider whose key is missing", async () => {
	const f = await fixture();
	await f.mount();
	for (const [keyless, line] of [
		["ELEVENLABS_API_KEY", "Dictation needs an ElevenLabs key"],
		["DEEPGRAM_API_KEY", "Dictation needs a Deepgram key"],
	] as const) {
		f.state.token = { keyless };
		await act(async () => { notifySettingsSaved("dictation"); }); // drops the warm token
		await act(async () => { f.dictation.toggle(); });
		assert.equal(f.dictation.error, line);
		assert.equal(Socket.all.length, 0);
		await act(async () => { f.dictation.clearError(); });
	}
});

test("saving the dictation settings drops the warm token so a provider switch applies to the next run", async () => {
	const f = await fixture();
	await f.mount();
	f.state.token = { provider: "elevenlabs" };
	await act(async () => { notifySettingsSaved("dictation"); });
	await act(async () => { f.dictation.toggle(); });
	assert.match(Socket.all[0]!.url, /elevenlabs/);
});
