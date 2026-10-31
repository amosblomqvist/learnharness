/**
 * Microphone-capture tests for the dictation hook.
 *
 * The existing dictation-flow suite proves the language/socket/token plumbing;
 * this file pins the MICROPHONE edge of the capture path specifically:
 *   1. a successful run actually asks the browser for the mic, with the
 *      noise-cleanup constraints the hook promises (mono + AEC/NS/AGC);
 *   2. a DENIED mic (NotAllowedError/SecurityError) surfaces the exact
 *      "Microphone permission denied" line, returns to idle, opens NO socket,
 *      and leaves dictation inactive (no leaked resources);
 *   3. a MISSING mic (NotFoundError) surfaces the device's own message and
 *      likewise never opens a socket.
 *
 * Same global-mock seam as tests/dictation-flow.test.tsx (linkedom DOM +
 * fake WebSocket/AudioContext), with the getUserMedia mock made
 * controllable so a run can be forced to fail at the mic.
 */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { useDictation, type Dictation } from "../components/dictation.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { isDictationActive, useDictationActive } from "../components/dictation-state.ts";
import type { UserSettings } from "../src/core/index.ts";

class Socket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static all: Socket[] = [];
	readyState = Socket.CONNECTING;
	sent: unknown[] = [];
	constructor(readonly url: string, readonly protocols: string[]) { super(); Socket.all.push(this); }
	send(data: unknown) { this.sent.push(data); }
	close() { this.readyState = 3; }
}

class AudioGraph {
	state = "running";
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}
class Worklet { port = {}; connect() {} disconnect() {} }

const globals = globalThis as Record<string, unknown>;
let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;

type MicState = {
	/** The constraint object the hook passed to getUserMedia (last call). */
	micConstraints: MediaStreamConstraints | undefined;
	/** When set, getUserMedia rejects with this instead of returning a stream. */
	micError: unknown;
	captures: number;
	stops: number;
	appends: string[];
	record: UserSettings;
};

async function fixture(micError?: unknown) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const state: MicState = {
		micConstraints: undefined,
		micError,
		captures: 0,
		stops: 0,
		appends: [],
		record: { version: 1, dictation: { language: "en" } } as UserSettings,
	};
	Socket.all = [];
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
		navigator: {
			userAgent: "", platform: "",
			mediaDevices: {
				getUserMedia: async (constraints: MediaStreamConstraints) => {
					state.captures++;
					state.micConstraints = constraints;
					if (state.micError) throw state.micError;
					return { getTracks: () => [{ stop() { state.stops++; } }] };
				},
			},
		},
		WebSocket: Socket, AudioContext: AudioGraph, AudioWorkletNode: Worklet,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string) => {
			if (url === "/api/stt/token") return Response.json({ token: "test-token" });
			if (url === "/api/settings") return Response.json({ settings: state.record });
			throw new Error(`unexpected fetch ${url}`);
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
	let active = false;
	function Harness() {
		latest = useDictation({ append: (text) => state.appends.push(text) });
		active = useDictationActive();
		return null;
	}
	const root = createRoot(document.getElementById("root")!);
	await act(async () => { root.render(<Harness />); });
	// Confirm the saved language so toggle() goes straight to the mic.
	await act(async () => { notifySettingsSaved("dictation"); });
	dispose = async () => { await act(async () => { root.unmount(); }); };
	return { state, get dictation() { return latest; }, get active() { return active; } };
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("a run acquires the mic with mono + echo/noise/gain cleanup constraints", async () => {
	const f = await fixture();
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.state.captures, 1, "exactly one getUserMedia call");
	const audio = f.state.micConstraints?.audio as MediaTrackConstraints;
	assert.ok(audio, "requested the audio track");
	assert.equal(audio.channelCount, 1, "mono capture");
	assert.equal(audio.echoCancellation, true);
	assert.equal(audio.noiseSuppression, true);
	assert.equal(audio.autoGainControl, true);
	// Mic resolved → the socket handshake fires; no mic error surfaced.
	assert.equal(f.dictation.error, null);
	assert.equal(Socket.all.length, 1);
});

test("a denied mic surfaces 'Microphone permission denied', opens no socket, and stays inactive", async () => {
	const f = await fixture(new DOMException("Permission dismissed", "NotAllowedError"));
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.state.captures, 1, "the hook did ask for the mic");
	assert.equal(f.dictation.error, "Microphone permission denied");
	assert.equal(f.dictation.phase, "idle", "returns to idle after the denial");
	assert.equal(Socket.all.length, 0, "never opens a Deepgram socket without a mic");
	assert.equal(f.active, false);
	assert.equal(isDictationActive(), false);
});

test("a SecurityError is treated as a permission denial", async () => {
	const f = await fixture(new DOMException("Insecure context", "SecurityError"));
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.error, "Microphone permission denied");
	assert.equal(Socket.all.length, 0);
});

test("a missing mic (NotFoundError) surfaces the device message and opens no socket", async () => {
	const f = await fixture(new DOMException("Requested device not found", "NotFoundError"));
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.state.captures, 1);
	assert.equal(f.dictation.error, "Requested device not found");
	assert.equal(f.dictation.phase, "idle");
	assert.equal(Socket.all.length, 0);
	assert.equal(isDictationActive(), false);
});
