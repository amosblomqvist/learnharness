import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { useDictation, type Dictation } from "../components/dictation.tsx";
import { useLocalModelConsent, fetchLocalSttStatus } from "../components/local-dictation.ts";
import { isDictationActive } from "../components/dictation-state.ts";
import { LOCAL_STT_MAX_BYTES, type LocalSttStatus, type UserSettings } from "../src/core/index.ts";

class Socket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static all: Socket[] = [];
	readyState = Socket.CONNECTING;
	constructor(readonly url: string) { super(); Socket.all.push(this); }
	send() {}
	close() { this.readyState = 3; }
}
class AudioGraph {
	state = "running";
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}
class Worklet {
	static all: Worklet[] = [];
	port: { onmessage?: (e: { data: unknown }) => void } = {};
	constructor() { Worklet.all.push(this); }
	connect() {}
	disconnect() {}
	/** Like pcm-capture.js: Int16Array frames, here built from little-endian bytes. */
	audio(bytes: number[] | Uint8Array) { this.port.onmessage?.({ data: { type: "audio", buffer: new Int16Array(new Uint8Array(bytes).buffer) } }); }
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}

const globals = globalThis as Record<string, unknown>;
let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;

type ModelState = LocalSttStatus["model"]["state"];

async function fixture({ key = false, model = "ready" as ModelState } = {}) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const state = {
		key, model, received: 0,
		captures: 0, stops: 0,
		appends: [] as string[],
		uploads: [] as Uint8Array[],
		requests: [] as string[],
		nextUpload: undefined as Promise<Response> | undefined,
	};
	const status = (): LocalSttStatus => ({
		deepgramKey: state.key,
		model: state.model === "downloading"
			? { state: "downloading", receivedBytes: state.received, totalBytes: 670, id: "p", label: "Parakeet v3" }
			: { state: state.model, totalBytes: 670, id: "p", label: "Parakeet v3" } as LocalSttStatus["model"],
	});
	Socket.all = [];
	Worklet.all = [];
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => {
			state.captures++;
			return { getTracks: () => [{ stop() { state.stops++; } }] };
		} } },
		WebSocket: Socket, AudioContext: AudioGraph, AudioWorkletNode: Worklet,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string, init?: RequestInit) => {
			state.requests.push(`${init?.method ?? "GET"} ${url}`);
			if (url === "/api/stt/local") return Response.json(status());
			if (url === "/api/stt/local/model" && init?.method === "POST") {
				state.model = "downloading";
				return Response.json(status());
			}
			if (url === "/api/stt/local/transcribe") {
				state.uploads.push(new Uint8Array(init!.body as Uint8Array));
				if (state.nextUpload) { const next = state.nextUpload; state.nextUpload = undefined; return next; }
				return Response.json({ text: "spoken words" });
			}
			if (url === "/api/stt/token") return state.key ? Response.json({ token: "t" }) : Response.json({}, { status: 503 });
			if (url === "/api/settings") return Response.json({ settings: { version: 1, dictation: { language: "en" } } as UserSettings });
			throw new Error(`unexpected fetch ${url}`);
		},
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete globals[name];
		}
	};
	const { createRoot } = await import("react-dom/client");
	let latest!: Dictation;
	let consent: ReturnType<typeof useLocalModelConsent> = null;
	function Harness() {
		latest = useDictation({ append: (text) => { state.appends.push(text); } });
		consent = useLocalModelConsent();
		return null;
	}
	const root = createRoot(document.getElementById("root")!);
	await act(async () => { root.render(<Harness />); });
	await act(async () => { await fetchLocalSttStatus(); });
	dispose = async () => { await act(async () => { root.unmount(); }); };
	return {
		state,
		get dictation() { return latest; },
		get consent() { return consent; },
		/** Push the server's current state to the cached status (one poll). */
		poll: () => act(async () => { await fetchLocalSttStatus(); }),
	};
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("with a Deepgram key, dictation streams to Deepgram and never uploads locally", async () => {
	const f = await fixture({ key: true });
	await act(async () => { f.dictation.toggle(); });
	assert.equal(Socket.all.length, 1);
	assert.match(Socket.all[0]!.url, /deepgram/);
	assert.ok(!f.state.requests.some((r) => r.includes("transcribe")));
});

test("keyless with the model ready: records locally, uploads once at stop, appends the text", async () => {
	const f = await fixture();
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "recording");
	assert.equal(f.state.captures, 1);
	assert.equal(Socket.all.length, 0);
	await act(async () => { Worklet.all[0]!.audio([1, 0, 0x34, 0x12]); Worklet.all[0]!.audio([0xff, 0x7f]); });
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.state.stops, 1, "the mic stops before the upload");
	assert.deepEqual([...f.state.uploads[0]!], [1, 0, 0x34, 0x12, 0xff, 0x7f], "16-bit samples upload byte for byte");
	assert.deepEqual(f.state.appends, ["spoken words"]);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(isDictationActive(), false);
});

test("keyless without the model: asks first with the mic off, and Cancel ends the attempt", async () => {
	const f = await fixture({ model: "missing" });
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "preparing");
	assert.equal(f.state.captures, 0, "no mic before consent");
	assert.equal(f.consent?.totalBytes, 670);
	await act(async () => { f.consent!.answer("cancel"); });
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.captures, 0);
	assert.ok(!f.state.requests.includes("POST /api/stt/local/model"));
});

test("Download starts the model download, shows progress, then records into the same run", async () => {
	const f = await fixture({ model: "missing" });
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { f.consent!.answer("download"); });
	assert.ok(f.state.requests.includes("POST /api/stt/local/model"));
	assert.equal(f.dictation.phase, "preparing");
	assert.equal(f.state.captures, 0, "no mic while downloading");
	f.state.received = 335;
	await f.poll();
	assert.deepEqual(f.dictation.download, { receivedBytes: 335, totalBytes: 670 });
	f.state.model = "ready";
	await f.poll();
	await act(async () => {});
	assert.equal(f.dictation.phase, "recording");
	assert.equal(f.state.captures, 1);
	assert.equal(f.dictation.download, null);
});

test("Stop during the download ends the attempt but leaves the download running", async () => {
	const f = await fixture({ model: "missing" });
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { f.consent!.answer("download"); });
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "idle");
	assert.ok(!f.state.requests.includes("DELETE /api/stt/local/model"));
	assert.equal(f.state.captures, 0);
});

test("Esc while the consent dialog is open closes it and ends the attempt", async () => {
	const f = await fixture({ model: "missing" });
	await act(async () => { f.dictation.toggle(); });
	assert.ok(f.consent);
	await act(async () => { f.dictation.cancel(); });
	assert.equal(f.consent, null);
	assert.equal(f.dictation.phase, "idle");
});

test("a failed transcription keeps the clip: submit is refused, Retry resends it to the same place", async () => {
	const f = await fixture();
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { Worklet.all[0]!.audio([9, 0]); });
	f.state.nextUpload = Promise.resolve(Response.json({ error: "On-device dictation stopped unexpectedly (signal SIGSEGV)" }, { status: 500 }));
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "failed");
	assert.equal(f.dictation.error, "On-device dictation stopped unexpectedly (signal SIGSEGV)");
	assert.equal(isDictationActive(), true, "Esc still reaches the kept clip");
	await assert.rejects(f.dictation.finish(), /SIGSEGV/);
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.state.uploads.length, 2);
	assert.deepEqual([...f.state.uploads[1]!], [9, 0]);
	assert.deepEqual(f.state.appends, ["spoken words"]);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.error, null);
});

test("a submit that finishes the run waits for the upload and is rejected if it fails", async () => {
	const f = await fixture();
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { Worklet.all[0]!.audio([1, 0]); });
	const upload = deferred<Response>();
	f.state.nextUpload = upload.promise;
	let outcome!: Promise<unknown>;
	await act(async () => { outcome = f.dictation.finish().then(() => null, (error: unknown) => error); });
	assert.equal(f.dictation.phase, "stopping");
	await act(async () => { upload.resolve(Response.json({ error: "boom" }, { status: 500 })); });
	assert.match(String(await outcome), /boom/);
	assert.equal(f.dictation.phase, "failed");
});

test("Esc discards a kept clip without appending anything", async () => {
	const f = await fixture();
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { Worklet.all[0]!.audio([1, 0]); });
	f.state.nextUpload = Promise.resolve(Response.json({ error: "boom" }, { status: 500 }));
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { f.dictation.cancel(); });
	assert.equal(f.dictation.phase, "idle");
	assert.equal(isDictationActive(), false);
	assert.deepEqual(f.state.appends, []);
	assert.equal(f.state.uploads.length, 1);
});

test("Esc during the upload abandons it and appends nothing", async () => {
	const f = await fixture();
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { Worklet.all[0]!.audio([1, 0]); });
	const upload = deferred<Response>();
	f.state.nextUpload = upload.promise;
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { f.dictation.cancel(); });
	await act(async () => { upload.resolve(Response.json({ text: "late words" })); });
	assert.deepEqual(f.state.appends, []);
	assert.equal(f.dictation.phase, "idle");
});

test("recording stops itself at the ten-minute cap and transcribes what it has", async () => {
	const f = await fixture();
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { Worklet.all[0]!.audio(new Uint8Array(LOCAL_STT_MAX_BYTES)); });
	assert.equal(f.state.stops, 1);
	assert.equal(f.state.uploads[0]!.byteLength, LOCAL_STT_MAX_BYTES);
	assert.deepEqual(f.state.appends, ["spoken words"]);
});
