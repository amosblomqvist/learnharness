import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import {
	DICTATION_MODEL_MISSING, DictationBar, useDictation, type Dictation,
} from "../components/dictation.tsx";
import { isDictationActive, isDictationRetained } from "../components/dictation-state.ts";
import { KeyboardShortcuts } from "../components/keyboard-shortcuts.tsx";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { notifySettingsSaved } from "../components/settings-signal.ts";
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
	readyState = 0;
	constructor(readonly url: string, readonly protocols: string[]) { super(); Socket.all.push(this); }
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
	static last: Worklet | undefined;
	port: { onmessage?: (e: { data: unknown }) => void } = {};
	constructor() { Worklet.last = this; }
	connect() {}
	disconnect() {}
	frame(bytes: Uint8Array) {
		this.port.onmessage?.({ data: { type: "audio", buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } });
	}
}

const globals = globalThis as Record<string, unknown>;
let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;
const bytes = (...values: number[]) => new Uint8Array(values);

type Status = { state: "missing"; error?: string } | { state: "downloading"; receivedBytes: number; totalBytes: number } | { state: "ready"; diskBytes: number };

async function fixture(provider: "deepgram" | "parakeet", model: Status = { state: "ready", diskBytes: 670_000_000 }) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const state = {
		record: { version: 1, dictation: { language: "pl", provider } } as UserSettings,
		model,
		tokens: 0,
		captures: 0,
		stops: 0,
		appends: [] as string[],
		posts: [] as { body: Uint8Array; type: string | null; signal: AbortSignal | null | undefined }[],
		nextTranscribe: undefined as Promise<Response> | undefined,
		transcribe: (): Response => Response.json({ text: "hello world" }),
	};
	Socket.all = [];
	Worklet.last = undefined;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => {
			state.captures++;
			return { getTracks: () => [{ stop() { state.stops++; } }] };
		} } },
		WebSocket: Socket, AudioContext: AudioGraph, AudioWorkletNode: Worklet,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/stt/token") { state.tokens++; return Response.json({ token: "test-token" }); }
			if (url === "/api/settings") return Response.json({ settings: state.record });
			if (url === "/api/stt/parakeet") return Response.json(state.model);
			if (url === "/api/stt/parakeet/transcribe") {
				assert.equal(init?.method, "POST");
				const headers = new Headers(init?.headers);
				state.posts.push({ body: new Uint8Array(init!.body as Uint8Array), type: headers.get("content-type"), signal: init?.signal });
				if (state.nextTranscribe) { const next = state.nextTranscribe; state.nextTranscribe = undefined; return next; }
				return state.transcribe();
			}
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
	function Harness() {
		latest = useDictation({ append: (text) => state.appends.push(text) });
		return null;
	}
	let root = createRoot(document.getElementById("root")!);
	let live = true;
	dispose = async () => {
		if (!live) return;
		live = false;
		await act(async () => { root.unmount(); });
		// A failed recording outlives its page by design: drop it through a
		// throwaway mount so the next test starts clean.
		root = createRoot(document.getElementById("root")!);
		await act(async () => { root.render(<Harness />); });
		await act(async () => { latest.cancel(); });
		await act(async () => { root.unmount(); });
	};
	await act(async () => { root.render(<Harness />); });
	// A new server record per fixture: drop the window-lifetime cache.
	await act(async () => { notifySettingsSaved("dictation"); });
	await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
	state.tokens = 0;
	return {
		state,
		get root() { return root; },
		get dictation() { return latest; },
		/** Navigate away and back: unmount the page, mount a fresh one. */
		async remount() {
			await act(async () => { root.unmount(); });
			root = createRoot(document.getElementById("root")!);
			await act(async () => { root.render(<Harness />); });
			await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
		},
		async record() {
			await act(async () => { latest.toggle(); });
			await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
		},
		frame: (data: Uint8Array) => act(async () => { Worklet.last!.frame(data); }),
	};
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("Parakeet records without a socket or token, then POSTs the concatenated frames and lands the text", async () => {
	const f = await fixture("parakeet");
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
	assert.equal(f.dictation.phase, "recording");
	assert.equal(f.state.captures, 1);
	await f.frame(bytes(1, 2, 3, 4));
	await f.frame(bytes(5, 6));
	const pending = deferred<Response>();
	f.state.nextTranscribe = pending.promise;
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.phase, "stopping");
	assert.equal(f.state.stops, 1, "the mic dies first");
	assert.equal(f.state.posts.length, 1);
	assert.deepEqual([...f.state.posts[0]!.body], [1, 2, 3, 4, 5, 6]);
	assert.equal(f.state.posts[0]!.type, "application/octet-stream");
	assert.deepEqual(f.state.appends, [], "nothing lands before the transcription returns");
	let finished = false;
	const done = f.dictation.finish().then(() => { finished = true; });
	await act(async () => { pending.resolve(Response.json({ text: " hello world " })); await done; });
	assert.deepEqual(f.state.appends, ["hello world"]);
	assert.equal(finished, true);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.error, null);
	assert.equal(Socket.all.length, 0);
	assert.equal(f.state.tokens, 0, "no token is minted for the local provider");
});

test("a blank transcription just ends the run", async () => {
	const f = await fixture("parakeet");
	await f.record();
	await f.frame(bytes(1, 2));
	f.state.transcribe = () => Response.json({ text: "  " });
	await act(async () => { f.dictation.stop(); await new Promise((r) => setTimeout(r, 0)); });
	assert.deepEqual(f.state.appends, []);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.error, null);
	assert.equal(f.dictation.canRetry, false);
});

test("a failed transcription keeps the audio and Retry re-sends the same bytes", async () => {
	const f = await fixture("parakeet");
	await f.record();
	await f.frame(bytes(9, 8, 7, 6));
	f.state.transcribe = () => Response.json({ message: "boom" }, { status: 500 });
	await act(async () => { f.dictation.stop(); await new Promise((r) => setTimeout(r, 0)); });
	assert.equal(f.dictation.error, "Transcription failed");
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.canRetry, true);
	assert.equal(f.state.stops, 1, "the mic stays released");
	assert.deepEqual(f.state.appends, []);
	f.state.transcribe = () => Response.json({ text: "second try" });
	await act(async () => { f.dictation.retry(); await new Promise((r) => setTimeout(r, 0)); });
	assert.equal(f.state.posts.length, 2);
	assert.deepEqual([...f.state.posts[1]!.body], [9, 8, 7, 6]);
	assert.equal(f.state.captures, 1, "retry does not record again");
	assert.deepEqual(f.state.appends, ["second try"]);
	assert.equal(f.dictation.error, null);
	assert.equal(f.dictation.canRetry, false);
	assert.equal(f.dictation.phase, "idle");
});

test("a network failure is retryable too, and a second failure keeps the audio", async () => {
	const f = await fixture("parakeet");
	await f.record();
	await f.frame(bytes(1, 1));
	f.state.transcribe = () => { throw new TypeError("network"); };
	await act(async () => { f.dictation.stop(); await new Promise((r) => setTimeout(r, 0)); });
	assert.equal(f.dictation.error, "Transcription failed");
	await act(async () => { f.dictation.retry(); await new Promise((r) => setTimeout(r, 0)); });
	assert.equal(f.dictation.error, "Transcription failed");
	assert.equal(f.dictation.canRetry, true);
	assert.equal(f.state.posts.length, 2);
});

test("Esc discards the audio and aborts an in-flight transcription", async () => {
	const f = await fixture("parakeet");
	await f.record();
	await f.frame(bytes(1, 2));
	f.state.nextTranscribe = new Promise(() => {});
	await act(async () => { f.dictation.stop(); });
	await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
	assert.equal(f.dictation.phase, "stopping");
	await act(async () => { f.dictation.cancel(); });
	assert.equal(f.state.posts[0]!.signal!.aborted, true);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.canRetry, false);
	assert.deepEqual(f.state.appends, []);
});

test("cancelling while recording sends nothing, and cancel after a failure drops the retained audio", async () => {
	const f = await fixture("parakeet");
	await f.record();
	await f.frame(bytes(1, 2));
	await act(async () => { f.dictation.cancel(); });
	assert.equal(f.state.posts.length, 0);
	assert.equal(f.dictation.phase, "idle");
	await f.record();
	await f.frame(bytes(3, 4));
	f.state.transcribe = () => Response.json({}, { status: 500 });
	await act(async () => { f.dictation.stop(); await new Promise((r) => setTimeout(r, 0)); });
	assert.equal(f.dictation.canRetry, true);
	await act(async () => { f.dictation.cancel(); });
	assert.equal(f.dictation.canRetry, false);
	assert.equal(f.dictation.error, null);
});

test("a missing or downloading model errors before the microphone opens", async () => {
	for (const model of [{ state: "missing" }, { state: "downloading", receivedBytes: 1, totalBytes: 2 }] as Status[]) {
		const f = await fixture("parakeet", model);
		await f.record();
		assert.equal(DICTATION_MODEL_MISSING, "Dictation needs the local model");
		assert.equal(f.dictation.error, DICTATION_MODEL_MISSING);
		assert.equal(f.dictation.phase, "idle");
		assert.equal(f.dictation.canRetry, false);
		assert.equal(f.state.captures, 0);
		await dispose!(); restore!();
	}
});

test("the recording stops by itself at the server's size cap and sends exactly the cap", async () => {
	const f = await fixture("parakeet");
	await f.record();
	await f.frame(new Uint8Array(19_000_000));
	assert.equal(f.dictation.phase, "recording");
	await act(async () => { Worklet.last!.frame(new Uint8Array(400_000).fill(7)); await new Promise((r) => setTimeout(r, 0)); });
	assert.equal(f.state.posts.length, 1);
	assert.equal(f.state.posts[0]!.body.byteLength, 19_200_000);
	assert.equal(f.state.stops, 1);
	assert.deepEqual(f.state.appends, ["hello world"]);
	// Frames still in flight after the stop are ignored.
	await act(async () => { Worklet.last!.frame(bytes(1, 2)); });
	assert.equal(f.state.posts.length, 1);
});

test("unmounting while transcribing cancels it and never appends", async () => {
	const f = await fixture("parakeet");
	await f.record();
	await f.frame(bytes(1, 2));
	const pending = deferred<Response>();
	f.state.nextTranscribe = pending.promise;
	await act(async () => { f.dictation.stop(); });
	await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
	await dispose!();
	assert.equal(f.state.posts[0]!.signal!.aborted, true);
	await act(async () => { pending.resolve(Response.json({ text: "late" })); await new Promise((r) => setTimeout(r, 0)); });
	assert.deepEqual(f.state.appends, []);
});

test("the Deepgram path is untouched: token, socket, no Parakeet traffic", async () => {
	const f = await fixture("deepgram");
	const seen: string[] = [];
	const inner = globalThis.fetch;
	globalThis.fetch = (async (url: string, init?: RequestInit) => { seen.push(url); return inner(url, init); }) as typeof fetch;
	await f.record();
	assert.equal(Socket.all.length, 1);
	assert.equal(Socket.all[0]!.url.includes("language=pl"), true);
	assert.deepEqual(Socket.all[0]!.protocols, ["bearer", "test-token"]);
	assert.equal(seen.includes("/api/stt/parakeet"), false);
	await act(async () => { f.dictation.cancel(); });
	assert.equal(f.state.posts.length, 0);
});

test("the bar offers Retry after a failed transcription and deep-links Settings for a missing model", async () => {
	const f = await fixture("parakeet");
	const calls: string[] = [];
	const base: Dictation = {
		phase: "idle", error: null, levelRef: { current: 0 }, active: false, canRetry: false,
		toggle: () => calls.push("toggle"), stop() {}, finish: async () => {}, cancel() {},
		retry: () => calls.push("retry"), clearError: () => calls.push("clear"),
	};
	const button = () => document.querySelector<HTMLButtonElement>('[data-testid="dictation-toggle"]')!;
	await act(async () => { f.root.render(<DictationBar dictation={{ ...base, error: "Transcription failed", canRetry: true }} />); });
	assert.equal(button().getAttribute("aria-label"), "Retry transcription");
	assert.match(button().textContent!, /Transcription failed/);
	await act(async () => { button().click(); });
	assert.deepEqual(calls, ["retry"]);
	calls.length = 0;
	await act(async () => { f.root.render(<DictationBar dictation={{ ...base, error: DICTATION_MODEL_MISSING }} />); });
	await act(async () => { button().click(); });
	assert.deepEqual(calls, ["clear"], "clears the error and leaves for Settings, never toggles");
});

test("a failed transcription survives finish(), unmount and navigation: the next page offers Retry", async () => {
	const f = await fixture("parakeet");
	await f.record();
	await f.frame(bytes(9, 8, 7, 6));
	f.state.transcribe = () => Response.json({ message: "boom" }, { status: 500 });
	let proceeded = false;
	await act(async () => { await f.dictation.finish().then(() => { proceeded = true; }); });
	assert.equal(proceeded, true, "finish() still resolves when the run ends");
	assert.equal(f.dictation.canRetry, true);
	await f.remount();
	assert.equal(f.dictation.error, "Transcription failed");
	assert.equal(f.dictation.canRetry, true);
	assert.equal(f.dictation.phase, "idle");
	f.state.transcribe = () => Response.json({ text: "recovered" });
	await act(async () => { f.dictation.retry(); await new Promise((r) => setTimeout(r, 0)); });
	assert.deepEqual([...f.state.posts[1]!.body], [9, 8, 7, 6]);
	assert.equal(f.state.captures, 1);
	assert.deepEqual(f.state.appends, ["recovered"]);
	await f.remount();
	assert.equal(f.dictation.error, null);
	assert.equal(f.dictation.canRetry, false);
});

test("the retained recording is dropped by Esc and by a provider change, never on mount", async () => {
	const f = await fixture("parakeet");
	const fail = async () => {
		await f.record();
		await f.frame(bytes(1, 2));
		f.state.transcribe = () => Response.json({}, { status: 500 });
		await act(async () => { f.dictation.stop(); await new Promise((r) => setTimeout(r, 0)); });
		assert.equal(f.dictation.canRetry, true);
	};
	await fail();
	await f.remount();
	await act(async () => { f.dictation.cancel(); });
	assert.equal(f.dictation.canRetry, false);
	assert.equal(f.dictation.error, null);
	await f.remount();
	assert.equal(f.dictation.canRetry, false, "a cancelled recording does not come back");
	await fail();
	f.state.record = { version: 1, dictation: { language: "pl", provider: "deepgram" } };
	await act(async () => { notifySettingsSaved("dictation"); });
	await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
	assert.equal(f.dictation.canRetry, false);
	assert.equal(f.dictation.error, null);
	await f.remount();
	assert.equal(f.dictation.canRetry, false);
});

test("real Escape discards a failed recording instead of aborting a turn, and Settings stay unlocked", async () => {
	const f = await fixture("parakeet");
	const { createRoot } = await import("react-dom/client");
	const host = document.createElement("div");
	document.body.appendChild(host);
	const shortcuts = createRoot(host);
	await act(async () => { shortcuts.render(<AppRouterContext.Provider value={{ push() {} } as never}><KeyboardShortcuts /></AppRouterContext.Provider>); });
	let aborts = 0;
	const onAbort = () => { aborts++; };
	window.addEventListener("lh:kbd-abort-turn", onAbort);
	const escape = async () => {
		const event = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "key", { value: "Escape" });
		await act(async () => { window.dispatchEvent(event); });
	};
	try {
		await f.record();
		await f.frame(bytes(1, 2));
		f.state.transcribe = () => Response.json({}, { status: 500 });
		await act(async () => { f.dictation.stop(); await new Promise((r) => setTimeout(r, 0)); });
		assert.equal(f.dictation.canRetry, true);
		assert.equal(isDictationActive(), false, "the Settings controls are not locked");
		assert.equal(isDictationRetained(), true);
		await escape();
		assert.equal(f.dictation.canRetry, false);
		assert.equal(f.dictation.error, null);
		assert.equal(isDictationRetained(), false);
		assert.equal(aborts, 0);
		await escape();
		assert.equal(aborts, 1, "with nothing to discard, Esc aborts the turn as before");
	} finally {
		window.removeEventListener("lh:kbd-abort-turn", onAbort);
		await act(async () => { shortcuts.unmount(); });
	}
});

test("regression: hookless Escape discards the retained recording", async () => {
	const f = await fixture("parakeet");
	await f.record();
	await f.frame(bytes(11, 12));
	f.state.transcribe = () => Response.json({}, { status: 500 });
	await act(async () => { await f.dictation.finish(); });

	const { createRoot } = await import("react-dom/client");
	const host = document.createElement("div");
	document.body.appendChild(host);
	const shortcuts = createRoot(host);
	let aborts = 0;
	const onAbort = () => { aborts++; };
	window.addEventListener("lh:kbd-abort-turn", onAbort);

	try {
		await act(async () => {
			shortcuts.render(
				<AppRouterContext.Provider value={{ push() {} } as never}>
					<KeyboardShortcuts />
				</AppRouterContext.Provider>,
			);
			f.root.render(null);
		});
		const event = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "key", { value: "Escape" });
		await act(async () => { window.dispatchEvent(event); });
		const retainedAfterEscape = isDictationRetained();

		await f.remount();
		assert.equal(aborts, 0);
		assert.equal(f.dictation.canRetry, false);
		assert.equal(f.dictation.error, null);
		assert.equal(retainedAfterEscape, false);
	} finally {
		window.removeEventListener("lh:kbd-abort-turn", onAbort);
		await act(async () => { shortcuts.unmount(); });
	}
});

test("regression: hookless provider change releases audio permanently", async () => {
	const f = await fixture("parakeet");
	const { useDictationLanguage } = await import("../components/dictation-preference.ts");
	let observed = "";
	function PreferenceOnly() {
		observed = useDictationLanguage().provider;
		return null;
	}

	await f.record();
	await f.frame(bytes(13, 14));
	f.state.transcribe = () => Response.json({}, { status: 500 });
	await act(async () => { await f.dictation.finish(); });
	await act(async () => { f.root.render(<PreferenceOnly />); });

	for (const provider of ["deepgram", "parakeet"] as const) {
		f.state.record = { version: 1, dictation: { language: "pl", provider } };
		await act(async () => { notifySettingsSaved("dictation"); });
		await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
		assert.equal(observed, provider);
	}

	await f.remount();
	assert.equal(f.dictation.canRetry, false);
	assert.equal(f.dictation.error, null);
	assert.equal(isDictationRetained(), false);
});
