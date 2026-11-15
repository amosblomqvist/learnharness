import React, { act, useRef, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import { ChatSessionComposer } from "../components/composer.tsx";
import { ReadingThinkingField } from "../components/reading-thinking.tsx";
import { readPathInput } from "../components/path-input-dom.ts";
import { appendToPrimaryInput, joinDictation } from "../components/dictation.tsx";

const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
let active: Element = document.body;
Object.defineProperty(document, "activeElement", { get: () => active });
const selection = {
	anchorNode: null as Node | null,
	anchorOffset: 0,
	focusNode: null as Node | null,
	focusOffset: 0,
	setBaseAndExtent(anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number) {
		Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset });
	},
};
Object.assign(document, { getSelection: () => selection, oninput: null });
window.HTMLElement.prototype.focus = function () { active = this; };
Object.assign(globalThis, {
	window,
	document,
	Element: window.Element,
	HTMLElement: window.HTMLElement,
	Event: window.Event,
	CustomEvent: window.CustomEvent,
});

const roots: { root: Root; host: HTMLElement }[] = [];

async function mount(element: React.ReactElement) {
	const host = document.createElement("div") as unknown as HTMLElement;
	document.body.append(host);
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => { root.render(element); });
	return host;
}

async function typeText(editor: HTMLElement, value: string) {
	await act(async () => {
		editor.replaceChildren(document.createTextNode(value));
		editor.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => { root.unmount(); });
		host.remove();
	}
});

function editorIn(host: HTMLElement): HTMLElement {
	const editor = host.querySelector<HTMLElement>("[data-file-path-input]");
	assert.ok(editor);
	return editor;
}

describe("session text fields keep keystrokes local", () => {
	it("updates composer and send affordance without rerendering the chat owner per change", async () => {
		let parentRenders = 0;
		let latest = "";
		let reset!: (value: string) => void;
		function Parent() {
			parentRenders++;
			const [external, setExternal] = useState({ value: "", revision: 0 });
			reset = (value) => setExternal((previous) => ({ value, revision: previous.revision + 1 }));
			return (
				<ChatSessionComposer
					busy={false}
					value={external.value}
					revision={external.revision}
					onChange={(value) => { latest = value; }}
					onSend={() => {}}
					onStop={() => {}}
					sendAllowed
					dictationActive={false}
				/>
			);
		}

		const host = await mount(<Parent />);
		const editor = host.querySelector<HTMLElement>("[data-file-path-input]");
		assert.ok(editor);
		await typeText(editor, "dictated phrase");
		assert.equal(readPathInput(editor), "dictated phrase");
		assert.equal(latest, "dictated phrase");
		assert.equal(parentRenders, 1, "typing only renders the local composer subtree");
		assert.equal(host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled, false);

		await act(async () => { reset("restored draft"); });
		assert.equal(readPathInput(editor), "restored draft", "explicit external resets still reach PathInput");
		assert.equal(parentRenders, 2);
	});

	it("updates reading thoughts locally while forwarding drafts for submit", async () => {
		let parentRenders = 0;
		let latest = "";
		let reset!: (value: string) => void;
		function Parent() {
			parentRenders++;
			const [external, setExternal] = useState({ value: "", revision: 0 });
			reset = (value) => setExternal((previous) => ({ value, revision: previous.revision + 1 }));
			return (
				<ReadingThinkingField
					value={external.value}
					revision={external.revision}
					onChange={(value) => { latest = value; }}
					claim={false}
				/>
			);
		}

		const host = await mount(<Parent />);
		const editor = host.querySelector<HTMLElement>("[data-file-path-input]");
		assert.ok(editor);
		await typeText(editor, "thinking while reading");
		assert.equal(readPathInput(editor), "thinking while reading");
		assert.equal(latest, "thinking while reading");
		assert.equal(parentRenders, 1, "typing doesn't rerender the chat owner");

		await act(async () => { reset("restored thought"); });
		assert.equal(readPathInput(editor), "restored thought", "explicit per-question resets still reach PathInput");
		assert.equal(parentRenders, 2);
	});

	it("composer retains local edits across owner renders and reads the latest text for send/append", async () => {
		let parentRenders = 0;
		let refresh!: () => void;
		let replace!: (value: string) => void;
		let append!: (value: string) => void;
		let remount!: (visible: boolean) => void;
		const sent: string[] = [];
		function Parent() {
			parentRenders++;
			const draft = useRef("");
			const [revision, setRevision] = useState(0);
			const [, setTick] = useState(0);
			const [visible, setVisible] = useState(true);
			refresh = () => setTick(tick => tick + 1);
			remount = setVisible;
			replace = value => {
				draft.current = value;
				setRevision(previous => previous + 1);
			};
			append = value => replace(joinDictation(draft.current, value));
			return visible ? <ChatSessionComposer
				busy={false} value={draft.current} revision={revision}
				onChange={value => { draft.current = value; }}
				onSend={() => { sent.push(draft.current); replace(""); }}
				onStop={() => {}} sendAllowed dictationActive={false}
			/> : null;
		}
		const host = await mount(<Parent />);
		let editor = editorIn(host);
		await typeText(editor, "typed");
		assert.equal(parentRenders, 1);
		await act(async () => { refresh(); });
		assert.equal(readPathInput(editor), "typed", "an unrelated owner render must not restore an old seed");
		await act(async () => { append("dictated"); });
		assert.equal(readPathInput(editor), "typed dictated");
		await act(async () => { host.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
		assert.deepEqual(sent, ["typed dictated"]);
		assert.equal(readPathInput(editor), "");
		assert.equal(host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled, true);

		// The seed is already empty; a new explicit reset must still clear local edits.
		await typeText(editor, "unsent");
		await act(async () => { replace(""); });
		assert.equal(readPathInput(editor), "");
		await act(async () => { replace("refused send restored"); });
		await typeText(editor, "new edit");
		await act(async () => { replace("refused send restored"); });
		assert.equal(readPathInput(editor), "refused send restored");
		await act(async () => { remount(false); });
		await act(async () => { remount(true); });
		editor = editorIn(host);
		assert.equal(readPathInput(editor), "refused send restored", "a remounted composer takes the current owner ref");
	});

	it("composer keeps dictation, busy steering/stop, compaction gating, and Next affordances", async () => {
		let update!: (patch: Partial<typeof flags>) => void;
		let flags = { busy: false, sendAllowed: true, dictationActive: false, nextProblem: true };
		let sends = 0;
		let stops = 0;
		let nexts = 0;
		function Parent() {
			const [state, setState] = useState(flags);
			update = patch => { flags = { ...flags, ...patch }; setState(flags); };
			return <ChatSessionComposer {...state} value="" revision={0} onChange={() => {}}
				onSend={() => { sends++; }} onStop={() => { stops++; }} onNext={() => { nexts++; }} />;
		}
		const host = await mount(<Parent />);
		const submit = async () => { await act(async () => { host.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); }); };
		assert.ok(host.querySelector('[aria-label="Next problem"]'));
		await submit();
		assert.equal(nexts, 1);
		await act(async () => { update({ dictationActive: true }); });
		assert.equal(host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.disabled, false);
		await submit();
		assert.equal(sends, 1, "empty input still allows finish-first dictation send");
		await act(async () => { update({ busy: true, dictationActive: false, nextProblem: false }); });
		assert.ok(host.querySelector('[aria-label="Stop"]'));
		await submit();
		assert.equal(stops, 1);
		await typeText(editorIn(host), "steer now");
		assert.ok(host.querySelector('[aria-label="Send"]'));
		await submit();
		assert.equal(sends, 2);
		await act(async () => { update({ busy: false, sendAllowed: false }); });
		assert.equal(host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.disabled, true);
		await submit();
		assert.equal(sends, 2, "a closed send gate must win over local text");
	});

	it("reading thoughts survive unrelated renders and explicit same-value restoration", async () => {
		let refresh!: () => void;
		let replace!: (value: string) => void;
		let latest = "";
		function Parent() {
			const [seed, setSeed] = useState({ value: "", revision: 0 });
			const [, setTick] = useState(0);
			refresh = () => setTick(tick => tick + 1);
			replace = value => { latest = value; setSeed(previous => ({ value, revision: previous.revision + 1 })); };
			return <ReadingThinkingField {...seed} onChange={value => { latest = value; }} claim={false} />;
		}
		const host = await mount(<Parent />);
		const editor = editorIn(host);
		await typeText(editor, "reading draft");
		await act(async () => { refresh(); });
		assert.equal(readPathInput(editor), "reading draft");
		assert.equal(latest, "reading draft");
		await act(async () => { replace(""); });
		assert.equal(readPathInput(editor), "");
		await act(async () => { replace("saved question thoughts"); });
		await typeText(editor, "edited after restoration");
		await act(async () => { replace("saved question thoughts"); });
		assert.equal(readPathInput(editor), "saved question thoughts");
		assert.equal(latest, "saved question thoughts");
	});

	it("reading append uses the latest typed draft synchronously, including consecutive file/dictation insertions", async () => {
		let latest = "";
		let forwardedEdits = 0;
		const host = await mount(<ReadingThinkingField value="" revision={0} claim
			onChange={value => { latest = value; forwardedEdits++; }} />);
		const editor = editorIn(host);
		await typeText(editor, "typed thoughts");
		await act(async () => {
			assert.equal(appendToPrimaryInput("spoken tail"), true);
			assert.equal(latest, "typed thoughts spoken tail", "submit after finish sees the tail before React commits");
			assert.equal(appendToPrimaryInput("`/synthetic/notes.pdf`"), true);
			assert.equal(latest, "typed thoughts spoken tail `/synthetic/notes.pdf`");
		});
		assert.equal(readPathInput(editor), "typed thoughts spoken tail `/synthetic/notes.pdf`");
		assert.equal(forwardedEdits, 3, "each edit forwards its synchronous snapshot exactly once");
	});
});
