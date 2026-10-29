/**
 * Figure/demo auto-invert (2026-10-29): the pin semantics. No pin = auto
 * (inverted only while the app renders dark AND the artifact measured
 * light); a pin is absolute; toggling to the auto value clears the pin.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { autoInverted, effectiveInverted, nextInvertPin } from "../src/core/artifact-invert.ts";

describe("artifact auto-invert pins", () => {
	it("auto inverts only a light artifact in dark mode", () => {
		assert.equal(autoInverted("dark", "light"), true);
		assert.equal(autoInverted("dark", "dark"), false);
		assert.equal(autoInverted("dark", "unknown"), false, "unmeasurable never auto-flips");
		assert.equal(autoInverted("light", "light"), false);
	});

	it("a pin wins in every mode; no pin follows auto", () => {
		assert.equal(effectiveInverted(undefined, "dark", "light"), true);
		assert.equal(effectiveInverted(false, "dark", "light"), false);
		assert.equal(effectiveInverted(true, "light", "light"), true);
		assert.equal(effectiveInverted(undefined, "light", "light"), false);
	});

	it("toggling to the auto value clears the pin, otherwise stores it", () => {
		// dark, light figure: flip to original → pin false; flip back → clear
		assert.equal(nextInvertPin(false, "dark", "light"), false);
		assert.equal(nextInvertPin(true, "dark", "light"), null);
		// light mode: flip to inverted → pin true
		assert.equal(nextInvertPin(true, "light", "light"), true);
		assert.equal(nextInvertPin(false, "light", "light"), null);
		// a dark figure in dark mode: inverting it is a pin
		assert.equal(nextInvertPin(true, "dark", "dark"), true);
	});
});
