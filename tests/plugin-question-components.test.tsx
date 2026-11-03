import React, { act, useRef, useState } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { PluginQuestionDockContent } from "../components/plugin-question-dock.tsx";
import { ReadingThinkingField } from "../components/reading-thinking.tsx";
import { DictationBar, useDictation, type Dictation } from "../components/dictation.tsx";
import { capturePluginQuestionKey } from "../components/plugin-question-keys.ts";
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

async function fixture(options: { thinking?: boolean; check?: boolean; missing?: boolean; append?: boolean; asyncMount?: boolean; ready?: boolean; question?: PluginQuestionRenderer["mountQuestion"] } = {}) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	let active: Element = dom.document.body;
	Object.defineProperty(dom.document, "activeElement", { get: () => active });
	dom.window.HTMLElement.prototype.focus = function () { active = this; };
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({ React, window: dom.window, document: dom.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} },
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } }, WebSocket: Socket, AudioContext: AudioGraph, AudioWorkletNode: Worklet,
		fetch: async (url: string) => { if (url === "/api/stt/token") return Response.json({ token: "fake" }); assert.equal(url, "/api/settings"); return Response.json({ settings: { version: 1, dictation: { language: "en" } } }); },
	})) { previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
	restore = () => { for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; };
	Socket.all = [];
	const draft: PluginQuestionDraft = { answer: { status: "empty" }, thinking: "", readingThinking: "" };
	const state = { snapshot: { ...saved, showThinking: options.thinking ?? false, ...(options.check ? { variant: "teach" as const, input: { ...saved.input, type: "check" as const, nodeId: "node" } } : {}) }, expanded: !options.check, reveal: !!options.check, ready: options.ready ?? true, available: true, mic: false, sent: [] as ChatInput[], dismissed: 0, mounts: 0, disposed: 0, updates: [] as boolean[], speech: [] as string[], fallback: [] as string[] };
	const mount = deferred<PluginQuestionEditorHandle>(); const delivery = deferred<void>();
	let editorProps!: PluginQuestionEditorProps;
	let registration: QuestionRendererRegistration | undefined = options.missing ? undefined : { pluginId: "fixture", renderer: { id: "code", supportedContractVersions: [1], ...(options.question ? { mountQuestion: options.question } : {}), mountAnswerEditor(container, props) {
		state.mounts++; editorProps = props;
		const textarea = container.ownerDocument.createElement("textarea"); textarea.id = "plugin-editor"; container.append(textarea);
		props.onChange({ status: "ready", value: "  code\n" });
		const handle: PluginQuestionEditorHandle = { update(value) { state.updates.push(value.active); }, focus() { textarea.focus(); }, dispose() { state.disposed++; },
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
			<PluginQuestionDockContent snapshot={state.snapshot} chatId="chat" draft={draft} expanded={state.expanded} reveal={state.reveal} ready={state.ready} available={state.available} registration={registration} readingRef={reading} onMicAvailable={setMic}
				onExpand={() => { state.reveal = false; state.expanded = true; }} send={async input => { state.sent.push(input); return true; }} dismiss={async () => { state.dismissed++; }} />
			<DictationBar dictation={dictation} disabled={!mic} />
		</>;
	}
	const { createRoot } = await import("react-dom/client"); const root = createRoot(document.getElementById("root")!);
	const render = async () => { await act(async () => { root.render(<Harness />); }); };
	cleanup = async () => { await act(async () => { root.unmount(); }); };
	await render();
	const commandSubmit = async () => { await act(async () => { capturePluginQuestionKey({ key: "Enter", ctrlKey: true, target: document.getElementById("plugin-editor"), preventDefault() {} } as unknown as KeyboardEvent); }); };
	return { state, draft, render, delivery, mount, get registration() { return registration; }, replaceRegistration(next: QuestionRendererRegistration) { registration = next; }, commandSubmit, get editorProps() { return editorProps; }, get dictation() { return dictation; }, get socket() { return Socket.all.at(-1)!; } };
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
	f.state.ready = true; await f.render(); assert.equal(f.state.mounts, 1);
	f.state.ready = false; await f.render(); assert.equal(f.state.mounts, 1); assert.equal(f.state.updates.at(-1), false);
	await f.commandSubmit(); assert.equal(f.state.sent.length, 0);
	f.state.ready = true; await f.render(); assert.equal(f.state.mounts, 1); assert.equal(f.state.updates.at(-1), true);
});

test("folding/canonical replacement preserve editor generation, active updates and ready-state drafts", async () => {
	const f = await fixture(); assert.equal(f.state.mounts, 1); assert.equal(f.state.mic, false);
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
	const root = document.querySelector('[data-testid="plugin-question-dock"]') as HTMLElement; root.hidden = true;
	await f.commandSubmit(); assert.equal(f.state.sent.length, 0);
	root.hidden = false; await f.commandSubmit(); assert.equal(f.state.sent.length, 1);
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

test("thinking-on speech stays host-owned, empty thinking remains an applicable answer channel", async () => {
	const f = await fixture({ append: true, thinking: true });
	await f.commandSubmit(); let input = f.state.sent[0]!; if (input.type === "plugin-question-answer") assert.equal(input.thinking, "");
	f.state.sent.length = 0;
	await act(async () => { f.dictation.toggle(); }); await act(async () => { f.socket.open(); f.socket.final("thinking"); });
	await f.commandSubmit(); await act(async () => { f.socket.final("tail"); f.socket.end(); });
	input = f.state.sent[0]!; assert.equal(input.type, "plugin-question-answer"); if (input.type === "plugin-question-answer") { assert.equal(input.answer, "  code\n"); assert.equal(input.thinking, "thinking tail"); }
	assert.deepEqual(f.state.speech, []); assert.deepEqual(f.state.fallback, []);
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
