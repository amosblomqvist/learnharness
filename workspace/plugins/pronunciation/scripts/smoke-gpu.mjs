/**
 * Manual GPU check: downloads the model and runtime (~245 MB on Windows, ~1.5 GB
 * on Linux, once per scratch directory) and runs the real model on the GPU
 * (DirectML on Windows, CUDA on Linux) through the built backend, then writes
 * WAV files.
 *
 * From workspace/ with scratch LH_DATA_DIR and LH_AUTH_FILE:
 *   npm --prefix plugins/pronunciation run build
 *   node plugins/pronunciation/scripts/smoke-gpu.mjs <scratch-model-directory>
 *
 * The directory stands in for core-plugin-data/pronunciation. It must not be
 * inside a LearnHarness profile; nothing here touches app data or settings.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = process.argv[2] && path.resolve(process.argv[2]);
if (!directory) throw new Error("Usage: node scripts/smoke-gpu.mjs <scratch-data-directory>");
if (/[\\/](data|core-plugin-data)([\\/]|$)/.test(directory)) throw new Error("Refusing a directory that looks like a LearnHarness profile; use a scratch directory.");

const { activateWith } = createRequire(import.meta.url)(path.join(root, "dist/backend.cjs"));
const controller = new AbortController();
const handlers = new Map();
let latest;
const dispose = activateWith({
  dataDirectory: directory, signal: controller.signal,
  handle(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); },
  events: { emit(topic, data) { if (topic === "state-changed") latest = data; } },
}, {});
const call = (name, input) => handlers.get(name)(input);

let state = await call("get-state");
console.log("install:", state.install.kind);
if (state.install.kind === "missing" || state.install.kind === "failed") {
  await call("download");
  let shown = "";
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const install = latest?.install ?? state.install;
    const line = install.kind === "downloading" ? `${install.step} ${Math.round(install.received / 2 ** 20)}/${Math.round(install.total / 2 ** 20)} MB` : install.kind;
    if (line !== shown) { console.log(line); shown = line; }
    if (install.kind !== "downloading") break;
  }
  state = await call("get-state");
  if (state.install.kind !== "installed") throw new Error(`Download did not finish: ${JSON.stringify(state.install)}`);
}

const out = path.join(directory, "smoke-output");
fs.mkdirSync(out, { recursive: true });
const phrases = ["你好", "银行", "行", "我们一起去银行吧", "不客气", "长大", "一会儿", "研究生命的起源"];
for (const [index, text] of phrases.entries()) {
  const started = performance.now();
  const { wav } = await call("speak", { text });
  const bytes = Buffer.from(wav, "base64");
  fs.writeFileSync(path.join(out, `${index}.wav`), bytes);
  const rate = bytes.readUInt32LE(24);
  const sampleBytes = bytes.readUInt32LE(40);
  if (rate !== 22_050 || sampleBytes !== bytes.length - 44 || sampleBytes === 0) throw new Error("Expected a nonempty 22.05 kHz WAV.");
  console.log(`${text}: ${Math.round(performance.now() - started)} ms, ${(sampleBytes / (rate * 2)).toFixed(2)} s audio`);
}
console.log(`WAV files: ${out}`);
controller.abort();
dispose();
