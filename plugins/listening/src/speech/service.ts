import { createHash } from "node:crypto";
import type { SpeechCache } from "./cache.ts";
import { codePointLength, isLanguageTag, MAX_CONCURRENT_GENERATIONS, normalizeSpokenText, SpeechError, spokenTextProblem } from "./limits.ts";
import { baseLanguage, type ModelInfo, type SpeechAudio, type TtsProvider } from "./provider.ts";

export type SpeechResult = SpeechAudio & { cache: "hit" | "miss"; warning?: string };
export interface SpeechSelection {
  provider: TtsProvider;
  voiceId: string;
  modelId: string;
  model?: ModelInfo;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** Any change of provider, model, voice, language or text produces different audio. */
export function speechCacheKey(identity: { provider: string; modelId: string; voiceId: string; language: string; text: string }): string {
  return createHash("sha256").update(canonical({ ...identity, normalization: 1 })).digest("hex");
}

export function parseSpeechRequest(input: unknown): { text: string; language: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SpeechError("invalid_request", "The audio request was invalid.");
  const { text, language } = input as Record<string, unknown>;
  if (typeof text !== "string" || typeof language !== "string" || !isLanguageTag(language)) {
    throw new SpeechError("invalid_request", "The audio request was invalid.");
  }
  const problem = spokenTextProblem(text);
  if (problem) throw new SpeechError("invalid_request", problem);
  // Providers take the base code ("pt" for "pt-BR"); the same code also keys the cache.
  return { text: normalizeSpokenText(text), language: baseLanguage(language) };
}

/** Cached audio plays without a key; generation is deduplicated and bounded. */
export function createSpeechService({ cache, selection, key, maxConcurrent = MAX_CONCURRENT_GENERATIONS }: {
  cache: SpeechCache;
  selection: () => SpeechSelection;
  key: (providerId: string) => string | undefined;
  maxConcurrent?: number;
}) {
  const pending = new Map<string, Promise<SpeechResult>>();
  let generating = 0;
  return async (input: unknown): Promise<SpeechResult> => {
    const { text, language } = parseSpeechRequest(input);
    const { provider, voiceId, modelId, model } = selection();
    if (!voiceId.trim() || !model || model.id !== modelId) throw new SpeechError("not_ready", "Listening is not set up yet. Choose a voice and model in Listening settings.");
    if (codePointLength(text) > model.maxTextLength) throw new SpeechError("text_too_long", `The spoken text is longer than ${model.label} accepts (${model.maxTextLength.toLocaleString("en-US")} characters).`);
    const identity = speechCacheKey({ provider: provider.id, modelId, voiceId, language, text });
    const existing = pending.get(identity);
    if (existing) return existing;
    const work = async (): Promise<SpeechResult> => {
      let warning: string | undefined;
      try { const saved = await cache.get(identity); if (saved) return { ...saved, cache: "hit" }; }
      catch { warning = "Audio cache is unavailable; replay in this window still works."; }
      const apiKey = key(provider.id);
      if (!apiKey) throw new SpeechError("key_missing", `Add your ${provider.label} API key in Listening settings.`);
      if (generating >= maxConcurrent) throw new SpeechError("busy", "Speech generation is busy. Try again shortly.");
      generating++;
      try {
        const result = await provider.synthesize({ text, language, voiceId, model, apiKey });
        try { await cache.put(identity, result.audio, result.mimeType); }
        catch { warning = "Audio could not be saved; replay in this window still works."; }
        return { ...result, cache: "miss", ...(warning ? { warning } : {}) };
      } finally { generating--; }
    };
    // Defer work so the map owns the request before any await completes.
    const request = Promise.resolve().then(work);
    pending.set(identity, request);
    try { return await request; }
    finally { if (pending.get(identity) === request) pending.delete(identity); }
  };
}
