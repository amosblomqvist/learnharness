import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

/** Default ceiling for cached sentence audio: roughly a few hundred lesson responses. */
export const SPEECH_CACHE_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Sentence audio that already exists, keyed by voice, pinned model revision and exact text.
 * Playback rate is applied in the client, so one entry serves every rate. Entries are
 * ordinary files written atomically and pruned least-recently-used by size.
 */
export class SpeechAudioCache {
 constructor(private readonly directory: string, private readonly maxBytes = SPEECH_CACHE_MAX_BYTES) {}

 private file(voiceId: string, revision: string, text: string): string {
  const digest = createHash("sha256").update(revision).update("\0").update(text).digest("hex");
  return path.join(this.directory, `${voiceId}-${digest}.wav`);
 }

 /** The cached audio, or null. A hit refreshes the entry's recency. */
 async get(voiceId: string, revision: string, text: string): Promise<Buffer | null> {
  const file = this.file(voiceId, revision, text);
  try {
   const data = await fs.readFile(file);
   const now = new Date();
   await fs.utimes(file, now, now).catch(() => {});
   return data;
  } catch {
   return null;
  }
 }

 /** Stores audio atomically: a reader never sees a partly written entry. */
 async put(voiceId: string, revision: string, text: string, audio: Buffer): Promise<void> {
  await fs.mkdir(this.directory, { recursive: true });
  const file = this.file(voiceId, revision, text);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, audio);
  await fs.rename(temporary, file);
  await this.prune();
 }

 /** Removes every entry for one voice, for example when the voice is uninstalled. */
 async removeVoice(voiceId: string): Promise<void> {
  for (const name of await this.names()) {
   if (name.startsWith(`${voiceId}-`)) await fs.rm(path.join(this.directory, name), { force: true });
  }
 }

 /** Deletes least-recently-used entries until the cache fits its size ceiling. */
 async prune(): Promise<void> {
  const entries: { file: string; size: number; time: number }[] = [];
  for (const name of await this.names()) {
   const file = path.join(this.directory, name);
   try {
    const stat = await fs.stat(file);
    entries.push({ file, size: stat.size, time: stat.mtimeMs });
   } catch { /* Removed concurrently. */ }
  }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of entries.sort((a, b) => a.time - b.time)) {
   if (total <= this.maxBytes) break;
   await fs.rm(entry.file, { force: true });
   total -= entry.size;
  }
 }

 private async names(): Promise<string[]> {
  try {
   return (await fs.readdir(this.directory)).filter(name => name.endsWith(".wav"));
  } catch {
   return [];
  }
 }
}
