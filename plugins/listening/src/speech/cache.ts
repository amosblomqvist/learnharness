import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { SPEECH_CACHE_MAX_BYTES } from "./limits.ts";
import type { SpeechAudio } from "./provider.ts";

export interface SpeechCache {
  get(key: string): Promise<SpeechAudio | null>;
  put(key: string, audio: Uint8Array, mimeType: string): Promise<void>;
}

type Entry = { version: 1; mimeType: string; size: number; checksum: string; created: number; accessed: number };
const validKey = (key: string) => /^[a-f0-9]{64}$/.test(key);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Single-server file cache with LRU eviction. A promise chain serializes commit, touch and eviction. */
export function createSpeechCache({ directory, maxBytes = SPEECH_CACHE_MAX_BYTES, now = Date.now }: {
  directory: string; maxBytes?: number; now?: () => number;
}): SpeechCache {
  if (!Number.isFinite(maxBytes) || maxBytes < 1) throw new Error("Invalid speech cache budget");
  let tail: Promise<unknown> = Promise.resolve();
  let initialized = false;
  let lastClock = 0;
  const entries = new Map<string, Entry>();
  const file = (key: string, extension: string) => path.join(directory, `${key}.${extension}`);
  const tick = () => lastClock = Math.max(now(), lastClock + 1);
  async function remove(key: string) {
    await Promise.all([fs.rm(file(key, "mp3"), { force: true }), fs.rm(file(key, "json"), { force: true })]);
    entries.delete(key);
  }
  async function atomic(target: string, data: string | Uint8Array) {
    const temp = `${target}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temp, data, { mode: 0o600 }); await fs.rename(temp, target); }
    finally { await fs.rm(temp, { force: true }); }
  }
  async function load(key: string): Promise<{ entry: Entry; audio: Uint8Array } | null> {
    try {
      const entry = JSON.parse(await fs.readFile(file(key, "json"), "utf8")) as Entry;
      if (!entry || typeof entry !== "object" || entry.version !== 1 || entry.mimeType !== "audio/mpeg" || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > maxBytes || !Number.isFinite(entry.created) || !Number.isFinite(entry.accessed)) return null;
      const stat = await fs.stat(file(key, "mp3"));
      if (stat.size !== entry.size) return null;
      const audio = await fs.readFile(file(key, "mp3"));
      if (digest(audio) !== entry.checksum) return null;
      return { entry, audio: new Uint8Array(audio) };
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  const cost = (entry: Entry) => entry.size + Buffer.byteLength(JSON.stringify(entry));
  async function evict() {
    let size = [...entries.values()].reduce((sum, entry) => sum + cost(entry), 0);
    for (const [key, entry] of [...entries].sort((a, b) => a[1].accessed - b[1].accessed)) {
      if (size <= maxBytes) break;
      await remove(key); size -= cost(entry);
    }
  }
  async function initialize() {
    if (initialized) return;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    entries.clear();
    const names = await fs.readdir(directory);
    for (const name of names) {
      if (/^[a-f0-9]{64}\.(mp3|json)\.[a-f0-9-]+\.tmp$/.test(name)) await fs.rm(path.join(directory, name), { force: true });
    }
    const keys = new Set(names.filter(name => /^[a-f0-9]{64}\.(mp3|json)$/.test(name)).map(name => name.split(".")[0]!));
    for (const key of keys) {
      const loaded = await load(key);
      if (!loaded) await remove(key);
      else { entries.set(key, loaded.entry); lastClock = Math.max(lastClock, loaded.entry.accessed); }
    }
    await evict(); initialized = true;
  }
  function serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (!validKey(key)) return Promise.reject(new Error("Invalid speech cache key"));
    const result = tail.then(async () => { await initialize(); return action(); });
    tail = result.catch(() => {});
    return result;
  }
  return {
    get(key) { return serial(key, async (): Promise<SpeechAudio | null> => {
      const loaded = await load(key);
      if (!loaded) { await remove(key); return null; }
      loaded.entry.accessed = tick();
      await atomic(file(key, "json"), JSON.stringify(loaded.entry));
      entries.set(key, loaded.entry);
      await evict();
      return { audio: loaded.audio, mimeType: loaded.entry.mimeType };
    }); },
    put(key, audio, mimeType) { return serial(key, async () => {
      if (!audio.byteLength || mimeType !== "audio/mpeg") throw new Error("Invalid speech cache audio");
      const stamp = tick();
      const entry: Entry = { version: 1, mimeType, size: audio.byteLength, checksum: digest(audio), created: stamp, accessed: stamp };
      if (cost(entry) > maxBytes) throw new Error("Audio exceeds speech cache budget");
      await atomic(file(key, "mp3"), audio);
      await atomic(file(key, "json"), JSON.stringify(entry));
      entries.set(key, entry); await evict();
    }); },
  };
}
