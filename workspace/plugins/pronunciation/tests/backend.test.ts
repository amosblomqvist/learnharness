import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { NOT_INSTALLED, activateWith, type BackendOptions } from "../src/backend.ts";
import { parseSpeakResult, parseState, type PluginState } from "../src/contract.ts";
import { VOCOS_STFT } from "../src/dsp.ts";
import { SAMPLE_RATE } from "../src/engine.ts";
import { ASSETS, MARKER, ONNXRUNTIME_VERSION, voiceLayout } from "../src/install.ts";
import { assetFor, fakeExtract, fakeRuntime, modelFiles, serve, temporaryDirectory } from "./helpers.ts";

function host(directory: string, options: BackendOptions) {
  const controller = new AbortController();
  const handlers = new Map<string, (input: unknown) => unknown>();
  const events: PluginState[] = [];
  const ctx = {
    dataDirectory: directory, signal: controller.signal,
    handle(name: string, handler: (input: unknown) => unknown) { handlers.set(name, handler); return () => { handlers.delete(name); }; },
    events: { emit(topic: string, data: unknown) { assert.equal(topic, "state-changed"); events.push(parseState(data)); } },
  } as unknown as PluginBackendContext;
  const dispose = activateWith(ctx, { platform: "win32", arch: "x64", ...options });
  const call = async (name: string, input?: unknown) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`No handler ${name}`);
    return handler(input);
  };
  return { controller, handlers, events, dispose, call, state: async () => parseState(await call("get-state")) };
}

function writeInstall(directory: string) {
  const layout = voiceLayout(directory);
  for (const [name, bytes] of Object.entries(modelFiles())) {
    fs.mkdirSync(path.dirname(path.join(layout.model, name)), { recursive: true });
    fs.writeFileSync(path.join(layout.model, name), bytes);
  }
  fs.writeFileSync(layout.marker, JSON.stringify(MARKER));
}

const wavHeader = (base64: string) => {
  const bytes = Buffer.from(base64, "base64");
  return { riff: bytes.toString("ascii", 0, 4), rate: bytes.readUInt32LE(24), dataBytes: bytes.readUInt32LE(40), first: bytes.readInt16LE(46) };
};

test("other platforms are unsupported and say why", async () => {
  using scratch = temporaryDirectory("lh-pron-backend-");
  const app = host(scratch.directory, { platform: "darwin", arch: "arm64" });
  const state = await app.state();
  assert.equal(state.install.kind, "unsupported");
  await assert.rejects(app.call("speak", { text: "你好" }), /needs Windows \(x64\)/);
  assert.deepEqual(await app.call("download"), state, "download does nothing");
  app.dispose();
});

test("speaking before the download points to settings; bad input is refused", async () => {
  using scratch = temporaryDirectory("lh-pron-backend-");
  const runtime = fakeRuntime();
  const app = host(scratch.directory, { runtime: runtime.load });
  assert.equal((await app.state()).install.kind, "missing");
  await assert.rejects(app.call("speak", { text: "你好" }), { message: NOT_INSTALLED });
  for (const input of [undefined, {}, { text: 3 }, { text: "hello" }, { text: "你好!" }, { text: "我".repeat(101) }]) {
    await assert.rejects(app.call("speak", input), /Invalid request|Only Chinese characters/);
  }
  assert.equal(runtime.loads, 0);
  app.dispose();
});

test("activation retires Kokoro and its settings while keeping its compatible runtime", async () => {
  using scratch = temporaryDirectory("lh-pron-backend-");
  const layout = voiceLayout(scratch.directory);
  const settings = path.join(scratch.directory, "settings.json");
  fs.mkdirSync(layout.model, { recursive: true });
  fs.writeFileSync(path.join(layout.model, "voices.bin"), "old");
  fs.writeFileSync(layout.marker, JSON.stringify({ format: 1, model: "kokoro-multi-lang-v1_1", onnxruntime: ONNXRUNTIME_VERSION }));
  fs.writeFileSync(settings, JSON.stringify({ revision: 1, voice: "zm_009" }));
  for (const asset of ASSETS.filter(asset => asset.part === "runtime")) for (const file of asset.required) {
    const target = path.join(layout.root, asset.into, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "kept");
  }

  const app = host(scratch.directory, {});
  const state = await app.state();
  assert.equal(state.install.kind, "missing");
  assert.equal(state.downloadBytes, ASSETS.filter(asset => asset.part === "voice").reduce((sum, asset) => sum + asset.size, 0));
  assert.equal(fs.existsSync(settings), false);
  assert.equal(fs.existsSync(layout.model), false);
  assert.equal(fs.existsSync(layout.marker), false);
  assert.deepEqual(fs.readdirSync(layout.root).sort(), ["runtime", "runtime.json"]);
  assert.equal(app.handlers.has("set-voice"), false);
  app.controller.abort();
  await assert.rejects(app.call("get-state"), /disabled/);
  app.dispose();
});

test("speech runs Matcha and Vocos on DirectML with interleaved blanks and returns 22.05 kHz WAVs", async () => {
  using scratch = temporaryDirectory("lh-pron-backend-");
  writeInstall(scratch.directory);
  const runtime = fakeRuntime();
  const app = host(scratch.directory, { runtime: runtime.load });
  assert.equal((await app.state()).install.kind, "installed");
  const [first, second] = await Promise.all([app.call("speak", { text: "你好" }), app.call("speak", { text: "银行" })]);
  assert.equal(runtime.loads, 1, "concurrent first clicks share one model load");
  assert.deepEqual(runtime.created.map(entry => entry.options.executionProviders), [["dml"], ["dml"]]);
  const acoustic = "model-steps-3.onnx", vocoder = "vocos-22khz-univ.onnx";
  assert.deepEqual(runtime.created.map(entry => path.basename(entry.model)), [acoustic, vocoder]);
  assert.deepEqual(runtime.runs.map(run => run.model), [acoustic, vocoder, acoustic, vocoder, acoustic, vocoder]);
  const { x, x_length, noise_scale, length_scale } = runtime.runs[2]!.feeds;
  assert.deepEqual([...x!.data], [1n, 14n, 1n, 15n, 1n]);
  assert.deepEqual(x!.dims, [1, 5]);
  assert.deepEqual([...x_length!.data], [5n]);
  assert.deepEqual([...noise_scale!.data], [1]);
  assert.deepEqual([...length_scale!.data], [1]);
  assert.deepEqual(runtime.runs[3]!.feeds.mels!.dims, [1, 80, 10]);
  assert.deepEqual([...runtime.runs[4]!.feeds.x!.data], [1n, 10n, 1n, 12n, 1n]);
  for (const result of [first, second]) {
    const { first: sample, ...header } = wavHeader(parseSpeakResult(result).wav);
    assert.deepEqual(header, { riff: "RIFF", rate: SAMPLE_RATE, dataBytes: 9 * VOCOS_STFT.hop * 2 });
    assert.ok(sample > 0);
  }
  await assert.rejects(app.call("speak", { text: "猫" }), /Nothing to pronounce/);
  app.dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.released, 2, "disabling unloads both sessions");
});

test("a DirectML failure is reported and retried on the next click", async () => {
  using scratch = temporaryDirectory("lh-pron-backend-");
  writeInstall(scratch.directory);
  const runtime = fakeRuntime({ failCreate: "No DirectX 12 adapter" });
  const app = host(scratch.directory, { runtime: runtime.load });
  await assert.rejects(app.call("speak", { text: "你好" }), /GPU \(DirectML\) unavailable: No DirectX 12 adapter/);
  await assert.rejects(app.call("speak", { text: "你好" }), /GPU \(DirectML\) unavailable/);
  assert.equal(runtime.loads, 2);
  app.dispose();
});

test("download publishes progress, installs, and removal returns to missing", async () => {
  using scratch = temporaryDirectory("lh-pron-backend-");
  const archive = Buffer.alloc(4096, 7);
  const server = await serve({ "/model": archive });
  try {
    const runtime = fakeRuntime();
    const asset = assetFor(`${server.url}/model`, archive, { step: "voice model", required: Object.keys(modelFiles()) });
    const app = host(scratch.directory, { runtime: runtime.load, install: { assets: [asset], extract: fakeExtract(modelFiles()) } });
    const started = parseState(await app.call("download"));
    assert.equal(started.install.kind, "downloading");
    assert.deepEqual(parseState(await app.call("download")).install.kind, "downloading", "a second press does not start another download");
    await assert.rejects(app.call("remove"), /Wait for the download/);
    for (let i = 0; i < 200 && (await app.state()).install.kind === "downloading"; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await app.state()).install.kind, "installed");
    assert.equal(app.events.at(-1)!.install.kind, "installed");
    assert.ok(app.events.every((event, index) => index === 0 || event.sequence > app.events[index - 1]!.sequence));
    assert.equal(server.requests.length, 1);
    await app.call("speak", { text: "你好" });
    const removed = parseState(await app.call("remove"));
    assert.equal(removed.install.kind, "missing");
    assert.equal(runtime.released, 2, "both sessions are unloaded before deleting their files");
    assert.equal(fs.existsSync(voiceLayout(scratch.directory).root), false);
    await assert.rejects(app.call("speak", { text: "你好" }), /Download the voice model first/);
    app.dispose();
  } finally { await server.close(); }
});

test("a failed download can be retried", async () => {
  using scratch = temporaryDirectory("lh-pron-backend-");
  const archive = Buffer.from("archive");
  const server = await serve({});
  try {
    const app = host(scratch.directory, { install: { assets: [assetFor(`${server.url}/gone`, archive)], extract: fakeExtract() } });
    await app.call("download");
    for (let i = 0; i < 200 && (await app.state()).install.kind === "downloading"; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const failed = (await app.state()).install;
    assert.equal(failed.kind, "failed");
    assert.match(failed.kind === "failed" ? failed.message : "", /HTTP 404/);
    assert.equal(parseState(await app.call("download")).install.kind, "downloading");
    app.controller.abort();
    app.dispose();
  } finally { await server.close(); }
});
