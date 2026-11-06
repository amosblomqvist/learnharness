import React, { act, useRef, useState } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { KeyboardShortcuts } from "../components/keyboard-shortcuts.tsx";
import { createInteractionLayers } from "../components/interaction-layers.tsx";
import { PluginQuestionDockContent } from "../components/plugin-question-dock.tsx";
import { ReadingThinkingField } from "../components/reading-thinking.tsx";
import { DictationBar, useDictation, type Dictation } from "../components/dictation.tsx";
import { capturePluginQuestionKey, pluginQuestionKeySuppressed } from "../components/plugin-question-keys.ts";
import type { PluginQuestionDraft } from "../components/session-core.ts";
import type { QuestionRendererRegistration } from "../components/plugin-manager.ts";
import type { ChatInput } from "../src/core/index.ts";
import type { PluginQuestionEditorProps, PluginQuestionEditorHandle, PluginQuestionSnapshot, PluginQuestionRenderer } from "../src/core/plugin-questions.ts";

const saved: PluginQuestionSnapshot = { protocolVersion: 1, pluginId: "fixture", typeId: "code", label: "Code", variant: "probe", questionId: "q1", contractVersion: 1, occurrence: { messageId: "a", contentIndex: 0, toolCallId: "call", toolName: "code" }, input: { question: "Public question", payload: { reference: "PRIVATE_REFERENCE" } }, questionSchema: { type: "object" }, answerSchema: { type: "string" }, showThinking: false, requiresAnswerRefinement: false };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
class Socket extends EventTarget {
	static CONNECTING = 0; static OPEN = 1; static all: Socket[] = [];
	readyState = Socket.CONNECTING;
	constructor() { super(); Socket.all.push(this); }
	send() {} close() { this.readyState = 3; }
	open() { this.readyState = Socket.OPEN; this.dispatchEvent(new Event("open")); }
	end() { this.close(); this.dispatchEvent(Object.assign(new Event("close"), { code: 1000 })); }
	final(text: string) { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: text }] } }) })); }
}
class AudioGraph { state = "running"; destination = {}; audioWorklet = { addModule: async () => {} }; createMediaStreamSource() { return { connect() {}, disconnect() {} }; } }
class Worklet { port = {}; connect() {} disconnect() {} }
let cleanup: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;
afterEach(async () => { await cleanup?.(); restore?.(); cleanup = undefined; restore = undefined; });

async function fixture(options: { keyboard?: boolean; thinking?: boolean; check?: boolean; missing?: boolean; available?: boolean; append?: boolean; asyncMount?: boolean; deferPublication?: boolean; ready?: boolean; reconciliation?: "ready" | "syncing" | "failed"; editorFails?: boolean; handleKeyDown?: PluginQuestionEditorHandle["handleKeyDown"]; question?: PluginQuestionRenderer["mountQuestion"] } = {}) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	let active: Element = dom.document.body;
	Object.defineProperty(dom.document, "activeElement", { get: () => active });
	dom.window.HTMLElement.prototype.focus = function () { active = this; };
	dom.window.HTMLElement.prototype.blur = function () { if (active === this) active = dom.document.body; };
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({ React, window: dom.window, document: dom.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} },
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } }, WebSocket: Socket, AudioContext: AudioGraph, AudioWorkletNode: Worklet,
		fetch: async (url: string) => { if (url === "/api/stt/token") return Response.json({ token: "fake" }); assert.equal(url, "/api/settings"); return Response.json({ settings: { version: 1, dictation: { language: "en" } } }); },
	})) { previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
	restore = () => { for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; };
	Socket.all = [];
	const draft: PluginQuestionDraft = { answer: { status: "empty" }, thinking: "", readingThinking: "" };
	const state = { snapshot: { ...saved, showThinking: options.thinking ?? false, ...(options.check ? { variant: "teach" as const, input: { ...saved.input, type: "check" as const, nodeId: "node" } } : {}) }, expanded: !options.check, reveal: !!options.check, ready: options.ready ?? true, reconciliation: options.reconciliation ?? "ready" as "ready" | "syncing" | "failed", available: options.available ?? true, mic: false, sent: [] as ChatInput[], dismissed: 0, mounts: 0, disposed: 0, updates: [] as boolean[], speech: [] as string[], fallback: [] as string[] };
	const mount = deferred<PluginQuestionEditorHandle>(); const delivery = deferred<void>();
	let editorProps!: PluginQuestionEditorProps;
	let registration: QuestionRendererRegistration | undefined = options.missing ? undefined : { pluginId: "fixture", renderer: { id: "code", supportedContractVersions: [1], ...(options.question ? { mountQuestion: options.question } : {}), mountAnswerEditor(container, props) {
		state.mounts++; editorProps = props;
		if (options.editorFails) throw new Error("PRIVATE_EDITOR_FAILURE");
		const textarea = container.ownerDocument.createElement("textarea"); textarea.id = "plugin-editor"; container.append(textarea);
		if (!options.deferPublication) props.onChange({ status: "ready", value: "  code\n" });
		const handle: PluginQuestionEditorHandle = { ...(options.handleKeyDown ? { handleKeyDown: options.handleKeyDown } : {}), update(value) { state.updates.push(value.active); }, focus() { textarea.focus(); }, dispose() { state.disposed++; },
			...(options.append ? { async appendTranscript(text: string) { state.speech.push(text); await delivery.promise; props.onChange({ status: "ready", value: `  code\n${text}` }); } } : {}) };
		if (options.asyncMount) return mount.promise; return handle;
	} } };
	let dictation!: Dictation;
	function Harness() {
		const reading = useRef<HTMLDivElement>(null);
		const [mic, setMic] = useState(false); state.mic = mic;
		dictation = useDictation({ append: text => { state.fallback.push(text); }, disabled: !mic });
		return <>
			{options.check && <ReadingThinkingField inputRef={reading} value={draft.readingThinking} revision={0} onChange={value => { draft.readingThinking = value; }} claim={state.reveal} />}
			<PluginQuestionDockContent snapshot={state.snapshot} chatId="chat" draft={draft} expanded={state.expanded} reveal={state.reveal} ready={state.ready} reconciliation={state.reconciliation} available={state.available} registration={registration} readingRef={reading} onMicAvailable={setMic}
				onExpand={() => { state.reveal = false; state.expanded = true; }} send={async input => { state.sent.push(input); return true; }} dismiss={async () => { state.dismissed++; }} />
			<DictationBar dictation={dictation} disabled={!mic} />
			{options.keyboard && <AppRouterContext.Provider value={{ bfcacheId: "plugin-question-fixture", back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} }}><KeyboardShortcuts /></AppRouterContext.Provider>}
		</>;
	}
	const { createRoot } = await import("react-dom/client"); const root = createRoot(document.getElementById("root")!);
	const render = async () => { await act(async () => { root.render(<Harness />); }); };
	cleanup = async () => { await act(async () => { root.unmount(); }); };
	await render();
	const commandSubmit = async () => { await act(async () => { capturePluginQuestionKey({ key: "Enter", ctrlKey: true, target: document.getElementById("plugin-editor"), preventDefault() {} } as unknown as KeyboardEvent); }); };
	return { state, draft, render, delivery, mount, get registration() { return registration; }, replaceRegistration(next: QuestionRendererRegistration | undefined) { registration = next; }, commandSubmit, get editorProps() { return editorProps; }, get dictation() { return dictation; }, get socket() { return Socket.all.at(-1)!; } };
}

test("missing renderer keeps safe public fallback, thinking drafts and dismiss; no payload or raw errors", async () => {
	const f = await fixture({ missing: true, thinking: true });
	assert.match(document.body.textContent ?? "", /Public question/); assert.match(document.body.textContent ?? "", /Question unavailable/);
	assert.doesNotMatch(document.body.textContent ?? "", /PRIVATE_REFERENCE/);
	assert.ok(document.querySelector('[type="submit"]')!.hasAttribute("disabled")); assert.equal(f.state.mic, true);
	await act(async () => { (Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Dismiss question") as HTMLElement).click(); });
	assert.equal(f.state.dismissed, 1); assert.equal(f.state.sent.length, 0);
});

test("new mounts wait for canonical readiness; a current generation survives reconciliation without remounting", async () => {
	const f = await fixture({ ready: false }); assert.equal(f.state.mounts, 0);
	assert.equal(document.querySelector('[role="status"]'), null, "canonical readiness is not a renderer failure");
	assert.equal(Array.from(document.querySelectorAll("button")).some(button => button.textContent === "Dismiss question"), false);
	f.state.ready = true; await f.render(); assert.equal(f.state.mounts, 1);
	f.state.ready = false; await f.render(); assert.equal(f.state.mounts, 1); assert.equal(f.state.updates.at(-1), false);
	await f.commandSubmit(); assert.equal(f.state.sent.length, 0);
	f.state.ready = true; await f.render(); assert.equal(f.state.mounts, 1); assert.equal(f.state.updates.at(-1), true);
});

test("canonical unknown availability is preparing or read-only failure, never renderer recovery", async () => {
	const f = await fixture({ reconciliation: "syncing", available: false, missing: true, ready: true });
	assert.equal(f.state.mounts, 0);
	assert.match(document.body.textContent ?? "", /Preparing question…/);
	assert.match(document.body.textContent ?? "", /Public question/);
	assert.doesNotMatch(document.body.textContent ?? "", /Question unavailable|Dismiss question|PRIVATE_/);
	assert.ok(document.querySelector('button[type="submit"]')?.hasAttribute("disabled"));
	await f.commandSubmit(); assert.equal(f.state.sent.length, 0);
	f.state.reconciliation = "failed"; await f.render();
	assert.match(document.body.textContent ?? "", /Public question/);
	assert.doesNotMatch(document.body.textContent ?? "", /Preparing question|Question unavailable|Dismiss question|Retry|PRIVATE_/);
	assert.equal(document.querySelector('[role="status"]'), null, "canonical failure is explained by the parent Retry banner only");
	f.state.reconciliation = "ready"; f.state.ready = false; await f.render();
	assert.match(document.body.textContent ?? "", /Question unavailable/);
	const dismiss = Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Dismiss question");
	assert.ok(dismiss); assert.equal(dismiss.disabled, true, "known unavailability is distinct from interaction readiness");
});

test("new editor generations require canonical and interaction readiness independently", async () => {
	const f = await fixture({ reconciliation: "syncing", ready: true });
	assert.equal(f.state.mounts, 0);
	f.state.reconciliation = "failed"; await f.render(); assert.equal(f.state.mounts, 0);
	f.state.reconciliation = "ready"; f.state.ready = false; await f.render(); assert.equal(f.state.mounts, 0);
	assert.doesNotMatch(document.body.textContent ?? "", /Question unavailable|Dismiss question/);
	f.state.ready = true; await f.render(); assert.equal(f.state.mounts, 1);
});

test("an admitted live editor survives reconciliation read-only and rejects publications while availability is unknown", async () => {
	const f = await fixture(); const editor = document.getElementById("plugin-editor"); const props = f.editorProps;
	const before = structuredClone(f.draft.answer);
	f.state.reconciliation = "syncing"; f.state.ready = false; f.state.available = false; await f.render();
	assert.equal(f.state.mounts, 1); assert.equal(f.state.disposed, 0); assert.equal(props.signal.aborted, false);
	assert.equal(document.getElementById("plugin-editor"), editor); assert.equal(f.state.updates.at(-1), false);
	assert.equal(editor?.parentElement?.parentElement?.className, "min-w-0");
	await act(async () => { props.onChange({ status: "ready", value: "unconfirmed" }); });
	assert.deepEqual(f.draft.answer, before);
	await f.commandSubmit(); assert.equal(f.state.sent.length, 0);
	f.state.reconciliation = "failed"; await f.render();
	assert.equal(f.state.disposed, 0); assert.equal(f.state.updates.at(-1), false);
	assert.doesNotMatch(document.body.textContent ?? "", /Question unavailable|Dismiss question|Preparing question/);
	f.state.reconciliation = "ready"; f.state.available = true; await f.render();
	assert.equal(f.state.updates.at(-1), false, "busy/compacting readiness is not canonical readiness");
	await act(async () => { props.onChange({ status: "ready", value: "while busy" }); });
	assert.deepEqual(f.draft.answer, { status: "ready", value: "while busy" }, "current-owner programmatic publication survives interaction read-only state");
	f.state.ready = true; await f.render();
	assert.equal(f.state.mounts, 1); assert.equal(f.state.disposed, 0); assert.equal(f.state.updates.at(-1), true);
	await f.commandSubmit(); assert.equal(f.state.sent.length, 1);
});

test("confirmed unavailability after reconciliation revokes the retained editor and exposes recovery", async () => {
	const f = await fixture(); const props = f.editorProps;
	f.state.reconciliation = "syncing"; f.state.available = false; await f.render(); assert.equal(f.state.disposed, 0);
	f.state.reconciliation = "ready"; await f.render();
	assert.equal(f.state.disposed, 1); assert.equal(props.signal.aborted, true);
	assert.match(document.body.textContent ?? "", /Question unavailable/);
	assert.match(document.body.textContent ?? "", /Dismiss question/);
	await act(async () => { props.onChange({ status: "ready", value: "revoked" }); });
	assert.deepEqual(f.draft.answer, { status: "ready", value: "  code\n" });
	await f.commandSubmit(); assert.equal(f.state.sent.length, 0);
	f.state.available = true; await f.render(); assert.equal(f.state.mounts, 2);
});

for (const change of ["question", "registration", "unregister", "reveal"] as const) test(`unknown reconciliation does not retain a generation across ${change}`, async () => {
	const f = await fixture(); const props = f.editorProps;
	f.state.reconciliation = "syncing"; f.state.ready = false; f.state.available = false;
	if (change === "question") f.state.snapshot = { ...f.state.snapshot, occurrence: { ...f.state.snapshot.occurrence, messageId: "replacement" } };
	if (change === "registration") f.replaceRegistration({ ...f.registration!, renderer: { ...f.registration!.renderer } });
	if (change === "unregister") f.replaceRegistration(undefined);
	if (change === "reveal") f.state.reveal = true;
	await f.render(); assert.equal(f.state.disposed, 1); assert.equal(props.signal.aborted, true); assert.equal(f.state.mounts, 1);
	await act(async () => { props.onChange({ status: "ready", value: "obsolete" }); });
	assert.deepEqual(f.draft.answer, { status: "ready", value: "  code\n" });
});

for (const hook of ["absent", "pass", "handled"] as const) test(`${hook} editor hook uses host Enter default unless explicitly handled`, async () => {
	const calls: string[] = [];
	const f = await fixture(hook === "absent" ? {} : { handleKeyDown(key) { calls.push(key); return hook; } });
	let prevented = 0;
	await act(async () => { capturePluginQuestionKey({ key: "Enter", target: document.getElementById("plugin-editor"), preventDefault() { prevented++; } } as unknown as KeyboardEvent); });
	assert.equal(prevented, 1); assert.equal(f.state.sent.length, hook === "handled" ? 0 : 1);
	assert.deepEqual(calls, hook === "absent" ? [] : ["Enter"]);
});

async function pressQuestionKey(key: string, extra = {}) {
	const target = document.activeElement!;
	const event = Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key, ...extra });
	Object.defineProperty(event, "target", { configurable: true, value: target });
	await act(async () => { capturePluginQuestionKey(event as unknown as KeyboardEvent); target.dispatchEvent(event); });
	return event;
}

for (const hook of ["absent", "pass"] as const) for (const field of ["thinking", "reading", "none"] as const) test(`${hook} editor Escape moves directly to ${field}, claims that event and preserves the following host Enter`, async () => {
	const calls: string[] = [];
	const f = await fixture({ keyboard: true, thinking: field === "thinking", check: field === "reading", ...(hook === "pass" ? { handleKeyDown(key) { calls.push(key); return "pass"; } } : {}) });
	if (field === "reading") { f.state.reveal = false; f.state.expanded = true; await f.render(); }
	const editor = document.getElementById("plugin-editor")!;
	editor.focus();
	const next = field === "none" ? document.body : document.querySelector<HTMLElement>(`[data-testid="${field === "thinking" ? "thinking-field" : "reading-thinking-field"}"] [data-file-path-input]`)!;
	assert.ok(next);
	let aborts = 0;
	const onAbort = () => { aborts++; };
	window.addEventListener("lh:kbd-abort-turn", onAbort);
	let escape: Event;
	try { escape = await pressQuestionKey("Escape"); } finally { window.removeEventListener("lh:kbd-abort-turn", onAbort); }
	assert.equal(escape.defaultPrevented, true); assert.equal(pluginQuestionKeySuppressed(escape), true);
	assert.equal(aborts, 0); assert.equal(f.state.sent.length, 0);
	assert.equal(document.activeElement, next, "one Escape leaves the plugin without an intermediate unfocused state when a local host field exists");
	assert.deepEqual(calls, hook === "pass" ? ["Escape"] : []);
	if (field !== "none") Object.defineProperty(next, "isContentEditable", { configurable: true, value: true });
	await pressQuestionKey("Enter");
	assert.equal(f.state.sent.length, field === "reading" ? 0 : 1, "the next Enter preserves the existing host field default (reading keeps its newline)");
	if (field === "reading") { await pressQuestionKey("Enter", { ctrlKey: true }); assert.equal(f.state.sent.length, 1, "the reserved host chord still submits from reading"); }
	assert.deepEqual(calls, hook === "pass" ? ["Escape"] : []);
	if (field === "none") {
		await pressQuestionKey("Tab"); assert.equal(document.activeElement, editor, "Tab re-enters the existing local editor chain");
	}
});

test("Escape chooses Your thinking before reading in the existing local chain", async () => {
	const f = await fixture({ thinking: true, check: true });
	f.state.reveal = false; f.state.expanded = true; await f.render();
	document.getElementById("plugin-editor")!.focus(); await pressQuestionKey("Escape");
	assert.equal(document.activeElement, document.querySelector('[data-testid="thinking-field"] [data-file-path-input]'));
	assert.equal(f.state.sent.length, 0);
});

test("an editor-claimed Escape keeps focus and performs no host navigation or submission; Tab indentation remains editor-owned", async () => {
	const calls: string[] = [];
	const f = await fixture({ thinking: true, handleKeyDown(key) { calls.push(key); return "handled"; } });
	const editor = document.getElementById("plugin-editor")!; editor.focus();
	for (const key of ["Escape", "Tab"]) {
		const event = await pressQuestionKey(key);
		assert.equal(event.defaultPrevented, true); assert.equal(pluginQuestionKeySuppressed(event), true);
		assert.equal(document.activeElement, editor); assert.equal(f.state.sent.length, 0);
	}
	assert.deepEqual(calls, ["Escape", "Tab"]);
});

test("editor Escape ignores modifiers and IME/229, inactive and hidden docks, and covered foreground layers", async () => {
	const calls: string[] = [];
	const f = await fixture({ thinking: true, handleKeyDown(key) { calls.push(key); return "pass"; } });
	const editor = document.getElementById("plugin-editor")!; editor.focus();
	const untouched = async (extra = {}) => {
		const event = await pressQuestionKey("Escape", extra);
		assert.equal(event.defaultPrevented, false); assert.equal(document.activeElement, editor);
		assert.equal(f.state.sent.length, 0); assert.deepEqual(calls, []);
	};
	for (const extra of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }]) await untouched(extra);
	f.state.expanded = false; await f.render(); await untouched();
	f.state.expanded = true; f.state.ready = false; await f.render(); await untouched();
	f.state.ready = true; f.state.reconciliation = "syncing"; await f.render(); await untouched();
	f.state.reconciliation = "failed"; await f.render(); await untouched();
	f.state.reconciliation = "ready"; await f.render();
	const root = document.querySelector<HTMLElement>('[data-testid="plugin-question-dock"]')!;
	root.hidden = true; await untouched(); root.hidden = false;
	const modal = document.createElement("div"); modal.setAttribute("role", "dialog"); document.body.append(modal);
	await untouched(); modal.remove();
	await pressQuestionKey("Escape"); assert.deepEqual(calls, ["Escape"]);
	assert.equal(document.activeElement, document.querySelector('[data-testid="thinking-field"] [data-file-path-input]'));
});

test("the same editor Escape claim suppresses the snapshotted layer close as well as the global fallback", async () => {
	const f = await fixture({ keyboard: true, thinking: true });
	const layers = createInteractionLayers(); let closes = 0, aborts = 0;
	const remove = layers.register({ id: "question-view", kind: "view", rootRef: { current: document.querySelector<HTMLElement>('[data-testid="plugin-question-dock"]') }, onClose() { closes++; return "closed"; } });
	const onAbort = () => { aborts++; }; window.addEventListener("lh:kbd-abort-turn", onAbort);
	try {
		const editor = document.getElementById("plugin-editor")!; editor.focus();
		const event = Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" });
		Object.defineProperty(event, "target", { configurable: true, value: editor });
		await act(async () => {
			layers.captureKeyDown(event as unknown as KeyboardEvent);
			editor.dispatchEvent(event);
			assert.equal(layers.dispatchEscape(event as unknown as KeyboardEvent), null);
		});
		assert.equal(event.defaultPrevented, true); assert.equal(pluginQuestionKeySuppressed(event), true);
		assert.equal(closes, 0); assert.equal(aborts, 0); assert.equal(f.state.sent.length, 0);
		assert.equal(document.activeElement, document.querySelector('[data-testid="thinking-field"] [data-file-path-input]'));
	} finally { remove(); window.removeEventListener("lh:kbd-abort-turn", onAbort); }
});

test("a pending unadopted editor cannot claim Escape or move focus", async () => {
	const calls: string[] = [];
	await fixture({ thinking: true, asyncMount: true, handleKeyDown(key) { calls.push(key); return "pass"; } });
	const editor = document.getElementById("plugin-editor")!; editor.focus();
	const event = await pressQuestionKey("Escape");
	assert.equal(event.defaultPrevented, false); assert.equal(pluginQuestionKeySuppressed(event), false);
	assert.equal(document.activeElement, editor); assert.deepEqual(calls, []);
});

test("folding/canonical replacement preserve editor generation, active updates and ready-state drafts", async () => {
	const f = await fixture(); assert.equal(f.state.mounts, 1); assert.equal(f.state.mic, false);
	assert.equal(document.querySelector('[data-testid="thinking-field"]'), null);
	assert.equal(Array.from(document.querySelectorAll("button")).some(button => button.textContent === "Dismiss question"), false, "healthy no-thinking questions have no dismissal action either");
	f.state.expanded = false; await f.render(); assert.equal(f.state.updates.at(-1), false); await f.commandSubmit(); assert.equal(f.state.sent.length, 0);
	f.state.snapshot = structuredClone(f.state.snapshot); f.state.expanded = true; await f.render();
	assert.equal(f.state.mounts, 1); assert.equal(f.state.disposed, 0); assert.equal(f.state.updates.at(-1), true);
	await f.commandSubmit(); assert.equal(f.state.sent.length, 1); assert.equal(f.state.sent[0]!.type, "plugin-question-answer");
});

test("component host commands suppress IME/229 without preventing native editing, and covered scopes stay inert", async () => {
	const f = await fixture();
	let prevented = 0;
	await act(async () => {
		for (const extra of [{ isComposing: true }, { keyCode: 229 }]) capturePluginQuestionKey({ key: "Enter", ctrlKey: true, target: document.getElementById("plugin-editor"), ...extra, preventDefault() { prevented++; } } as unknown as KeyboardEvent);
	});
	assert.equal(prevented, 0); assert.equal(f.state.sent.length, 0);
	const enter = async () => { await act(async () => { capturePluginQuestionKey({ key: "Enter", target: document.getElementById("plugin-editor"), preventDefault() {} } as unknown as KeyboardEvent); }); };
	const root = document.querySelector('[data-testid="plugin-question-dock"]') as HTMLElement; root.hidden = true;
	await enter(); await f.commandSubmit(); assert.equal(f.state.sent.length, 0);
	root.hidden = false;
	const modal = document.createElement("div"); modal.setAttribute("role", "dialog"); document.body.append(modal);
	await enter(); await f.commandSubmit(); assert.equal(f.state.sent.length, 0, "foreground modal blocks both native and chord submission");
	modal.remove(); await enter(); assert.equal(f.state.sent.length, 1);
});

test("asynchronous mount is never answer-ready before adoption and stale callbacks cannot submit", async () => {
	const f = await fixture({ asyncMount: true });
	await f.commandSubmit(); assert.equal(f.state.sent.length, 0);
	const old = f.editorProps;
	f.state.available = false; await f.render();
	let disposed = 0;
	await act(async () => { f.mount.resolve({ update() {}, focus() {}, dispose() { disposed++; } }); });
	assert.equal(disposed, 1); assert.equal(old.signal.aborted, true);
	await act(async () => { old.onChange({ status: "ready", value: "STALE" }); });
	assert.deepEqual(f.draft.answer, { status: "ready", value: "  code\n" });
	await f.commandSubmit(); assert.equal(f.state.sent.length, 0);
});

test("explicit answer-speech opt-in awaits final STT delivery before reading refs and submitting", async () => {
	const f = await fixture({ append: true }); assert.equal(f.state.mic, true);
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { f.socket.open(); f.socket.final("first"); });
	await f.commandSubmit(); assert.equal(f.dictation.phase, "stopping"); assert.equal(f.state.sent.length, 0);
	await act(async () => { f.socket.final("tail"); f.socket.end(); });
	assert.deepEqual(f.state.speech, ["first tail"]); assert.equal(f.state.sent.length, 0);
	await act(async () => { f.delivery.resolve(); });
	assert.equal(f.state.sent.length, 1); const input = f.state.sent[0]!;
	assert.equal(input.type, "plugin-question-answer"); if (input.type === "plugin-question-answer") { assert.equal(input.answer, "  code\nfirst tail"); assert.equal("thinking" in input, false); }
	assert.deepEqual(f.state.fallback, []);
});

test("in-flight editor speech cannot publish or submit while its retained generation is unconfirmed", async () => {
	const f = await fixture({ append: true });
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { f.socket.open(); f.socket.final("in flight"); });
	await f.commandSubmit();
	await act(async () => { f.socket.end(); });
	assert.deepEqual(f.state.speech, ["in flight"]); assert.equal(f.state.sent.length, 0);
	f.state.reconciliation = "syncing"; f.state.ready = false; f.state.available = false; await f.render();
	assert.equal(f.state.disposed, 0);
	await act(async () => { f.delivery.resolve(); });
	assert.deepEqual(f.draft.answer, { status: "ready", value: "  code\n" });
	assert.equal(f.state.sent.length, 0); assert.equal(f.state.disposed, 0);
});

for (const reconciliation of ["syncing", "failed"] as const) test(`current answer capture starts final delivery during ${reconciliation} without losing or replaying its draft`, async () => {
	const f = await fixture({ append: true });
	await act(async () => { f.dictation.toggle(); }); const socket = f.socket;
	await act(async () => { socket.open(); socket.final("first"); });
	f.state.reconciliation = reconciliation; f.state.ready = false; await f.render();
	assert.equal(f.state.available, true, "cached authority still belongs to this admitted current owner");
	assert.equal(f.state.updates.at(-1), false); assert.equal(f.dictation.phase, "recording");
	await act(async () => { f.dictation.stop(); });
	await act(async () => { socket.final("tail"); socket.end(); });
	assert.deepEqual(f.state.speech, ["first tail"], "read-only current owner still receives its already-captured final");
	assert.equal(f.state.sent.length, 0);
	await act(async () => { f.delivery.resolve(); });
	const expected = "  code\nfirst tail";
	assert.deepEqual(f.draft.answer, { status: "ready", value: expected });
	await f.commandSubmit(); assert.equal(f.state.sent.length, 0, "canonical submission remains gated");
	f.state.reconciliation = "ready"; f.state.ready = true; await f.render();
	await act(async () => { await f.dictation.finish(); socket.end(); });
	assert.deepEqual(f.state.speech, ["first tail"]); assert.deepEqual(f.draft.answer, { status: "ready", value: expected });
	await f.commandSubmit(); const input = f.state.sent[0]!;
	assert.equal(input.type, "plugin-question-answer"); if (input.type === "plugin-question-answer") assert.equal(input.answer, expected);
	assert.equal(f.state.sent.length, 1); assert.equal(f.state.mounts, 1);
});

for (const reconciliation of ["syncing", "failed"] as const) test(`in-flight answer publication completes during ${reconciliation} without losing its current-owner final`, async () => {
	const f = await fixture({ append: true });
	await act(async () => { f.dictation.toggle(); }); const socket = f.socket;
	await act(async () => { socket.open(); socket.final("first"); });
	await f.commandSubmit();
	await act(async () => { socket.final("tail"); socket.end(); });
	assert.deepEqual(f.state.speech, ["first tail"]);
	assert.deepEqual(f.draft.answer, { status: "ready", value: "  code\n" }, "plugin publication is still awaiting its async delivery");
	f.state.reconciliation = reconciliation; f.state.ready = false; await f.render();
	assert.equal(f.state.available, true); assert.equal(f.state.disposed, 0); assert.equal(f.state.updates.at(-1), false);
	await act(async () => { f.delivery.resolve(); });
	const expected = "  code\nfirst tail";
	assert.deepEqual(f.draft.answer, { status: "ready", value: expected });
	assert.equal(f.state.sent.length, 0, "the pending submit must not POST while canonical state is unknown");
	f.state.reconciliation = "ready"; f.state.ready = true; await f.render();
	await act(async () => { await f.dictation.finish(); });
	assert.deepEqual(f.state.speech, ["first tail"]); assert.deepEqual(f.draft.answer, { status: "ready", value: expected });
	await f.commandSubmit(); const input = f.state.sent[0]!;
	assert.equal(input.type, "plugin-question-answer"); if (input.type === "plugin-question-answer") assert.equal(input.answer, expected);
	assert.equal(f.state.sent.length, 1); assert.equal(f.state.mounts, 1);
});

test("an admitted async editor keeps its first current-owner publication and adoption during reconciliation", async () => {
	const f = await fixture({ asyncMount: true, deferPublication: true }); const props = f.editorProps;
	assert.deepEqual(f.draft.answer, { status: "empty" }); assert.equal(f.state.mounts, 1);
	f.state.reconciliation = "syncing"; f.state.ready = false; await f.render();
	const expected = "  delayed initial answer\n";
	await act(async () => { props.onChange({ status: "ready", value: expected }); });
	assert.deepEqual(f.draft.answer, { status: "ready", value: expected });
	await f.commandSubmit(); assert.equal(f.state.sent.length, 0);
	await act(async () => { f.mount.resolve({ update(value) { f.state.updates.push(value.active); }, focus() {}, dispose() { f.state.disposed++; } }); });
	assert.equal(f.state.updates.at(-1), false); assert.equal(props.signal.aborted, false); assert.equal(f.state.disposed, 0);
	f.state.reconciliation = "failed"; await f.render();
	assert.deepEqual(f.draft.answer, { status: "ready", value: expected }); assert.equal(f.state.updates.at(-1), false);
	f.state.reconciliation = "ready"; f.state.ready = true; await f.render();
	assert.equal(f.state.mounts, 1); assert.equal(f.state.updates.at(-1), true);
	assert.deepEqual(f.draft.answer, { status: "ready", value: expected });
	await f.commandSubmit(); const input = f.state.sent[0]!;
	assert.equal(input.type, "plugin-question-answer"); if (input.type === "plugin-question-answer") assert.equal(input.answer, expected);
	assert.equal(f.state.sent.length, 1);
});

test("thinking-on speech stays host-owned, empty thinking remains an applicable answer channel", async () => {
	const f = await fixture({ append: true, thinking: true });
	await f.commandSubmit(); let input = f.state.sent[0]!; if (input.type === "plugin-question-answer") assert.equal(input.thinking, "");
	f.state.sent.length = 0;
	await act(async () => { f.dictation.toggle(); }); await act(async () => { f.socket.open(); f.socket.final("thinking"); });
	await f.commandSubmit(); await act(async () => { f.socket.final("tail"); f.socket.end(); });
	input = f.state.sent[0]!; assert.equal(input.type, "plugin-question-answer"); if (input.type === "plugin-question-answer") { assert.equal(input.answer, "  code\n"); assert.equal(input.thinking, "thinking tail"); }
	assert.deepEqual(f.state.speech, []); assert.deepEqual(f.state.fallback, []);
});

for (const transition of [
	{ label: "syncing with unknown availability", reconciliation: "syncing", ready: false, available: false },
	{ label: "failed canonical read with unknown availability", reconciliation: "failed", ready: false, available: false },
	{ label: "interaction not ready during compaction", reconciliation: "ready", ready: false, available: true },
	{ label: "plugin unavailable", reconciliation: "ready", ready: true, available: false },
] as const) test(`active host-thinking capture retains its final exactly once during ${transition.label}`, async () => {
	const f = await fixture({ thinking: true, append: true });
	f.draft.thinking = "  existing thought";
	await act(async () => { f.dictation.toggle(); });
	const socket = f.socket;
	await act(async () => { socket.open(); socket.final("first"); });
	assert.equal(f.dictation.phase, "recording");
	assert.equal(f.draft.thinking, "  existing thought", "the active capture still buffers its final");
	Object.assign(f.state, transition); await f.render();
	assert.equal(f.dictation.phase, "recording", "ordinary readiness changes do not revoke the host destination");
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.phase, "stopping");
	await act(async () => { socket.final("tail"); socket.end(); });
	const expected = "  existing thought first tail";
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.draft.thinking, expected, "final delivery updates the same host draft despite readiness gates");
	assert.deepEqual(f.state.speech, []); assert.deepEqual(f.state.fallback, []); assert.equal(f.state.sent.length, 0);
	f.state.reconciliation = "ready"; f.state.ready = true; f.state.available = true; await f.render();
	await act(async () => { await f.dictation.finish(); socket.end(); });
	assert.equal(f.draft.thinking, expected, "resuming and repeated finish do not replay a delivered final");
	await f.commandSubmit();
	const input = f.state.sent[0]!; assert.equal(input.type, "plugin-question-answer");
	if (input.type === "plugin-question-answer") assert.equal(input.thinking, expected);
	assert.equal(f.state.sent.length, 1);
});

for (const change of ["question key", "reveal"] as const) test(`host-thinking capture is still discarded after ${change} changes its destination`, async () => {
	const f = await fixture({ thinking: true }); f.draft.thinking = "keep this draft";
	await act(async () => { f.dictation.toggle(); }); const socket = f.socket;
	await act(async () => { socket.open(); socket.final("obsolete first"); });
	assert.equal(f.dictation.phase, "recording");
	if (change === "question key") f.state.snapshot = { ...f.state.snapshot, occurrence: { ...f.state.snapshot.occurrence, messageId: "new question" } };
	else f.state.reveal = true;
	await f.render();
	assert.equal(f.dictation.phase, "idle"); assert.equal(f.dictation.active, false);
	await act(async () => { socket.final("obsolete tail"); socket.end(); });
	assert.equal(f.draft.thinking, "keep this draft");
	assert.deepEqual(f.state.fallback, []); assert.equal(f.state.sent.length, 0);
});

test("unrevealed check finishes reading speech before reveal, then shows disabled mic without opt-in", async () => {
	const f = await fixture({ check: true }); assert.equal(f.state.mic, true); assert.equal(f.state.mounts, 0, "no plugin slot runs before check reveal");
	await act(async () => { f.dictation.toggle(); }); await act(async () => { f.socket.open(); f.socket.final("reading"); });
	await act(async () => { (document.querySelector('[data-testid="teach-check-reveal"]') as HTMLElement).click(); });
	assert.equal(f.state.reveal, true); assert.equal(f.dictation.phase, "stopping");
	await act(async () => { f.socket.final("tail"); f.socket.end(); });
	assert.equal(f.draft.readingThinking, "reading tail"); assert.equal(f.state.reveal, false);
	await f.render(); assert.equal(f.state.mic, false); assert.ok(document.querySelector('[data-testid="reading-thinking-field"]'));
	const mic = Array.from(document.querySelectorAll("button")).find(button => button.textContent?.includes("Dictate")); assert.ok(mic); assert.equal(mic.hasAttribute("disabled"), true);
	await f.commandSubmit(); const input = f.state.sent[0]!; if (input.type === "plugin-question-answer") { assert.equal(input.readingThinking, "reading tail"); assert.equal("thinking" in input, false); }
	assert.deepEqual(f.state.fallback, []);
});


for (const check of [false, true]) test(`healthy ${check ? "teach" : "probe"} thinking uses the native framed field without Dismiss`, async () => {
	const f = await fixture({ thinking: true, check });
	if (check) { f.state.reveal = false; f.state.expanded = true; await f.render(); }
	const frame = document.querySelector<HTMLElement>('[data-testid="thinking-field"]')!;
	assert.ok(frame);
	for (const token of ["rounded-[10px]", "border", "border-border/70", "bg-background/60", "focus-within:border-primary/50"]) assert.ok(frame.classList.contains(token), token);
	assert.equal(frame.parentElement?.tagName, "FORM");
	for (const token of ["border-t", "border-border/60", "p-1.5"]) assert.ok(frame.parentElement?.classList.contains(token), token);
	const label = frame.firstElementChild!;
	assert.equal(label.textContent?.toLowerCase(), "your thinking");
	for (const token of ["px-2.5", "pt-2", "text-xs", "font-medium", "uppercase"]) assert.ok(label.classList.contains(token), token);
	const input = frame.querySelector<HTMLElement>("[data-file-path-input]")!;
	assert.ok(input);
	assert.equal(input.getAttribute("data-placeholder"), "Your thinking");
	for (const token of ["field-sizing-content", "lh-input", "max-h-48", "w-full", "resize-none", "bg-transparent", "px-2.5", "py-2", "outline-none", "placeholder:text-muted-foreground/70", "min-h-10"]) assert.ok(input.classList.contains(token), token);
	const submit = frame.querySelector<HTMLButtonElement>('button[type="submit"]')!;
	assert.ok(submit); assert.equal(submit.disabled, false);
	assert.equal(submit.textContent, "Submit answer");
	assert.equal(input.classList.contains("min-h-[4.5rem]"), false, "even teaching starts with the approved compact field");
	const hint = submit.parentElement?.querySelector('span[aria-hidden="true"]')!;
	assert.ok(hint); assert.equal(hint.textContent, "↵ submits · ⇧↵ newline");
	for (const token of ["pl-1.5", "text-xs", "text-muted-foreground"]) assert.ok(hint.classList.contains(token), token);
	assert.ok(submit.parentElement?.classList.contains("p-1"));
	for (const token of ["ml-auto", "h-9", "rounded-[6px]", "px-3.5", "text-sm", "font-medium"]) assert.ok(submit.classList.contains(token), token);
	assert.equal(document.getElementById("plugin-editor")?.closest("form"), null, "arbitrary plugin DOM stays outside the host form");
	assert.equal(Array.from(document.querySelectorAll("button")).some(button => button.textContent === "Dismiss question"), false);
	assert.equal(f.state.dismissed, 0);
});

test("framed PathInput preserves the thinking ref, typed draft and native editing keys", async () => {
	const f = await fixture({ thinking: true });
	const input = document.querySelector<HTMLElement>('[data-testid="thinking-field"] [data-file-path-input]')!;
	// linkedom does not implement the browser's isContentEditable getter.
	Object.defineProperty(input, "isContentEditable", { configurable: true, value: true });
	await act(async () => {
		document.getElementById("plugin-editor")!.focus();
		capturePluginQuestionKey({ key: "Tab", target: document.getElementById("plugin-editor"), preventDefault() {} } as unknown as KeyboardEvent);
	});
	assert.equal(document.activeElement, input, "host Tab still reaches the thinking ref through its frame");
	await act(async () => { input.textContent = "  typed thinking\nwith spaces  "; input.dispatchEvent(new window.Event("input", { bubbles: true })); });
	assert.equal(f.draft.thinking, "  typed thinking\nwith spaces  ");
	for (const extra of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true, isComposing: true }, { ctrlKey: true, keyCode: 229 }]) {
		await act(async () => { input.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Enter", ...extra })); });
		assert.equal(f.state.sent.length, 0);
	}
	for (const extra of [{}, { ctrlKey: true }, { metaKey: true }]) {
		f.state.sent.length = 0;
		await act(async () => { input.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Enter", ...extra })); });
		assert.equal(f.state.sent.length, 1, "plain Enter and both universal submit chords work in host thinking");
	}
	const sent = f.state.sent[0]!; assert.equal(sent.type, "plugin-question-answer");
	if (sent.type === "plugin-question-answer") assert.equal(sent.thinking, "  typed thinking\nwith spaces  ");
});

for (const failure of ["backend", "missing", "editor", "presentation"] as const) test(`${failure} fallback retains Dismiss and recovers to a healthy form`, async () => {
	const f = await fixture({ thinking: true, available: failure !== "backend", missing: failure === "missing", editorFails: failure === "editor",
		...(failure === "presentation" ? { question: async () => { throw new Error("PRIVATE_PRESENTATION_FAILURE"); } } : {}),
	});
	assert.match(document.body.textContent ?? "", /Question unavailable/);
	assert.doesNotMatch(document.body.textContent ?? "", /PRIVATE_/);
	assert.ok(document.querySelector('button[type="submit"]')?.hasAttribute("disabled"));
	const dismiss = Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Dismiss question")!;
	assert.ok(dismiss); assert.equal(dismiss.disabled, false);
	await act(async () => { dismiss.click(); });
	assert.equal(f.state.dismissed, 1); assert.equal(f.state.sent.length, 0);
	f.state.available = true;
	f.replaceRegistration({ pluginId: "fixture", renderer: { id: "code", supportedContractVersions: [1], mountQuestion(container) { container.textContent = "Recovered question"; }, mountAnswerEditor(container, props) {
		const editor = container.ownerDocument.createElement("textarea"); editor.id = "plugin-editor"; container.append(editor);
		props.onChange({ status: "ready", value: "recovered answer" });
		return { update() {}, focus() { editor.focus(); }, dispose() {} };
	} } });
	await f.render();
	assert.equal(document.querySelector('[role="status"]'), null);
	assert.match(document.body.textContent ?? "", /Recovered question/);
	assert.equal(Array.from(document.querySelectorAll("button")).some(button => button.textContent === "Dismiss question"), false);
	assert.equal(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled, false);
	await f.commandSubmit(); assert.equal(f.state.sent.length, 1);
});

test("late custom-presentation cleanup cannot erase a replacement slot", async () => {
	const oldCleanup = deferred<() => void>();
	let oldContainer!: HTMLElement;
	const f = await fixture({ question: async container => { oldContainer = container; container.textContent = "old presentation"; return oldCleanup.promise; } });
	assert.match(document.body.textContent ?? "", /old presentation/);
	const previous = f.registration!;
	f.replaceRegistration({ ...previous, renderer: { ...previous.renderer, mountQuestion(container) { container.textContent = "new presentation"; } } });
	await f.render(); assert.match(document.body.textContent ?? "", /new presentation/);
	await act(async () => { oldCleanup.resolve(() => { oldContainer.replaceChildren(); }); });
	assert.match(document.body.textContent ?? "", /new presentation/);
});

test("renderer replacement cancels an old capture rather than delivering it to the new editor", async () => {
	const f = await fixture({ append: true });
	await act(async () => { f.dictation.toggle(); }); await act(async () => { f.socket.open(); f.socket.final("old editor speech"); });
	const replacementSpeech: string[] = [];
	f.replaceRegistration({ ...f.registration!, renderer: { ...f.registration!.renderer, mountAnswerEditor(_container, props) { props.onChange({ status: "ready", value: "new" }); return { update() {}, focus() {}, dispose() {}, appendTranscript(text) { replacementSpeech.push(text); } }; } } });
	await f.render();
	assert.equal(f.dictation.active, false); assert.deepEqual(replacementSpeech, []); assert.deepEqual(f.state.speech, []); assert.deepEqual(f.state.fallback, []);
});
