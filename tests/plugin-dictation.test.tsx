import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { appendToPrimaryInput, DICTATION_ACTIVE_ELSEWHERE, finishDictation, useDictation, useDictationTarget, type Dictation } from "../components/dictation.tsx";
import { usePluginDictation } from "../components/plugin-dictation.tsx";
import { claimPluginInputFocus, dispatchFocusedPluginShortcut } from "../components/plugin-input-focus.ts";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { isDictationActive } from "../components/dictation-state.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}
class Socket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static all: Socket[] = [];
	readyState = Socket.CONNECTING;
	sent: unknown[] = [];
	constructor(readonly url: string, readonly protocols: string[]) { super(); Socket.all.push(this); }
	send(data: unknown) { this.sent.push(data); }
	close() { this.readyState = 3; }
	open() { this.readyState = Socket.OPEN; this.dispatchEvent(new Event("open")); }
	end() { this.close(); this.dispatchEvent(Object.assign(new Event("close"), { code: 1000 })); }
	final(text: string) { this.dispatchEvent(Object.assign(new Event("message"), {
		data: JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: text }] } }),
	})); }
}
class AudioGraph {
	state = "running";
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}
class Worklet { port = {}; connect() {} disconnect() {} }
let dispose: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;
let releaseFocus: (() => void)[] = [];

async function fixture() {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	let active: Element = dom.document.body;
	Object.defineProperty(dom.document, "activeElement", { get: () => active });
	dom.window.HTMLElement.prototype.focus = function () { active = this; };
	const state = {
		core: [] as string[], question: [] as string[], plugin: [] as string[], other: [] as string[],
		questionClaimed: false, showPlugin: true, showCore: true, disabled: false, captures: 0, stops: 0,
		append: undefined as ((text: string) => void | Promise<void>) | undefined,
		mic: undefined as Promise<{ getTracks: () => { stop: () => void }[] }> | undefined,
	};
	Socket.all = [];
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => {
			state.captures++;
			return state.mic ?? { getTracks: () => [{ stop() { state.stops++; } }] };
		} } },
		WebSocket: Socket, AudioContext: AudioGraph, AudioWorkletNode: Worklet,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string) => {
			if (url === "/api/stt/token") return Response.json({ token: "test-token" });
			assert.equal(url, "/api/settings");
			return Response.json({ settings: { version: 1, dictation: { language: "en" } } });
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	};
	let core!: Dictation;
	let plugin!: Dictation;
	let other!: Dictation;
	function Plugin() {
		plugin = usePluginDictation({ append: (text) => {
			if (state.append) return state.append(text);
			state.plugin.push(text);
		}, disabled: state.disabled });
		return <div id="plugin"><textarea id="plugin-input" /><button id="plugin-button">Dictate</button></div>;
	}
	function Core() {
		core = useDictation({ append: (text) => { state.core.push(text); } });
		return <textarea id="core" />;
	}
	function Harness() {
		other = usePluginDictation({ append: (text) => { state.other.push(text); } });
		useDictationTarget((text) => { state.question.push(text); }, state.questionClaimed);
		return <>{state.showCore && <Core />}{state.showPlugin && <Plugin />}<div id="other"><textarea id="other-input" /></div></>;
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	const render = async () => { await act(async () => { root.render(<Harness />); }); };
	dispose = async () => { await act(async () => { root.unmount(); }); };
	await render();
	await act(async () => { notifySettingsSaved("dictation"); });
	const registerFocus = () => {
		releaseFocus.push(claimPluginInputFocus(document.getElementById("plugin")!, { toggleDictation: () => plugin.toggle() }));
		releaseFocus.push(claimPluginInputFocus(document.getElementById("other")!, { toggleDictation: () => other.toggle() }));
	};
	const focus = (id: string) => document.getElementById(id)!.focus();
	const event = async (name: string) => { await act(async () => { window.dispatchEvent(new CustomEvent(`lh:kbd-${name}`)); }); };
	return { state, render, registerFocus, focus, event, unmount: () => dispose!(),
		get core() { return core; }, get plugin() { return plugin; }, get other() { return other; } };
}

afterEach(async () => {
	for (const release of releaseFocus.splice(0)) release();
	await dispose?.(); restore?.(); dispose = undefined; restore = undefined;
});

test("mounted plugins never replace core insertion, question priority, or core finish", async () => {
	const f = await fixture();
	assert.equal(appendToPrimaryInput("file"), true);
	assert.deepEqual(f.state.core, ["file"]);
	f.state.questionClaimed = true;
	await f.render();
	appendToPrimaryInput("question file");
	await act(async () => { f.core.toggle(); });
	const socket = Socket.all[0]!;
	await act(async () => { socket.open(); socket.final("spoken answer"); });
	let finished = false;
	let finish!: Promise<void>;
	await act(async () => { finish = finishDictation().then(() => { finished = true; }); });
	assert.equal(f.core.phase, "stopping");
	assert.equal(finished, false);
	await act(async () => { socket.final("tail"); socket.end(); await finish; });
	assert.equal(finished, true);
	assert.deepEqual(f.state.question, ["question file", "spoken answer tail"]);
	assert.deepEqual(f.state.plugin, []);
});

test("explicit plugin capture never appends into core/question and cannot steal capture", async () => {
	const f = await fixture();
	f.state.questionClaimed = true;
	await f.render();
	await act(async () => { f.plugin.toggle(); f.other.toggle(); f.core.toggle(); });
	assert.equal(f.state.captures, 1);
	assert.equal(Socket.all.length, 1);
	assert.equal(f.other.error, DICTATION_ACTIVE_ELSEWHERE);
	assert.equal(f.core.error, DICTATION_ACTIVE_ELSEWHERE);
	const socket = Socket.all[0]!;
	await act(async () => { socket.open(); socket.final("plugin only"); });
	await finishDictation();
	assert.equal(f.plugin.phase, "recording", "a mounted plugin cannot replace the core finisher");
	let finish!: Promise<void>;
	await act(async () => { finish = f.plugin.finish(); });
	await act(async () => { socket.end(); await finish; });
	assert.deepEqual(f.state.plugin, ["plugin only"]);
	assert.deepEqual(f.state.core, []);
	assert.deepEqual(f.state.question, []);
	assert.equal(isDictationActive(), false);
});

test("one shortcut activation goes to focused plugin; otherwise core fallback and global cancel", async () => {
	const f = await fixture();
	f.registerFocus();
	f.focus("plugin-input");
	await f.event("toggle-dictation");
	assert.equal(f.plugin.phase, "connecting");
	assert.equal(f.core.phase, "idle");
	assert.equal(f.state.captures, 1);
	const socket = Socket.all[0]!;
	await act(async () => { socket.open(); socket.final("discard me"); });
	f.focus("core");
	await f.event("cancel-dictation");
	assert.equal(f.plugin.phase, "idle");
	assert.deepEqual(f.state.plugin, []);
	await f.event("toggle-dictation");
	assert.equal(f.core.phase, "connecting");
	assert.equal(f.state.captures, 2);
	await f.event("cancel-dictation");
	assert.equal(isDictationActive(), false);
});

test("nested focus ownership scopes model/thinking callbacks and releases cleanly", async () => {
	const f = await fixture();
	const calls: string[] = [];
	const root = document.getElementById("plugin")!;
	const button = document.getElementById("plugin-button")!;
	const release = claimPluginInputFocus(root, { cycleModel: () => calls.push("model"), cycleThinking: () => calls.push("thinking") });
	const childRelease = claimPluginInputFocus(button, { toggleDictation: () => calls.push("dictation") });
	f.focus("plugin-button");
	assert.equal(dispatchFocusedPluginShortcut("toggle-dictation"), true);
	assert.equal(dispatchFocusedPluginShortcut("open-model-picker"), true, "routes the actual Mod+K registry action");
	assert.equal(dispatchFocusedPluginShortcut("cycle-thinking"), true);
	assert.deepEqual(calls, ["dictation", "model", "thinking"]);
	childRelease(); release();
	assert.equal(dispatchFocusedPluginShortcut("open-model-picker"), false);
	f.focus("core");
	assert.equal(dispatchFocusedPluginShortcut("toggle-dictation"), false);
});

test("disposal cancels only its own capture and ignores late transcript/mic events", async () => {
	const f = await fixture();
	const mic = deferred<{ getTracks: () => { stop: () => void }[] }>();
	f.state.mic = mic.promise;
	await act(async () => { f.plugin.toggle(); });
	f.state.showPlugin = false;
	await f.render();
	assert.equal(isDictationActive(), false);
	await act(async () => { mic.resolve({ getTracks: () => [{ stop() { f.state.stops++; } }] }); });
	assert.equal(f.state.stops, 1);
	assert.equal(Socket.all.length, 0);
	f.state.mic = undefined;
	await act(async () => { f.core.toggle(); });
	assert.equal(isDictationActive(), true);
	f.state.showPlugin = true;
	await f.render();
	f.state.showPlugin = false;
	await f.render();
	assert.equal(isDictationActive(), true, "idle plugin disposal cannot release another recording's lock");
	await f.event("cancel-dictation");
});

test("a standalone plugin can own shortcuts without a core composer or primary target", async () => {
	const f = await fixture();
	f.state.showCore = false;
	await f.render();
	f.registerFocus();
	f.focus("plugin-input");
	assert.equal(appendToPrimaryInput("must not reach plugin"), false);
	await f.event("toggle-dictation");
	assert.equal(f.plugin.phase, "connecting");
	assert.equal(f.state.captures, 1);
	const socket = Socket.all[0]!;
	await act(async () => { socket.open(); socket.final("standalone words"); });
	let finish!: Promise<void>;
	await act(async () => { finish = f.plugin.finish(); socket.end(); await finish; });
	assert.deepEqual(f.state.plugin, ["standalone words"]);
});

test("disposing a recorded plugin discards buffered text and stale socket events", async () => {
	const f = await fixture();
	await act(async () => { f.plugin.toggle(); });
	const socket = Socket.all[0]!;
	await act(async () => { socket.open(); socket.final("leaving page"); });
	f.state.showPlugin = false;
	await f.render();
	await act(async () => { socket.final("late words"); socket.end(); });
	assert.deepEqual(f.state.plugin, []);
	assert.equal(isDictationActive(), false);
	assert.equal(f.state.stops, 1);
	assert.equal(Socket.all.length, 1);
});

test("disabled prevents new capture but an active control still stops and keeps text", async () => {
	const f = await fixture();
	f.state.disabled = true;
	await f.render();
	await act(async () => { f.plugin.toggle(); });
	assert.equal(f.state.captures, 0);
	f.state.disabled = false;
	await f.render();
	await act(async () => { f.plugin.toggle(); });
	const socket = Socket.all[0]!;
	await act(async () => { socket.open(); socket.final("keep this"); });
	f.state.disabled = true;
	await f.render();
	await act(async () => { f.plugin.toggle(); socket.end(); });
	assert.deepEqual(f.state.plugin, ["keep this"]);
});

test("finish awaits an async transcript callback before a sender reads controlled text", async () => {
	const f = await fixture();
	const delivered = deferred<void>();
	let controlled = "";
	f.state.append = async (text) => { await delivered.promise; controlled = text; };
	await act(async () => { f.plugin.toggle(); });
	const socket = Socket.all[0]!;
	await act(async () => { socket.open(); socket.final("last words"); });
	let sent: string | undefined;
	let finish!: Promise<void>;
	await act(async () => { finish = f.plugin.finish().then(() => { sent = controlled; }); socket.end(); });
	assert.equal(sent, undefined);
	assert.equal(f.plugin.phase, "stopping");
	await act(async () => { delivered.resolve(); await finish; });
	assert.equal(sent, "last words");
	assert.equal(f.plugin.phase, "idle");
});

test("async transcript failure rejects finish, displays the error, and does not send", async () => {
	const f = await fixture();
	const delivered = deferred<void>();
	f.state.append = () => delivered.promise;
	await act(async () => { f.plugin.toggle(); });
	const socket = Socket.all[0]!;
	await act(async () => { socket.open(); socket.final("not delivered"); });
	let failure!: Promise<unknown>;
	await act(async () => { failure = f.plugin.finish().then(() => assert.fail("must not send"), (error) => error); socket.end(); });
	const error = new Error("Plugin input unavailable");
	await act(async () => { delivered.reject(error); assert.equal(await failure, error); });
	assert.equal(f.plugin.error, error.message);
	assert.equal(f.plugin.phase, "idle");
	await assert.rejects(f.plugin.finish(), /Plugin input unavailable/);
});

for (const action of ["cancel", "dispose"] as const) {
	for (const settlement of ["resolve", "reject"] as const) {
		test(`${action} during async transcript delivery rejects finish and never sends (${settlement})`, async () => {
			const f = await fixture();
			const delivered = deferred<void>();
			let controlled = "old draft";
			f.state.append = async (text) => { await delivered.promise; controlled = text; };
			await act(async () => { f.plugin.toggle(); });
			const socket = Socket.all[0]!;
			await act(async () => { socket.open(); socket.final("new transcript"); });
			let sent: string | undefined;
			let finish!: Promise<unknown>;
			await act(async () => {
				finish = f.plugin.finish().then(() => { sent = controlled; }, (error: unknown) => error);
				socket.end();
			});
			assert.equal(f.plugin.phase, "stopping");
			if (action === "cancel") await act(async () => { f.plugin.cancel(); });
			else { f.state.showPlugin = false; await f.render(); }
			const error = await finish;
			assert.ok(error instanceof DOMException);
			assert.equal(error.name, "AbortError");
			assert.equal(sent, undefined, "cancel/dispose must not resume send with the old draft");
			assert.equal(isDictationActive(), false);
			await act(async () => { f.core.toggle(); });
			assert.equal(isDictationActive(), true);
			await act(async () => {
				if (settlement === "resolve") delivered.resolve();
				else delivered.reject(new Error("late callback failure"));
			});
			assert.equal(sent, undefined, "late callback settlement must not revive the canceled sender");
			assert.equal(isDictationActive(), true, "late settlement must not release a subsequent recording's lock");
		});
	}
}

test("core cancel before transcript delivery still resolves finish and discards buffered speech", async () => {
	const f = await fixture();
	await act(async () => { f.core.toggle(); });
	const socket = Socket.all[0]!;
	await act(async () => { socket.open(); socket.final("discard me"); });
	let finished = false;
	await act(async () => {
		const finish = f.core.finish().then(() => { finished = true; });
		f.core.cancel();
		await finish;
	});
	assert.equal(finished, true);
	assert.deepEqual(f.state.core, []);
	assert.equal(isDictationActive(), false);
});

test("stop without a finish waiter safely consumes async transcript rejection", async () => {
	const f = await fixture();
	f.state.append = async () => { throw new Error("delivery failed"); };
	await act(async () => { f.plugin.toggle(); });
	const socket = Socket.all[0]!;
	await act(async () => { socket.open(); socket.final("text"); f.plugin.stop(); socket.end(); });
	assert.equal(f.plugin.error, "delivery failed");
	assert.equal(isDictationActive(), false);
});
