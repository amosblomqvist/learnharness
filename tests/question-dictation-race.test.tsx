import React, { act } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { useDictation, type Dictation } from "../components/dictation.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import type { QuestionAnswerData } from "../src/core/question-core.ts";

async function fixture(mode: "select" | "text" = "select") {
	const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	let current!: Dictation;
	let worklet!: Worklet;
	let resolveUpload!: (response: Response) => void;
	const answers: QuestionAnswerData[] = [];
	class Context {
		sampleRate = 16_000;
		state = "running";
		destination = {};
		audioWorklet = { addModule: async () => {} };
		createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
	}
	class Worklet {
		port = {
			onmessage: (_event: { data: unknown }) => {},
			postMessage: () => queueMicrotask(() => this.port.onmessage({ data: { type: "flushed" } })),
		};
		constructor() { worklet = this; }
		connect() {}
		disconnect() {}
	}
	for (const [key, value] of Object.entries({
		React, window, document, CustomEvent: window.CustomEvent, Element: window.Element,
		HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
		AudioContext: Context, AudioWorkletNode: Worklet,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
		fetch: async (url: string) => {
			if (url === "/api/settings") return Response.json({ settings: { version: 1, general: { dictationProvider: "openai" } } });
			if (url === "/api/keys") return Response.json({ keys: [{ id: "OPENAI_API_KEY", present: true }] });
			if (url === "/api/stt/openai") return new Promise<Response>((resolve) => { resolveUpload = resolve; });
			throw new Error(`Unexpected request ${url}`);
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	function Harness({ showQuestion = true }: { showQuestion?: boolean }) {
		current = useDictation({ append() {} });
		const input = mode === "select"
			? { question: "Pick", options: [{ label: "FIRST", value: "first" }, { label: "SECOND", value: "second" }] }
			: { question: "Explain your answer" };
		return showQuestion ? <QuestionDock toolName="ask_user_question" toolCallId="q1" input={input}
			expanded onExpand={() => {}} onSubmit={(answer) => answers.push(answer)} /> : null;
	}
	await act(async () => root.render(<Harness />));
	return {
		document, window, answers,
		get current() { return current; },
		async record() {
			await act(async () => current.toggle());
			assert.equal(current.phase, "recording");
			act(() => worklet.port.onmessage({ data: { type: "audio", buffer: new Int16Array([1]) } }));
		},
		async submit() {
			await act(async () => document.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
		},
		async resolve(text: string) {
			assert.equal(typeof resolveUpload, "function", "the upload is pending");
			await act(async () => resolveUpload(Response.json({ text })));
		},
		async removeQuestion() { await act(async () => root.render(<Harness showQuestion={false} />)); },
		async cleanup() {
			await act(async () => root.unmount());
			for (const [key, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else delete (globalThis as Record<string, unknown>)[key];
			}
		},
	};
}

test("an upload submits the latest visible choice once with the dictated reasoning", async () => {
	const f = await fixture();
	try {
		const radios = () => [...f.document.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
		await act(async () => radios()[0]!.click());
		await f.record();
		await f.submit();
		assert.equal(f.current.phase, "stopping");
		await act(async () => radios()[1]!.click());
		assert.match(f.document.querySelector('[role="radio"][aria-checked="true"]')!.textContent!, /SECOND/);
		await f.submit();
		await f.resolve("dictated reasoning");
		assert.equal(f.answers.length, 1, "repeated submit cannot queue duplicate answers");
		assert.equal(f.answers[0]!.answers[0]!.value, "second");
		assert.equal(f.answers[0]!.thinking, "dictated reasoning");
	} finally { await f.cleanup(); }
});

test("a removed question cannot submit when its pending upload completes", async () => {
	const f = await fixture();
	try {
		await act(async () => f.document.querySelector<HTMLButtonElement>('[role="radio"]')!.click());
		await f.record();
		await f.submit();
		await f.removeQuestion();
		await f.resolve("late reasoning");
		assert.deepEqual(f.answers, []);
	} finally { await f.cleanup(); }
});

test("a dictated text answer can replace text cleared during the upload", async () => {
	const f = await fixture("text");
	try {
		const editor = f.document.querySelector<HTMLElement>('[data-testid="answer-field"] [data-file-path-input]')!;
		assert.ok(editor);
		await act(async () => { editor.textContent = "initial"; editor.dispatchEvent(new f.window.Event("input", { bubbles: true })); });
		await f.record();
		await f.submit();
		await act(async () => { editor.textContent = ""; editor.dispatchEvent(new f.window.Event("input", { bubbles: true })); });
		await f.resolve("spoken answer");
		assert.equal(f.answers.length, 1);
		assert.equal(f.answers[0]!.text, "spoken answer");
	} finally { await f.cleanup(); }
});
