/** Download, verify and unpack the voice model, its vocoder and the DirectML runtime. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface Asset {
  id: string;
  /** Shown in progress text: "Downloading <step>…". */
  step: string;
  /** Runtime assets are kept and reused when only the voice changes. */
  part: "voice" | "runtime";
  url: string;
  size: number;
  digest: { algorithm: "sha256" | "sha512"; encoding: "hex" | "base64"; value: string };
  /** "file": the download itself is stored as `required[0]`, without unpacking. */
  archive: "bzip2" | "gzip" | "file";
  /** Directory inside the install root to unpack into. */
  into: string;
  strip: number;
  /** Archive members to unpack (a directory member includes its contents). */
  members: string[];
  /** Files (relative to `into`) that must exist after unpacking. */
  required: string[];
}

const MODEL = "matcha-icefall-zh-baker";
const VOCODER = "vocos-22khz-univ";
export const ONNXRUNTIME_VERSION = "1.31.1";
const MODEL_FILES = ["model-steps-3.onnx", "tokens.txt", "lexicon.txt", "dict/jieba.dict.utf8", "dict/user.dict.utf8", "README.md"];
export const VOCODER_FILE = `${VOCODER}.onnx`;

export const ASSETS: readonly Asset[] = [
  {
    id: "model", step: "voice model", part: "voice",
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${MODEL}.tar.bz2`,
    size: 75_455_267,
    digest: { algorithm: "sha256", encoding: "hex", value: "ae70096b19c6e283ea351a26b8a718ce6427c8bde8c1da22eb46a5478d39a69b" },
    archive: "bzip2", into: "model", strip: 1,
    members: MODEL_FILES.map(name => `${MODEL}/${name}`),
    required: MODEL_FILES,
  },
  {
    id: "vocoder", step: "vocoder", part: "voice",
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/${VOCODER_FILE}`,
    size: 53_884_024,
    digest: { algorithm: "sha256", encoding: "hex", value: "0574a135aa1db2de6e181050db2ec528496cacd4a4701fc5d7faf9f9804c0081" },
    archive: "file", into: "model", strip: 0, members: [], required: [VOCODER_FILE],
  },
  {
    id: "onnxruntime-node", step: "GPU runtime", part: "runtime",
    url: `https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-${ONNXRUNTIME_VERSION}.tgz`,
    size: 115_391_311,
    digest: { algorithm: "sha512", encoding: "base64", value: "ijnSghbDHVWaQ2nDPmVccPlCHI8kH1Mx1aJ4a/qzRP16bBcVs4E3EqZQKZCkhWnbqN1tuQWxagimFtDpbPYYQw==" },
    archive: "gzip", into: "runtime/node_modules/onnxruntime-node", strip: 1,
    members: ["package/package.json", "package/dist", "package/bin/napi-v6/win32/x64"],
    required: ["package.json", "dist/index.js", ...["onnxruntime_binding.node", "onnxruntime.dll", "DirectML.dll"].map(name => `bin/napi-v6/win32/x64/${name}`)],
  },
  {
    id: "onnxruntime-common", step: "GPU runtime support files", part: "runtime",
    url: `https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-${ONNXRUNTIME_VERSION}.tgz`,
    size: 72_322,
    digest: { algorithm: "sha512", encoding: "base64", value: "F+nnYNiQtmNJ95V6R/isBJqiVpdANCrsMEg1OaF+Bkbl3GAtzWLR7Ng17Ld0QtYtYJyotOHPJzOQn1Y6PLZjpg==" },
    archive: "gzip", into: "runtime/node_modules/onnxruntime-common", strip: 1,
    members: ["package"], required: ["package.json"],
  },
];

export const TOTAL_BYTES = ASSETS.reduce((sum, asset) => sum + asset.size, 0);

/** Written last; its presence (with these values) means the install is complete. */
export const MARKER = { format: 2, model: MODEL, vocoder: VOCODER, onnxruntime: ONNXRUNTIME_VERSION } as const;
/** Records which runtime `runtime/` holds, so a new voice can keep it. */
export const RUNTIME_MARKER = { onnxruntime: ONNXRUNTIME_VERSION } as const;

export function voiceLayout(dataDirectory: string) {
  const root = path.join(dataDirectory, "voice");
  return {
    root,
    marker: path.join(root, "installed.json"),
    runtimeMarker: path.join(root, "runtime.json"),
    model: path.join(root, "model"),
    runtime: path.join(root, "runtime"),
  };
}

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}
const same = (value: unknown, expected: object) => value !== undefined && JSON.stringify(value) === JSON.stringify(expected);
const isFile = (file: string) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;

export function isInstalled(dataDirectory: string, marker: object = MARKER): boolean {
  return same(readJson(voiceLayout(dataDirectory).marker), marker);
}

/** Whether `runtime/` holds a complete runtime of the pinned version that a new install can keep. */
export function hasReusableRuntime(dataDirectory: string, assets: readonly Asset[] = ASSETS): boolean {
  const layout = voiceLayout(dataDirectory);
  const runtime = assets.filter(asset => asset.part === "runtime");
  return runtime.length > 0 && same(readJson(layout.runtimeMarker), RUNTIME_MARKER)
    && runtime.every(asset => asset.required.every(file => isFile(path.join(layout.root, asset.into, file))));
}

/** Bytes the next download fetches: everything, or only the voice when the runtime is kept. */
export function pendingBytes(dataDirectory: string, assets: readonly Asset[] = ASSETS): number {
  const reuse = hasReusableRuntime(dataDirectory, assets);
  return assets.reduce((sum, asset) => sum + (reuse && asset.part === "runtime" ? 0 : asset.size), 0);
}

/**
 * An install made for another voice or runtime (such as the earlier Kokoro
 * voice) is retired at startup: its marker goes first, then everything except
 * a runtime of the pinned version, which the next download keeps. This runs
 * before any model is loaded, so no runtime DLL is locked by this process.
 * Returns true when an outdated install was found.
 */
export function retireOutdated(dataDirectory: string, marker: object = MARKER): boolean {
  const layout = voiceLayout(dataDirectory);
  const found = readJson(layout.marker);
  if (found === undefined || same(found, marker)) return false;
  // Record the kept runtime before dropping the old marker, so stopping in
  // between leaves the old marker for the next start to retire again.
  const runtime = found && typeof found === "object" ? (found as Record<string, unknown>).onnxruntime : undefined;
  if (runtime === ONNXRUNTIME_VERSION) fs.writeFileSync(layout.runtimeMarker, JSON.stringify(RUNTIME_MARKER) + "\n");
  fs.rmSync(layout.marker, { force: true });
  if (!hasReusableRuntime(dataDirectory)) { removeVoice(dataDirectory); return true; }
  for (const name of fs.readdirSync(layout.root)) {
    if (name !== "runtime" && name !== "runtime.json") deleteTree(path.join(layout.root, name));
  }
  return true;
}

export interface Progress { step: string; received: number; total: number }
export type Extract = (asset: Asset, archive: string, destination: string, signal: AbortSignal) => Promise<void>;
export interface InstallOptions {
  dataDirectory: string;
  signal: AbortSignal;
  onProgress(progress: Progress): void;
  assets?: readonly Asset[];
  marker?: object;
  fetch?: typeof globalThis.fetch;
  extract?: Extract;
}

async function download(asset: Asset, file: string, options: Required<Pick<InstallOptions, "signal" | "fetch">>, report: (received: number) => void): Promise<void> {
  const response = await options.fetch(asset.url, { signal: options.signal, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Could not download the ${asset.step} (HTTP ${response.status}).`);
  const hash = createHash(asset.digest.algorithm);
  let received = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      if (received > asset.size) { done(new Error(`The ${asset.step} download is larger than expected.`)); return; }
      hash.update(chunk); report(received); done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), meter, fs.createWriteStream(file, { flags: "wx" }), { signal: options.signal });
  if (received !== asset.size) throw new Error(`The ${asset.step} download is incomplete (${received} of ${asset.size} bytes).`);
  if (hash.digest(asset.digest.encoding) !== asset.digest.value) throw new Error(`The ${asset.step} download failed its integrity check.`);
}

/** Windows' built-in bsdtar handles both .tar.bz2 and .tgz. */
export const windowsTar: Extract = (asset, archive, destination, signal) => new Promise((resolve, reject) => {
  const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  const child = spawn(tar, ["-x", asset.archive === "bzip2" ? "-j" : "-z", "-f", archive, "-C", destination, `--strip-components=${asset.strip}`, ...asset.members], { signal, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  child.stderr.setEncoding("utf8").on("data", (text: string) => { if (errors.length < 2000) errors += text; });
  child.on("error", reject);
  child.on("close", code => code === 0 ? resolve() : reject(new Error(`Could not unpack the ${asset.step}${errors.trim() ? `: ${errors.trim()}` : "."}`)));
});

/**
 * Download every asset into a private staging directory, verify each, unpack,
 * write the marker and only then move the finished tree into place. A failure
 * or abort leaves no usable partial install. A kept runtime stays in place
 * while the voice downloads, including across app shutdowns.
 */
export async function installVoice(options: InstallOptions): Promise<void> {
  const assets = options.assets ?? ASSETS, fetcher = options.fetch ?? globalThis.fetch, extract = options.extract ?? windowsTar;
  const layout = voiceLayout(options.dataDirectory);
  if (isInstalled(options.dataDirectory, options.marker)) throw new Error("The voice model is already installed.");
  const reuse = hasReusableRuntime(options.dataDirectory, assets);
  // Clear what the finished install replaces before downloading anything: a
  // stale model next to a kept runtime, or else the whole earlier tree (which
  // may still hold DLLs locked by this process).
  if (deleteTree(reuse ? layout.model : layout.root)) throw new Error("Restart the app to finish removing the previous voice files, then download again.");
  fs.mkdirSync(options.dataDirectory, { recursive: true });
  const staging = fs.mkdtempSync(path.join(options.dataDirectory, ".download-"));
  const root = path.join(staging, "voice");
  try {
    const wanted = assets.filter(asset => !(reuse && asset.part === "runtime"));
    const total = wanted.reduce((sum, asset) => sum + asset.size, 0);
    let done = 0;
    for (const asset of wanted) {
      options.signal.throwIfAborted();
      const archive = path.join(staging, `${asset.id}.download`);
      options.onProgress({ step: asset.step, received: done, total });
      await download(asset, archive, { signal: options.signal, fetch: fetcher }, received => options.onProgress({ step: asset.step, received: done + received, total }));
      done += asset.size;
      const destination = path.join(root, asset.into);
      fs.mkdirSync(destination, { recursive: true });
      if (asset.archive === "file") {
        const target = path.join(destination, asset.required[0] ?? `${asset.id}.bin`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(archive, target);
      } else {
        await extract(asset, archive, destination, options.signal);
        fs.rmSync(archive, { force: true });
      }
      for (const file of asset.required) {
        if (!isFile(path.join(destination, file))) throw new Error(`The ${asset.step} is missing ${file}.`);
      }
    }
    options.signal.throwIfAborted();
    if (!reuse && assets.some(asset => asset.part === "runtime")) fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify(RUNTIME_MARKER) + "\n", { flag: "wx" });
    const marker = path.join(root, "installed.json");
    fs.writeFileSync(marker, JSON.stringify(options.marker ?? MARKER) + "\n", { flag: "wx" });
    // Successful installs publish the marker last.
    if (reuse) {
      fs.renameSync(path.join(root, "model"), layout.model);
      fs.renameSync(marker, layout.marker);
    } else {
      fs.renameSync(root, layout.root);
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Move the install aside and delete it. Windows keeps a loaded DirectML/ONNX
 * runtime DLL locked until the app exits, so anything that cannot be deleted
 * yet is left in a `.trash-*` directory for the next start to finish.
 * Returns true when files are left over.
 */
export function removeVoice(dataDirectory: string): boolean {
  const layout = voiceLayout(dataDirectory);
  if (!fs.existsSync(layout.root)) return false;
  // The markers go first, so even a failed move never looks installed or reusable.
  fs.rmSync(layout.marker, { force: true });
  fs.rmSync(layout.runtimeMarker, { force: true });
  const trash = path.join(dataDirectory, `.trash-${randomUUID()}`);
  try { fs.renameSync(layout.root, trash); }
  catch { return deleteTree(layout.root); }
  return deleteTree(trash);
}

function deleteTree(directory: string): boolean {
  try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2 }); return false; }
  catch { return fs.existsSync(directory); }
}

/** Remove leftovers from an interrupted download or an earlier removal. */
export function cleanLeftovers(dataDirectory: string): void {
  let names: string[];
  try { names = fs.readdirSync(dataDirectory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const name of names) if (/^\.(download|trash)-/.test(name)) deleteTree(path.join(dataDirectory, name));
}
