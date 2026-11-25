/** Kokoro inference on DirectML through the downloaded onnxruntime-node. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Lexicon } from "./lexicon.ts";
import { voiceLayout } from "./install.ts";

export const SAMPLE_RATE = 24_000;
const STYLE_ROWS = 510, STYLE_WIDTH = 256;

/** The slice of the onnxruntime-node API this plugin uses. */
export interface OrtTensor { readonly data: unknown }
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

/** Load the runtime from the install directory, outside the app's own modules. */
export function loadRuntime(runtimeDirectory: string): OrtModule {
  return createRequire(path.join(runtimeDirectory, "loader.cjs"))("onnxruntime-node") as OrtModule;
}

export class Engine {
  private queue: Promise<unknown> = Promise.resolve();
  private released = false;

  private constructor(private readonly ort: OrtModule, private readonly session: OrtSession, private readonly lexicon: Lexicon, private readonly styles: Float32Array, private readonly speakers: number) {}

  static async load(dataDirectory: string, runtime: (directory: string) => OrtModule = loadRuntime): Promise<Engine> {
    const layout = voiceLayout(dataDirectory);
    const read = (name: string) => fs.readFileSync(path.join(layout.model, name), "utf8");
    const lexicon = new Lexicon({ tokens: read("tokens.txt"), lexicon: read("lexicon-zh.txt"), dictionaries: [read("dict/jieba.dict.utf8"), read("dict/user.dict.utf8")] });
    const voices = fs.readFileSync(path.join(layout.model, "voices.bin"));
    const perSpeaker = STYLE_ROWS * STYLE_WIDTH * 4;
    if (!voices.length || voices.length % perSpeaker) throw new Error("The voice file is damaged. Remove the downloaded files and download again.");
    const styles = new Float32Array(voices.buffer.slice(voices.byteOffset, voices.byteOffset + voices.length));
    const ort = runtime(layout.runtime);
    let session: OrtSession;
    try {
      // DirectML only: no CPU execution provider is requested.
      session = await ort.InferenceSession.create(path.join(layout.model, "model.onnx"), { executionProviders: ["dml"], logSeverityLevel: 3 });
    } catch (error) {
      throw new Error(`GPU (DirectML) unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const name of ["tokens", "style", "speed"]) if (!session.inputNames.includes(name)) {
      await session.release();
      throw new Error(`The voice model is missing its "${name}" input.`);
    }
    const engine = new Engine(ort, session, lexicon, styles, voices.length / perSpeaker);
    // The first DirectML run compiles kernels (seconds); pay that once, here.
    await engine.synthesize("你好", 0);
    return engine;
  }

  /** Runs one request at a time; resolves to mono samples at SAMPLE_RATE. */
  synthesize(text: string, speaker: number): Promise<Float32Array> {
    const task = this.queue.then(() => this.run(text, speaker));
    this.queue = task.catch(() => {});
    return task;
  }

  private async run(text: string, speaker: number): Promise<Float32Array> {
    if (this.released) throw new Error("The voice model was unloaded.");
    if (!Number.isSafeInteger(speaker) || speaker < 0 || speaker >= this.speakers) throw new Error("Unknown voice.");
    const ids = this.lexicon.tokenize(text);
    if (!ids.length) throw new Error(`Nothing to pronounce in “${text}”.`);
    // Kokoro's style row is chosen by the number of content tokens.
    const offset = (speaker * STYLE_ROWS + ids.length) * STYLE_WIDTH;
    const padded = [0, ...ids, 0];
    const outputs = await this.session.run({
      tokens: new this.ort.Tensor("int64", BigInt64Array.from(padded, BigInt), [1, padded.length]),
      style: new this.ort.Tensor("float32", this.styles.slice(offset, offset + STYLE_WIDTH), [1, STYLE_WIDTH]),
      speed: new this.ort.Tensor("float32", Float32Array.of(1), [1]),
    });
    const audio = outputs[this.session.outputNames[0] ?? ""]?.data;
    if (!(audio instanceof Float32Array)) throw new Error("The voice model returned no audio.");
    return audio;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.queue;
    await this.session.release();
  }
}
