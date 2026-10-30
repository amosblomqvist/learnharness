import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deepgramListenUrl } from "../src/core/dictation.ts";
import { createDictationEngine, createElevenLabsEngine, deepgramEngine, type DictationEngine } from "../src/core/dictation-engine.ts";

describe("Deepgram dictation engine adapter", () => {
	it("builds today's socket: listen URL plus the bearer subprotocol carrying the token", () => {
		assert.deepEqual(deepgramEngine.socket("jwt-1", "en-GB"), {
			url: deepgramListenUrl("en-GB"),
			protocols: ["bearer", "jwt-1"],
		});
	});

	it("passes a PCM frame through as binary", () => {
		const frame = new ArrayBuffer(8);
		assert.equal(deepgramEngine.encodeFrame(frame), frame);
	});

	it("yields the transcript of a final Results message", () => {
		const raw = JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: "hello there" }] } });
		assert.deepEqual(deepgramEngine.parseMessage(raw), { finals: ["hello there"] });
	});

	it("yields nothing for non-final, empty, other-typed or malformed messages", () => {
		const alt = (transcript: string) => ({ alternatives: [{ transcript }] });
		for (const raw of [
			JSON.stringify({ type: "Results", is_final: false, channel: alt("interim") }),
			JSON.stringify({ type: "Results", is_final: true, channel: alt("") }),
			JSON.stringify({ type: "Results", is_final: true }),
			JSON.stringify({ type: "Metadata" }),
			"{not json",
		]) {
			assert.deepEqual(deepgramEngine.parseMessage(raw), { finals: [] }, raw);
		}
	});

	it("ends the stream with a CloseStream message", () => {
		assert.deepEqual(deepgramEngine.endOfStream(), ['{"type":"CloseStream"}']);
	});

	it("treats close code 1000 as finished and any other code as not", () => {
		assert.equal(deepgramEngine.isFinishedClose(1000), true);
		for (const code of [1001, 1006, 1008, 1011, 4000]) assert.equal(deepgramEngine.isFinishedClose(code), false, String(code));
	});

	it("never marks a message as finishing the stream (the close does that)", () => {
		const raw = JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: "x" }] } });
		assert.notEqual(deepgramEngine.parseMessage(raw).settles, true);
	});
});

describe("ElevenLabs dictation engine adapter", () => {
	const msg = (o: object) => JSON.stringify(o);

	it("opens the realtime socket with the token in the query, VAD commits at 0.3 s, the language code and no subprotocols", () => {
		const { url, protocols } = createElevenLabsEngine().socket("sutkn_1", "pl");
		const u = new URL(url);
		assert.equal(`${u.origin}${u.pathname}`, "wss://api.elevenlabs.io/v1/speech-to-text/realtime");
		assert.deepEqual(Object.fromEntries(u.searchParams), {
			token: "sutkn_1",
			model_id: "scribe_v2_realtime",
			audio_format: "pcm_16000",
			commit_strategy: "vad",
			vad_silence_threshold_secs: "0.3",
			language_code: "pl",
		});
		assert.deepEqual(protocols, []);
	});

	it("sends the base language for a regional choice, yue for zh-HK, fil for Tagalog, and omits language_code for multi", () => {
		const code = (language: Parameters<DictationEngine["socket"]>[1]) =>
			new URL(createElevenLabsEngine().socket("t", language).url).searchParams.get("language_code");
		assert.equal(code("en-GB"), "en");
		assert.equal(code("zh-HK"), "yue");
		assert.equal(code("multi"), null);
		assert.equal(code("tl"), "fil");
	});

	it("leaves Deepgram's URL language handling alone", () => {
		assert.equal(new URL(deepgramEngine.socket("t", "en-GB").url).searchParams.get("language"), "en-GB");
	});

	it("encodes a PCM frame as a base64 input_audio_chunk", () => {
		const frame = new Uint8Array([0, 1, 2, 250, 255]).buffer;
		assert.deepEqual(JSON.parse(createElevenLabsEngine().encodeFrame(frame) as string), {
			message_type: "input_audio_chunk",
			audio_base_64: "AAEC+v8=",
			commit: false,
			sample_rate: 16000,
		});
	});

	it("encodes a large frame without overflowing the call stack", () => {
		const big = new Uint8Array(200_000).buffer;
		const out = JSON.parse(createElevenLabsEngine().encodeFrame(big) as string);
		assert.equal(out.audio_base_64.length, Math.ceil(200_000 / 3) * 4);
	});

	it("turns committed transcripts (plain and with timestamps) into finals", () => {
		const e = createElevenLabsEngine();
		assert.deepEqual(e.parseMessage(msg({ message_type: "committed_transcript", text: "hello there" })), { finals: ["hello there"] });
		assert.deepEqual(
			e.parseMessage(msg({ message_type: "committed_transcript_with_timestamps", text: "again", words: [] })),
			{ finals: ["again"] },
		);
	});

	it("ignores partials, session_started, warnings, empty commits, unknown types and malformed JSON", () => {
		const e = createElevenLabsEngine();
		for (const raw of [
			msg({ message_type: "partial_transcript", text: "hel" }),
			msg({ message_type: "session_started", session_id: "s" }),
			msg({ message_type: "warning", warning: "careful" }),
			msg({ message_type: "committed_transcript", text: "" }),
			msg({ message_type: "something_new" }),
			"{not json",
		]) {
			assert.deepEqual(e.parseMessage(raw), { finals: [] }, raw);
		}
	});

	it("maps every documented error type to a short user-facing error", () => {
		const e = createElevenLabsEngine();
		for (const type of [
			"auth_error", "quota_exceeded", "rate_limited", "commit_throttled", "session_time_limit_exceeded",
			"insufficient_audio_activity", "invalid_request", "input_error", "chunk_size_exceeded",
			"transcriber_error", "error", "unaccepted_terms", "queue_overflow", "resource_exhausted",
		]) {
			const parsed = e.parseMessage(msg({ message_type: type, error: "detail" }));
			assert.deepEqual(parsed.finals, [], type);
			assert.match(parsed.error ?? "", /^ElevenLabs /, type);
			assert.ok((parsed.error ?? "").length < 70, type);
		}
		assert.match(e.parseMessage(msg({ message_type: "auth_error", error: "x" })).error!, /key/i);
	});

	it("ends the stream with one silent committing chunk, and any commit after it settles (never finishes) the run", () => {
		const e = createElevenLabsEngine();
		assert.deepEqual(e.parseMessage(msg({ message_type: "committed_transcript", text: "mid-run" })), { finals: ["mid-run"] });
		const [end, ...rest] = e.endOfStream();
		assert.deepEqual(rest, []);
		const chunk = JSON.parse(end!);
		assert.equal(chunk.message_type, "input_audio_chunk");
		assert.equal(chunk.commit, true);
		assert.equal(chunk.sample_rate, 16000);
		assert.ok(chunk.audio_base_64.length > 0);
		assert.match(atob(chunk.audio_base_64), /^\0+$/, "silence, not speech");
		assert.deepEqual(e.parseMessage(msg({ message_type: "committed_transcript", text: "last words" })), {
			finals: ["last words"], settles: true,
		});
	});

	it("keeps run state per engine instance", () => {
		const a = createElevenLabsEngine();
		a.endOfStream();
		const b = createElevenLabsEngine();
		assert.notEqual(b.parseMessage(msg({ message_type: "committed_transcript", text: "x" })).settles, true);
	});

	it("after Stop, a silent commit that finds nothing new ends the run cleanly rather than as an error", () => {
		const e = createElevenLabsEngine();
		e.endOfStream();
		assert.deepEqual(e.parseMessage(msg({ message_type: "insufficient_audio_activity", error: "none" })), { finals: [], settles: true });
	});

	it("createDictationEngine picks the engine per provider, a fresh ElevenLabs engine each run", () => {
		assert.equal(createDictationEngine("deepgram"), deepgramEngine);
		const a = createDictationEngine("elevenlabs");
		assert.notEqual(a, createDictationEngine("elevenlabs"));
		assert.match(a.socket("t", "en").url, /^wss:\/\/api\.elevenlabs\.io\//);
	});

	it("never treats a socket close as finished (the client closes)", () => {
		const e = createElevenLabsEngine();
		for (const code of [1000, 1001, 1006, 1011]) assert.equal(e.isFinishedClose(code), false, String(code));
	});
});
