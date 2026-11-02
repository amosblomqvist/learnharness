import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { NarrationSessionProvider, stopSpeechPreview } from "../components/narration.tsx";
import { QuestionDock } from "../components/question-dock.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent });
const originalFetch = globalThis.fetch;
const originalAudio = globalThis.Audio;
const originalBroadcastChannel = globalThis.BroadcastChannel;
const roots: { root: Root; host: HTMLElement }[] = [];

/** Plays for a short time, then reports ended, so the playback loop can advance. */
class FakeAudio {
	onended: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(public src: string) {}
	play() { setTimeout(() => this.onended?.(), 2); return Promise.resolve(); }
	pause() {}
	removeAttribute() {}
}

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) { await act(async () => root.unmount()); host.remove(); }
	stopSpeechPreview();
	globalThis.fetch = originalFetch;
	globalThis.Audio = originalAudio;
	globalThis.BroadcastChannel = originalBroadcastChannel;
});

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

test("the first sentence of a question is spoken when automatic reading turns on after the question appears", async () => {
	const synthesized: string[] = [];
	globalThis.Audio = FakeAudio as unknown as typeof Audio;
	globalThis.BroadcastChannel = undefined as unknown as typeof BroadcastChannel;
	// Preferences arrive late: the question registers while automatic reading is still off.
	let releaseSettings!: () => void;
	const settingsGate = new Promise<void>(resolve => { releaseSettings = resolve; });
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === "/api/settings") { await settingsGate; return Response.json({ settings: { speech: { voice: "en_US-ljspeech-high", automaticReading: true } } }); }
		if (url === "/api/speech/status") return Response.json({ engines: [{ id: "piper", available: true }], voices: [{ id: "en_US-ljspeech-high", engine: "piper", name: "LJ", quality: "high", license: "x", downloadBytes: 1, state: "ready" }], operation: null });
		if (url === "/api/speech/synthesize") { synthesized.push(JSON.parse(String(init?.body)).text); return new Response(new Blob(["audio"], { type: "audio/wav" })); }
		return Response.json({});
	}) as typeof fetch;

	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push({ root, host });
	const input = {
		question: "A user's events created, deposited, withdrawn are written to different partitions. What can it count on?",
		options: [{ label: "Nothing: it may see withdrawn before created" }, { label: "It always sees them in write order" }],
	};
	await act(async () => root.render(
		<NarrationSessionProvider sessionId="s1" messages={[]} running={false}>
			<QuestionDock toolName="ask_user_question" toolCallId="call1" input={input as never} expanded reveal={false} revealed onExpand={() => {}} onSubmit={() => {}} />
		</NarrationSessionProvider>,
	));
	await act(async () => { releaseSettings(); await tick(120); });
	assert.ok(synthesized.length > 0, "nothing was synthesized");
	assert.match(synthesized[0]!, /^A user's events created, deposited, withdrawn are written to different partitions\.$/, `first sentence skipped; synthesized=${JSON.stringify(synthesized)}`);
});

test("the first sentence of a question is spoken when the question is revealed after it mounted", async () => {
	const synthesized: string[] = [];
	globalThis.Audio = FakeAudio as unknown as typeof Audio;
	globalThis.BroadcastChannel = undefined as unknown as typeof BroadcastChannel;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === "/api/settings") return Response.json({ settings: { speech: { voice: "en_US-ljspeech-high", automaticReading: true } } });
		if (url === "/api/speech/status") return Response.json({ engines: [{ id: "piper", available: true }], voices: [{ id: "en_US-ljspeech-high", engine: "piper", name: "LJ", quality: "high", license: "x", downloadBytes: 1, state: "ready" }], operation: null });
		if (url === "/api/speech/synthesize") { synthesized.push(JSON.parse(String(init?.body)).text); return new Response(new Blob(["audio"], { type: "audio/wav" })); }
		return Response.json({});
	}) as typeof fetch;
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push({ root, host });
	const input = {
		question: "A user's events created, deposited, withdrawn are written to different partitions. What can it count on?",
		options: [{ label: "Nothing: it may see withdrawn before created" }, { label: "It always sees them in write order" }],
	};
	const page = (revealed: boolean) => (
		<NarrationSessionProvider sessionId="s2" messages={[]} running={false}>
			<QuestionDock toolName="ask_user_question" toolCallId="call2" input={input as never} expanded reveal={!revealed} revealed={revealed} onExpand={() => {}} onSubmit={() => {}} />
		</NarrationSessionProvider>
	);
	await act(async () => root.render(page(false)));
	await act(async () => { await tick(80); });
	await act(async () => root.render(page(true)));
	await act(async () => { await tick(120); });
	assert.ok(synthesized.length > 0, "nothing was synthesized");
	assert.match(synthesized[0]!, /^A user's events created, deposited, withdrawn are written to different partitions\.$/, `first sentence skipped; synthesized=${JSON.stringify(synthesized)}`);
});
