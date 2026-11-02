import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, utimes, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SpeechAudioCache } from "../src/server/speech-cache.ts";

async function withCache<T>(maxBytes: number | undefined, run: (cache: SpeechAudioCache, dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "lh-speech-cache-"));
	try { return await run(new SpeechAudioCache(path.join(dir, "cache"), maxBytes), path.join(dir, "cache")); }
	finally { await rm(dir, { recursive: true, force: true }); }
}

test("a stored sentence is returned without synthesis, keyed by voice, revision and exact text", () => withCache(undefined, async cache => {
	const audio = Buffer.from("RIFFaudio");
	assert.equal(await cache.get("en_US-joe-medium", "rev1", "Hello."), null);
	await cache.put("en_US-joe-medium", "rev1", "Hello.", audio);
	assert.deepEqual(await cache.get("en_US-joe-medium", "rev1", "Hello."), audio);
	assert.equal(await cache.get("en_US-joe-medium", "rev1", "Hello!"), null, "different text is a different entry");
	assert.equal(await cache.get("en_US-amy-medium", "rev1", "Hello."), null, "different voice is a different entry");
	assert.equal(await cache.get("en_US-joe-medium", "rev2", "Hello."), null, "a new model revision never reuses old audio");
}));

test("least recently used entries are pruned to the size ceiling", () => withCache(25, async (cache, dir) => {
	await cache.put("v", "r", "first", Buffer.alloc(10, 1));
	await cache.put("v", "r", "second", Buffer.alloc(10, 2));
	const names = await readdir(dir);
	const old = names.find(name => name.endsWith(".wav"));
	await utimes(path.join(dir, old!), new Date(1000), new Date(1000));
	await cache.put("v", "r", "third", Buffer.alloc(10, 3));
	assert.equal(await cache.get("v", "r", "first"), null, "the oldest entry is evicted");
	assert.ok(await cache.get("v", "r", "third"));
}));

test("removing a voice clears only that voice's audio", () => withCache(undefined, async cache => {
	await cache.put("en_US-joe-medium", "r", "one", Buffer.from("a"));
	await cache.put("en_US-amy-medium", "r", "one", Buffer.from("b"));
	await cache.removeVoice("en_US-joe-medium");
	assert.equal(await cache.get("en_US-joe-medium", "r", "one"), null);
	assert.deepEqual(await cache.get("en_US-amy-medium", "r", "one"), Buffer.from("b"));
}));
