import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { NOT_INSTALLED, activateWith, type BackendOptions } from "../src/backend.ts";
import { parseSettings, parseSpeakResult, parseState, type PluginState } from "../src/contract.ts";
import { MARKER, voiceLayout } from "../src/install.ts";
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

test("the voice choice is validated, saved atomically and survives restart", async () => {
  using scratch = temporaryDirectory("lh-pron-backend-");
  const first = host(scratch.directory, {});
  assert.equal((await first.state()).settings.voice, "zf_001");
  assert.equal(fs.existsSync(scratch.directory) && fs.readdirSync(scratch.directory).length, 0, "startup writes nothing");
  await assert.rejects(first.call("set-voice", { voice: "zf_999" }), /Unknown voice/);
  const changed = parseState(await first.call("set-voice", { voice: "zm_009" }));
  assert.deepEqual(changed.settings, { revision: 1, voice: "zm_009" });
  assert.equal(first.events.length, 1);
  await first.call("set-voice", { voice: "zm_009" });
  assert.equal(first.events.length, 1, "an unchanged value is not rewritten");
  assert.deepEqual(fs.readdirSync(scratch.directory), ["settings.json"]);
  assert.deepEqual(parseSettings(JSON.parse(fs.readFileSync(path.join(scratch.directory, "settings.json"), "utf8"))), { revision: 1, voice: "zm_009" });
  first.dispose();
  const second = host(scratch.directory, {});
  assert.equal((await second.state()).settings.voice, "zm_009");
  second.controller.abort();
  await assert.rejects(second.call("get-state"), /disabled/);
  second.dispose();
});

test("speech runs on DirectML with padded tokens and the voice's style row, and returns a WAV", async () => {
  using scratch = temporaryDirectory("lh-pron-backend-");
  writeInstall(scratch.directory);
  const runtime = fakeRuntime();
  const app = host(scratch.directory, { runtime: runtime.load });
  assert.equal((await app.state()).install.kind, "installed");
  const [first, second] = await Promise.all([app.call("speak", { text: "你好" }), app.call("speak", { text: "银行" })]);
  assert.equal(runtime.loads, 1, "concurrent first clicks share one model load");
  assert.deepEqual(runtime.created.map(entry => entry.options.executionProviders), [["dml"]], "no CPU provider is requested");
  assert.equal(path.basename(runtime.created[0]!.model), "model.onnx");
  assert.equal(runtime.runs.length, 3, "warm-up plus two phrases");
  const run = runtime.runs[1]!;
  assert.deepEqual([...run.tokens!.data as BigInt64Array], [0n, 46n, 2n, 47n, 3n, 0n]);
  assert.deepEqual(run.tokens!.dims, [1, 6]);
  // zf_001 is speaker 3; four content tokens select style row 4.
  assert.equal((run.style!.data as Float32Array)[0], 3004);
  assert.equal((run.style!.data as Float32Array).length, 256);
  assert.deepEqual([...run.speed!.data as Float32Array], [1]);
  for (const result of [first, second]) {
    const header = wavHeader(parseSpeakResult(result).wav);
    assert.deepEqual(header, { riff: "RIFF", rate: 24000, dataBytes: 8, first: 16384 });
  }
  await assert.rejects(app.call("speak", { text: "猫" }), /Nothing to pronounce/);
  await app.call("set-voice", { voice: "zm_010" });
  await assert.rejects(app.call("speak", { text: "你好" }), /Unknown voice/, "the fixture has only four speakers");
  app.dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.released, 1, "disabling unloads the model");
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
    assert.equal(runtime.released, 1, "the model is unloaded before its files are deleted");
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
