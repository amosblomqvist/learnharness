/**
 * The drawing pad's live gestures (2026-11-04), mounted: the lasso from
 * the toolbar Select tool and from the pen's held UPPER button, then the
 * selection's Esc and Delete. Pointer events carry probe values from a
 * Wacom CTL-672 (Artist Mode via XWayland: upper button = buttons & 2).
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { DrawingStroke } from "../src/core/drawings.ts";
import { DrawingPad } from "../components/drawing/drawing-pad.tsx";
import { selectionBox } from "../components/drawing/strokes.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
});

const stroke = (x: number, y: number): DrawingStroke => ({
	ink: "ink",
	points: [{ x, y, p: 0.5 }, { x: x + 20, y: y + 20, p: 0.5 }],
});

async function mount(initialStrokes: DrawingStroke[]) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	win.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() {} });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		React, window: win, document: doc, Node: win.Node, HTMLElement: win.HTMLElement, Element: win.Element,
		Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	const done: DrawingStroke[][] = [];
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(doc.getElementById("root")!);
	await act(async () => {
		root.render(<DrawingPad initialStrokes={initialStrokes} onDone={(s) => done.push(s)} />);
	});
	cleanup = async () => {
		await act(async () => root.unmount());
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const canvas = () => doc.querySelector<HTMLCanvasElement>('[data-testid="drawing-canvas"]')!;
	const pointer = async (type: string, x: number, y: number, buttons: number, pointerType = "pen") => {
		const event = new win.Event(type, { bubbles: true, cancelable: true });
		for (const [key, value] of Object.entries({ clientX: x, clientY: y, buttons, button: type === "pointermove" ? -1 : 0, pointerId: 2, pointerType, pressure: buttons & 1 ? 0.5 : 0 })) {
			Object.defineProperty(event, key, { value });
		}
		await act(async () => {
			canvas().dispatchEvent(event);
		});
	};
	const key = async (k: string) => {
		const event = new win.Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "key", { value: k });
		await act(async () => {
			doc.dispatchEvent(event);
		});
	};
	const click = async (testid: string) => {
		await act(async () => {
			doc.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!.click();
		});
	};
	const trash = () => doc.querySelector('[data-testid="pad-delete-selection"]');
	return { doc, done, pointer, key, click, trash };
}

/** A square loop around (40..160, 40..160), with the given buttons held. */
async function lassoAround(pad: Awaited<ReturnType<typeof mount>>, held: number) {
	await pad.pointer("pointermove", 40, 40, held | 1);
	for (const [x, y] of [[160, 40], [160, 160], [40, 160]] as const) await pad.pointer("pointermove", x, y, held | 1);
}

describe("drawing pad selection gestures", () => {
	it("the toolbar Select tool lassoes; Esc clears the selection before it closes the pad", async () => {
		const pad = await mount([stroke(60, 60), stroke(400, 400)]);
		await pad.click("pad-select");
		assert.equal(pad.doc.querySelector('[data-testid="pad-select"]')!.getAttribute("aria-pressed"), "true");
		await pad.pointer("pointerdown", 40, 40, 1, "mouse");
		for (const [x, y] of [[160, 40], [160, 160], [40, 160]] as const) await pad.pointer("pointermove", x, y, 1, "mouse");
		await pad.pointer("pointerup", 40, 160, 0, "mouse");
		assert.ok(pad.trash(), "a selection shows its trash button");
		await pad.key("Escape");
		assert.equal(pad.trash(), null, "the first Esc clears the selection");
		assert.equal(pad.done.length, 0, "…and keeps the pad open");
		await pad.key("Escape");
		assert.equal(pad.done.length, 1, "the next Esc closes the pad");
		assert.equal(pad.done[0]!.length, 2, "nothing was removed");
	});

	it("holding the UPPER pen button lassoes (button first, then the tip: 2 → 3 → 2); Delete removes the selection", async () => {
		const pad = await mount([stroke(60, 60), stroke(400, 400)]);
		await pad.pointer("pointerdown", 40, 40, 2); // the button, hovering
		await lassoAround(pad, 2); // the tip touches under it
		await pad.pointer("pointermove", 40, 160, 2); // the tip lifts, button still held
		assert.ok(pad.trash(), "the tip lifting ends the lasso and selects");
		await pad.pointer("pointerup", 40, 160, 0);
		await pad.key("Delete");
		assert.equal(pad.trash(), null);
		await pad.click("pad-done");
		assert.equal(pad.done[0]!.length, 1, "only the stroke outside the loop is left");
		assert.equal(pad.done[0]![0]!.points[0]!.x, 400);
	});

	it("a selection moves by dragging inside its box and resizes from a corner, thickness kept", async () => {
		const pad = await mount([stroke(60, 60)]);
		await pad.pointer("pointerdown", 40, 40, 2);
		await lassoAround(pad, 2);
		await pad.pointer("pointermove", 40, 160, 2);
		await pad.pointer("pointerup", 40, 160, 0);
		// Move: the tip alone, starting inside the box (the stroke spans 60..80).
		await pad.pointer("pointerdown", 70, 70, 1);
		await pad.pointer("pointermove", 170, 120, 1);
		await pad.pointer("pointerup", 170, 120, 0);
		assert.ok(pad.trash(), "the selection follows the moved strokes");
		// Resize: drag the south-east handle outward to double the box.
		const box = { right: 180 + 2.5 / 2 + 6, bottom: 130 + 2.5 / 2 + 6 }; // ink bounds + pad
		await pad.pointer("pointerdown", box.right, box.bottom, 1);
		const left = 160 - 2.5 / 2 - 6;
		const top = 110 - 2.5 / 2 - 6;
		await pad.pointer("pointermove", left + (box.right - left) * 2, top + (box.bottom - top) * 2, 1);
		await pad.pointer("pointerup", left + (box.right - left) * 2, top + (box.bottom - top) * 2, 0);
		await pad.click("pad-done");
		const pts = pad.done[0]![0]!.points;
		assert.ok(Math.abs(pts[1]!.x - pts[0]!.x - 40) < 0.01, "the 20px stroke doubled to 40px");
		assert.equal(pts[0]!.p, 0.5, "pressure — and so line thickness — unchanged");
		const after = selectionBox(pad.done[0]!)!;
		assert.ok(Math.abs(after.x - left) < 0.01 && Math.abs(after.y - top) < 0.01, "moved by +100/+50, then the far (north-west) corner stayed put");
	});

	it("holding the LOWER pen button erases whatever the tip sweeps (4 → 5 → 4)", async () => {
		const pad = await mount([stroke(60, 60), stroke(400, 400)]);
		await pad.pointer("pointerdown", 0, 0, 4);
		await pad.pointer("pointermove", 70, 70, 5);
		await pad.pointer("pointermove", 72, 72, 4);
		await pad.pointer("pointerup", 72, 72, 0);
		await pad.click("pad-done");
		assert.equal(pad.done[0]!.length, 1, "the swept stroke is gone");
		assert.equal(pad.done[0]![0]!.points[0]!.x, 400);
	});
});
