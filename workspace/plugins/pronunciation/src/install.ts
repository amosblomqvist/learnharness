/** Download, verify and unpack the voice model and the DirectML runtime. */
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
  url: string;
  size: number;
  digest: { algorithm: "sha256" | "sha512"; encoding: "hex" | "base64"; value: string };
  archive: "bzip2" | "gzip";
  /** Directory inside the install root to unpack into. */
  into: string;
  strip: number;
  /** Archive members to unpack (a directory member includes its contents). */
  members: string[];
  /** Files (relative to `into`) that must exist after unpacking. */
  required: string[];
}

const MODEL = "kokoro-multi-lang-v1_1";
export const ONNXRUNTIME_VERSION = "1.31.1";

export const ASSETS: readonly Asset[] = [
  {
    id: "model", step: "voice model",
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${MODEL}.tar.bz2`,
    size: 364_855_331,
    digest: { algorithm: "sha256", encoding: "hex", value: "b78e1ac42b852e839cceaafbe88f66806bf5860992d1d7b9a3f2ad1198427aed" },
    archive: "bzip2", into: "model", strip: 1,
    members: ["model.onnx", "voices.bin", "tokens.txt", "lexicon-zh.txt", "dict/jieba.dict.utf8", "dict/user.dict.utf8", "LICENSE"].map(name => `${MODEL}/${name}`),
    required: ["model.onnx", "voices.bin", "tokens.txt", "lexicon-zh.txt", "dict/jieba.dict.utf8", "dict/user.dict.utf8", "LICENSE"],
  },
  {
    id: "onnxruntime-node", step: "GPU runtime",
    url: `https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-${ONNXRUNTIME_VERSION}.tgz`,
    size: 115_391_311,
    digest: { algorithm: "sha512", encoding: "base64", value: "ijnSghbDHVWaQ2nDPmVccPlCHI8kH1Mx1aJ4a/qzRP16bBcVs4E3EqZQKZCkhWnbqN1tuQWxagimFtDpbPYYQw==" },
    archive: "gzip", into: "runtime/node_modules/onnxruntime-node", strip: 1,
    members: ["package/package.json", "package/dist", "package/bin/napi-v6/win32/x64"],
    required: ["package.json", "dist/index.js", ...["onnxruntime_binding.node", "onnxruntime.dll", "DirectML.dll"].map(name => `bin/napi-v6/win32/x64/${name}`)],
  },
  {
    id: "onnxruntime-common", step: "GPU runtime support files",
    url: `https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-${ONNXRUNTIME_VERSION}.tgz`,
    size: 72_322,
    digest: { algorithm: "sha512", encoding: "base64", value: "F+nnYNiQtmNJ95V6R/isBJqiVpdANCrsMEg1OaF+Bkbl3GAtzWLR7Ng17Ld0QtYtYJyotOHPJzOQn1Y6PLZjpg==" },
    archive: "gzip", into: "runtime/node_modules/onnxruntime-common", strip: 1,
    members: ["package"], required: ["package.json"],
  },
];

export const TOTAL_BYTES = ASSETS.reduce((sum, asset) => sum + asset.size, 0);

/** Written last; its presence (with these values) means the install is complete. */
export const MARKER = { format: 1, model: MODEL, onnxruntime: ONNXRUNTIME_VERSION } as const;

export function voiceLayout(dataDirectory: string) {
  const root = path.join(dataDirectory, "voice");
  return {
    root,
    marker: path.join(root, "installed.json"),
    model: path.join(root, "model"),
    runtime: path.join(root, "runtime"),
  };
}

export function isInstalled(dataDirectory: string, marker: object = MARKER): boolean {
  try { return JSON.stringify(JSON.parse(fs.readFileSync(voiceLayout(dataDirectory).marker, "utf8"))) === JSON.stringify(marker); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
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
 * or abort leaves no partial install behind.
 */
export async function installVoice(options: InstallOptions): Promise<void> {
  const assets = options.assets ?? ASSETS, fetcher = options.fetch ?? globalThis.fetch, extract = options.extract ?? windowsTar;
  const layout = voiceLayout(options.dataDirectory);
  if (isInstalled(options.dataDirectory, options.marker)) throw new Error("The voice model is already installed.");
  // An incomplete tree (marker removed, DLLs still locked) blocks the final move.
  if (fs.existsSync(layout.root) && deleteTree(layout.root)) throw new Error("Restart the app to finish removing the previous voice files, then download again.");
  fs.mkdirSync(options.dataDirectory, { recursive: true });
  const staging = fs.mkdtempSync(path.join(options.dataDirectory, ".download-"));
  const total = assets.reduce((sum, asset) => sum + asset.size, 0);
  try {
    const root = path.join(staging, "voice");
    let done = 0;
    for (const asset of assets) {
      options.signal.throwIfAborted();
      const archive = path.join(staging, `${asset.id}.download`);
      options.onProgress({ step: asset.step, received: done, total });
      await download(asset, archive, { signal: options.signal, fetch: fetcher }, received => options.onProgress({ step: asset.step, received: done + received, total }));
      done += asset.size;
      const destination = path.join(root, asset.into);
      fs.mkdirSync(destination, { recursive: true });
      await extract(asset, archive, destination, options.signal);
      fs.rmSync(archive, { force: true });
      for (const file of asset.required) {
        if (!fs.statSync(path.join(destination, file), { throwIfNoEntry: false })?.isFile()) throw new Error(`The ${asset.step} is missing ${file}.`);
      }
    }
    options.signal.throwIfAborted();
    fs.writeFileSync(path.join(root, "installed.json"), JSON.stringify(options.marker ?? MARKER) + "\n", { flag: "wx" });
    fs.renameSync(root, layout.root);
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
  // The marker goes first, so even a failed move never looks installed.
  fs.rmSync(layout.marker, { force: true });
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
