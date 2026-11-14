/**
 * The narrow sidebar's presentation query (mobile web pass, 2026-11-14).
 *
 * CSS owns the layout (`narrow` variant, tests/narrow-breakpoint.test.ts);
 * the sidebar is the one place JS must choose which DOM to mount, and it
 * reads the same width. This pins that spelling.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

describe("narrow sidebar presentation", () => {
	it("uses the breakpoint's media query", () => {
		const source = readFileSync(fileURLToPath(new URL("../components/sidebar.tsx", import.meta.url)), "utf8");
		const query = source.match(/const NARROW_QUERY = "([^"]+)";/);
		assert.ok(query, "components/sidebar.tsx owns the one JS branch");
		assert.equal(query![1], "(width < 40rem)", "40rem = the 640px Electron floor");
	});
});
