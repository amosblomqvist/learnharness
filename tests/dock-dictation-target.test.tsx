import React, { act, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import test from "node:test";
import { StickToBottom, type StickToBottomInstance } from "use-stick-to-bottom";
import { DockOverlay } from "../components/chat.tsx";
import { appendToPrimaryInput, useDictation, type Dictation } from "../components/dictation.tsx";
import { mountPluginChrome } from "./helpers/plugin-chrome.tsx";

test("the production teaching dock returns dictation to reading after scrolling away from an opened check", async (t) => {
	let now = 10_000;
	t.mock.method(Date, "now", () => now);
	const scrollRef = Object.assign((element: HTMLElement | null) => { scrollRef.current = element; }, { current: null as HTMLElement | null });
	const contentRef = Object.assign((element: HTMLElement | null) => { contentRef.current = element; }, { current: null as HTMLElement | null });
	const instance: StickToBottomInstance = {
		scrollRef, contentRef, scrollToBottom: () => true, stopScroll() {},
		isAtBottom: false, isNearBottom: false, escapedFromLock: true,
		state: {} as StickToBottomInstance["state"],
	};
	const unexpected = () => { throw new Error("This routing fixture must not submit an answer"); };
	let dictation!: Dictation;
	let replaceQuestion!: () => void;
	class Socket extends EventTarget {
		static CONNECTING = 0;
		static OPEN = 1;
		static latest: Socket;
		readyState = Socket.CONNECTING;
		constructor() { super(); Socket.latest = this; }
		send() {}
		close() { this.readyState = 3; }
		open() { this.readyState = Socket.OPEN; this.dispatchEvent(new Event("open")); }
		final(text: string) { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: text }] } }) })); }
		end() { this.close(); this.dispatchEvent(Object.assign(new Event("close"), { code: 1000 })); }
	}
	function Session() {
		const [reading, setReading] = useState("");
		const [questionId, setQuestionId] = useState("question");
		dictation = useDictation({ append: unexpected });
		replaceQuestion = () => { setQuestionId("next-question"); setReading(""); };
		return <StickToBottom instance={instance}>
			<StickToBottom.Content><p>Synthetic teaching text.</p></StickToBottom.Content>
			<DockOverlay pending={{ key: questionId, messageId: "message", contentIndex: 0, toolCallId: questionId, tool: "explain", input: { type: "check", question: "Explain the result", correctAnswer: "A synthetic result" } }}
				onPrepareBuiltin={unexpected} onBuiltinPendingInput={() => false} onPrepareThinking={unexpected} pendingThinkingInput={false}
				onPreparePluginQuestion={unexpected} preparing={false} preparationStatus={null}
				pluginAvailable={false} pluginReady={false} onPluginMicAvailable={() => {}} onPluginSend={unexpected} onPluginDismiss={unexpected}
				unreadablePlugin={false} reconciliation="ready" onRetrySync={() => {}} onSaveQuestionDraft={() => {}}
				practice={null} compactionRunning={false} onSubmitThinking={unexpected} requiresReveal
				readingThinking={reading} readingThinkingRevision={0} onReadingThinking={setReading}
				phase="teach" turns={[]} contextTokens={null} cliContextWindow={null} composer={null} onSubmitAnswer={unexpected}
				chatId="fixture" onModelChange={() => {}} onReserve={() => {}} onOpenPlan={() => {}} queuedSteers={[]} />
		</StickToBottom>;
	}
	const previousObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
	const audioGlobals = {
		WebSocket: Socket,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
		AudioContext: class { state = "running"; destination = {}; audioWorklet = { addModule: async () => {} }; createMediaStreamSource() { return { connect() {}, disconnect() {} }; } },
		AudioWorkletNode: class { port = {}; connect() {} disconnect() {} },
	};
	const previousAudio = Object.keys(audioGlobals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	for (const [key, value] of Object.entries(audioGlobals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
	let fixture: Awaited<ReturnType<typeof mountPluginChrome>> | undefined;
	try {
		fixture = await mountPluginChrome({ activate() {} }, <Session />, {
			strictMode: true,
			prepareDom(dom) {
				const prototype = dom.window.HTMLElement.prototype;
				const saved = ["getAnimations", "animate", "scrollHeight", "clientHeight", "offsetWidth"].map(key => [key, Object.getOwnPropertyDescriptor(prototype, key)] as const);
				Object.defineProperties(prototype, {
					getAnimations: { configurable: true, value: () => [] },
					animate: { configurable: true, value: () => ({ cancel() {}, finished: Promise.resolve(), playState: "finished" }) },
					scrollHeight: { configurable: true, get() { return 1_400; } },
					clientHeight: { configurable: true, get() { return 600; } },
					offsetWidth: { configurable: true, get() { return 900; } },
				});
				return () => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(prototype, key, descriptor); else Reflect.deleteProperty(prototype, key); } };
			},
			fetch: async input => {
				if (String(input) === "/api/models") return Response.json({ providers: [], models: [], slots: {} });
				if (String(input) === "/api/settings") return Response.json({ settings: { version: 1, dictation: { language: "en" } } });
				if (String(input) === "/api/stt/token") return Response.json({ token: "synthetic-token" });
				assert.fail(`Unexpected request: ${String(input)}`);
			},
		});
		const document = fixture.document;
		const reading = () => document.querySelector<HTMLElement>('[data-testid="reading-thinking-field"] [data-file-path-input]')!.textContent;
		const answer = () => document.querySelector<HTMLElement>('[data-testid="answer-field"] [data-file-path-input]')!.textContent;
		const dictate = async (text: string) => { await act(async () => { assert.equal(appendToPrimaryInput(text), true); }); };
		const open = async () => {
			const bar = document.querySelector<HTMLButtonElement>('[data-testid="teach-check-reveal"], [data-testid="question-dock-bar"]');
			assert.ok(bar, "the actual dock is folded");
			await fixture!.click(bar);
		};
		await dictate("reading before");
		assert.equal(reading(), "reading before");
		await open();
		await dictate("answer open");
		assert.equal(answer(), "answer open");
		await act(async () => { dictation.toggle(); });
		await act(async () => { Socket.latest.open(); Socket.latest.final("captured answer"); });
		// Bypass the real dock's brief resize/reveal mute without a timed sleep.
		now += 500;
		await act(async () => {
			scrollRef.current!.scrollTop = 100;
			scrollRef.current!.dispatchEvent(new window.Event("scroll"));
		});
		assert.equal(dictation.active, true, "folding preserves the recording's starting destination");
		await act(async () => { dictation.stop(); Socket.latest.end(); });
		assert.equal(answer(), "answer open captured answer");
		await dictate("reading folded");
		assert.equal(reading(), "reading before reading folded");
		assert.equal(answer(), "answer open captured answer", "the hidden answer does not receive the new words");
		await open();
		await dictate("answer reopened");
		assert.equal(answer(), "answer open captured answer answer reopened");
		now += 500;
		await act(async () => { scrollRef.current!.dispatchEvent(new window.Event("scroll")); });
		await act(async () => { dictation.toggle(); });
		await act(async () => { Socket.latest.open(); Socket.latest.final("obsolete reading"); });
		await act(async () => { replaceQuestion(); });
		assert.equal(dictation.active, false, "a new question retires the old reading capture");
		await act(async () => { Socket.latest.final("late words"); Socket.latest.end(); });
		assert.equal(reading(), "", "the next question's draft receives no old speech");
	} finally {
		await fixture?.close();
		if (previousObserver) Object.defineProperty(globalThis, "ResizeObserver", previousObserver); else Reflect.deleteProperty(globalThis, "ResizeObserver");
		for (const [key, descriptor] of previousAudio) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
});
