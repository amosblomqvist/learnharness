/**
 * Figure/demo auto-invert (2026-10-29): the pin semantics. No pin = auto
 * (inverted only while the app renders dark AND the artifact measured
 * light); a pin is absolute; toggling to the auto value clears the pin.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import {
	autoInverted,
	effectiveInverted,
	nextInvertPin,
	relativeLuminance,
	toneFromCssColor,
	toneFromPixels,
} from "../src/core/artifact-invert.ts";

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

function pixels(bg: string, fg = "#000000") {
	const c = createCanvas(64, 40);
	const ctx = c.getContext("2d");
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, 64, 40);
	ctx.fillStyle = fg;
	ctx.fillRect(16, 10, 32, 20); // content in the middle never decides
	return ctx.getImageData(0, 0, 64, 40).data;
}

describe("artifact tone", () => {
	it("relativeLuminance spans black → white", () => {
		assert.equal(relativeLuminance(0, 0, 0), 0);
		assert.ok(Math.abs(relativeLuminance(255, 255, 255) - 1) < 1e-9);
	});

	it("the perimeter decides: white page = light, dark page = dark", () => {
		assert.equal(toneFromPixels(pixels("#ffffff"), 64, 40), "light");
		assert.equal(toneFromPixels(pixels("#1e1e1e", "#ffffff"), 64, 40), "dark");
		assert.equal(toneFromPixels(new Uint8ClampedArray(0), 0, 0), "unknown");
	});

	it("CSS colors: opaque reads a tone, transparent is null", () => {
		assert.equal(toneFromCssColor("rgb(255, 255, 255)"), "light");
		assert.equal(toneFromCssColor("rgb(20, 20, 20)"), "dark");
		assert.equal(toneFromCssColor("rgba(0, 0, 0, 0)"), null);
		assert.equal(toneFromCssColor("transparent"), null);
		assert.equal(toneFromCssColor("color(display-p3 1 1 1)"), "unknown");
	});
});
