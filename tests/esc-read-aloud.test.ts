import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escFallbackTarget, runEscFallback } from "../components/esc-fallback.ts";

/**
 * ESC STOPS READ ALOUD (ElevenLabs voice slice 7). The window-level fallback
 * chain, bottom-up: cancel dictation → stop read aloud → abort turn. Surfaced
 * layers (popovers, overlays, dialogs) claim Esc before this chain runs.
 */
describe("escFallbackTarget (the window Esc chain)", () => {
	it("nothing live: Esc falls through to the turn abort", () => {
		assert.equal(escFallbackTarget({ dictationActive: false, playing: false }), "abort-turn");
	});

	it("audio playing: Esc stops it instead of aborting the turn", () => {
		assert.equal(escFallbackTarget({ dictationActive: false, playing: true }), "stop-read-aloud");
	});

	it("dictation outranks playback: cancel dictation first", () => {
		assert.equal(escFallbackTarget({ dictationActive: true, playing: true }), "cancel-dictation");
		assert.equal(escFallbackTarget({ dictationActive: true, playing: false }), "cancel-dictation");
	});
});

describe("runEscFallback (one Esc, one action)", () => {
	function harness(state: { dictationActive: boolean; playing: boolean }) {
		const calls: string[] = [];
		let prevented = false;
		const run = () =>
			runEscFallback(
				{ preventDefault: () => { prevented = true; } },
				{
					isDictationActive: () => state.dictationActive,
					player: { getSnapshot: () => ({ sourceId: state.playing ? "m1" : null, error: null }), stop: () => calls.push("stop") },
					dispatch: (name) => calls.push(name),
				},
			);
		return { calls, run, prevented: () => prevented };
	}

	it("playing: stops playback, consumes the key, does NOT abort the turn", () => {
		const h = harness({ dictationActive: false, playing: true });
		h.run();
		assert.deepEqual(h.calls, ["stop"]);
		assert.equal(h.prevented(), true);
	});

	it("dictation active and playing: only dictation is cancelled", () => {
		const h = harness({ dictationActive: true, playing: true });
		h.run();
		assert.deepEqual(h.calls, ["lh:kbd-cancel-dictation"]);
	});

	it("nothing playing: aborts the turn as before", () => {
		const h = harness({ dictationActive: false, playing: false });
		h.run();
		assert.deepEqual(h.calls, ["lh:kbd-abort-turn"]);
	});
});
