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
    id: "fixture", step: "fixture", url, size: bytes.length,
    digest: { algorithm: "sha256", encoding: "hex", value: createHash("sha256").update(bytes).digest("hex") },
    archive: "gzip", into: "model", strip: 0, members: [], required: [],
    ...overrides,
  };
}

/** The model files a real archive would unpack, built from the fixtures. */
export const SPEAKERS = 4, STYLE_ROWS = 510, STYLE_WIDTH = 256;
export function modelFiles(): Record<string, Buffer> {
  const styles = new Float32Array(SPEAKERS * STYLE_ROWS * STYLE_WIDTH);
  // Every value in a row is speaker * 1000 + row, so tests can see which row was used.
  for (let speaker = 0; speaker < SPEAKERS; speaker++) for (let row = 0; row < STYLE_ROWS; row++) {
    styles.fill(speaker * 1000 + row, (speaker * STYLE_ROWS + row) * STYLE_WIDTH, (speaker * STYLE_ROWS + row + 1) * STYLE_WIDTH);
  }
  return {
    "model.onnx": Buffer.from("fake model"), "voices.bin": Buffer.from(styles.buffer), "tokens.txt": Buffer.from(TOKENS),
    "lexicon-zh.txt": Buffer.from(LEXICON), "dict/jieba.dict.utf8": Buffer.from(DICTIONARY), "dict/user.dict.utf8": Buffer.from(USER_DICTIONARY),
    LICENSE: Buffer.from("Apache-2.0"),
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
export function fakeRuntime(options: { failCreate?: string } = {}) {
  const created: { model: string; options: Record<string, unknown> }[] = [];
  const runs: Record<string, FakeTensor>[] = [];
  let released = 0, loads = 0;
  const ort: OrtModule = {
    InferenceSession: {
      async create(model, sessionOptions) {
        created.push({ model, options: sessionOptions });
        if (options.failCreate) throw new Error(options.failCreate);
        return {
          inputNames: ["tokens", "style", "speed"], outputNames: ["audio", "durations"],
          async run(feeds) { runs.push(feeds as Record<string, FakeTensor>); return { audio: new FakeTensor("float32", Float32Array.of(0, 0.5, -0.5, 1), [4]) }; },
          async release() { released++; },
        };
      },
    },
    Tensor: FakeTensor,
  };
  return { load: (directory: string) => { loads++; void directory; return ort; }, created, runs, get released() { return released; }, get loads() { return loads; } };
}
