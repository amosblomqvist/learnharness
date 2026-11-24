/**
 * The default-order resolution, client-side (chunk 2): the UI populates a
 * fresh model pick's thinking level with the SAME level the engine build
 * runs for an unset record — first DEFAULT_THINKING_ORDER entry the model
 * supports (Platform's interlude bd68486 moved the ordering into the core
 * barrel exactly for this). These tests pin the helper against the
 * server's defaultThinkingLevel semantics (src/agent/models.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_THINKING_ORDER } from "../src/core/settings.ts";
import { defaultOrderLevel, populateLevel } from "../components/thinking-default.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

const tl = (levels: string[]) => levels as ThinkingLevel[];

describe("defaultOrderLevel — the ordering's first supported", () => {
	it("a reasoning model taking the ladder's head (medium) resolves medium", () => {
		assert.equal(defaultOrderLevel(tl(["minimal", "low", "medium", "high"])), "medium");
	});

	it("a model without medium falls to the NEXT order entry it supports", () => {
		// order: medium, low, high, minimal, xhigh, max — low wins here
		assert.equal(defaultOrderLevel(tl(["minimal", "low", "high"])), "low");
		assert.equal(defaultOrderLevel(tl(["high", "xhigh", "max"])), "high");
	});

	it("a non-reasoning model (pi reports exactly [off]) resolves off", () => {
		assert.equal(defaultOrderLevel(tl(["off"])), "off");
	});

	it("empty support resolves off (the server's fallback), never crashes", () => {
		assert.equal(defaultOrderLevel(tl([])), "off");
	});

	it("the full ladder resolves its head", () => {
		const full = tl(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		assert.equal(defaultOrderLevel(full), DEFAULT_THINKING_ORDER[0]);
	});
});

describe("populateLevel — an explicit pick always rides; absence populates", () => {
	it("a supported explicit level rides unchanged", () => {
		assert.equal(populateLevel("high", tl(["low", "high"])), "high");
	});

	it("an UNSUPPORTED explicit level STILL rides — the write clamps server-side (bd68486), the signal re-reads the clamped truth", () => {
		// xhigh rides even though unsupported here; never re-populated client-side
		assert.equal(populateLevel("xhigh", tl(["minimal", "medium", "high"])), "xhigh");
	});

	it("no explicit level populates the ordering's level (the fresh-pick case)", () => {
		assert.equal(populateLevel(undefined, tl(["low", "high"])), "low");
	});

	it("off as an explicit level rides when supported", () => {
		assert.equal(populateLevel("off", tl(["off"])), "off");
	});
});
