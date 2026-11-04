import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampDragged, placeSideThread, resizedHeight, SIDE_THREAD_MIN_HEIGHT, SIDE_THREAD_WIDTH } from "../components/side-thread-float.ts";

const viewport = { width: 1400, height: 900 };

describe("placeSideThread", () => {
	it("sits right above the composer at its exact width (/btw)", () => {
		const p = placeSideThread({ kind: "composer", rect: { left: 492, right: 1196, top: 790, bottom: 845 }, viewport, contentHeight: 300 });
		assert.deepEqual(p.style, { left: 492, width: 704, bottom: 900 - 790 + 8 });
		assert.equal(p.maxHeight, Math.min(0.6 * 900, 790 - 8 - 8));
	});

	it("opens below a passage, and flips above when the content no longer fits below", () => {
		const rect = { left: 900, right: 1300, top: 520, bottom: 545 };
		const small = placeSideThread({ kind: "rect", rect, viewport, contentHeight: 200 });
		assert.equal(small.style.top, 545 + 4);
		assert.equal(small.style.width, SIDE_THREAD_WIDTH);
		const grown = placeSideThread({ kind: "rect", rect, viewport, contentHeight: 500 });
		assert.equal(grown.style.top, undefined);
		assert.equal(grown.style.bottom, 900 - 520 + 4);
	});

	it("keeps a narrow window's popover inside it", () => {
		const p = placeSideThread({ kind: "rect", rect: { left: 10, right: 50, top: 100, bottom: 120 }, viewport: { width: 300, height: 900 }, contentHeight: 100 });
		assert.equal(p.style.width, 300 - 16);
	});
});

describe("clampDragged", () => {
	it("keeps a dragged popover fully inside the window", () => {
		assert.deepEqual(clampDragged({ x: -50, y: -20 }, { width: 416, height: 300 }, viewport), { x: 8, y: 8 });
		assert.deepEqual(clampDragged({ x: 1300, y: 800 }, { width: 416, height: 300 }, viewport), { x: 1400 - 416 - 8, y: 900 - 300 - 8 });
		assert.deepEqual(clampDragged({ x: 200, y: 150 }, { width: 416, height: 300 }, viewport), { x: 200, y: 150 });
	});
});

describe("resizedHeight", () => {
	it("follows the pointer between the minimum and the window bottom", () => {
		assert.equal(resizedHeight(300, 120, 100, 900), 420);
		assert.equal(resizedHeight(300, -250, 100, 900), SIDE_THREAD_MIN_HEIGHT);
		assert.equal(resizedHeight(300, 900, 100, 900), 900 - 100 - 8);
	});
});
