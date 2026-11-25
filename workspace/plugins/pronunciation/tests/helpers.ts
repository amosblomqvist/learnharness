import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Asset, Extract } from "../src/install.ts";
import type { OrtModule, OrtTensor } from "../src/engine.ts";
import { DICTIONARY, LEXICON, TOKENS, USER_DICTIONARY } from "./fixtures.ts";

export function temporaryDirectory(prefix: string): { directory: string; [Symbol.dispose](): void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { directory, [Symbol.dispose]: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

/** Serves fixed bytes on loopback; unknown paths are 404. */
export async function serve(files: Record<string, Buffer>): Promise<{ url: string; requests: string[]; close(): Promise<void> }> {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? "");
    const body = files[request.url ?? ""];
    if (!body) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Length": body.length }).end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise(resolve => server.close(() => resolve())) };
}

export function assetFor(url: string, bytes: Buffer, overrides: Partial<Asset> = {}): Asset {
  return {
    id: "fixture", step: "fixture", part: "voice", url, size: bytes.length,
    digest: { algorithm: "sha256", encoding: "hex", value: createHash("sha256").update(bytes).digest("hex") },
    archive: "gzip", into: "model", strip: 0, members: [], required: [],
    ...overrides,
  };
}

/** The model files a real install holds, built from the fixtures. */
export function modelFiles(): Record<string, Buffer> {
  return {
    "model-steps-3.onnx": Buffer.from("fake acoustic model"), "vocos-22khz-univ.onnx": Buffer.from("fake vocoder"),
    "tokens.txt": Buffer.from(TOKENS), "lexicon.txt": Buffer.from(LEXICON),
    "dict/jieba.dict.utf8": Buffer.from(DICTIONARY), "dict/user.dict.utf8": Buffer.from(USER_DICTIONARY),
    "README.md": Buffer.from("non-commercial use only"),
  };
}

/** Stands in for tar: writes the given files (or the archive bytes) into the destination. */
export function fakeExtract(files?: Record<string, Buffer>): Extract & { calls: string[] } {
  const calls: string[] = [];
  const extract = async (asset: Asset, archive: string, destination: string) => {
    calls.push(asset.id);
    const contents = files ?? Object.fromEntries(asset.required.map(name => [name, fs.readFileSync(archive)]));
    for (const [name, bytes] of Object.entries(contents)) {
      fs.mkdirSync(path.dirname(path.join(destination, name)), { recursive: true });
      fs.writeFileSync(path.join(destination, name), bytes);
    }
  };
  return Object.assign(extract, { calls });
}

export class FakeTensor implements OrtTensor {
  constructor(readonly type: string, readonly data: BigInt64Array | Float32Array, readonly dims: readonly number[]) {}
}
/** Mel frames the fake acoustic model returns per input token. */
export const FRAMES_PER_TOKEN = 2;
export const SPECTRUM_BINS = 513;
/**
 * A fake runtime with the acoustic model and vocoder interfaces. The vocoder
 * returns a DC-only spectrum (magnitude 512 in bin 0), so the audio is a
 * steady non-silent level and no pause is shortened.
 */
export function fakeRuntime(options: { failCreate?: string } = {}) {
  const created: { model: string; options: Record<string, unknown> }[] = [];
  const runs: { model: string; feeds: Record<string, FakeTensor> }[] = [];
  let released = 0, loads = 0;
  const ort: OrtModule = {
    InferenceSession: {
      async create(model, sessionOptions) {
        created.push({ model, options: sessionOptions });
        if (options.failCreate) throw new Error(options.failCreate);
        const name = path.basename(model);
        const vocoder = name.startsWith("vocos");
        return {
          inputNames: vocoder ? ["mels"] : ["x", "x_length", "noise_scale", "length_scale"],
          outputNames: vocoder ? ["mag", "x", "y"] : ["mel"],
          async run(feeds): Promise<Record<string, OrtTensor>> {
            const typed = feeds as Record<string, FakeTensor>;
            runs.push({ model: name, feeds: typed });
            if (!vocoder) {
              const frames = typed.x!.dims[1]! * FRAMES_PER_TOKEN;
              return { mel: new FakeTensor("float32", new Float32Array(80 * frames).fill(0.25), [1, 80, frames]) };
            }
            const frames = typed.mels!.dims[2]!;
            const mag = new Float32Array(SPECTRUM_BINS * frames), x = new Float32Array(SPECTRUM_BINS * frames), y = new Float32Array(SPECTRUM_BINS * frames);
            mag.fill(512, 0, frames); x.fill(1, 0, frames);
            const dims = [1, SPECTRUM_BINS, frames];
            return { mag: new FakeTensor("float32", mag, dims), x: new FakeTensor("float32", x, dims), y: new FakeTensor("float32", y, dims) };
          },
          async release() { released++; },
        };
      },
    },
    Tensor: FakeTensor,
  };
  return { load: (directory: string) => { loads++; void directory; return ort; }, created, runs, get released() { return released; }, get loads() { return loads; } };
}
