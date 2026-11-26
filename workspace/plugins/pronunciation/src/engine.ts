/**
 * Matcha-TTS (Baker voice) + Vocos inference on the GPU (DirectML on Windows,
 * CUDA on Linux) through the downloaded onnxruntime-node, reproducing sherpa-onnx 2.0.3's pipeline:
 * tokens interspersed with the blank token → mel spectrogram → Vocos
 * spectrum → inverse STFT → long pauses shortened.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Lexicon } from "./lexicon.ts";
import { CUDA_PRELOAD, VOCODER_FILE, voiceLayout } from "./install.ts";
import { istft, scaleSilence } from "./dsp.ts";

export const SAMPLE_RATE = 22_050;
/** The model's `pad_id` metadata: the blank token placed around every token. */
export const BLANK_ID = 1;
/** sherpa-onnx's Matcha defaults. */
export const NOISE_SCALE = 1, LENGTH_SCALE = 1;
const MEL_BINS = 80;

/** The slice of the onnxruntime-node API this plugin uses. */
export interface OrtTensor { readonly data: unknown; readonly dims: readonly number[] }
export interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release(): Promise<void>;
}
export interface OrtModule {
  InferenceSession: { create(model: string, options: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: "int64" | "float32", data: BigInt64Array | Float32Array, dims: readonly number[]) => OrtTensor;
}

/** The GPU execution provider for one platform. There is no CPU fallback. */
export interface Accelerator {
  /** Shown in errors: "GPU (<name>) unavailable: …". */
  name: string;
  providers: readonly string[];
  /** Shared libraries (relative to `runtime/`) to load before the provider. */
  preload: readonly string[];
}
export const DIRECTML: Accelerator = { name: "DirectML", providers: ["dml"], preload: [] };
export const CUDA: Accelerator = { name: "CUDA", providers: ["cuda"], preload: CUDA_PRELOAD };

/** glibc's RTLD_NODELETE, which `os.constants.dlopen` does not expose. */
const RTLD_NODELETE = 0x1000;
const unavailable = (accelerator: Accelerator, error: unknown) => new Error(`GPU (${accelerator.name}) unavailable: ${error instanceof Error ? error.message : String(error)}`);

/**
 * Load the runtime from the install directory, outside the app's own modules.
 * The CUDA provider library has no RUNPATH, and LD_LIBRARY_PATH cannot change
 * in a running process, so the downloaded CUDA libraries are loaded first:
 * the dynamic linker then resolves the provider's dependencies by soname to
 * these already-loaded copies. `process.dlopen` rejects them because they are
 * not Node addons and then closes them; RTLD_NODELETE keeps them loaded.
 */
export function loadRuntime(runtimeDirectory: string, accelerator: Accelerator): OrtModule {
  const { RTLD_NOW, RTLD_GLOBAL } = os.constants.dlopen as Record<string, number>;
  for (const library of accelerator.preload) {
    try { process.dlopen({ exports: {} }, path.join(runtimeDirectory, library), RTLD_NOW! | RTLD_GLOBAL! | RTLD_NODELETE); }
    catch (error) {
      if (!(error instanceof Error && error.message.startsWith("Module did not self-register"))) throw unavailable(accelerator, error);
    }
  }
  return createRequire(path.join(runtimeDirectory, "loader.cjs"))("onnxruntime-node") as OrtModule;
}

/** [blank, t1, blank, t2, …, blank], as sherpa-onnx's AddBlank. */
export function intersperse(ids: readonly number[], blank = BLANK_ID): number[] {
  const out = [blank];
  for (const id of ids) out.push(id, blank);
  return out;
}

const floats = (tensor: OrtTensor | undefined, what: string): Float32Array => {
  if (!(tensor?.data instanceof Float32Array)) throw new Error(`The voice model returned no ${what}.`);
  return tensor.data;
};

export class Engine {
  private queue: Promise<unknown> = Promise.resolve();
  private released = false;

  private constructor(private readonly ort: OrtModule, private readonly acoustic: OrtSession, private readonly vocoder: OrtSession, private readonly lexicon: Lexicon) {}

  static async load(dataDirectory: string, accelerator: Accelerator, runtime: (directory: string, accelerator: Accelerator) => OrtModule = loadRuntime): Promise<Engine> {
    const layout = voiceLayout(dataDirectory);
    const read = (name: string) => fs.readFileSync(path.join(layout.model, name), "utf8");
    const lexicon = new Lexicon({ tokens: read("tokens.txt"), lexicon: read("lexicon.txt"), dictionaries: [read("dict/jieba.dict.utf8"), read("dict/user.dict.utf8")] });
    if (lexicon.tokenId("_") !== BLANK_ID) throw new Error("The voice model's token table is not the expected one. Remove the downloaded files and download again.");
    const ort = runtime(layout.runtime, accelerator);
    const sessions: OrtSession[] = [];
    const open = async (file: string) => {
      try {
        // GPU only: no CPU execution provider is requested.
        const session = await ort.InferenceSession.create(path.join(layout.model, file), { executionProviders: [...accelerator.providers], logSeverityLevel: 3 });
        sessions.push(session);
        return session;
      } catch (error) {
        throw unavailable(accelerator, error);
      }
    };
    try {
      const acoustic = await open("model-steps-3.onnx");
      const vocoder = await open(VOCODER_FILE);
      for (const name of ["x", "x_length", "noise_scale", "length_scale"]) if (!acoustic.inputNames.includes(name)) throw new Error(`The voice model is missing its "${name}" input.`);
      if (!vocoder.inputNames.includes("mels")) throw new Error(`The vocoder is missing its "mels" input.`);
      for (const name of ["mag", "x", "y"]) if (!vocoder.outputNames.includes(name)) throw new Error(`The vocoder is missing its "${name}" output.`);
      const engine = new Engine(ort, acoustic, vocoder, lexicon);
      // The first GPU run compiles kernels; pay that once, here.
      await engine.synthesize("你好");
      return engine;
    } catch (error) {
      await Promise.all(sessions.map(session => session.release().catch(() => {})));
      throw error;
    }
  }

  /** Runs one request at a time; resolves to mono samples at SAMPLE_RATE. */
  synthesize(text: string): Promise<Float32Array> {
    const task = this.queue.then(() => this.run(text));
    this.queue = task.catch(() => {});
    return task;
  }

  private async run(text: string): Promise<Float32Array> {
    if (this.released) throw new Error("The voice model was unloaded.");
    const content = this.lexicon.tokenize(text);
    if (!content.length) throw new Error(`Nothing to pronounce in “${text}”.`);
    const ids = intersperse(content);
    const { Tensor } = this.ort;
    const acoustic = await this.acoustic.run({
      x: new Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
      x_length: new Tensor("int64", BigInt64Array.of(BigInt(ids.length)), [1]),
      noise_scale: new Tensor("float32", Float32Array.of(NOISE_SCALE), [1]),
      length_scale: new Tensor("float32", Float32Array.of(LENGTH_SCALE), [1]),
    });
    const mel = acoustic[this.acoustic.outputNames[0] ?? ""];
    const melData = floats(mel, "spectrogram");
    const frames = mel!.dims[2] ?? 0;
    if (mel!.dims.length !== 3 || mel!.dims[1] !== MEL_BINS || melData.length !== MEL_BINS * frames) throw new Error("The voice model returned an unexpected spectrogram.");
    const spectrum = await this.vocoder.run({ mels: new Tensor("float32", melData, [1, MEL_BINS, frames]) });
    const mag = spectrum.mag;
    const [, bins = 0, count = 0] = mag?.dims ?? [];
    const audio = istft(floats(mag, "magnitude"), floats(spectrum.x, "phase"), floats(spectrum.y, "phase"), bins, count);
    return scaleSilence(audio, SAMPLE_RATE);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.queue;
    await Promise.all([this.acoustic.release(), this.vocoder.release()]);
  }
}
