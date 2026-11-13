import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { activate, type ListeningStatus } from "../src/backend.ts";
import type { SpeechCache } from "../src/speech/cache.ts";
import { createElevenLabsProvider } from "../src/speech/elevenlabs.ts";
import type { ModelInfo, TtsProvider } from "../src/speech/provider.ts";

const KEY = "sk_" + "a".repeat(40);
const flash: ModelInfo = { id: "eleven_flash_v2_5", label: "Flash v2.5", maxTextLength: 50, languages: ["en", "es", "zh"] };
const other: ModelInfo = { id: "other_model", label: "Other", maxTextLength: 10, languages: ["ja"] };

function memoryCache(): SpeechCache {
  const map = new Map<string, { audio: Uint8Array; mimeType: string }>();
  return { get: async k => map.get(k) ?? null, put: async (k, audio, mimeType) => { map.set(k, { audio, mimeType }); } };
}

async function harness(t: { after(fn: () => Promise<unknown>): unknown }, dataDirectory?: string) {
  const directory = dataDirectory ?? await fs.mkdtemp(path.join(os.tmpdir(), "lh-listening-backend-"));
  if (!dataDirectory) t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const handlers = new Map<string, (input: unknown) => unknown>();
  const events: [string, unknown][] = [];
  const syntheses: unknown[] = [];
  const base = createElevenLabsProvider({ fetch: async () => { throw new Error("no network in tests"); } });
  const models = [other, flash];
  const provider: TtsProvider = {
    ...base,
    listModels: async apiKey => { assert.equal(apiKey, KEY); return [...models]; },
    synthesize: async request => { syntheses.push(request); return { audio: new Uint8Array([0xff, 0xfb, 9]), mimeType: "audio/mpeg" }; },
  };
  const controller = new AbortController();
  const ctx = {
    dataDirectory: directory,
    signal: controller.signal,
    handle(name: string, handler: (input: unknown) => unknown) { handlers.set(name, handler); return () => { handlers.delete(name); }; },
    events: { emit(topic: string, data: unknown) { events.push([topic, data]); }, on() { return () => {}; } },
  } as unknown as PluginBackendContext;
  const cleanup = activate(ctx, { providers: [provider], cache: memoryCache() });
  const call = async <T = ListeningStatus>(name: string, input?: unknown) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`No handler ${name}`);
    return await handler(input) as T;
  };
  return { directory, call, events, syntheses, cleanup, handlers, models };
}

async function makeReady(h: Awaited<ReturnType<typeof harness>>) {
  await h.call("save-key", { apiKey: KEY });
  await h.call("list-models");
  return h.call("save-settings", { voiceId: "voice-1" });
}

test("Ready needs a key, a Voice ID and a loaded model; status never includes the key", async t => {
  const h = await harness(t);
  const initial = await h.call("get-status");
  assert.deepEqual(initial, { providers: [{ id: "elevenlabs", label: "ElevenLabs" }], provider: "elevenlabs", hasKey: false, voiceId: "", modelId: "eleven_flash_v2_5", ready: false });
  await assert.rejects(h.call("list-models"), /API key first/);
  assert.equal((await h.call("save-key", { apiKey: KEY })).ready, false, "a key alone is not Ready");
  const listed = await h.call<{ models: ModelInfo[]; status: ListeningStatus }>("list-models");
  assert.deepEqual(listed.models, [other, flash]);
  assert.deepEqual(listed.status.model, flash, "the preferred default is chosen and snapshotted");
  assert.equal(listed.status.ready, false, "no voice yet");
  const ready = await h.call("save-settings", { voiceId: "  voice-1  " });
  assert.equal(ready.ready, true);
  assert.equal(ready.voiceId, "voice-1");
  assert.ok(h.events.some(([topic, data]) => topic === "status-changed" && (data as ListeningStatus).ready));
  const switched = await h.call("save-settings", { modelId: other.id });
  assert.deepEqual(switched.model, other);
  await assert.rejects(h.call("save-settings", { modelId: "not-listed" }), /Reload the model list/);
  await assert.rejects(h.call("save-settings", { model: flash }), /Unknown setting/);
  await assert.rejects(h.call("save-settings", { provider: "nope" }), /Unknown speech provider/);
  assert.equal((await h.call("remove-key")).ready, false);
  await h.call("save-key", { apiKey: KEY });
  assert.equal((await h.call("save-settings", { voiceId: "" })).ready, false);
  h.cleanup();
  assert.equal(h.handlers.size, 0);
});

test("a saved model missing from the live list is kept, never replaced silently", async t => {
  const h = await harness(t);
  await makeReady(h);
  await h.call("save-settings", { modelId: other.id });
  h.models.splice(0, h.models.length, flash);
  const listed = await h.call<{ models: ModelInfo[]; status: ListeningStatus }>("list-models");
  assert.deepEqual(listed.models, [flash]);
  assert.equal(listed.status.modelId, other.id);
  assert.deepEqual(listed.status.model, other);
  assert.equal(listed.status.ready, true);
  h.cleanup();
});

test("unreadable saved files fall back to defaults with a notice instead of failing activation", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-listening-corrupt-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "settings.json"), "{ truncated");
  await fs.writeFile(path.join(directory, "credentials.json"), JSON.stringify({ version: 99, keys: {} }));
  const h = await harness(t, directory);
  const status = await h.call("get-status");
  assert.equal(status.ready, false);
  assert.match(status.notice!, /settings and API key file could not be read/);
  await h.call("save-settings", { voiceId: "v" });
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, "settings.json"), "utf8")).voiceId, "v", "the next save rewrites the file");
  h.cleanup();
});

test("the API key is stored owner-only, survives restart and is never returned", async t => {
  const h = await harness(t);
  await assert.rejects(h.call("save-key", { apiKey: "short" }), /does not look like/);
  await assert.rejects(h.call("save-key", {}), /Expected an API key/);
  const ready = await makeReady(h);
  assert.equal(JSON.stringify(ready).includes(KEY), false);
  const stat = await fs.stat(path.join(h.directory, "credentials.json"));
  assert.equal(stat.mode & 0o777, 0o600);
  for (const name of ["get-status", "list-models", "save-settings"]) {
    const value = await h.call<unknown>(name, name === "save-settings" ? {} : undefined);
    assert.equal(JSON.stringify(value).includes(KEY), false, name);
  }
  h.cleanup();
  const restarted = await harness(t, h.directory);
  const status = await restarted.call("get-status");
  assert.equal(status.ready, true);
  assert.deepEqual(status.model, flash);
  assert.deepEqual(restarted.syntheses, [], "Ready at startup without a network call");
  restarted.cleanup();
});

test("synthesize returns base64 audio, caches it and reports readable errors only", async t => {
  const h = await harness(t);
  await assert.rejects(h.call("synthesize", { text: "hi", language: "en" }), /not set up yet/);
  await makeReady(h);
  const first = await h.call<{ mimeType: string; audioBase64: string; cache: string }>("synthesize", { text: " hi\n", language: "en" });
  assert.deepEqual(first, { mimeType: "audio/mpeg", audioBase64: Buffer.from([0xff, 0xfb, 9]).toString("base64"), cache: "miss" });
  assert.equal((await h.call<{ cache: string }>("synthesize", { text: "hi", language: "en" })).cache, "hit");
  assert.equal(h.syntheses.length, 1);
  assert.deepEqual({ ...(h.syntheses[0] as object), apiKey: "redacted" }, { text: "hi", language: "en", voiceId: "voice-1", model: flash, apiKey: "redacted" });
  await assert.rejects(h.call("synthesize", { text: "hi" }), /invalid/);
  await assert.rejects(h.call("synthesize", { text: "a".repeat(51), language: "en" }), /longer than/);
  h.cleanup();
});
