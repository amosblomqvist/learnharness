import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSelectionRectVisible, observeSelectionActions, resolveSelectionActionPosition, type SelectionActionPoint, type SelectionDismissReason } from "../components/selection-actions.ts";

const bounds = { left: 100, top: 50, right: 700, bottom: 650 };
const viewport = { width: 1000, height: 800 };

describe("resolveSelectionActionPosition", () => {
	it("prefers the pointer", () => {
		assert.deepEqual(resolveSelectionActionPosition({ bounds, selectionRect: { left: 200, top: 100, right: 300, bottom: 120 }, pointer: { x: 250, y: 110 }, viewport }), { x: 250, y: 110 });
	});
	it("falls back to the right end of the last line, 4px below", () => {
		assert.deepEqual(resolveSelectionActionPosition({ bounds, selectionRect: { left: 200, top: 100, right: 300, bottom: 120 }, pointer: null, viewport }), { x: 300, y: 124 });
	});
	it("falls back to the top right of the bounds without a rect", () => {
		assert.deepEqual(resolveSelectionActionPosition({ bounds, selectionRect: null, pointer: null, viewport }), { x: 560, y: 62 });
	});
	it("clamps 8px inside the bounds and the window", () => {
		assert.deepEqual(resolveSelectionActionPosition({ bounds, selectionRect: null, pointer: { x: 5, y: 900 }, viewport }), { x: 108, y: 642 });
	});
});

describe("isSelectionRectVisible", () => {
	it("needs a positive-area intersection with every clip", () => {
		const rect = { left: 10, top: 10, right: 50, bottom: 20 };
		assert.equal(isSelectionRectVisible(rect, [{ left: 0, top: 0, right: 100, bottom: 100 }]), true);
		assert.equal(isSelectionRectVisible(rect, [{ left: 50, top: 0, right: 100, bottom: 100 }]), false);
		assert.equal(isSelectionRectVisible(rect, [{ left: 0, top: 0, right: 100, bottom: 100 }, { left: 0, top: 20, right: 100, bottom: 30 }]), false);
	});
});

describe("observeSelectionActions", () => {
	function makeHarness() {
		class FakeNode {}
		type Listener = (event: unknown) => void;
		const makeTarget = () => {
			const map = new Map<string, Set<Listener>>();
			return {
				addEventListener(type: string, fn: Listener) {
					if (!map.has(type)) map.set(type, new Set());
					map.get(type)!.add(fn);
				},
				removeEventListener(type: string, fn: Listener) {
					map.get(type)?.delete(fn);
				},
				emit(type: string, event: unknown = {}) {
					for (const fn of map.get(type) ?? []) fn(event);
				},
			};
		};

		let nextTimer = 1;
		const timers = new Map<number, () => void>();
		const frames = new Map<number, () => void>();
		const view = Object.assign(makeTarget(), {
			Node: FakeNode,
			setTimeout(fn: () => void) {
				const id = nextTimer++;
				timers.set(id, fn);
				return id;
			},
			clearTimeout(id: number) {
				timers.delete(id);
			},
			requestAnimationFrame(fn: () => void) {
				const id = nextTimer++;
				frames.set(id, fn);
				return id;
			},
			cancelAnimationFrame(id: number) {
				frames.delete(id);
			},
		});
		const doc = Object.assign(makeTarget(), { defaultView: view });
		const targetEl = Object.assign(new FakeNode(), { closest: () => null });
		const element = Object.assign(makeTarget(), {
			ownerDocument: doc,
			contains: (node: unknown) => node === targetEl,
		});

		const selections: Array<SelectionActionPoint | null> = [];
		const dismissals: SelectionDismissReason[] = [];
		const observer = observeSelectionActions({
			element: element as unknown as HTMLElement,
			getActionElement: () => null,
			restoreAfterScroll: false,
			onSelection: (p) => selections.push(p),
			onDismiss: (r) => dismissals.push(r),
		});

		const flush = () => {
			for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
			for (const [id, fn] of [...frames]) { frames.delete(id); fn(); }
		};

		return { view, doc, element, targetEl, observer, selections, dismissals, flush };
	}

	it("clears pointerDown on touch pointercancel and ignores touch contextmenu", () => {
		const h = makeHarness();
		h.doc.emit("pointerdown", { pointerType: "touch", button: 0, defaultPrevented: false, target: h.targetEl });
		h.view.emit("pointercancel", { pointerType: "touch" });
		h.element.emit("contextmenu", {});
		h.observer.selectionChanged();
		h.flush();
		assert.deepEqual(h.selections, [null]);
		assert.deepEqual(h.dismissals, []);
		h.observer.dispose();
	});

	it("clears pointerDown and schedules on touch pointerup", () => {
		const h = makeHarness();
		h.doc.emit("pointerdown", { pointerType: "touch", button: 0, defaultPrevented: false, target: h.targetEl });
		h.doc.emit("pointerup", { pointerType: "touch", button: 0, target: h.targetEl });
		h.flush();
		assert.deepEqual(h.selections, [null]);
		h.observer.dispose();
	});

	it("preserves desktop mouse pointer coordinates and right-click dismiss", () => {
		const h = makeHarness();
		h.doc.emit("pointerdown", { pointerType: "mouse", button: 0, defaultPrevented: false, target: h.targetEl });
		h.doc.emit("mouseup", { button: 0, detail: 1, clientX: 240, clientY: 180 });
		h.flush();
		assert.deepEqual(h.selections, [{ x: 240, y: 180 }]);
		h.element.emit("contextmenu", {});
		assert.deepEqual(h.dismissals, ["interaction"]);
		h.observer.dispose();
	});
});
