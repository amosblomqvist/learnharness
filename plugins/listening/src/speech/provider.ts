/** Text-to-speech provider seam. Only ElevenLabs ships; others plug in here. */

export interface SpeechAudio {
  audio: Uint8Array;
  mimeType: string;
}

/** What the plugin remembers about a model, so startup and validation need no network. */
export interface ModelInfo {
  id: string;
  label: string;
  /** Longest spoken text the model accepts per request, in characters. */
  maxTextLength: number;
  /** Lowercase base language codes the model speaks, such as "en" or "zh". */
  languages: string[];
}

/** Provider-relevant settings. The key is passed separately and never leaves the backend. */
export interface ProviderSettings {
  voiceId: string;
  modelId: string;
  model?: ModelInfo;
}

export interface SynthesisRequest {
  text: string;
  language: string;
  voiceId: string;
  model: ModelInfo;
  apiKey: string;
}

export interface TtsProvider {
  readonly id: string;
  readonly label: string;
  readonly preferredDefaultModel: string;
  /** Live list of models usable for speech with this key. */
  listModels(apiKey: string): Promise<ModelInfo[]>;
  /** Everything needed to synthesize, apart from the key. */
  isReady(settings: ProviderSettings, hasKey: boolean): boolean;
  /** Format check only; the key is never tested against the provider on save. */
  validateKeyShape(key: string): string | undefined;
  synthesize(request: SynthesisRequest): Promise<SpeechAudio>;
}

/** Default rule: the provider's preferred model when listed, otherwise the first. */
export function chooseModel(models: readonly ModelInfo[], savedId: string, preferredId: string): ModelInfo | undefined {
  return models.find(model => model.id === savedId) ?? models.find(model => model.id === preferredId) ?? models[0];
}

/** "pt-BR" → "pt". */
export function baseLanguage(code: string): string {
  return code.split("-")[0]!.toLowerCase();
}
