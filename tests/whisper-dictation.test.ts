import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanTranscript, isDictationEngine, pcmToWav, whisperLanguage } from "../src/server/whisper.ts";

test("pcmToWav writes a 16kHz mono linear16 header around the PCM", () => {
	const pcm = Buffer.alloc(3200, 1);
	const wav = pcmToWav(pcm);
	assert.equal(wav.length, 44 + pcm.length);
	assert.equal(wav.toString("ascii", 0, 4), "RIFF");
	assert.equal(wav.toString("ascii", 8, 12), "WAVE");
	assert.equal(wav.readUInt16LE(22), 1);
	assert.equal(wav.readUInt32LE(24), 16000);
	assert.equal(wav.readUInt16LE(34), 16);
	assert.equal(wav.readUInt32LE(40), pcm.length);
});

test("cleanTranscript drops whisper.cpp's non-speech markers and collapses whitespace", () => {
	assert.equal(cleanTranscript(" [BLANK_AUDIO]\n Hello,  world. (music)\n"), "Hello, world.");
	assert.equal(cleanTranscript("[BLANK_AUDIO]"), "");
});

test("the default English-only model always transcribes as English", () => {
	assert.equal(whisperLanguage("pl"), "en");
	assert.equal(whisperLanguage("multi"), "en");
	assert.equal(whisperLanguage(null), "en");
});

test("engine values are validated", () => {
	assert.ok(isDictationEngine("whisper"));
	assert.ok(isDictationEngine("deepgram"));
	assert.ok(!isDictationEngine("nope"));
	assert.ok(!isDictationEngine(undefined));
});
