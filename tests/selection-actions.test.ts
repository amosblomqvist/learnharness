import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSelectionRectVisible, resolveSelectionActionPosition } from "../components/selection-actions.ts";

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
