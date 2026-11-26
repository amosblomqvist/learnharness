import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { LINUX, WINDOWS, cleanLeftovers, installVoice, isInstalled, pendingBytes, removeVoice, retireOutdated, systemTar, totalBytes, unzip, voiceLayout, windowsTar, type Asset, type Extract, type InstallTarget, type Progress } from "../src/install.ts";
import { assetFor, fakeExtract, makeZip, serve, temporaryDirectory } from "./helpers.ts";

const never = new AbortController().signal;

const MARKER = WINDOWS.marker, RUNTIME_MARKER = WINDOWS.runtimeMarker;
const windows = (assets: readonly Asset[], extract: Extract): InstallTarget => ({ ...WINDOWS, assets, extract });

test("the pinned downloads add up to the advertised size", () => {
  for (const target of [WINDOWS, LINUX]) assert.ok(target.assets.every(asset => asset.url.startsWith("https://")));
  assert.equal(totalBytes(WINDOWS.assets), 244_802_924);
  assert.equal(totalBytes(LINUX.assets), 1_530_454_185);
});

test("Linux keeps the voice assets and runs on a CUDA runtime with its own marker", () => {
  const ids = (target: InstallTarget, part: Asset["part"]) => target.assets.filter(asset => asset.part === part).map(asset => asset.id);
  assert.deepEqual(ids(LINUX, "voice"), ids(WINDOWS, "voice"));
  assert.deepEqual(ids(LINUX, "runtime"), ["onnxruntime-node", "onnxruntime-common", "onnxruntime-gpu", "cuda-runtime", "cublas", "curand", "cudnn"]);
  assert.notDeepEqual(LINUX.runtimeMarker, WINDOWS.runtimeMarker, "a Windows runtime is never reused on Linux");
  assert.notDeepEqual(LINUX.marker, WINDOWS.marker);
  const node = LINUX.assets.find(asset => asset.id === "onnxruntime-node")!;
  assert.ok(node.members.every(member => !member.includes("win32")));
  for (const asset of LINUX.assets.filter(asset => asset.archive === "zip" && asset.id !== "onnxruntime-gpu")) {
    assert.ok(asset.required.some(file => file.endsWith("/licenses/License.txt")), `${asset.id} keeps its license`);
  }
});

test("a verified download is unpacked, marked and moved into place", async () => {
  using scratch = temporaryDirectory("lh-pron-install-");
  const model = Buffer.from("model bytes"), runtime = Buffer.from("runtime bytes, a little longer");
  const server = await serve({ "/model": model, "/runtime": runtime });
  try {
    const assets = [
      assetFor(`${server.url}/model`, model, { id: "model", step: "voice model", required: ["model.onnx"] }),
      assetFor(`${server.url}/runtime`, runtime, { id: "runtime", step: "GPU runtime", part: "runtime", into: "runtime/node_modules/x", required: ["package.json"] }),
    ];
    const progress: Progress[] = [];
    const extract = fakeExtract();
    await installVoice({ dataDirectory: scratch.directory, signal: never, target: windows(assets, extract), onProgress: value => progress.push(value) });
    assert.deepEqual(extract.calls, ["model", "runtime"]);
    assert.ok(isInstalled(scratch.directory, WINDOWS));
    const layout = voiceLayout(scratch.directory);
    assert.deepEqual(JSON.parse(fs.readFileSync(layout.marker, "utf8")), MARKER);
    assert.equal(fs.readFileSync(path.join(layout.model, "model.onnx"), "utf8"), "model bytes");
    assert.ok(fs.existsSync(path.join(layout.runtime, "node_modules/x/package.json")));
    assert.deepEqual(fs.readdirSync(scratch.directory), ["voice"], "staging and archives are gone");
    assert.ok(progress.every((value, index) => index === 0 || value.received >= progress[index - 1]!.received));
    assert.deepEqual(progress.at(-1), { step: "GPU runtime", received: model.length + runtime.length, total: model.length + runtime.length });
    await assert.rejects(installVoice({ dataDirectory: scratch.directory, signal: never, target: windows(assets, extract), onProgress() {} }), /already installed/);
  } finally { await server.close(); }
});

test("a retry keeps the compatible runtime and installs the verified raw vocoder", async () => {
  using scratch = temporaryDirectory("lh-pron-reuse-");
  const model = Buffer.from("acoustic model"), vocoder = Buffer.from("vocoder"), runtime = Buffer.from("runtime");
  const server = await serve({ "/model": model, "/vocoder": vocoder });
  try {
    const layout = voiceLayout(scratch.directory);
    fs.mkdirSync(layout.runtime, { recursive: true });
    fs.writeFileSync(layout.runtimeMarker, JSON.stringify(RUNTIME_MARKER));
    const runtimeFile = path.join(layout.runtime, "fixture.dll");
    fs.writeFileSync(runtimeFile, runtime);
    const assets = [
      assetFor(`${server.url}/model`, model, { id: "model", required: ["model-steps-3.onnx"] }),
      assetFor(`${server.url}/vocoder`, vocoder, { id: "vocoder", archive: "file", required: ["vocos-22khz-univ.onnx"] }),
      assetFor(`${server.url}/runtime`, runtime, { id: "runtime", part: "runtime", into: "runtime", required: ["fixture.dll"] }),
    ];
    const voiceBytes = model.length + vocoder.length;
    assert.equal(pendingBytes(scratch.directory, windows(assets, fakeExtract())), voiceBytes);
    const options = { dataDirectory: scratch.directory, signal: never, onProgress() {} };
    await assert.rejects(installVoice({ ...options, target: windows(assets, async () => {
      assert.deepEqual(fs.readFileSync(runtimeFile), runtime);
      throw new Error("interrupted");
    }) }), /interrupted/);
    assert.equal(isInstalled(scratch.directory, WINDOWS), false);
    assert.equal(pendingBytes(scratch.directory, windows(assets, fakeExtract())), voiceBytes);
    assert.deepEqual(fs.readdirSync(scratch.directory), ["voice"]);

    const extract = fakeExtract();
    const progress: Progress[] = [];
    await installVoice({ ...options, target: windows(assets, extract), onProgress: value => progress.push(value) });
    assert.deepEqual(server.requests, ["/model", "/model", "/vocoder"]);
    assert.deepEqual(extract.calls, ["model"]);
    assert.deepEqual(fs.readFileSync(path.join(layout.model, "vocos-22khz-univ.onnx")), vocoder);
    assert.deepEqual(fs.readFileSync(runtimeFile), runtime);
    assert.equal(isInstalled(scratch.directory, WINDOWS), true);
    assert.ok(progress.every(value => value.total === voiceBytes));
    assert.equal(progress.at(-1)!.received, voiceBytes);
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
      await assert.rejects(installVoice({ dataDirectory: scratch.directory, signal: never, target: windows([asset], extract), onProgress() {} }), expected);
      assert.deepEqual(extract.calls, [], "unverified bytes are never unpacked");
      assert.deepEqual(fs.readdirSync(scratch.directory), []);
      assert.equal(isInstalled(scratch.directory, WINDOWS), false);
    } finally { await server.close(); }
  });
}

test("HTTP errors, missing files and aborts leave nothing behind", async () => {
  using scratch = temporaryDirectory("lh-pron-fail-");
  const bytes = Buffer.from("model");
  const server = await serve({ "/model": bytes });
  try {
    const missing = assetFor(`${server.url}/missing`, bytes);
    await assert.rejects(installVoice({ dataDirectory: scratch.directory, signal: never, target: windows([missing], fakeExtract()), onProgress() {} }), /HTTP 404/);
    const incomplete = assetFor(`${server.url}/model`, bytes, { required: ["model.onnx"] });
    await assert.rejects(installVoice({ dataDirectory: scratch.directory, signal: never, target: windows([incomplete], fakeExtract({})), onProgress() {} }), /missing model\.onnx/);
    const controller = new AbortController();
    const second = assetFor(`${server.url}/model`, bytes, { id: "second" });
    const extract = fakeExtract();
    await assert.rejects(installVoice({
      dataDirectory: scratch.directory, signal: controller.signal, onProgress() {},
      target: windows([incomplete, second], async (...args) => { await extract(...args); controller.abort(); }),
    }));
    assert.deepEqual(fs.readdirSync(scratch.directory), []);
    assert.equal(isInstalled(scratch.directory, WINDOWS), false);
  } finally { await server.close(); }
});

test("removal deletes the install, and leftovers are cleaned on the next start", () => {
  using scratch = temporaryDirectory("lh-pron-remove-");
  assert.equal(removeVoice(scratch.directory), false, "nothing to remove");
  const layout = voiceLayout(scratch.directory);
  fs.mkdirSync(layout.model, { recursive: true });
  fs.writeFileSync(layout.marker, JSON.stringify(MARKER));
  fs.writeFileSync(path.join(layout.model, "model.onnx"), "x");
  assert.ok(isInstalled(scratch.directory, WINDOWS));
  assert.equal(removeVoice(scratch.directory), false);
  assert.equal(isInstalled(scratch.directory, WINDOWS), false);
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
  assert.equal(isInstalled(scratch.directory, WINDOWS), false);
  fs.writeFileSync(layout.marker, "{");
  assert.equal(isInstalled(scratch.directory, WINDOWS), false);
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

test("the system tar unpacks only the listed members, stripping the top folder", { skip: process.platform !== "linux" }, async () => {
  using scratch = temporaryDirectory("lh-pron-gnutar-");
  const source = path.join(scratch.directory, "source");
  fs.mkdirSync(path.join(source, "package/dist"), { recursive: true });
  fs.writeFileSync(path.join(source, "package/package.json"), "{}");
  fs.writeFileSync(path.join(source, "package/dist/index.js"), "");
  fs.writeFileSync(path.join(source, "package/README.md"), "not wanted");
  for (const archive of ["gzip", "bzip2"] as const) {
    const file = path.join(scratch.directory, `fixture.${archive}`);
    const made = spawnSync("tar", ["-c", archive === "gzip" ? "-z" : "-j", "-f", file, "-C", source, "package"], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    const destination = path.join(scratch.directory, `out-${archive}`);
    fs.mkdirSync(destination);
    await systemTar({ ...assetFor("", Buffer.alloc(0)), archive, strip: 1, members: ["package/package.json", "package/dist"] }, file, destination, never);
    assert.deepEqual(fs.readdirSync(destination).sort(), ["dist", "package.json"]);
    assert.ok(fs.existsSync(path.join(destination, "dist/index.js")));
  }
  await assert.rejects(systemTar(assetFor("", Buffer.alloc(0), { step: "broken thing" }), path.join(scratch.directory, "absent.tgz"), scratch.directory, never), /Could not unpack the broken thing/);
});

test("unzip unpacks only the listed members, stripping leading folders and checking each file", async () => {
  using scratch = temporaryDirectory("lh-pron-unzip-");
  const big = Buffer.alloc(200_000, "native code ");
  const file = path.join(scratch.directory, "fixture.zip");
  fs.writeFileSync(file, makeZip({
    "runtimes/linux-x64/native/libwanted.so": big,
    "runtimes/linux-x64/native/libstored.so": "stored bytes",
    "runtimes/linux-x64/native/libunwanted.so": "not wanted",
    "runtimes/linux-x64/native/sub/": "",
    "lib/inside/a.so": "a", "lib/inside/b.so": "b", "lib/insider.so": "prefix only",
  }, { stored: ["runtimes/linux-x64/native/libstored.so"] }));
  const out = (name: string) => { const directory = path.join(scratch.directory, name); fs.mkdirSync(directory); return directory; };
  const flat = out("flat");
  await unzip(assetFor("", Buffer.alloc(0), { archive: "zip", strip: 3, members: ["runtimes/linux-x64/native/libwanted.so", "runtimes/linux-x64/native/libstored.so"] }), file, flat, never);
  assert.deepEqual(fs.readdirSync(flat).sort(), ["libstored.so", "libwanted.so"]);
  assert.deepEqual(fs.readFileSync(path.join(flat, "libwanted.so")), big);
  assert.equal(fs.readFileSync(path.join(flat, "libstored.so"), "utf8"), "stored bytes");
  const kept = out("kept");
  await unzip(assetFor("", Buffer.alloc(0), { archive: "zip", members: ["lib/inside"] }), file, kept, never);
  assert.deepEqual(fs.readdirSync(path.join(kept, "lib")), ["inside"], "a directory member does not match by prefix alone");
  assert.deepEqual(fs.readdirSync(path.join(kept, "lib/inside")).sort(), ["a.so", "b.so"]);
});

test("unzip refuses entries that escape their folder, fail their checksum or are not a zip", async () => {
  using scratch = temporaryDirectory("lh-pron-unzip-bad-");
  const destination = path.join(scratch.directory, "out");
  fs.mkdirSync(destination);
  const attempt = (files: Record<string, string>, members: string[], options = {}, strip = 0) => {
    const file = path.join(scratch.directory, `${Math.random()}.zip`);
    fs.writeFileSync(file, makeZip(files, options));
    return unzip(assetFor("", Buffer.alloc(0), { step: "fixture", archive: "zip", strip, members }), file, destination, never);
  };
  await assert.rejects(attempt({ "../evil.so": "x" }, ["../evil.so"]), /Could not unpack the fixture: \.\.\/evil\.so would unpack outside/);
  await assert.rejects(attempt({ "/abs/evil.so": "x" }, ["/abs/evil.so"]), /outside/);
  await assert.rejects(attempt({ "a/../../evil.so": "x" }, ["a"]), /outside/);
  await assert.rejects(attempt({ "a/b.so": "x" }, ["a/b.so"], {}, 2), /outside/, "stripping every component leaves nothing");
  await assert.rejects(attempt({ "a.so": "payload" }, ["a.so"], { corrupt: "a.so" }), /a\.so failed its checksum/);
  assert.equal(fs.existsSync(path.join(scratch.directory, "evil.so")), false);
  const notZip = path.join(scratch.directory, "plain.zip");
  fs.writeFileSync(notZip, "just text");
  await assert.rejects(unzip(assetFor("", Buffer.alloc(0), { step: "fixture", archive: "zip" }), notZip, destination, never), /not a zip archive/);
});

test("Linux retires a Windows-format runtime instead of reusing it", () => {
  using scratch = temporaryDirectory("lh-pron-retire-linux-");
  const layout = voiceLayout(scratch.directory);
  fs.mkdirSync(layout.runtime, { recursive: true });
  fs.writeFileSync(layout.marker, JSON.stringify(WINDOWS.marker));
  fs.writeFileSync(layout.runtimeMarker, JSON.stringify(WINDOWS.runtimeMarker));
  assert.equal(retireOutdated(scratch.directory, LINUX), true);
  assert.equal(fs.existsSync(layout.root), false);
  assert.equal(pendingBytes(scratch.directory, LINUX), totalBytes(LINUX.assets));
});
