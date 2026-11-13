import { generationTimeoutMs, isLanguageTag, maxAudioBytes, SpeechError } from "./limits.ts";
import { baseLanguage, type ModelInfo, type ProviderSettings, type SpeechAudio, type SynthesisRequest, type TtsProvider } from "./provider.ts";

const API = "https://api.elevenlabs.io/v1";
const OUTPUT_FORMAT = "mp3_44100_128";
const TIMEOUT_LIST_MS = 15_000;
/** ElevenLabs ignores language_code on this model and rejects it on some requests. */
const NO_LANGUAGE_CODE_MODELS = new Set(["eleven_multilingual_v2"]);

/** Bounded binary reader: do not trust Content-Length alone. */
async function readAudio(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) throw new SpeechError("invalid_audio", "The speech service returned no audio. Try again.");
  const tooLarge = () => new SpeechError("invalid_audio", "The generated audio is too large.");
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body.cancel().catch(() => {});
    throw tooLarge();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw tooLarge();
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const audio = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.byteLength; }
  // MP3 starts with an ID3 tag or an MPEG frame header. This also catches an
  // upstream JSON/HTML error mislabeled as audio/mpeg.
  const id3 = size >= 10 && audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33;
  const frame = size >= 4 && audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0;
  if (!id3 && !frame) throw new SpeechError("invalid_audio", "The speech service returned unusable audio. Try again.");
  return audio;
}

/** The permission each call needs on a restricted ElevenLabs key, as the ElevenLabs dashboard names it. */
type KeyPermission = "Models: Read" | "Text to Speech";

/** Reads the failure reply only to tell a missing key permission from a wrong key; its text is never shown. */
async function failure(response: Response, permission: KeyPermission): Promise<SpeechError> {
  if (response.status === 401 || response.status === 403) {
    let body: unknown;
    if (response.headers.get("content-type")?.includes("json")) {
      try { body = await response.json(); }
      catch { body = undefined; }
    } else void response.body?.cancel().catch(() => {});
    const detail = body && typeof body === "object" ? (body as Record<string, unknown>).detail : undefined;
    if (detail && typeof detail === "object" && (detail as Record<string, unknown>).status === "missing_permissions") {
      return new SpeechError("auth_failed", permission === "Models: Read"
        ? "This API key can't read your ElevenLabs model list. Edit the key in ElevenLabs and turn on \"Models: Read\", or create a new key with it."
        : "This API key can't generate speech. Edit the key in ElevenLabs and turn on \"Text to Speech\", or create a new key with it.");
    }
  } else void response.body?.cancel().catch(() => {});
  return statusError(response.status);
}

function statusError(status: number): SpeechError {
  if (status === 402) return new SpeechError("payment_required", "ElevenLabs requires a paid plan for this voice or request. Use a voice available on your plan, or update your ElevenLabs subscription.");
  if (status === 401 || status === 403) return new SpeechError("auth_failed", "ElevenLabs rejected the API key. Check the key in Listening settings.");
  if (status === 404) return new SpeechError("voice_unavailable", "The ElevenLabs voice is unavailable. Check the Voice ID in Listening settings.");
  if (status === 429) return new SpeechError("rate_limited", "ElevenLabs is rate-limiting requests or your quota is exhausted. Check your account and try again later.");
  return new SpeechError("provider_failed", "ElevenLabs could not generate this audio. Check your account or try again.");
}

function readModels(value: unknown): ModelInfo[] {
  if (!Array.isArray(value)) throw new SpeechError("provider_failed", "ElevenLabs returned an unreadable model list.");
  const models: ModelInfo[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const model = item as Record<string, unknown>;
    if (model.can_do_text_to_speech !== true || model.requires_alpha_access === true) continue;
    if (typeof model.model_id !== "string" || !model.model_id) continue;
    const maxTextLength = model.maximum_text_length_per_request;
    if (typeof maxTextLength !== "number" || !Number.isSafeInteger(maxTextLength) || maxTextLength < 1) continue;
    const languages = Array.isArray(model.languages)
      ? [...new Set(model.languages.flatMap(language => {
        const id = language && typeof language === "object" ? (language as Record<string, unknown>).language_id : undefined;
        return typeof id === "string" && isLanguageTag(id) ? [baseLanguage(id)] : [];
      }))].sort()
      : [];
    models.push({ id: model.model_id, label: typeof model.name === "string" && model.name.trim() ? model.name : model.model_id, maxTextLength, languages });
  }
  return models;
}

/** No automatic retries: a failed connection may already have been billed. */
export function createElevenLabsProvider(options: { fetch?: typeof fetch; timeoutMs?: (text: string) => number } = {}): TtsProvider {
  const fetcher = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timeoutFor = options.timeoutMs ?? generationTimeoutMs;

  async function withTimeout<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new SpeechError("timeout", "Speech generation took too long. Try again."));
      }, ms);
    });
    try {
      return await Promise.race([work(controller.signal), timeout]);
    } catch (error) {
      if (error instanceof SpeechError) throw error;
      if (controller.signal.aborted) throw new SpeechError("timeout", "Speech generation took too long. Try again.");
      throw new SpeechError("provider_failed", "Could not reach ElevenLabs. Check your connection and try again.");
    } finally { clearTimeout(timer); }
  }

  return {
    id: "elevenlabs",
    label: "ElevenLabs",
    preferredDefaultModel: "eleven_flash_v2_5",
    isReady(settings: ProviderSettings, hasKey: boolean) {
      return hasKey && settings.voiceId.trim() !== "" && settings.model?.id === settings.modelId;
    },
    validateKeyShape(key: string) {
      if (!key) return "Enter an API key.";
      if (/\s/.test(key)) return "API keys contain no spaces or line breaks.";
      if (!/^[\x21-\x7e]+$/.test(key)) return "API keys contain only plain letters, digits and symbols.";
      if (key.length < 20 || key.length > 200) return "That does not look like an ElevenLabs API key.";
      return undefined;
    },
    listModels(apiKey: string) {
      return withTimeout(TIMEOUT_LIST_MS, async signal => {
        const response = await fetcher(`${API}/models`, { headers: { "xi-api-key": apiKey, Accept: "application/json" }, signal, redirect: "error" });
        if (!response.ok) throw await failure(response, "Models: Read");
        let body: unknown;
        try { body = await response.json(); }
        catch { throw new SpeechError("provider_failed", "ElevenLabs returned an unreadable model list."); }
        return readModels(body);
      });
    },
    synthesize({ text, language, voiceId, model, apiKey }: SynthesisRequest): Promise<SpeechAudio> {
      return withTimeout(timeoutFor(text), async signal => {
        const response = await fetcher(`${API}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`, {
          method: "POST",
          headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: JSON.stringify({ text, model_id: model.id, ...(NO_LANGUAGE_CODE_MODELS.has(model.id) ? {} : { language_code: language }) }),
          signal,
          redirect: "error",
        });
        if (!response.ok) throw await failure(response, "Text to Speech");
        const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        if (mimeType !== "audio/mpeg" && mimeType !== "audio/mp3") {
          void response.body?.cancel().catch(() => {});
          throw new SpeechError("invalid_audio", "The speech service returned an unsupported audio format.");
        }
        return { audio: await readAudio(response, maxAudioBytes(text), signal), mimeType: "audio/mpeg" };
      });
    },
  };
}
