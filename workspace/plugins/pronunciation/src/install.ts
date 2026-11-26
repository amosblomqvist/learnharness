/** Download, verify and unpack the voice model, its vocoder and the GPU runtime (DirectML on Windows, CUDA on Linux). */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { PassThrough, Readable, Transform } from "node:stream";
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
  archive: "bzip2" | "gzip" | "zip" | "file";
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

const MODEL_ASSET: Asset = {
  id: "model", step: "voice model", part: "voice",
  url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${MODEL}.tar.bz2`,
  size: 75_455_267,
  digest: { algorithm: "sha256", encoding: "hex", value: "ae70096b19c6e283ea351a26b8a718ce6427c8bde8c1da22eb46a5478d39a69b" },
  archive: "bzip2", into: "model", strip: 1,
  members: MODEL_FILES.map(name => `${MODEL}/${name}`),
  required: MODEL_FILES,
};
const VOCODER_ASSET: Asset = {
  id: "vocoder", step: "vocoder", part: "voice",
  url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/${VOCODER_FILE}`,
  size: 53_884_024,
  digest: { algorithm: "sha256", encoding: "hex", value: "0574a135aa1db2de6e181050db2ec528496cacd4a4701fc5d7faf9f9804c0081" },
  archive: "file", into: "model", strip: 0, members: [], required: [VOCODER_FILE],
};
const ORT_NODE = "runtime/node_modules/onnxruntime-node";
const onnxruntimeNode = (bin: string, files: readonly string[]): Asset => ({
  id: "onnxruntime-node", step: "GPU runtime", part: "runtime",
  url: `https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-${ONNXRUNTIME_VERSION}.tgz`,
  size: 115_391_311,
  digest: { algorithm: "sha512", encoding: "base64", value: "ijnSghbDHVWaQ2nDPmVccPlCHI8kH1Mx1aJ4a/qzRP16bBcVs4E3EqZQKZCkhWnbqN1tuQWxagimFtDpbPYYQw==" },
  archive: "gzip", into: ORT_NODE, strip: 1,
  members: ["package/package.json", "package/dist", `package/${bin}`],
  required: ["package.json", "dist/index.js", ...files.map(name => `${bin}/${name}`)],
});
const ONNXRUNTIME_COMMON: Asset = {
  id: "onnxruntime-common", step: "GPU runtime support files", part: "runtime",
  url: `https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-${ONNXRUNTIME_VERSION}.tgz`,
  size: 72_322,
  digest: { algorithm: "sha512", encoding: "base64", value: "F+nnYNiQtmNJ95V6R/isBJqiVpdANCrsMEg1OaF+Bkbl3GAtzWLR7Ng17Ld0QtYtYJyotOHPJzOQn1Y6PLZjpg==" },
  archive: "gzip", into: "runtime/node_modules/onnxruntime-common", strip: 1,
  members: ["package"], required: ["package.json"],
};

export const WINDOWS_ASSETS: readonly Asset[] = [
  MODEL_ASSET, VOCODER_ASSET,
  onnxruntimeNode("bin/napi-v6/win32/x64", ["onnxruntime_binding.node", "onnxruntime.dll", "DirectML.dll"]),
  ONNXRUNTIME_COMMON,
];

const LINUX_BIN = "bin/napi-v6/linux/x64";
/** Where the CUDA wheels unpack, keeping their `nvidia/<package>/lib` layout. */
export const CUDA_DIRECTORY = "cuda";
const CUDA_LIB = "nvidia/cu13/lib", CUDNN_LIB = "nvidia/cudnn/lib";
const CUDNN_FILES = ["", "_adv", "_cnn", "_engines_precompiled", "_engines_runtime_compiled", "_engines_tensor_ir", "_ext", "_graph", "_heuristic", "_ops"].map(name => `${CUDNN_LIB}/libcudnn${name}.so.9`);
/**
 * NVIDIA's PyPI wheels for the CUDA 13 libraries the CUDA provider links
 * against. Each keeps its license file beside the libraries.
 */
const wheel = (id: string, step: string, url: string, size: number, sha256: string, distInfo: string, files: readonly string[]): Asset => {
  const members = [...files, `${distInfo}.dist-info/licenses/License.txt`];
  return {
    id, step, part: "runtime", url, size,
    digest: { algorithm: "sha256", encoding: "hex", value: sha256 },
    archive: "zip", into: `runtime/${CUDA_DIRECTORY}`, strip: 0, members, required: members,
  };
};
/** Linux libraries loaded before the CUDA provider, in dependency order, relative to `runtime/`. */
export const CUDA_PRELOAD = [`${CUDA_LIB}/libcudart.so.13`, `${CUDA_LIB}/libcublasLt.so.13`, `${CUDA_LIB}/libcublas.so.13`, `${CUDA_LIB}/libcurand.so.10`, `${CUDNN_LIB}/libcudnn.so.9`].map(file => `${CUDA_DIRECTORY}/${file}`);

export const LINUX_ASSETS: readonly Asset[] = [
  MODEL_ASSET, VOCODER_ASSET,
  onnxruntimeNode(LINUX_BIN, ["onnxruntime_binding.node", "libonnxruntime.so.1"]),
  ONNXRUNTIME_COMMON,
  {
    id: "onnxruntime-gpu", step: "CUDA provider", part: "runtime",
    url: `https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime.gpu.linux/${ONNXRUNTIME_VERSION}/microsoft.ml.onnxruntime.gpu.linux.${ONNXRUNTIME_VERSION}.nupkg`,
    size: 244_926_281,
    digest: { algorithm: "sha512", encoding: "base64", value: "iB4gKnPUwfeJN01l5Yeuz40Uy1IM/8v1pj/DTrvslbqYNsMEBhw4Mp8LcJgDAGo7zkLlkSFqgJCV9zWXkMgdjQ==" },
    archive: "zip", into: `${ORT_NODE}/${LINUX_BIN}`, strip: 3,
    members: ["libonnxruntime_providers_cuda.so", "libonnxruntime_providers_shared.so"].map(name => `runtimes/linux-x64/native/${name}`),
    required: ["libonnxruntime_providers_cuda.so", "libonnxruntime_providers_shared.so"],
  },
  wheel("cuda-runtime", "CUDA runtime",
    "https://files.pythonhosted.org/packages/0b/7c/14b8f5518f8951e9dca57ea80f44f8ea8bcc8671812e6cc38009f3205e57/nvidia_cuda_runtime-13.5.37-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl",
    2_504_024, "df2b79a8852f10d1fef8c848489c49eebb5754051bf870202a862831412b179d", "nvidia_cuda_runtime-13.5.37", [`${CUDA_LIB}/libcudart.so.13`]),
  wheel("cublas", "cuBLAS",
    "https://files.pythonhosted.org/packages/27/11/db2c1a4321c2145928f87e0f647104d3a908f78d4d582908759ce81a0c17/nvidia_cublas-13.10.1.6-py3-none-manylinux1_x86_64.manylinux_2_5_x86_64.whl",
    444_290_004, "0f26cf49a81377fd96f519e28fd56c5f638a2581f303d531f60e633fb222e1ea", "nvidia_cublas-13.10.1.6", [`${CUDA_LIB}/libcublas.so.13`, `${CUDA_LIB}/libcublasLt.so.13`]),
  wheel("curand", "cuRAND",
    "https://files.pythonhosted.org/packages/12/63/636e5dc9afb2959bfc0042a357d5567358df829b66c96d9fc36d77dc0596/nvidia_curand-10.4.5.25-py3-none-manylinux_2_27_x86_64.whl",
    77_113_015, "22bb226a857e5888fe6b54ae465fc4371296bcff13a35f79e19691bcf454f529", "nvidia_curand-10.4.5.25", [`${CUDA_LIB}/libcurand.so.10`]),
  wheel("cudnn", "cuDNN",
    "https://files.pythonhosted.org/packages/ef/6f/94535c450d44a68ef0b43d7a5e54c0e5ecda2ca3db7daec5d54c8d94e0d8/nvidia_cudnn_cu13-9.28.1.4-py3-none-manylinux_2_27_x86_64.whl",
    516_817_937, "a54f205b1db1f2895d99f398754db1369816f0569dd459731f925635cf7b65ec", "nvidia_cudnn_cu13-9.28.1.4", CUDNN_FILES),
];

export const totalBytes = (assets: readonly Asset[]): number => assets.reduce((sum, asset) => sum + asset.size, 0);

/** What one platform downloads, how it unpacks, and the markers a finished install carries. */
export interface InstallTarget {
  assets: readonly Asset[];
  /** Written last; its presence (with these values) means the install is complete. */
  marker: object;
  /** Records which runtime `runtime/` holds, so a new voice can keep it. */
  runtimeMarker: object;
  extract: Extract;
}

export const WINDOWS: InstallTarget = {
  assets: WINDOWS_ASSETS,
  marker: { format: 2, model: MODEL, vocoder: VOCODER, onnxruntime: ONNXRUNTIME_VERSION },
  runtimeMarker: { onnxruntime: ONNXRUNTIME_VERSION },
  extract: (...args) => windowsTar(...args),
};
export const LINUX: InstallTarget = {
  assets: LINUX_ASSETS,
  marker: { format: 2, model: MODEL, vocoder: VOCODER, onnxruntime: ONNXRUNTIME_VERSION, cuda: 13 },
  runtimeMarker: { onnxruntime: ONNXRUNTIME_VERSION, cuda: 13 },
  extract: (asset, ...args) => asset.archive === "zip" ? unzip(asset, ...args) : systemTar(asset, ...args),
};

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

export function isInstalled(dataDirectory: string, target: InstallTarget): boolean {
  return same(readJson(voiceLayout(dataDirectory).marker), target.marker);
}

/** Whether `runtime/` holds a complete runtime of the pinned version that a new install can keep. */
export function hasReusableRuntime(dataDirectory: string, target: InstallTarget): boolean {
  const layout = voiceLayout(dataDirectory);
  const runtime = target.assets.filter(asset => asset.part === "runtime");
  return runtime.length > 0 && same(readJson(layout.runtimeMarker), target.runtimeMarker)
    && runtime.every(asset => asset.required.every(file => isFile(path.join(layout.root, asset.into, file))));
}

/** Bytes the next download fetches: everything, or only the voice when the runtime is kept. */
export function pendingBytes(dataDirectory: string, target: InstallTarget): number {
  const reuse = hasReusableRuntime(dataDirectory, target);
  return target.assets.reduce((sum, asset) => sum + (reuse && asset.part === "runtime" ? 0 : asset.size), 0);
}

/**
 * An install made for another voice or runtime (such as the earlier Kokoro
 * voice) is retired at startup: its marker goes first, then everything except
 * a runtime of the pinned version, which the next download keeps. This runs
 * before any model is loaded, so no runtime DLL is locked by this process.
 * Returns true when an outdated install was found.
 */
export function retireOutdated(dataDirectory: string, target: InstallTarget): boolean {
  const layout = voiceLayout(dataDirectory);
  const found = readJson(layout.marker);
  if (found === undefined || same(found, target.marker)) return false;
  // Record the kept runtime before dropping the old marker, so stopping in
  // between leaves the old marker for the next start to retire again. The old
  // marker must name the same runtime in every field the runtime marker has.
  const fields = found && typeof found === "object" ? found as Record<string, unknown> : {};
  if (Object.entries(target.runtimeMarker).every(([key, value]) => fields[key] === value)) fs.writeFileSync(layout.runtimeMarker, JSON.stringify(target.runtimeMarker) + "\n");
  fs.rmSync(layout.marker, { force: true });
  if (!hasReusableRuntime(dataDirectory, target)) { removeVoice(dataDirectory); return true; }
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
  target: InstallTarget;
  fetch?: typeof globalThis.fetch;
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

const runTar = (tar: string): Extract => (asset, archive, destination, signal) => new Promise((resolve, reject) => {
  const child = spawn(tar, ["-x", asset.archive === "bzip2" ? "-j" : "-z", "-f", archive, "-C", destination, `--strip-components=${asset.strip}`, ...asset.members], { signal, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  child.stderr.setEncoding("utf8").on("data", (text: string) => { if (errors.length < 2000) errors += text; });
  child.on("error", reject);
  child.on("close", code => code === 0 ? resolve() : reject(new Error(`Could not unpack the ${asset.step}${errors.trim() ? `: ${errors.trim()}` : "."}`)));
});

/** Windows' built-in bsdtar handles both .tar.bz2 and .tgz. */
export const windowsTar: Extract = (...args) => runTar(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"))(...args);
/** The system `tar` on PATH (GNU tar on Linux, which runs `bzip2` for .tar.bz2). */
export const systemTar: Extract = runTar("tar");

const ZIP_END = 0x06054b50, ZIP_ENTRY = 0x02014b50, ZIP_LOCAL = 0x04034b50;

/**
 * Unpack the listed members of a .zip (a NuGet package or Python wheel). A
 * directory member includes its contents. Only stored and deflated entries
 * are read, each is checked against its size and CRC-32, and every target
 * must stay inside `destination`.
 */
export const unzip: Extract = async (asset, archive, destination, signal) => {
  const fail = (reason: string) => new Error(`Could not unpack the ${asset.step}: ${reason}`);
  const file = await fs.promises.open(archive, "r");
  try {
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, position);
      if (bytesRead !== length) throw fail("the archive is truncated.");
      return buffer;
    };
    const { size } = await file.stat();
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = await read(size - tailLength, tailLength);
    let end = -1;
    for (let at = tailLength - 22; at >= 0; at--) if (tail.readUInt32LE(at) === ZIP_END) { end = at; break; }
    if (end < 0) throw fail("it is not a zip archive.");
    const count = tail.readUInt16LE(end + 10), directorySize = tail.readUInt32LE(end + 12), directoryOffset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw fail("ZIP64 archives are not supported.");
    const directory = await read(directoryOffset, directorySize);
    const root = path.resolve(destination);
    const entries: { name: string; method: number; compressed: number; size: number; crc: number; offset: number }[] = [];
    for (let at = 0, index = 0; index < count; index++) {
      if (at + 46 > directory.length || directory.readUInt32LE(at) !== ZIP_ENTRY) throw fail("its directory is damaged.");
      const flags = directory.readUInt16LE(at + 8), nameLength = directory.readUInt16LE(at + 28);
      const name = directory.toString("utf8", at + 46, at + 46 + nameLength);
      const entry = { name, method: directory.readUInt16LE(at + 10), crc: directory.readUInt32LE(at + 16), compressed: directory.readUInt32LE(at + 20), size: directory.readUInt32LE(at + 24), offset: directory.readUInt32LE(at + 42) };
      at += 46 + nameLength + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
      if (name.endsWith("/") || !asset.members.some(member => name === member || name.startsWith(`${member}/`))) continue;
      if (flags & 1) throw fail(`${name} is encrypted.`);
      if (entry.method !== 0 && entry.method !== 8) throw fail(`${name} uses an unsupported compression method.`);
      if ([entry.compressed, entry.size, entry.offset].includes(0xffffffff)) throw fail("ZIP64 archives are not supported.");
      entries.push(entry);
    }
    for (const entry of entries) {
      signal.throwIfAborted();
      const parts = entry.name.split("/").slice(asset.strip);
      const target = path.resolve(root, ...parts);
      if (!parts.length || entry.name.includes("\\") || path.isAbsolute(entry.name) || !target.startsWith(root + path.sep)) throw fail(`${entry.name} would unpack outside its folder.`);
      const local = await read(entry.offset, 30);
      if (local.readUInt32LE(0) !== ZIP_LOCAL) throw fail(`${entry.name} is damaged.`);
      const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      let crc = 0, written = 0;
      const check = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          written += chunk.length;
          if (written > entry.size) { done(fail(`${entry.name} is larger than its directory says.`)); return; }
          crc = zlib.crc32(chunk, crc); done(null, chunk);
        },
      });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const source = entry.compressed ? file.createReadStream({ autoClose: false, start, end: start + entry.compressed - 1 }) : Readable.from([]);
      await pipeline(source, entry.method === 8 ? zlib.createInflateRaw() : new PassThrough(), check, fs.createWriteStream(target), { signal });
      if (written !== entry.size || crc !== entry.crc) throw fail(`${entry.name} failed its checksum.`);
    }
  } finally {
    await file.close();
  }
};

/**
 * Download every asset into a private staging directory, verify each, unpack,
 * write the marker and only then move the finished tree into place. A failure
 * or abort leaves no usable partial install. A kept runtime stays in place
 * while the voice downloads, including across app shutdowns.
 */
export async function installVoice(options: InstallOptions): Promise<void> {
  const { target } = options, { assets, extract } = target, fetcher = options.fetch ?? globalThis.fetch;
  const layout = voiceLayout(options.dataDirectory);
  if (isInstalled(options.dataDirectory, target)) throw new Error("The voice model is already installed.");
  const reuse = hasReusableRuntime(options.dataDirectory, target);
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
    if (!reuse && assets.some(asset => asset.part === "runtime")) fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify(target.runtimeMarker) + "\n", { flag: "wx" });
    const marker = path.join(root, "installed.json");
    fs.writeFileSync(marker, JSON.stringify(target.marker) + "\n", { flag: "wx" });
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
