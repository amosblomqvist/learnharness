/**
 * The floating dock card — the pending question/practice card freed from the
 * bottom band. This file pins the CONTENT contract only (the grip, the
 * minimize control, drag/keyboard geometry); the chip, reserve height and
 * composer lanes live in chat.tsx and its own tests.
 *
 * Markup assertions use react-dom/server (no DOM). Behavior runs on the
 * repo's linkedom harness (tests/pending-question-form.test.tsx): linkedom
 * has no layout and no PointerEvent/setPointerCapture, so the bare-mount
 * gesture tests fall through to the {8, 8} clamp floor; the tests that pin
 * real seeding spoof the panel's rect. Only clamp bounds come from the
 * declared viewport. No timers, no network.
 *
 * tsx note: tsx uses the CLASSIC JSX transform, so `React` must be a
 * resolvable global (see tests/render-cards.test.tsx).
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { QuestionDock } from "../components/question-dock.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";

const quizInput = {
	// A prediction's eyebrow is the distinctive one ("Prediction", never
	// "Check"), so the kind-label assertion cannot pass by accident.
	type: "predict",
	question: "Which graph keeps the same slope?",
	options: [{ label: "Graph A" }, { label: "Graph B" }],
	correctAnswer: "Graph A",
	explanation: "Parallel lines share a slope.",
};

// ── the chrome, as markup (no DOM) ──────────────────────────────────────────

describe("floating docks carry the grip and a live minimize control", () => {
	it("QuestionDock: floating renders grip + kind label + labeled minimize", () => {
		const html = renderToStaticMarkup(
			<QuestionDock
				toolName="quiz"
				toolCallId="q-float"
				input={quizInput}
				expanded
				floating
				onMinimize={() => {}}
				onExpand={() => {}}
				onSubmit={() => {}}
				dictationClaim={false}
			/>,
		);
		assert.match(html, /data-testid="dock-float-grip"/);
		assert.match(html, /data-testid="dock-float-minimize"/);
		assert.match(html, /aria-label="[^"]*[Mm]inimize[^"]*"/);
		// The kind label is the dock's own eyebrow ("Prediction" for a predict
		// quiz), not the question text.
		assert.match(html, /Prediction/);
	});

	it("QuestionDock: without floating there is no grip and no minimize", () => {
		const html = renderToStaticMarkup(
			<QuestionDock
				toolName="quiz"
				toolCallId="q-band"
				input={quizInput}
				expanded
				onExpand={() => {}}
				onSubmit={() => {}}
				dictationClaim={false}
			/>,
		);
		assert.doesNotMatch(html, /dock-float/);
	});

	it("QuestionDock: floating without onMinimize shows no dead button", () => {
		const html = renderToStaticMarkup(
			<QuestionDock
				toolName="quiz"
				toolCallId="q-float-dead"
				input={quizInput}
				expanded
				floating
				onExpand={() => {}}
				onSubmit={() => {}}
				dictationClaim={false}
			/>,
		);
		assert.match(html, /data-testid="dock-float-grip"/);
		assert.doesNotMatch(html, /dock-float-minimize/);
	});

	it("PracticeDock: floating renders grip + labeled minimize", () => {
		const html = renderToStaticMarkup(
			<PracticeDock
				problemCallId="p-float"
				input={{ statement: "Show that every square is a rectangle." }}
				expanded
				floating
				onMinimize={() => {}}
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);
		assert.match(html, /data-testid="dock-float-grip"/);
		assert.match(html, /data-testid="dock-float-minimize"/);
		assert.match(html, /aria-label="[^"]*[Mm]inimize[^"]*"/);
	});

	it("PracticeDock: without floating the band chrome is unchanged", () => {
		const html = renderToStaticMarkup(
			<PracticeDock
				problemCallId="p-band"
				input={{ statement: "Show that every square is a rectangle." }}
				expanded
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);
		assert.doesNotMatch(html, /dock-float/);
	});
});

// ── behavior, mounted (the repo's linkedom harness) ─────────────────────────
// Same createRoot/act/parseHTML shape as tests/pending-question-form.test.tsx
// and tests/backdrop-dismiss.test.ts. Events are plain Events with assigned
// fields: linkedom has no PointerEvent or KeyboardEvent constructor.

describe("floating dock gestures", () => {
	const dom = parseHTML("<html><body></body></html>");
	const VIEWPORT = { width: 1024, height: 800 };
	// The grip clamps to an 8px edge plus a 96×48 sliver of itself.
	const BOUNDS = { min: 8, maxX: VIEWPORT.width - 96, maxY: VIEWPORT.height - 48 };
	const previous = new Map<string, PropertyDescriptor | undefined>();
	let root: Root | undefined;
	let host: HTMLDivElement | undefined;

	before(async () => {
		for (const [key, value] of Object.entries({
			window: dom.window,
			document: dom.document,
			HTMLElement: dom.window.HTMLElement,
			IS_REACT_ACT_ENVIRONMENT: true,
			innerWidth: VIEWPORT.width,
			innerHeight: VIEWPORT.height,
		})) {
			previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}
		Object.assign(dom.window, { innerWidth: VIEWPORT.width, innerHeight: VIEWPORT.height });
	});

	after(() => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	});

	afterEach(async () => {
		if (root) await act(async () => root!.unmount());
		host?.remove();
		root = undefined;
		host = undefined;
		positions.length = 0;
	});

	async function mount(element: React.ReactElement) {
		const node = document.createElement("div");
		document.body.append(node);
		host = node;
		const mounted = createRoot(node);
		root = mounted;
		await act(async () => mounted.render(element));
	}

	function element(id: string): HTMLElement {
		const found = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
		assert.ok(found, id);
		return found;
	}

	function dispatch(target: EventTarget, type: string, fields: Record<string, unknown> = {}) {
		const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
		Object.assign(event, { pointerId: 1, button: 0, isPrimary: true }, fields);
		act(() => { target.dispatchEvent(event); });
		return event;
	}

	const positions: { x: number; y: number }[] = [];
	const record = (x: number, y: number) => { positions.push({ x, y }); };

	function floatingQuestion(onMinimize: () => void) {
		return (
			<QuestionDock
				toolName="quiz"
				toolCallId="q-float"
				input={quizInput}
				expanded
				floating
				onMinimize={onMinimize}
				onFloatPosition={record}
				onExpand={() => {}}
				onSubmit={() => {}}
				dictationClaim={false}
			/>
		);
	}

	it("minimize collapses on click and on Escape, and pressing it never drags", async () => {
		let minimized = 0;
		await mount(floatingQuestion(() => { minimized++; }));
		const grip = element("dock-float-grip");
		const minimize = element("dock-float-minimize");
		assert.equal(grip.getAttribute("role"), "toolbar");
		assert.equal(grip.getAttribute("tabindex"), "0");
		assert.ok(grip.getAttribute("aria-label"), "the grip announces how it moves");
		await act(async () => { minimize.click(); });
		assert.equal(minimized, 1);
		// A press on the control must not start a card drag.
		dispatch(minimize, "pointerdown", { clientX: 300, clientY: 300 });
		dispatch(dom.window, "pointermove", { clientX: 360, clientY: 340 });
		assert.deepEqual(positions, [], "the minimize button is not a drag handle");
		const escape = dispatch(grip, "keydown", { key: "Escape" });
		assert.equal(minimized, 2);
		assert.equal(escape.defaultPrevented, true);
	});

	it("pointer drag emits absolute coordinates, clamps to the viewport, and ends on pointerup", async () => {
		await mount(floatingQuestion(() => {}));
		const grip = element("dock-float-grip");
		// Interior moves only: linkedom reports a zero rect, so the drag seeds
		// itself from the agreed fallback and a first step toward the edge would
		// be clamped. Two successive interior points carry the same offset.
		dispatch(grip, "pointerdown", { clientX: 200, clientY: 200 });
		dispatch(dom.window, "pointermove", { clientX: 300, clientY: 300 });
		dispatch(dom.window, "pointermove", { clientX: 400, clientY: 340 });
		assert.equal(positions.length, 2);
		assert.deepEqual(
			{ x: positions[1]!.x - positions[0]!.x, y: positions[1]!.y - positions[0]!.y },
			{ x: 100, y: 40 },
			"each move tracks the pointer offset from the press point",
		);
		dispatch(dom.window, "pointermove", { clientX: -5000, clientY: -5000 });
		assert.deepEqual(positions[2], { x: BOUNDS.min, y: BOUNDS.min }, "the card cannot leave the viewport");
		dispatch(dom.window, "pointermove", { clientX: 99_999, clientY: 99_999 });
		assert.deepEqual(positions[3], { x: BOUNDS.maxX, y: BOUNDS.maxY }, "a sliver of the card always stays visible");
		const emitted = positions.length;
		dispatch(dom.window, "pointerup");
		dispatch(dom.window, "pointermove", { clientX: 10, clientY: 10 });
		assert.equal(positions.length, emitted, "pointerup ends the drag");
	});

	it("a drag seeds from the REAL panel rect, then chains while the rect is stale", async () => {
		// linkedom has no layout, so the rect is spoofed with REAL values, not
		// the zero rect the bare-mount tests above rely on.
		await mount(
			<div data-testid="dock-float-panel">
				<QuestionDock
					toolName="quiz"
					toolCallId="q-real"
					input={quizInput}
					expanded
					floating
					onMinimize={() => {}}
					onFloatPosition={record}
					onExpand={() => {}}
					onSubmit={() => {}}
					dictationClaim={false}
				/>
			</div>,
		);
		const grip = element("dock-float-grip");
		// The panel sits at a REAL 24,96 and stays there: the drag chain must
		// carry the card even before the host paints the emitted position.
		element("dock-float-panel").getBoundingClientRect = () => ({
			x: 24, y: 96, left: 24, top: 96, right: 344, bottom: 336,
			width: 320, height: 240, toJSON: () => ({}),
		});
		Object.defineProperty(element("dock-float-panel"), "offsetWidth", { configurable: true, value: 320 });
		Object.defineProperty(element("dock-float-panel"), "offsetHeight", { configurable: true, value: 240 });
		// First drag: absolute position = the panel's real top-left + the
		// pointer delta. The old fixed-8 seed would emit {108, 108} here.
		dispatch(grip, "pointerdown", { clientX: 200, clientY: 200 });
		dispatch(dom.window, "pointermove", { clientX: 300, clientY: 300 });
		assert.deepEqual(positions[0], { x: 124, y: 196 }, "the drag seeds from the panel's real 24,96");
		dispatch(dom.window, "pointerup");
		// Second drag while the rect has NOT caught up (still 24,96): the card
		// chains from the last emitted point. Re-seeding from the stale rect
		// would emit {54, 106}; the fixed-8 bug would emit {38, 18}.
		dispatch(grip, "pointerdown", { clientX: 100, clientY: 100 });
		dispatch(dom.window, "pointermove", { clientX: 130, clientY: 110 });
		dispatch(dom.window, "pointerup");
		assert.deepEqual(positions.at(-1), { x: 154, y: 206 }, "the second drag chains from the last emitted point");
	});

	it("the first arrow key nudges from the real panel rect, not the fallback", async () => {
		await mount(
			<div data-testid="dock-float-panel">
				<QuestionDock
					toolName="quiz"
					toolCallId="q-real-keys"
					input={quizInput}
					expanded
					floating
					onMinimize={() => {}}
					onFloatPosition={record}
					onExpand={() => {}}
					onSubmit={() => {}}
					dictationClaim={false}
				/>
			</div>,
		);
		const grip = element("dock-float-grip");
		element("dock-float-panel").getBoundingClientRect = () => ({
			x: 24, y: 96, left: 24, top: 96, right: 344, bottom: 336,
			width: 320, height: 240, toJSON: () => ({}),
		});
		Object.defineProperty(element("dock-float-panel"), "offsetWidth", { configurable: true, value: 320 });
		Object.defineProperty(element("dock-float-panel"), "offsetHeight", { configurable: true, value: 240 });
		const right = dispatch(grip, "keydown", { key: "ArrowRight" });
		assert.equal(right.defaultPrevented, true);
		// The {8,8} fallback would emit {24, 8}; the real rect emits 24+16, 96.
		assert.deepEqual(positions[0], { x: 40, y: 96 }, "the first key chains from the real panel top-left");
	});

	it("arrow keys nudge by 16px, clamp to the same sliver, and never trap Tab", async () => {
		await mount(floatingQuestion(() => {}));
		const grip = element("dock-float-grip");
		const right = dispatch(grip, "keydown", { key: "ArrowRight" });
		assert.equal(right.defaultPrevented, true);
		dispatch(grip, "keydown", { key: "ArrowRight" });
		dispatch(grip, "keydown", { key: "ArrowDown" });
		assert.deepEqual(
			{ x: positions[1]!.x - positions[0]!.x, y: positions[1]!.y - positions[0]!.y },
			{ x: 16, y: 0 },
			"Right moves the card horizontally",
		);
		assert.deepEqual(
			{ x: positions[2]!.x - positions[1]!.x, y: positions[2]!.y - positions[1]!.y },
			{ x: 0, y: 16 },
			"Down moves the card vertically",
		);
		for (let i = 0; i < 70; i++) dispatch(grip, "keydown", { key: "ArrowLeft" });
		assert.equal(positions.at(-1)!.x, BOUNDS.min);
		for (let i = 0; i < 70; i++) dispatch(grip, "keydown", { key: "ArrowUp" });
		assert.equal(positions.at(-1)!.y, BOUNDS.min);
		for (let i = 0; i < 70; i++) dispatch(grip, "keydown", { key: "ArrowDown" });
		assert.equal(positions.at(-1)!.y, BOUNDS.maxY);
		const tab = dispatch(grip, "keydown", { key: "Tab" });
		assert.equal(tab.defaultPrevented, false, "Tab must leave the grip");
	});

	it("PracticeDock shares the grip: arrows move it and minimize fires once", async () => {
		let minimized = 0;
		await mount(
			<PracticeDock
				problemCallId="p-float"
				input={{ statement: "Show that every square is a rectangle." }}
				expanded
				floating
				onMinimize={() => { minimized++; }}
				onFloatPosition={record}
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);
		const grip = element("dock-float-grip");
		dispatch(grip, "keydown", { key: "ArrowRight" });
		dispatch(grip, "keydown", { key: "ArrowRight" });
		assert.equal(positions[1]!.x - positions[0]!.x, 16);
		await act(async () => { element("dock-float-minimize").click(); });
		assert.equal(minimized, 1);
	});
});
