/**
 * The narrow-viewport breakpoint (mobile web pass, 2026-11-14).
 *
 * Two files have to agree or the phone layout silently drifts:
 * - electron/main.cjs minWidth is the desktop floor (640px);
 * - app/globals.css defines the `narrow` variant as that same width.
 *
 * Pinned by reading the sources: this is a cross-file invariant the code
 * comments already promise, not a magic string in one file. The sidebar's
 * JS query is pinned in tests/narrow-sidebar-query.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const source = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("narrow-viewport breakpoint", () => {
	it("is the Electron window floor", () => {
		const main = source("../electron/main.cjs");
		assert.match(main, /minWidth:\s*640\b/, "electron/main.cjs minWidth is the breakpoint's source of truth");
	});

	it("is the CSS narrow variant's width", () => {
		const css = source("../app/globals.css");
		const variant = css.match(/@custom-variant narrow \(@media \((width < [^)]+)\)\);/);
		assert.ok(variant, "app/globals.css declares the narrow variant as a width media query");
		assert.equal(variant![1], "width < 40rem", "40rem = the 640px Electron floor");
	});
});
