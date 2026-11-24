import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { probeArrivalExpanded, revealArrival, shouldStampGeometryMute } from "../components/chat.tsx";

/**
 * Teach-question arrival states (owner ruling, scroll-honesty round
 * 2026-09-25). Applied DURING RENDER before the first paint — the bug was
 * the stale expanded=true left by the previous question painting one
 * frame of the open question: the dock measured itself tall, reserved that
 * height permanently (fold immunity refused the give-back), and the
 * transcript scrolled as if the collapsed question had opened.
 */
/**
 * The geometry-mute's growth rule (flicker round, 2026-09-26): reserve
 * GROWTH while a question is pending is the dock stretching itself (the
 * dictation flush landing many dictated lines at once, reproduced d≈152 >
 * COLLAPSE_DIST) — the spacer's scroll catch-up must not read as the
 * learner leaving. Shrinks are the fold's own give-back and never stamp.
 */
describe("shouldStampGeometryMute — when a block resize is our own stretch", () => {
	it("growth while a question is pending stamps (dictation flush, arrival stretch)", () => {
		assert.equal(shouldStampGeometryMute(545, 393, true), true);
	});

	it("sub-pixel growth does not stamp (rounding noise)", () => {
		assert.equal(shouldStampGeometryMute(394, 393, true), false);
	});

	it("shrink never stamps — the fold's own morph must not self-mute the re-expand", () => {
		assert.equal(shouldStampGeometryMute(40, 545, true), false);
	});

	it("no growth stamps without a pending question (composer life)", () => {
		assert.equal(shouldStampGeometryMute(545, 393, false), false);
	});
});

describe("revealArrival — how a teach question lands", () => {
	it("fresh arrival after the composer: collapsed behind the reveal button", () => {
		assert.deepEqual(revealArrival(false), { expanded: false, revealed: false });
	});

	it("queued behind another question: open — the reading already happened", () => {
		assert.deepEqual(revealArrival(true), { expanded: true, revealed: true });
	});
});

/**
 * Probe-question arrival state (flicker round, 2026-09-26): open iff the
 * learner is following at the bottom; scrolled up in history → arrive as
 * the collapsed bar, decided DURING RENDER (the old after-paint effect
 * painted one stale-open frame first).
 */
describe("probeArrivalExpanded — how a probe question lands", () => {
	it("at the bottom following along: open", () => {
		assert.equal(probeArrivalExpanded(true), true);
	});

	it("scrolled up in history: arrive already-collapsed (owner ruling)", () => {
		assert.equal(probeArrivalExpanded(false), false);
	});
});