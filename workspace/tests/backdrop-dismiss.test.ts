import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { act, createElement, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { useBackdropDismiss } from "../components/backdrop-dismiss";
import { AbortTurnBody } from "../components/abort-turn-dialog";

/** Mounted React handlers, including portal propagation and the browser's
 * common-ancestor click after a cross-boundary press/release. Linkedom does
 * not synthesize that click for us, so each test dispatches it explicitly. */
describe("backdrop dismissal requires a whole primary gesture on the scrim", () => {
	const dom = parseHTML("<html><body></body></html>");
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	let root: Root;
	let host: HTMLDivElement;
	let createRoot: typeof import("react-dom/client").createRoot;
	let closes: number;
	let actions: number;

	before(async () => {
		for (const [key, value] of Object.entries({
			window: dom.window,
			document: dom.document,
			// ReactDOM reads navigator once it sees a DOM; Node can disable
			// that global. Keep this fallback local and platform-neutral.
			navigator: globals.navigator ?? { userAgent: "", platform: "" },
			HTMLElement: dom.window.HTMLElement,
			IS_REACT_ACT_ENVIRONMENT: true,
		})) {
			previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}
		({ createRoot } = await import("react-dom/client"));
	});

	after(() => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	});

	function Harness({ onClose = () => { closes++; }, busy = false, open = true }: {
		onClose?: () => void;
		busy?: boolean;
		open?: boolean;
	}) {
		const backdropDismiss = useBackdropDismiss(() => {
			if (!busy) onClose();
		});
		if (!open) return null;
		return createElement("div", { ...backdropDismiss, "data-testid": "backdrop" },
			createElement("div", {
				"data-testid": "body",
				onClick: (event: MouseEvent) => event.stopPropagation(),
			}, createElement("button", { onClick: () => { actions++; }, "data-testid": "action" }, "Save"),
			createPortal(createElement("button", {
				"data-testid": "portal-option",
				onClick: () => { actions++; },
			}, "Pick provider"), document.body)),
		);
	}

	function element(id: string): HTMLElement {
		const found = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
		assert.ok(found, id);
		return found;
	}

	function dispatch(target: HTMLElement, type: string, fields: Record<string, unknown> = {}) {
		const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
		Object.assign(event, { pointerId: 1, button: 0, isPrimary: true }, fields);
		act(() => { target.dispatchEvent(event); });
		return event;
	}

	function click(target: HTMLElement, fields: Record<string, unknown> = {}) {
		dispatch(target, "pointerdown", fields);
		dispatch(target, "pointerup", fields);
		return dispatch(target, "click", fields);
	}

	beforeEach(() => {
		closes = 0;
		actions = 0;
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		act(() => { root.render(createElement(Harness)); });
	});

	afterEach(() => {
		act(() => { root.unmount(); });
		host.remove();
	});

	it("ordinary primary backdrop click closes exactly once; a bare click does not", () => {
		const backdrop = element("backdrop");
		dispatch(backdrop, "click");
		assert.equal(closes, 0);
		const event = click(backdrop);
		assert.equal(closes, 1);
		assert.equal(event.defaultPrevented, false);
		dispatch(backdrop, "click");
		assert.equal(closes, 1, "the completed gesture is consumed");
	});

	it("inside press → backdrop release → common-ancestor click stays open", () => {
		dispatch(element("body"), "pointerdown");
		dispatch(element("backdrop"), "pointerup");
		dispatch(element("backdrop"), "click");
		assert.equal(closes, 0);
		click(element("backdrop"));
		assert.equal(closes, 1, "a later genuine click still works");
	});

	it("backdrop press → inside release → common-ancestor click stays open", () => {
		dispatch(element("backdrop"), "pointerdown");
		dispatch(element("body"), "pointerup");
		dispatch(element("backdrop"), "click");
		assert.equal(closes, 0);
	});

	it("releases implicit touch capture so a drag ending inside is not retargeted to the backdrop", () => {
		const backdrop = element("backdrop");
		let released = 0;
		backdrop.hasPointerCapture = (pointerId) => pointerId === 1;
		backdrop.releasePointerCapture = (pointerId) => {
			assert.equal(pointerId, 1);
			released++;
		};
		dispatch(backdrop, "pointerdown", { pointerType: "touch" });
		assert.equal(released, 1);
		dispatch(element("body"), "pointerup", { pointerType: "touch" });
		dispatch(backdrop, "click");
		assert.equal(closes, 0);
	});

	it("a release is required and a mismatched pointer cannot finish the press", () => {
		const backdrop = element("backdrop");
		dispatch(backdrop, "pointerdown");
		dispatch(backdrop, "click");
		assert.equal(closes, 0);
		dispatch(backdrop, "pointerdown");
		dispatch(backdrop, "pointerup", { pointerId: 2 });
		dispatch(backdrop, "click");
		assert.equal(closes, 0);
	});

	it("pointer cancellation invalidates the gesture, before or after release", () => {
		const backdrop = element("backdrop");
		dispatch(backdrop, "pointerdown");
		dispatch(backdrop, "pointercancel");
		dispatch(backdrop, "pointerup");
		dispatch(backdrop, "click");
		assert.equal(closes, 0);
		dispatch(backdrop, "pointerdown");
		dispatch(backdrop, "pointerup");
		dispatch(backdrop, "pointercancel");
		dispatch(backdrop, "click");
		assert.equal(closes, 0);
	});

	it("right/middle clicks and non-primary pointers never dismiss", () => {
		for (const fields of [{ button: 1 }, { button: 2 }, { isPrimary: false }]) {
			click(element("backdrop"), fields);
			assert.equal(closes, 0);
		}
	});

	it("inside buttons retain their own action without closing the dialog", () => {
		click(element("action"));
		assert.equal(actions, 1);
		assert.equal(closes, 0);
	});

	it("portaled dropdown picks work and neither cross-boundary direction closes the parent", () => {
		const option = element("portal-option");
		const backdrop = element("backdrop");
		assert.equal(backdrop.contains(option), false, "the menu is physically outside the backdrop");
		click(option);
		assert.equal(actions, 1);
		assert.equal(closes, 0);
		dispatch(option, "pointerdown");
		dispatch(backdrop, "pointerup");
		dispatch(backdrop, "click");
		assert.equal(closes, 0);
		dispatch(backdrop, "pointerdown");
		dispatch(option, "pointerup");
		dispatch(backdrop, "click");
		assert.equal(closes, 0);
	});

	it("uses the latest callback and busy guard even when props change mid-gesture", () => {
		const backdrop = element("backdrop");
		dispatch(backdrop, "pointerdown");
		act(() => { root.render(createElement(Harness, { busy: true })); });
		dispatch(backdrop, "pointerup");
		dispatch(backdrop, "click");
		assert.equal(closes, 0, "new busy protection is honored");

		act(() => { root.render(createElement(Harness)); });
		dispatch(backdrop, "pointerdown");
		let currentCalls = 0;
		act(() => { root.render(createElement(Harness, { onClose: () => { currentCalls++; } })); });
		dispatch(backdrop, "pointerup");
		dispatch(backdrop, "click");
		assert.equal(closes, 0, "the old callback is not retained");
		assert.equal(currentCalls, 1);
	});

	it("can render closed/open without changing hook order or reusing a removed backdrop press", () => {
		dispatch(element("backdrop"), "pointerdown");
		act(() => { root.render(createElement(Harness, { open: false })); });
		act(() => { root.render(createElement(Harness)); });
		dispatch(element("backdrop"), "pointerup");
		dispatch(element("backdrop"), "click");
		assert.equal(closes, 0);
		click(element("backdrop"));
		assert.equal(closes, 1);
	});

	it("AbortTurnBody adopts the guard while retaining Cancel and Confirm actions", () => {
		act(() => {
			root.render(createElement(AbortTurnBody, {
				mode: "turn",
				onClose: () => { closes++; },
				onConfirm: () => { actions++; },
			}));
		});
		const backdrop = element("abort-turn-dialog");
		dispatch(element("abort-turn-title"), "pointerdown");
		dispatch(backdrop, "pointerup");
		dispatch(backdrop, "click");
		assert.equal(closes, 0);
		click(element("abort-turn-confirm"));
		assert.equal(actions, 1);
		assert.equal(closes, 0);
		click(element("abort-turn-cancel"));
		assert.equal(closes, 1);
		click(backdrop);
		assert.equal(closes, 2);
	});
});
