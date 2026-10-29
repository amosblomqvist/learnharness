/**
 * The light-mode wave's pure core (src/core/appearance-palette.ts): which
 * variant renders for a mode, and the pre-paint System script.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveRenderedMode, SYSTEM_MODE_SCRIPT } from "../src/core/appearance-palette.ts";

describe("appearance mode resolution", () => {
	it("pinned modes ignore the OS; system follows it", () => {
		assert.equal(resolveRenderedMode("dark", false), "dark");
		assert.equal(resolveRenderedMode("light", true), "light");
		assert.equal(resolveRenderedMode("system", true), "dark");
		assert.equal(resolveRenderedMode("system", false), "light");
	});

	it("the pre-paint script only acts on data-lh-mode=system", () => {
		assert.match(SYSTEM_MODE_SCRIPT, /lhMode/);
		assert.match(SYSTEM_MODE_SCRIPT, /prefers-color-scheme: dark/);
		assert.ok(!SYSTEM_MODE_SCRIPT.includes("localStorage"), "settings live on disk, not in storage");
	});
});
