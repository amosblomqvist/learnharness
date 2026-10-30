import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createReadAloudPlayer, type AudioLike } from "../components/read-aloud-player.ts";
import { stopOnDictation } from "../components/read-aloud.tsx";
import { setDictationActive } from "../components/dictation-state.ts";

/**
 * DICTATION WINS (ElevenLabs voice slice 7): when dictation becomes active,
 * any playback stops before the mic opens, and nothing resumes afterwards.
 * Fakes at the boundary only: the player's fetch and audio element.
 */
class FakeAudio implements AudioLike {
	src = "";
	onended: (() => void) | null = null;
	onerror: (() => void) | null = null;
	paused = 0;
	plays = 0;
	async play() { this.plays++; }
	pause() { this.paused++; }
}

function fixture(deps: { isDictationActive?: () => boolean } = {}) {
	const audio = new FakeAudio();
	let fetches = 0;
	const player = createReadAloudPlayer({
		fetch: (async () => { fetches++; return new Response(new Blob(["mp3"])); }) as unknown as typeof fetch,
		createAudio: () => audio,
		createObjectURL: () => `blob:${fetches}`,
		revokeObjectURL: () => {},
		...deps,
	});
	return { audio, player, fetches: () => fetches };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

afterEach(() => setDictationActive(false));

describe("dictation wins over read aloud", () => {
	it("dictation becoming active stops playback", async () => {
		const { audio, player } = fixture();
		const unbind = stopOnDictation(player);
		void player.play("m1", ["hello"]);
		await settle();
		assert.equal(player.getSnapshot().sourceId, "m1");
		setDictationActive(true);
		assert.equal(player.getSnapshot().sourceId, null);
		assert.ok(audio.paused > 0, "the audio element is paused");
		unbind();
	});

	it("playback does not restart when dictation ends", async () => {
		const { audio, player, fetches } = fixture();
		const unbind = stopOnDictation(player);
		void player.play("m1", ["hello"]);
		await settle();
		setDictationActive(true);
		const plays = audio.plays;
		const requested = fetches();
		setDictationActive(false);
		await settle();
		assert.equal(player.getSnapshot().sourceId, null);
		assert.equal(audio.plays, plays);
		assert.equal(fetches(), requested);
		unbind();
	});

	it("stopping dictation alone never starts playback, and unbinding detaches", async () => {
		const { player } = fixture();
		const unbind = stopOnDictation(player);
		setDictationActive(true);
		setDictationActive(false);
		assert.equal(player.getSnapshot().sourceId, null);
		unbind();
		void player.play("m1", ["hello"]);
		await settle();
		setDictationActive(true);
		assert.equal(player.getSnapshot().sourceId, "m1", "no longer bound");
		player.stop();
	});

	it("the player reports whether dictation is active, for auto-read to refuse", () => {
		let active = false;
		const { player } = fixture({ isDictationActive: () => active });
		assert.equal(player.dictationActive(), false);
		active = true;
		assert.equal(player.dictationActive(), true);
		assert.equal(fixture().player.dictationActive(), false, "defaults to inactive");
	});
});
