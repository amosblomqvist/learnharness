import path from "node:path";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { createSettingsStore, isRecord, type ListeningSettings } from "./settings-store.ts";
import { createSpeechCache, type SpeechCache } from "./speech/cache.ts";
import { createElevenLabsProvider } from "./speech/elevenlabs.ts";
import { SpeechError } from "./speech/limits.ts";
import { chooseModel, type ModelInfo, type TtsProvider } from "./speech/provider.ts";
import { createSpeechService } from "./speech/service.ts";

/** What the settings page may see. The API key itself is never included. */
export interface ListeningStatus {
  providers: { id: string; label: string }[];
  provider: string;
  hasKey: boolean;
  voiceId: string;
  modelId: string;
  model?: ModelInfo;
  ready: boolean;
  /** Shown once on the settings page when saved files were unreadable and reset. */
  notice?: string;
}

function record(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) throw new Error("Expected an object.");
  return input;
}

export interface ListeningBackendOptions {
  providers?: TtsProvider[];
  cache?: SpeechCache;
}

export function activate(ctx: PluginBackendContext, options: ListeningBackendOptions = {}): () => void {
  const providers = new Map((options.providers ?? [createElevenLabsProvider()]).map(provider => [provider.id, provider]));
  const store = createSettingsStore(ctx.dataDirectory);
  const cache = options.cache ?? createSpeechCache({ directory: path.join(ctx.dataDirectory, "cache", "speech") });
  let disposed = false;
  const assertActive = () => { if (disposed || ctx.signal.aborted) throw new Error("Listening is disabled."); };
  const providerFor = (settings: ListeningSettings) => {
    const provider = providers.get(settings.provider);
    if (!provider) throw new Error(`Unknown speech provider "${settings.provider}".`);
    return provider;
  };
  const isReady = (settings: ListeningSettings) => {
    const provider = providers.get(settings.provider);
    return provider !== undefined && provider.isReady(settings, store.hasKey(provider.id));
  };
  const status = (): ListeningStatus => {
    const settings = store.settings();
    return {
      providers: [...providers.values()].map(({ id, label }) => ({ id, label })),
      provider: settings.provider,
      hasKey: store.hasKey(settings.provider),
      voiceId: settings.voiceId,
      modelId: settings.modelId,
      ...(settings.model ? { model: settings.model } : {}),
      ready: isReady(settings),
      ...(store.notice ? { notice: store.notice } : {}),
    };
  };

  const speech = createSpeechService({
    cache,
    selection: () => { const settings = store.settings(); return { ...settings, provider: providerFor(settings) }; },
    key: provider => store.key(provider),
  });

  const changed = () => { const next = status(); ctx.events.emit("status-changed", next); return next; };

  /** The last live model list per provider; model choices must come from it. */
  const listed = new Map<string, ModelInfo[]>();

  /** Refresh the selected model's snapshot from the live list (G15). A saved model that is
   * missing from the list is kept as it is; the settings page warns about it. */
  const listModels = async () => {
    const settings = store.settings();
    const provider = providerFor(settings);
    const apiKey = store.key(provider.id);
    if (!apiKey) throw new SpeechError("key_missing", `Add your ${provider.label} API key first.`);
    const models = await provider.listModels(apiKey);
    assertActive();
    listed.set(provider.id, models);
    const current = store.settings();
    if (current.provider === settings.provider) {
      const listedModel = models.find(model => model.id === current.modelId);
      // Only a first choice uses the default rule; an existing choice is never replaced silently.
      const selected = listedModel ?? (current.model ? undefined : chooseModel(models, current.modelId, provider.preferredDefaultModel));
      if (selected && JSON.stringify(selected) !== JSON.stringify(current.model)) store.saveSettings({ ...current, modelId: selected.id, model: selected });
    }
    return { models, status: changed() };
  };

  const handlers = [
    ctx.handle("get-status", () => { assertActive(); return status(); }),
    ctx.handle("save-key", input => {
      assertActive();
      const { apiKey } = record(input);
      if (typeof apiKey !== "string") throw new Error("Expected an API key.");
      const provider = providerFor(store.settings());
      const problem = provider.validateKeyShape(apiKey);
      if (problem) throw new Error(problem);
      store.saveKey(provider.id, apiKey);
      return changed();
    }),
    ctx.handle("remove-key", () => {
      assertActive();
      store.removeKey(providerFor(store.settings()).id);
      return changed();
    }),
    ctx.handle("save-settings", input => {
      assertActive();
      const patch = record(input);
      const current = store.settings();
      const next = { ...current };
      for (const key of Object.keys(patch)) if (!["provider", "voiceId", "modelId"].includes(key)) throw new Error(`Unknown setting "${key}".`);
      if (patch.provider !== undefined) {
        if (typeof patch.provider !== "string" || !providers.has(patch.provider)) throw new Error("Unknown speech provider.");
        if (patch.provider !== current.provider) { next.provider = patch.provider; delete next.model; }
      }
      if (patch.voiceId !== undefined) {
        if (typeof patch.voiceId !== "string" || patch.voiceId.length > 200 || /[\u0000-\u001f]/.test(patch.voiceId)) throw new Error("Enter a valid Voice ID.");
        next.voiceId = patch.voiceId.trim();
      }
      if (patch.modelId !== undefined) {
        if (typeof patch.modelId !== "string" || !patch.modelId) throw new Error("Choose a model.");
        const model = listed.get(next.provider)?.find(candidate => candidate.id === patch.modelId);
        if (!model) throw new Error("Reload the model list and choose a model again.");
        next.modelId = model.id;
        next.model = model;
      }
      store.saveSettings(next);
      return changed();
    }),
    ctx.handle("list-models", () => { assertActive(); return listModels(); }),
    ctx.handle("synthesize", async input => {
      assertActive();
      try {
        const result = await speech(input);
        return { mimeType: result.mimeType, audioBase64: Buffer.from(result.audio).toString("base64"), cache: result.cache, ...(result.warning ? { warning: result.warning } : {}) };
      } catch (error) {
        // Only readable speech errors reach the learner; everything else stays generic.
        if (error instanceof SpeechError) throw new Error(error.message);
        throw new Error("Speech is unavailable. Try again.");
      }
    }),
  ];

  return () => {
    if (disposed) return;
    disposed = true;
    for (const unregister of handlers) unregister();
  };
}

