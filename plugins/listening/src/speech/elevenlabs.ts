import { generationTimeoutMs, isLanguageTag, maxAudioBytes, SpeechError } from "./limits.ts";
import { baseLanguage, type ModelInfo, type ProviderSettings, type SpeechAudio, type SynthesisRequest, type TtsProvider } from "./provider.ts";

const API = "https://api.elevenlabs.io/v1";
const OUTPUT_FORMAT = "mp3_44100_128";
const TIMEOUT_LIST_MS = 15_000;
/** ElevenLabs ignores language_code on this model and rejects it on some requests. */
const NO_LANGUAGE_CODE_MODELS = new Set(["eleven_multilingual_v2"]);

/** Bounded binary reader: do not trust Content-Length alone. */
async function readBody(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
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
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

/** MP3 starts with an ID3 tag or an MPEG frame header. This also catches an
 * upstream JSON/HTML error mislabeled as audio/mpeg. */
function checkMp3(audio: Uint8Array): Uint8Array {
  const id3 = audio.byteLength >= 10 && audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33;
  const frame = audio.byteLength >= 4 && audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0;
  if (!id3 && !frame) throw new SpeechError("invalid_audio", "The speech service returned unusable audio. Try again.");
  return audio;
}

async function readAudio(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  return checkMp3(await readBody(response, limit, signal));
}

/** Error replies are about 300 bytes; past this the status is not read and the HTTP code decides. */
const ERROR_REPLY_LIMIT = 64 * 1024;
/** Lists and lookups: the model list is about 50 KB. */
const JSON_REPLY_LIMIT = 2 * 1024 * 1024;

/** Bounded JSON reader: `unreadable` is thrown for a reply that is missing, too large or not JSON.
 * Cancellation (the signal) is rethrown as it is. */
async function readJson(response: Response, limit: number, signal: AbortSignal, unreadable: string): Promise<unknown> {
  let bytes: Uint8Array;
  try { bytes = await readBody(response, limit, signal); }
  catch (error) {
    if (signal.aborted) throw error;
    throw new SpeechError("provider_failed", unreadable);
  }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new SpeechError("provider_failed", unreadable); }
}

/** The permission each call needs on a restricted ElevenLabs key, as the ElevenLabs dashboard names it. */
type KeyPermission = "Models: Read" | "Text to Speech";

/** The `detail.status` of an ElevenLabs JSON error reply, such as "quota_exceeded". */
async function replyStatus(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.headers.get("content-type")?.includes("json")) {
    void response.body?.cancel().catch(() => {});
    return undefined;
  }
  let body: unknown;
  try { body = await readJson(response, ERROR_REPLY_LIMIT, signal, "unreadable"); }
  catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  }
  const detail = body && typeof body === "object" ? (body as Record<string, unknown>).detail : undefined;
  return detail && typeof detail === "object" ? (detail as Record<string, unknown>).status : undefined;
}

/** Reads the failure reply only for its status, because ElevenLabs reports a wrong key, a
 * missing key permission, a used-up quota and an unknown model as 400 or 401. The reply text is never shown. */
async function failure(response: Response, permission: KeyPermission, signal: AbortSignal): Promise<SpeechError> {
  let status: unknown;
  if (response.status === 400 || response.status === 401 || response.status === 403) status = await replyStatus(response, signal);
  else void response.body?.cancel().catch(() => {});
  if (status === "missing_permissions") {
    return new SpeechError("auth_failed", permission === "Models: Read"
      ? "This API key can't read your ElevenLabs model list. Edit the key in ElevenLabs and turn on \"Models: Read\", or create a new key with it."
      : "This API key can't generate speech. Edit the key in ElevenLabs and turn on \"Text to Speech\", or create a new key with it.");
  }
  if (status === "quota_exceeded") return new SpeechError("quota_exceeded", "Your ElevenLabs credits are used up. Add credits or wait for your quota to reset, then try again.");
  if (status === "invalid_api_key") return statusError(401);
  // The saved model was withdrawn or renamed; the snapshot still names it.
  if (status === "model_not_found") return new SpeechError("model_unavailable", "ElevenLabs no longer offers the saved model. Open Listening settings, reload the model list and choose a model again.");
  return statusError(response.status);
}

function statusError(status: number): SpeechError {
  if (status === 402) return new SpeechError("payment_required", "ElevenLabs requires a paid plan for this voice or request. Use a voice available on your plan, or update your ElevenLabs subscription.");
  if (status === 401 || status === 403) return new SpeechError("auth_failed", "ElevenLabs rejected the API key. Check the key in Listening settings.");
  if (status === 404) return new SpeechError("voice_unavailable", "The ElevenLabs voice is unavailable. Check the Voice ID in Listening settings.");
  if (status === 429) return new SpeechError("rate_limited", "ElevenLabs is rate-limiting requests. Wait a moment and try again.");
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

  /** `outer` is the plugin's lifetime: when it ends, the request is cancelled and its reason rethrown. */
  async function withTimeout<T>(ms: number, work: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
    outer?.throwIfAborted();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new SpeechError("timeout", "Speech generation took too long. Try again."));
      }, ms);
      if (outer) {
        cancel = () => { controller.abort(outer.reason); reject(outer.reason); };
        outer.addEventListener("abort", cancel, { once: true });
      }
    });
    try {
      return await Promise.race([work(controller.signal), stopped]);
    } catch (error) {
      if (outer?.aborted) throw outer.reason;
      if (error instanceof SpeechError) throw error;
      if (controller.signal.aborted) throw new SpeechError("timeout", "Speech generation took too long. Try again.");
      throw new SpeechError("provider_failed", "Could not reach ElevenLabs. Check your connection and try again.");
    } finally {
      clearTimeout(timer);
      if (cancel) outer?.removeEventListener("abort", cancel);
    }
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
    listModels(apiKey: string, lifetime?: AbortSignal) {
      return withTimeout(TIMEOUT_LIST_MS, async signal => {
        const response = await fetcher(`${API}/models`, { headers: { "xi-api-key": apiKey, Accept: "application/json" }, signal, redirect: "error" });
        if (!response.ok) throw await failure(response, "Models: Read", signal);
        return readModels(await readJson(response, JSON_REPLY_LIMIT, signal, "ElevenLabs returned an unreadable model list."));
      }, lifetime);
    },
    synthesize({ text, language, voiceId, model, apiKey, lifetime }: SynthesisRequest): Promise<SpeechAudio> {
      return withTimeout(timeoutFor(text), async signal => {
        const response = await fetcher(`${API}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`, {
          method: "POST",
          headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: JSON.stringify({ text, model_id: model.id, ...(NO_LANGUAGE_CODE_MODELS.has(model.id) ? {} : { language_code: language }) }),
          signal,
          redirect: "error",
        });
        if (!response.ok) throw await failure(response, "Text to Speech", signal);
        const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        if (mimeType !== "audio/mpeg" && mimeType !== "audio/mp3") {
          void response.body?.cancel().catch(() => {});
          throw new SpeechError("invalid_audio", "The speech service returned an unsupported audio format.");
        }
        return { audio: await readAudio(response, maxAudioBytes(text), signal), mimeType: "audio/mpeg" };
      }, lifetime);
    },
  };
}
