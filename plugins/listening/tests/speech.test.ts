import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createSpeechCache, type SpeechCache } from "../src/speech/cache.ts";
import { createElevenLabsProvider } from "../src/speech/elevenlabs.ts";
import { generationTimeoutMs, maxAudioBytes } from "../src/speech/limits.ts";
import { chooseModel, type ModelInfo, type SpeechAudio, type TtsProvider } from "../src/speech/provider.ts";
import { createSpeechService, parseSpeechRequest, speechCacheKey, type SpeechSelection } from "../src/speech/service.ts";

const key = (text: string) => createHash("sha256").update(text).digest("hex");
async function directory(t: { after(fn: () => Promise<unknown>): unknown }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-listening-speech-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const model: ModelInfo = { id: "eleven_flash_v2_5", label: "Flash v2.5", maxTextLength: 40, languages: ["en", "zh"] };
const audio: SpeechAudio = { audio: new Uint8Array([0xff, 0xfb, 1, 2]), mimeType: "audio/mpeg" };
function memoryCache(): SpeechCache {
  const map = new Map<string, SpeechAudio>();
  return { get: async k => map.get(k) ?? null, put: async (k, bytes, mimeType) => { map.set(k, { audio: bytes, mimeType }); } };
}
function fakeProvider(synthesize: TtsProvider["synthesize"]): TtsProvider {
  return { ...createElevenLabsProvider({ fetch: async () => { throw new Error("no network"); } }), synthesize };
}
function selection(provider: TtsProvider, overrides: Partial<SpeechSelection> = {}): () => SpeechSelection {
  return () => ({ provider, voiceId: "voice", modelId: model.id, model, ...overrides });
}

// ── cache ────────────────────────────────────────────────────────────────────

test("cache survives restart, verifies checksum and rejects unsafe keys", async t => {
  const dir = await directory(t), cache = createSpeechCache({ directory: dir });
  await cache.put(key("tea"), new Uint8Array([1, 2, 3]), "audio/mpeg");
  const restarted = createSpeechCache({ directory: dir });
  assert.deepEqual([...(await restarted.get(key("tea")))!.audio], [1, 2, 3]);
  await fs.writeFile(path.join(dir, `${key("tea")}.mp3`), new Uint8Array([3, 2, 1]));
  assert.equal(await restarted.get(key("tea")), null);
  await assert.rejects(cache.get("../../other"));
});

test("LRU accounts for metadata, touches entries and evicts the oldest", async t => {
  const dir = await directory(t), cache = createSpeechCache({ directory: dir, maxBytes: 1300 });
  const bytes = new Uint8Array(400);
  await cache.put(key("a"), bytes, "audio/mpeg"); await cache.put(key("b"), bytes, "audio/mpeg");
  assert.ok(await cache.get(key("a")));
  await cache.put(key("c"), bytes, "audio/mpeg");
  assert.equal(await cache.get(key("b")), null); assert.ok(await cache.get(key("a"))); assert.ok(await cache.get(key("c")));
  const size = (await Promise.all((await fs.readdir(dir)).map(async n => (await fs.stat(path.join(dir, n))).size))).reduce((a, b) => a + b, 0);
  assert.ok(size <= 1300);
});

test("startup cleans interrupted commits; simultaneous writes serialize", async t => {
  const dir = await directory(t);
  await fs.writeFile(path.join(dir, `${key("orphan")}.mp3`), "orphan");
  await fs.writeFile(path.join(dir, `${key("temp")}.json.1234.tmp`), "partial");
  const cache = createSpeechCache({ directory: dir });
  await Promise.all([1, 2, 3].map(n => cache.put(key("same"), new Uint8Array([n]), "audio/mpeg")));
  assert.deepEqual([...(await cache.get(key("same")))!.audio], [3]);
  assert.deepEqual((await fs.readdir(dir)).sort(), [`${key("same")}.json`, `${key("same")}.mp3`].sort());
});

test("valid JSON with invalid metadata is cleaned as a miss", async t => {
  const dir = await directory(t), identity = key("bad metadata");
  await fs.writeFile(path.join(dir, `${identity}.json`), "null");
  await fs.writeFile(path.join(dir, `${identity}.mp3`), "bad");
  assert.equal(await createSpeechCache({ directory: dir }).get(identity), null);
  assert.deepEqual(await fs.readdir(dir), []);
});

// ── limits and request parsing ───────────────────────────────────────────────

test("audio and timeout limits scale with text length", () => {
  assert.equal(maxAudioBytes("a"), 3 * 1024 * 1024);
  assert.equal(maxAudioBytes("a".repeat(40_000)), 42 * 1024 * 1024);
  assert.equal(generationTimeoutMs("a"), 50_000);
  assert.equal(generationTimeoutMs("a".repeat(40_000)), 830_000);
  assert.equal(maxAudioBytes("𠮷".repeat(1000)), maxAudioBytes("a".repeat(1000)), "counts code points, not UTF-16 units");
});

test("request keeps script and punctuation, normalizes layout whitespace and requires a language", () => {
  assert.deepEqual(parseSpeechRequest({ text: "  你好，\n 世界！ ", language: "zh" }), { text: "你好， 世界！", language: "zh" });
  assert.deepEqual(parseSpeechRequest({ text: "Olá", language: "pt-BR" }), { text: "Olá", language: "pt" }, "providers and the cache get the base code");
  assert.deepEqual(parseSpeechRequest({ text: "Hola", language: "ES" }), { text: "Hola", language: "es" });
  for (const input of [null, [], {}, { text: "x" }, { text: "x", language: "" }, { text: "x", language: "en us" }, { text: " \n", language: "en" }, { text: "\u0000", language: "en" }]) {
    assert.throws(() => parseSpeechRequest(input), /invalid|empty|control/);
  }
});

test("cache key separates provider, model, voice, language and text", () => {
  const base = { provider: "elevenlabs", modelId: "m", voiceId: "v", language: "zh", text: "茶" };
  const keys = new Set([base, { ...base, provider: "other" }, { ...base, modelId: "n" }, { ...base, voiceId: "w" }, { ...base, language: "ja" }, { ...base, text: "茶。" }].map(speechCacheKey));
  assert.equal(keys.size, 6);
});

// ── service ──────────────────────────────────────────────────────────────────

test("identical concurrent requests generate once and cached audio works without a key", async () => {
  let calls = 0, apiKey: string | undefined = "secret";
  const provider = fakeProvider(async () => { calls++; await new Promise(r => setTimeout(r, 5)); return audio; });
  const service = createSpeechService({ cache: memoryCache(), selection: selection(provider), key: () => apiKey });
  await Promise.all([service({ text: "hello", language: "en" }), service({ text: "hello", language: "en" })]);
  assert.equal(calls, 1);
  apiKey = undefined;
  assert.equal((await service({ text: "hello", language: "en" })).cache, "hit");
  assert.equal(calls, 1);
  await assert.rejects(service({ text: "goodbye", language: "en" }), { code: "key_missing" });
});

test("not ready without a voice or a matching model snapshot; text limit follows the model", async () => {
  const provider = fakeProvider(async () => audio);
  const run = (overrides: Partial<SpeechSelection>, text = "hello") => createSpeechService({ cache: memoryCache(), selection: selection(provider, overrides), key: () => "k" })({ text, language: "en" });
  await assert.rejects(run({ voiceId: " " }), { code: "not_ready" });
  await assert.rejects(run({ model: undefined }), { code: "not_ready" });
  await assert.rejects(run({ modelId: "another" }), { code: "not_ready" });
  await assert.rejects(run({}, "a".repeat(41)), { code: "text_too_long" });
  assert.equal((await run({}, "a".repeat(40))).cache, "miss");
});

test("failure is not cached; disk failure does not discard generated audio", async () => {
  let calls = 0;
  const provider = fakeProvider(async () => { if (++calls === 1) throw new Error("fail"); return audio; });
  const service = createSpeechService({ cache: memoryCache(), selection: selection(provider), key: () => "k" });
  await assert.rejects(service({ text: "tea", language: "en" }));
  assert.equal((await service({ text: "tea", language: "en" })).cache, "miss");
  assert.equal(calls, 2);
  const noDisk = createSpeechService({ cache: { get: async () => { throw Error("disk"); }, put: async () => { throw Error("disk"); } }, selection: selection(fakeProvider(async () => audio)), key: () => "k" });
  assert.ok((await noDisk({ text: "tea", language: "en" })).warning);
});

test("distinct generation is bounded while same-text callers can join", async () => {
  let done!: (value: SpeechAudio) => void;
  const provider = fakeProvider(() => new Promise(r => { done = r; }));
  const service = createSpeechService({ cache: memoryCache(), selection: selection(provider), key: () => "k", maxConcurrent: 1 });
  const first = service({ text: "tea", language: "en" }); await new Promise(r => setTimeout(r, 0));
  const joined = service({ text: "tea", language: "en" });
  await assert.rejects(service({ text: "rice", language: "en" }), { code: "busy" });
  done(audio); await Promise.all([first, joined]);
});

// ── ElevenLabs ───────────────────────────────────────────────────────────────

test("ElevenLabs sends the key only to the fixed endpoint with language_code, returns bytes and maps errors", async () => {
  let seenUrl = "", seen: RequestInit | undefined;
  const provider = createElevenLabsProvider({ fetch: async (url, init) => { seenUrl = String(url); seen = init; return new Response(new Uint8Array(audio.audio), { headers: { "content-type": "audio/mpeg" } }); } });
  const result = await provider.synthesize({ text: "茶", language: "zh", voiceId: "test voice", model, apiKey: "secret" });
  assert.deepEqual([...result.audio], [...audio.audio]);
  assert.equal(seenUrl, "https://api.elevenlabs.io/v1/text-to-speech/test%20voice?output_format=mp3_44100_128");
  assert.equal((seen!.headers as Record<string, string>)["xi-api-key"], "secret");
  assert.equal(seen!.redirect, "error");
  assert.deepEqual(JSON.parse(seen!.body as string), { text: "茶", model_id: model.id, language_code: "zh" });
  await provider.synthesize({ text: "茶", language: "zh", voiceId: "v", model: { ...model, id: "eleven_multilingual_v2" }, apiKey: "k" });
  assert.equal("language_code" in JSON.parse(seen!.body as string), false, "multilingual v2 does not take language_code");
  for (const [status, code] of [[401, "auth_failed"], [403, "auth_failed"], [402, "payment_required"], [404, "voice_unavailable"], [429, "rate_limited"], [500, "provider_failed"]] as const) {
    const failing = createElevenLabsProvider({ fetch: async () => new Response("PRIVATE PROVIDER DETAILS", { status }) });
    await assert.rejects(failing.synthesize({ text: "x", language: "en", voiceId: "v", model, apiKey: "k" }), (error: Error & { code?: string }) => error.code === code && !error.message.includes("PRIVATE"));
  }
});

test("ElevenLabs rejects non-audio, oversized and unreachable responses, and times out", async () => {
  const request = { text: "x", language: "en", voiceId: "v", model, apiKey: "k" };
  const json = createElevenLabsProvider({ fetch: async () => new Response("{}", { headers: { "content-type": "application/json" } }) });
  await assert.rejects(json.synthesize(request), { code: "invalid_audio" });
  const mislabeled = createElevenLabsProvider({ fetch: async () => new Response("{\"error\":1}", { headers: { "content-type": "audio/mpeg" } }) });
  await assert.rejects(mislabeled.synthesize(request), { code: "invalid_audio" });
  const huge = createElevenLabsProvider({ fetch: async () => new Response(new Uint8Array(4), { headers: { "content-type": "audio/mpeg", "content-length": String(maxAudioBytes("x") + 1) } }) });
  await assert.rejects(huge.synthesize(request), { code: "invalid_audio" });
  const offline = createElevenLabsProvider({ fetch: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(offline.synthesize(request), { code: "provider_failed" });
  const slow = createElevenLabsProvider({ timeoutMs: () => 5, fetch: () => new Promise(() => {}) });
  await assert.rejects(slow.synthesize(request), { code: "timeout" });
});

test("ElevenLabs model list keeps usable text-to-speech models with limits and base languages", async () => {
  let seenUrl = "", seen: RequestInit | undefined;
  const provider = createElevenLabsProvider({ fetch: async (url, init) => { seenUrl = String(url); seen = init; return Response.json([
    { model_id: "eleven_flash_v2_5", name: "Eleven Flash v2.5", can_do_text_to_speech: true, requires_alpha_access: false, maximum_text_length_per_request: 40000, languages: [{ language_id: "en", name: "English" }, { language_id: "zh", name: "Chinese" }, { language_id: "pt-BR", name: "Portuguese" }, { language_id: "en", name: "dup" }] },
    { model_id: "alpha", name: "Alpha", can_do_text_to_speech: true, requires_alpha_access: true, maximum_text_length_per_request: 100, languages: [] },
    { model_id: "sts", name: "Speech to speech", can_do_text_to_speech: false, maximum_text_length_per_request: 100, languages: [] },
    { model_id: "broken", name: "Broken", can_do_text_to_speech: true, languages: [] },
  ]); } });
  assert.deepEqual(await provider.listModels("secret"), [{ id: "eleven_flash_v2_5", label: "Eleven Flash v2.5", maxTextLength: 40000, languages: ["en", "pt", "zh"] }]);
  assert.equal(seenUrl, "https://api.elevenlabs.io/v1/models");
  assert.equal((seen!.headers as Record<string, string>)["xi-api-key"], "secret");
  const denied = createElevenLabsProvider({ fetch: async () => new Response("no", { status: 401 }) });
  await assert.rejects(denied.listModels("k"), { code: "auth_failed", message: "ElevenLabs rejected the API key. Check the key in Listening settings." });
});

test("ElevenLabs names the key permission a restricted key is missing, without showing its reply", async () => {
  const missing = (permission: string) => createElevenLabsProvider({ fetch: async () => Response.json(
    { detail: { status: "missing_permissions", message: `PRIVATE: the API key you used is missing the permission ${permission} to execute this operation.` } }, { status: 401 }) });
  await assert.rejects(missing("models_read").listModels("k"), (error: Error & { code?: string }) =>
    error.code === "auth_failed" && error.message.includes('"Models: Read"') && !error.message.includes("PRIVATE"));
  await assert.rejects(missing("text_to_speech").synthesize({ text: "x", language: "en", voiceId: "v", model, apiKey: "k" }), (error: Error & { code?: string }) =>
    error.code === "auth_failed" && error.message.includes('"Text to Speech"') && !error.message.includes("PRIVATE"));
  const invalid = createElevenLabsProvider({ fetch: async () => Response.json({ detail: { status: "invalid_api_key", message: "PRIVATE" } }, { status: 401 }) });
  await assert.rejects(invalid.listModels("k"), { code: "auth_failed", message: "ElevenLabs rejected the API key. Check the key in Listening settings." });
});

test("readiness, key shape and default model choice", () => {
  const provider = createElevenLabsProvider();
  assert.equal(provider.isReady({ voiceId: "v", modelId: model.id, model }, true), true);
  assert.equal(provider.isReady({ voiceId: "v", modelId: model.id, model }, false), false);
  assert.equal(provider.isReady({ voiceId: " ", modelId: model.id, model }, true), false);
  assert.equal(provider.isReady({ voiceId: "v", modelId: model.id }, true), false);
  assert.equal(provider.isReady({ voiceId: "v", modelId: "other", model }, true), false);
  assert.equal(provider.validateKeyShape("sk_" + "a".repeat(40)), undefined);
  for (const bad of ["", "short", "has space in it but long enough", "a".repeat(201), "ключ".repeat(10)]) assert.ok(provider.validateKeyShape(bad), bad);
  const other: ModelInfo = { ...model, id: "other" };
  assert.equal(chooseModel([other, model], "other", model.id), other, "keeps the saved model");
  assert.equal(chooseModel([other, model], "gone", model.id), model, "falls back to the preferred default");
  assert.equal(chooseModel([other], "gone", model.id), other, "otherwise the first");
  assert.equal(chooseModel([], "gone", model.id), undefined);
});
