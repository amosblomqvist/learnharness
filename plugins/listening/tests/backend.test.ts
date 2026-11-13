import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginBackendContext, PluginInstructions, PluginQuestionTypeDefinition } from "learnharness-plugin-api";
import { activate, type ListeningStatus } from "../src/backend.ts";
import { definition, listeningInstructions, PROBE_TOOL, TEACH_TOOL } from "../src/contract.ts";
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
  const questions: PluginQuestionTypeDefinition[] = [];
  const instructions: PluginInstructions[] = [];
  const events: [string, unknown][] = [];
  const log: string[] = [];
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
    registerQuestionType(value: PluginQuestionTypeDefinition) { questions.push(value); log.push("question+"); return () => { log.push("question-"); }; },
    registerInstructions(value: PluginInstructions) { instructions.push(value); log.push("instructions+"); return () => { log.push("instructions-"); }; },
    events: { emit(topic: string, data: unknown) { events.push([topic, data]); }, on() { return () => {}; } },
  } as unknown as PluginBackendContext;
  const cleanup = activate(ctx, { providers: [provider], cache: memoryCache() });
  const call = async <T = ListeningStatus>(name: string, input?: unknown) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`No handler ${name}`);
    return await handler(input) as T;
  };
  return { directory, call, questions, instructions, events, log, syntheses, cleanup, handlers, models };
}

async function makeReady(h: Awaited<ReturnType<typeof harness>>) {
  await h.call("save-key", { apiKey: KEY });
  await h.call("list-models");
  return h.call("save-settings", { voiceId: "voice-1" });
}

test("the type registers at activation; poses are refused and instructions withheld until Ready", async t => {
  const h = await harness(t);
  assert.deepEqual(h.log, ["question+"], "registered at once so pending questions stay answerable");
  const { validateQuestion, validateAnswer, gradeAnswer, ...rest } = h.questions[0]!;
  assert.deepEqual(rest, definition);
  assert.equal(rest.probe?.toolName, PROBE_TOOL);
  assert.equal(rest.teach?.toolName, TEACH_TOOL);
  for (const hook of [validateQuestion, validateAnswer, gradeAnswer]) assert.equal(typeof hook, "function");
  const pose = () => validateQuestion!({ chatId: "c", variant: "probe", contractVersion: 1, input: { question: "?", payload: { audio: { text: "hola", language: "es" }, format: "recall", correctAnswer: "hi" } } } as never) ?? [];
  assert.match(pose()[0]!, /isn't set up/);
  const initial = await h.call("get-status");
  assert.deepEqual(initial, { providers: [{ id: "elevenlabs", label: "ElevenLabs" }], provider: "elevenlabs", hasKey: false, voiceId: "", modelId: "eleven_flash_v2_5", ready: false });
  await h.call("save-key", { apiKey: KEY });
  const listed = await h.call<{ models: ModelInfo[]; status: ListeningStatus }>("list-models");
  assert.deepEqual(listed.models, [other, flash]);
  assert.deepEqual(listed.status.model, flash, "the preferred default is chosen and snapshotted");
  assert.deepEqual(h.log, ["question+"], "no voice yet");
  assert.match(pose()[0]!, /isn't set up/);
  const ready = await h.call("save-settings", { voiceId: "  voice-1  " });
  assert.equal(ready.ready, true);
  assert.equal(ready.voiceId, "voice-1");
  assert.deepEqual(h.log, ["question+", "instructions+"]);
  assert.deepEqual(pose(), []);
  assert.deepEqual(h.instructions[0], { agents: ["prober", "teacher"], text: listeningInstructions(flash) });
  assert.ok(h.events.some(([topic]) => topic === "status-changed"));
  h.cleanup();
  assert.deepEqual(h.log, ["question+", "instructions+", "instructions-", "question-"]);
  assert.equal(h.handlers.size, 0);
});

test("readiness changes only swap instructions; a pending answer still validates and grades when not Ready", async t => {
  const h = await harness(t);
  await makeReady(h);
  await h.call("save-settings", { voiceId: "voice-2" });
  assert.deepEqual(h.log, ["question+", "instructions+"], "a voice change keeps the instructions");
  const switched = await h.call("save-settings", { modelId: other.id });
  assert.deepEqual(switched.model, other);
  assert.deepEqual(h.log, ["question+", "instructions+", "instructions-", "instructions+"]);
  assert.match(h.instructions[1]!.text, /ja/);
  await assert.rejects(h.call("save-settings", { modelId: "not-listed" }), /Reload the model list/);
  await assert.rejects(h.call("save-settings", { model: flash }), /Unknown setting/);
  await h.call("remove-key");
  assert.equal(h.log.at(-1), "instructions-");
  const { validateAnswer, gradeAnswer } = h.questions[0]!;
  const pending = { chatId: "c", questionId: "q", variant: "probe", contractVersion: 1, input: { question: "?", payload: { audio: { text: "hi", language: "en" }, format: "recall", correctAnswer: "a greeting" } }, answer: { status: "audio_unavailable" }, signal: new AbortController().signal } as never;
  assert.deepEqual(validateAnswer!(pending), []);
  assert.deepEqual(await gradeAnswer!(pending), { modality: "listening", outcome: "audio_unavailable", assessment: "unassessed" });
  await h.call("save-key", { apiKey: KEY });
  assert.equal(h.log.at(-1), "instructions+");
  await h.call("save-settings", { voiceId: "" });
  assert.equal(h.log.at(-1), "instructions-");
  assert.equal(h.log.filter(entry => entry === "question-").length, 0, "the type is never unregistered while active");
  h.cleanup();
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
  assert.deepEqual(restarted.log, ["question+", "instructions+"], "Ready at startup without a network call");
  restarted.cleanup();
});

test("validation enforces the model snapshot's languages and length, and option consistency", async t => {
  const h = await harness(t);
  await makeReady(h);
  const validate = h.questions[0]!.validateQuestion!;
  const run = (payload: unknown) => validate({ chatId: "c", variant: "probe", contractVersion: 1, input: { question: "What did you hear?", payload } } as never) ?? [];
  const choice = { audio: { text: "Quiero un café.", language: "es" }, format: "choice", options: [{ label: "Coffee", value: "coffee" }, { label: "Tea" }], explanation: "café = coffee", correctAnswer: "coffee" };
  assert.deepEqual(run(choice), []);
  assert.deepEqual(run({ ...choice, correctAnswer: "Tea" }), [], "label fallback");
  assert.equal(run({ ...choice, audio: { text: "Olá", language: "pt-BR" } }).length, 1);
  assert.match(run({ ...choice, audio: { text: "Olá", language: "pt-BR" } })[0]!, /not supported.*en, es, zh/);
  assert.deepEqual(run({ ...choice, audio: { text: "你好", language: "zh-CN" } }), [], "region falls back to the base code");
  assert.match(run({ ...choice, audio: { text: "a".repeat(51), language: "en" } })[0]!, /at most 50/);
  assert.match(run({ ...choice, correctAnswer: "juice" })[0]!, /does not match any option/);
  assert.match(run({ ...choice, options: [{ label: "A" }, { label: "B", value: "A" }], correctAnswer: "A" })[0]!, /same value/);
  assert.match(run({ ...choice, options: undefined })[0]!, /need options/);
  const recall = { audio: { text: "Hello there", language: "en" }, format: "recall", correctAnswer: "A greeting" };
  assert.deepEqual(run(recall), []);
  assert.match(run({ ...recall, options: choice.options })[0]!, /no options/);
  assert.match(run({ ...recall, explanation: "x" })[0]!, /no explanation/);
  h.cleanup();
});

test("answers are checked against the format, and grading reports observations", async t => {
  const h = await harness(t);
  await makeReady(h);
  const { validateAnswer, gradeAnswer } = h.questions[0]!;
  const choicePayload = { audio: { text: "Quiero un café.", language: "es" }, format: "choice", options: [{ label: "Coffee", value: "coffee" }, { label: "Tea" }], correctAnswer: "coffee" };
  const recallPayload = { audio: { text: "Hello", language: "en" }, format: "recall", correctAnswer: "A greeting" };
  const context = (payload: unknown, answer: unknown) => ({ chatId: "c", questionId: "q", variant: "teach", contractVersion: 1, input: { question: "?", type: "check", nodeId: "n", payload }, answer, signal: new AbortController().signal }) as never;
  assert.deepEqual(validateAnswer!(context(choicePayload, { status: "answered", choice: "Tea", playbackRates: [1] })), []);
  assert.match(validateAnswer!(context(choicePayload, { status: "answered", choice: "juice", playbackRates: [1] }))![0]!, /not part/);
  assert.match(validateAnswer!(context(choicePayload, { status: "answered", text: "x", playbackRates: [1] }))![0]!, /Choose/);
  assert.match(validateAnswer!(context(recallPayload, { status: "answered", choice: "x", playbackRates: [1] }))![0]!, /Write/);
  assert.deepEqual(validateAnswer!(context(recallPayload, { status: "audio_unavailable" })), []);
  assert.deepEqual(await gradeAnswer!(context(choicePayload, { status: "answered", choice: "coffee", playbackRates: [0.75, 1] })), { modality: "listening", format: "choice", correct: true, playbackRates: [0.75, 1], slowPlaybackUsed: true });
  assert.deepEqual(await gradeAnswer!(context(choicePayload, { status: "answered", choice: "Tea", playbackRates: [1] })), { modality: "listening", format: "choice", correct: false, playbackRates: [1], slowPlaybackUsed: false });
  assert.deepEqual(await gradeAnswer!(context(recallPayload, { status: "answered", text: "hi", playbackRates: [1] })), { modality: "listening", format: "recall", playbackRates: [1], slowPlaybackUsed: false });
  assert.deepEqual(await gradeAnswer!(context(recallPayload, { status: "audio_unavailable" })), { modality: "listening", outcome: "audio_unavailable", assessment: "unassessed" });
  h.cleanup();
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
