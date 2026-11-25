import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ASSETS, MARKER, TOTAL_BYTES, cleanLeftovers, installVoice, isInstalled, removeVoice, voiceLayout, windowsTar, type Progress } from "../src/install.ts";
import { assetFor, fakeExtract, serve, temporaryDirectory } from "./helpers.ts";

const never = new AbortController().signal;

test("the pinned downloads add up to the advertised size", () => {
  assert.equal(TOTAL_BYTES, ASSETS.reduce((sum, asset) => sum + asset.size, 0));
  assert.ok(ASSETS.every(asset => asset.url.startsWith("https://")));
  assert.equal(Math.round(TOTAL_BYTES / 2 ** 20), 458);
});

test("a verified download is unpacked, marked and moved into place", async () => {
  using scratch = temporaryDirectory("lh-pron-install-");
  const model = Buffer.from("model bytes"), runtime = Buffer.from("runtime bytes, a little longer");
  const server = await serve({ "/model": model, "/runtime": runtime });
  try {
    const assets = [
      assetFor(`${server.url}/model`, model, { id: "model", step: "voice model", required: ["model.onnx"] }),
      assetFor(`${server.url}/runtime`, runtime, { id: "runtime", step: "GPU runtime", into: "runtime/node_modules/x", required: ["package.json"] }),
    ];
    const progress: Progress[] = [];
    const extract = fakeExtract();
    await installVoice({ dataDirectory: scratch.directory, signal: never, assets, extract, onProgress: value => progress.push(value) });
    assert.deepEqual(extract.calls, ["model", "runtime"]);
    assert.ok(isInstalled(scratch.directory));
    const layout = voiceLayout(scratch.directory);
    assert.deepEqual(JSON.parse(fs.readFileSync(layout.marker, "utf8")), MARKER);
    assert.equal(fs.readFileSync(path.join(layout.model, "model.onnx"), "utf8"), "model bytes");
    assert.ok(fs.existsSync(path.join(layout.runtime, "node_modules/x/package.json")));
    assert.deepEqual(fs.readdirSync(scratch.directory), ["voice"], "staging and archives are gone");
    assert.ok(progress.every((value, index) => index === 0 || value.received >= progress[index - 1]!.received));
    assert.deepEqual(progress.at(-1), { step: "GPU runtime", received: model.length + runtime.length, total: model.length + runtime.length });
    await assert.rejects(installVoice({ dataDirectory: scratch.directory, signal: never, assets, extract, onProgress() {} }), /already installed/);
  } finally { await server.close(); }
});

for (const [name, serveBytes, expected] of [
  ["integrity mismatch", Buffer.from("tampered!"), /integrity check/],
  ["oversized body", Buffer.from("much longer than expected"), /larger than expected/],
  ["truncated body", Buffer.from("short"), /incomplete/],
] as const) {
  test(`a download with a ${name} installs nothing`, async () => {
    using scratch = temporaryDirectory("lh-pron-reject-");
    const server = await serve({ "/model": serveBytes });
    try {
      const asset = assetFor(`${server.url}/model`, Buffer.from("expected!"), { required: ["model.onnx"] });
      const extract = fakeExtract();
      await assert.rejects(installVoice({ dataDirectory: scratch.directory, signal: never, assets: [asset], extract, onProgress() {} }), expected);
      assert.deepEqual(extract.calls, [], "unverified bytes are never unpacked");
      assert.deepEqual(fs.readdirSync(scratch.directory), []);
      assert.equal(isInstalled(scratch.directory), false);
    } finally { await server.close(); }
  });
}

test("HTTP errors, missing files and aborts leave nothing behind", async () => {
  using scratch = temporaryDirectory("lh-pron-fail-");
  const bytes = Buffer.from("model");
  const server = await serve({ "/model": bytes });
  try {
    const missing = assetFor(`${server.url}/missing`, bytes);
    await assert.rejects(installVoice({ dataDirectory: scratch.directory, signal: never, assets: [missing], extract: fakeExtract(), onProgress() {} }), /HTTP 404/);
    const incomplete = assetFor(`${server.url}/model`, bytes, { required: ["model.onnx"] });
    await assert.rejects(installVoice({ dataDirectory: scratch.directory, signal: never, assets: [incomplete], extract: fakeExtract({}), onProgress() {} }), /missing model\.onnx/);
    const controller = new AbortController();
    const second = assetFor(`${server.url}/model`, bytes, { id: "second" });
    const extract = fakeExtract();
    await assert.rejects(installVoice({
      dataDirectory: scratch.directory, signal: controller.signal, assets: [incomplete, second], onProgress() {},
      extract: async (...args) => { await extract(...args); controller.abort(); },
    }));
    assert.deepEqual(fs.readdirSync(scratch.directory), []);
    assert.equal(isInstalled(scratch.directory), false);
  } finally { await server.close(); }
});

test("removal deletes the install, and leftovers are cleaned on the next start", () => {
  using scratch = temporaryDirectory("lh-pron-remove-");
  assert.equal(removeVoice(scratch.directory), false, "nothing to remove");
  const layout = voiceLayout(scratch.directory);
  fs.mkdirSync(layout.model, { recursive: true });
  fs.writeFileSync(layout.marker, JSON.stringify(MARKER));
  fs.writeFileSync(path.join(layout.model, "model.onnx"), "x");
  assert.ok(isInstalled(scratch.directory));
  assert.equal(removeVoice(scratch.directory), false);
  assert.equal(isInstalled(scratch.directory), false);
  assert.deepEqual(fs.readdirSync(scratch.directory), []);
  for (const name of [".trash-a", ".download-b"]) fs.mkdirSync(path.join(scratch.directory, name, "deep"), { recursive: true });
  fs.writeFileSync(path.join(scratch.directory, "settings.json"), "{}");
  cleanLeftovers(scratch.directory);
  assert.deepEqual(fs.readdirSync(scratch.directory), ["settings.json"]);
  cleanLeftovers(path.join(scratch.directory, "absent"));
});

test("an older or damaged marker does not count as installed", () => {
  using scratch = temporaryDirectory("lh-pron-marker-");
  const layout = voiceLayout(scratch.directory);
  fs.mkdirSync(layout.root, { recursive: true });
  fs.writeFileSync(layout.marker, JSON.stringify({ ...MARKER, onnxruntime: "1.0.0" }));
  assert.equal(isInstalled(scratch.directory), false);
  fs.writeFileSync(layout.marker, "{");
  assert.equal(isInstalled(scratch.directory), false);
});

test("Windows tar unpacks only the listed members, stripping the top folder", { skip: process.platform !== "win32" }, async () => {
  using scratch = temporaryDirectory("lh-pron-tar-");
  const source = path.join(scratch.directory, "source");
  fs.mkdirSync(path.join(source, "package/dist"), { recursive: true });
  fs.writeFileSync(path.join(source, "package/package.json"), "{}");
  fs.writeFileSync(path.join(source, "package/dist/index.js"), "");
  fs.writeFileSync(path.join(source, "package/README.md"), "not wanted");
  const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  for (const archive of ["gzip", "bzip2"] as const) {
    const file = path.join(scratch.directory, `fixture.${archive}`);
    const made = spawnSync(tar, ["-c", archive === "gzip" ? "-z" : "-j", "-f", file, "-C", source, "package"], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    const destination = path.join(scratch.directory, `out-${archive}`);
    fs.mkdirSync(destination);
    await windowsTar({ ...assetFor("", Buffer.alloc(0)), archive, strip: 1, members: ["package/package.json", "package/dist"] }, file, destination, never);
    assert.deepEqual(fs.readdirSync(destination).sort(), ["dist", "package.json"]);
    assert.ok(fs.existsSync(path.join(destination, "dist/index.js")));
  }
  await assert.rejects(windowsTar(assetFor("", Buffer.alloc(0), { step: "broken thing" }), path.join(scratch.directory, "absent.tgz"), scratch.directory, never), /Could not unpack the broken thing/);
});
