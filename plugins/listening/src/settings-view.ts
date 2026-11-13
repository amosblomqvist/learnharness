import type { PluginFrontendContext, PluginSettingsSchema, PluginWidgetHandle } from "learnharness-plugin-api";
import type { ListeningStatus } from "./backend.ts";
import { element } from "./dom.ts";
import { SPEECH_CACHE_MAX_BYTES } from "./speech/limits.ts";
import type { ModelInfo } from "./speech/provider.ts";

type Ctx = Pick<PluginFrontendContext, "call" | "ui" | "onNotification" | "signal">;

const message = (error: unknown) => error instanceof Error && error.message ? error.message : "Something went wrong. Try again.";

/**
 * Provider · API key (masked, never read back) · Voice ID · Model (live list), plus notes.
 * The host stores nothing; every change goes through the backend and is published after it saves.
 */
export function mountSettings(container: HTMLElement, hostSignal: AbortSignal, ctx: Ctx): () => void {
  const document = container.ownerDocument;
  const scope = new AbortController();
  const signal = scope.signal;
  const abort = () => scope.abort();
  hostSignal.addEventListener("abort", abort, { once: true });
  ctx.signal.addEventListener("abort", abort, { once: true });

  const root = element(document, "div", "lh-listening-settings");
  const readiness = element(document, "p", "lh-listening-settings__readiness");
  readiness.setAttribute("role", "status");
  const notice = element(document, "p", "lh-listening-settings__error");
  notice.setAttribute("role", "status");
  const providerSlot = element(document, "div", "");
  const keyBlock = element(document, "div", "lh-listening-key");
  const rowsSlot = element(document, "div", "");
  const error = element(document, "p", "lh-listening-settings__error");
  error.setAttribute("role", "alert");
  const cacheNote = element(document, "p", "lh-listening-settings__note",
    `Generated audio is cached on this computer, up to ${SPEECH_CACHE_MAX_BYTES / (1024 * 1024)} MiB; the oldest clips are removed first. Spoken text is sent to the provider only when its audio is not cached yet. Audio generation and replay limits are described in the plugin README.`);
  root.append(readiness, notice, providerSlot, keyBlock, rowsSlot, error, cacheNote);
  container.append(root);

  // API key: a password field that is only ever written, never filled from the backend.
  const keyLabel = element(document, "label", "lh-listening-key__label");
  const keyName = element(document, "span", "lh-listening-key__name");
  const keyState = element(document, "span", "lh-listening-key__state");
  keyLabel.append(keyName, keyState);
  const keyRow = element(document, "div", "lh-listening-key__row");
  const keyInput = element(document, "input", "lh-listening-key__input");
  keyInput.type = "password";
  keyInput.autocomplete = "off";
  keyInput.spellcheck = false;
  keyInput.id = `lh-listening-key-${crypto.randomUUID()}`;
  keyLabel.htmlFor = keyInput.id;
  const saveKey = element(document, "button", "lh-listening-button", "Save key");
  saveKey.type = "button";
  const removeKey = element(document, "button", "lh-listening-button", "Remove");
  removeKey.type = "button";
  keyRow.append(keyInput, saveKey, removeKey);
  const keyHint = element(document, "p", "lh-listening-settings__hint", "Stored only on this computer, in the Listening plugin's data folder. It is never shown again; to change it, save a new one.");
  // Restricted ElevenLabs keys need these two permissions: one per call the plugin makes.
  const keyPermissions = element(document, "p", "lh-listening-settings__hint", "When you create the key in ElevenLabs, allow \"Text to Speech\" and \"Models: Read\".");
  keyBlock.append(keyLabel, keyRow, keyPermissions, keyHint);

  let status: ListeningStatus | undefined;
  let models: ModelInfo[] | undefined;
  let modelsError: string | undefined;
  let providerRows: PluginWidgetHandle<PluginSettingsSchema> | undefined;
  let rows: PluginWidgetHandle<PluginSettingsSchema> | undefined;
  let busy = false;

  const providerLabel = () => status?.providers.find(provider => provider.id === status?.provider)?.label ?? "Provider";
  const showError = (cause: unknown) => { if (!signal.aborted) error.textContent = message(cause); };
  const providerSchema = (current: ListeningStatus): PluginSettingsSchema => ({
    rows: [{
      key: "provider", type: "dropdown", label: "Provider", value: current.provider,
      options: current.providers.map(({ id, label }) => ({ value: id, label })),
      description: current.providers.length === 1
        ? `The text-to-speech service that voices listening questions. ${current.providers[0]!.label} is the only one for now; more providers may be added later.`
        : "The text-to-speech service that voices listening questions.",
      onChange: async provider => { await save({ provider }); },
    }],
  });
  const rowsSchema = (current: ListeningStatus): PluginSettingsSchema => {
    const savedLabel = current.model?.label ?? current.modelId;
    const unlisted = models !== undefined && !models.some(model => model.id === current.modelId);
    const options = models
      ? [...models.map(model => ({ value: model.id, label: model.label })), ...(unlisted ? [{ value: current.modelId, label: `${savedLabel} (not in your account's list)` }] : [])]
      : [{ value: current.modelId, label: savedLabel }];
    return {
      rows: [
        {
          key: "voiceId", type: "text", label: "Voice ID", value: current.voiceId,
          description: "Copy a Voice ID from your ElevenLabs voice library. Pick one voice that suits the language you are studying; it speaks every listening question.",
          validate: value => value.length > 200 ? "Voice IDs are shorter than 200 characters." : undefined,
          onChange: async voiceId => { await save({ voiceId }); },
        },
        {
          key: "model", type: "dropdown", label: "Model", value: current.modelId, options,
          disabled: !models,
          description: modelsError ? `Couldn't load models: ${modelsError}`
            : unlisted ? `${savedLabel} is no longer in your account's model list. It stays selected, but generating new audio may fail; choose another model.`
            : models ? "Loaded from your account. The model decides which languages work and how long the spoken text may be."
              : current.hasKey ? "Loading models…" : "Save an API key to load the models available to you.",
          onChange: async modelId => { await save({ modelId }); },
        },
      ],
    };
  };
  const render = () => {
    if (!status || signal.aborted) return;
    readiness.textContent = status.ready
      ? `Ready: Listening can generate speech with ${status.model?.label ?? status.modelId}.`
      : `Not ready: ${[!status.hasKey && "an API key", !status.voiceId && "a Voice ID", status.model?.id !== status.modelId && "a model"].filter(Boolean).join(", ")} still needed.`;
    readiness.dataset.ready = String(status.ready);
    notice.textContent = status.notice ?? "";
    keyName.textContent = `${providerLabel()} API key`;
    keyPermissions.hidden = status.provider !== "elevenlabs";
    keyState.textContent = status.hasKey ? "Saved" : "Not set";
    keyInput.placeholder = status.hasKey ? "Enter a new key to replace the saved one" : "Paste your API key";
    removeKey.hidden = !status.hasKey;
    saveKey.disabled = busy;
    removeKey.disabled = busy;
    if (providerRows) providerRows.update(providerSchema(status));
    else providerRows = ctx.ui.mountSettingsRows(providerSlot, providerSchema(status), { signal });
    if (rows) rows.update(rowsSchema(status));
    else rows = ctx.ui.mountSettingsRows(rowsSlot, rowsSchema(status), { signal });
  };
  const apply = (next: ListeningStatus) => {
    if (signal.aborted) return;
    const providerChanged = status !== undefined && status.provider !== next.provider;
    const keyChanged = status !== undefined && status.hasKey !== next.hasKey;
    status = next;
    if (providerChanged || keyChanged) { models = undefined; modelsError = undefined; }
    render();
    if (next.hasKey && !models && !modelsError && !loadingModels) void loadModels();
  };
  let loadingModels = false;
  const loadModels = async () => {
    loadingModels = true;
    try {
      const result = await ctx.call<{ models: ModelInfo[]; status: ListeningStatus }>("list-models");
      if (signal.aborted) return;
      models = result.models;
      modelsError = undefined;
      status = result.status;
      render();
    } catch (cause) {
      if (signal.aborted) return;
      modelsError = message(cause);
      render();
    } finally { loadingModels = false; }
  };
  const save = async (patch: Record<string, string>) => {
    try { apply(await ctx.call<ListeningStatus>("save-settings", patch)); error.textContent = ""; }
    catch (cause) { showError(cause); throw cause; }
  };
  const run = async (operation: () => Promise<ListeningStatus>) => {
    if (busy) return;
    busy = true; render();
    try { apply(await operation()); error.textContent = ""; }
    catch (cause) { showError(cause); }
    finally { busy = false; render(); }
  };
  saveKey.addEventListener("click", () => {
    const apiKey = keyInput.value.trim();
    void run(async () => {
      const next = await ctx.call<ListeningStatus>("save-key", { apiKey });
      keyInput.value = "";
      // A new key may see different models, and it may fix an earlier failed load.
      models = undefined;
      modelsError = undefined;
      return next;
    });
  }, { signal });
  keyInput.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); saveKey.click(); } }, { signal });
  removeKey.addEventListener("click", () => { void run(() => ctx.call<ListeningStatus>("remove-key")); }, { signal });

  const unsubscribe = ctx.onNotification(event => {
    if (event.topic === "status-changed" && event.data && typeof event.data === "object") {
      const next = event.data as ListeningStatus;
      // Another window changed settings: adopt it without discarding a loaded model list.
      if (status && JSON.stringify(next) !== JSON.stringify(status)) apply(next);
    }
  });
  void ctx.call<ListeningStatus>("get-status").then(apply, showError);

  return () => {
    hostSignal.removeEventListener("abort", abort);
    ctx.signal.removeEventListener("abort", abort);
    scope.abort();
    unsubscribe();
    root.remove();
  };
}
