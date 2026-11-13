import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ModelInfo } from "./speech/provider.ts";

export interface ListeningSettings {
  provider: string;
  voiceId: string;
  modelId: string;
  /** Snapshot of the selected model, saved whenever the model list loads. */
  model?: ModelInfo;
}

export const DEFAULT_SETTINGS: ListeningSettings = { provider: "elevenlabs", voiceId: "", modelId: "eleven_flash_v2_5" };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readModelInfo(value: unknown): ModelInfo | undefined {
  if (!isRecord(value)) return undefined;
  const { id, label, maxTextLength, languages } = value;
  if (typeof id !== "string" || !id || typeof label !== "string" || typeof maxTextLength !== "number" || !Number.isSafeInteger(maxTextLength) || maxTextLength < 1) return undefined;
  if (!Array.isArray(languages) || !languages.every(language => typeof language === "string")) return undefined;
  return { id, label, maxTextLength, languages: [...languages] };
}

function readSettings(value: unknown): ListeningSettings {
  if (!isRecord(value) || value.version !== 1) throw new Error("Listening settings are unreadable.");
  const settings: ListeningSettings = {
    provider: typeof value.provider === "string" && value.provider ? value.provider : DEFAULT_SETTINGS.provider,
    voiceId: typeof value.voiceId === "string" ? value.voiceId : DEFAULT_SETTINGS.voiceId,
    modelId: typeof value.modelId === "string" && value.modelId ? value.modelId : DEFAULT_SETTINGS.modelId,
  };
  const model = readModelInfo(value.model);
  return model ? { ...settings, model } : settings;
}

function readKeys(value: unknown): Record<string, string> {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.keys)) throw new Error("Listening credentials are unreadable.");
  return Object.fromEntries(Object.entries(value.keys).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""));
}

/** A missing file is the default. An unreadable one is also treated as the default, so the
 * plugin still activates and the settings page can write a fresh file over it. */
function readJson<T>(file: string, parse: (value: unknown) => T, fallback: T): { value: T; unreadable: boolean } {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: fallback, unreadable: false };
    throw error;
  }
  try { return { value: parse(JSON.parse(text)), unreadable: false }; }
  catch { return { value: fallback, unreadable: true }; }
}

/** Owner-only atomic write: a crash leaves either the old or the new file. */
function writeJson(directory: string, file: string, value: unknown): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** Plugin-owned settings and API keys. Keys never leave the backend. */
export function createSettingsStore(directory: string) {
  const settingsFile = path.join(directory, "settings.json");
  const credentialsFile = path.join(directory, "credentials.json");
  const savedSettings = readJson(settingsFile, readSettings, { ...DEFAULT_SETTINGS });
  const savedKeys = readJson<Record<string, string>>(credentialsFile, readKeys, {});
  let settings = savedSettings.value;
  let keys = savedKeys.value;
  const unreadable = [savedSettings.unreadable && "settings", savedKeys.unreadable && "API key"].filter(Boolean);
  return {
    /** Set when saved files could not be read at startup and defaults were used instead. */
    notice: unreadable.length ? `The saved Listening ${unreadable.join(" and ")} file could not be read, so it was reset. Enter your settings again.` : undefined,
    settings(): ListeningSettings { return structuredClone(settings); },
    key(provider: string): string | undefined { return keys[provider]; },
    hasKey(provider: string): boolean { return keys[provider] !== undefined; },
    saveSettings(next: ListeningSettings): ListeningSettings {
      const value = structuredClone(next);
      writeJson(directory, settingsFile, { version: 1, ...value });
      settings = value;
      return structuredClone(settings);
    },
    saveKey(provider: string, apiKey: string): void {
      const next = { ...keys, [provider]: apiKey };
      writeJson(directory, credentialsFile, { version: 1, keys: next });
      keys = next;
    },
    removeKey(provider: string): void {
      const next = { ...keys };
      delete next[provider];
      writeJson(directory, credentialsFile, { version: 1, keys: next });
      keys = next;
    },
  };
}
export type SettingsStore = ReturnType<typeof createSettingsStore>;
