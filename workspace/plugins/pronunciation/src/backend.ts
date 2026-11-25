import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { DEFAULT_SETTINGS, VOICES, isVoice, parseSettings, type InstallState, type PluginState, type Settings, type SpeakResult } from "./contract.ts";
import { isHanPhrase } from "./han.ts";
import { TOTAL_BYTES, cleanLeftovers, installVoice, isInstalled, removeVoice, type InstallOptions } from "./install.ts";
import { Engine, SAMPLE_RATE, type OrtModule } from "./engine.ts";
import { encodeWav } from "./wav.ts";

export interface BackendOptions {
  platform?: string;
  arch?: string;
  install?: Pick<InstallOptions, "assets" | "marker" | "fetch" | "extract">;
  runtime?: (directory: string) => OrtModule;
}

const PROGRESS_INTERVAL_MS = 250;
export const NOT_INSTALLED = "Download the voice model first: Settings → Chinese pronunciation.";

export function activate(ctx: PluginBackendContext): () => void {
  return activateWith(ctx, {});
}

export function activateWith(ctx: PluginBackendContext, options: BackendOptions): () => void {
  const directory = ctx.dataDirectory;
  const settingsFile = path.join(directory, "settings.json");
  let settings: Settings;
  try { settings = parseSettings(JSON.parse(fs.readFileSync(settingsFile, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    settings = { ...DEFAULT_SETTINGS };
  }
  const supported = (options.platform ?? process.platform) === "win32" && (options.arch ?? process.arch) === "x64";
  cleanLeftovers(directory);
  let install: InstallState = !supported
    ? { kind: "unsupported", reason: "Chinese pronunciation needs Windows (x64) with a DirectML-capable GPU." }
    : isInstalled(directory, options.install?.marker) ? { kind: "installed" } : { kind: "missing" };
  const epoch = randomUUID();
  let sequence = 0;
  let engine: Promise<Engine> | undefined;
  let downloading = false;
  let disposed = false;

  const snapshot = (): PluginState => ({ epoch, sequence, settings: { ...settings }, install: { ...install }, downloadBytes: TOTAL_BYTES });
  const publish = (): PluginState => {
    sequence++;
    const state = snapshot();
    if (!disposed && !ctx.signal.aborted) ctx.events.emit("state-changed", state);
    return state;
  };
  const assertActive = () => { if (disposed || ctx.signal.aborted) throw new Error("Chinese pronunciation is disabled."); };
  const input = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request.");
    return value as Record<string, unknown>;
  };

  const unloadEngine = async () => {
    const loading = engine;
    engine = undefined;
    const loaded = await loading?.catch(() => undefined);
    await loaded?.release();
  };

  const startDownload = () => {
    downloading = true;
    install = { kind: "downloading", step: "voice model", received: 0, total: TOTAL_BYTES };
    let last = 0;
    void installVoice({
      ...options.install, dataDirectory: directory, signal: ctx.signal,
      onProgress(progress) {
        install = { kind: "downloading", ...progress };
        const now = Date.now();
        if (now - last >= PROGRESS_INTERVAL_MS) { last = now; publish(); }
      },
    }).then(
      () => { install = { kind: "installed" }; },
      (error: unknown) => { install = { kind: "failed", message: error instanceof Error ? error.message : String(error) }; },
    ).finally(() => {
      downloading = false;
      if (!ctx.signal.aborted) publish();
    });
  };

  const handlers = [
    ctx.handle("get-state", () => { assertActive(); return snapshot(); }),
    ctx.handle("set-voice", value => {
      assertActive();
      const voice = input(value).voice;
      if (!isVoice(voice)) throw new Error("Unknown voice.");
      if (voice === settings.voice) return snapshot();
      if (settings.revision === Number.MAX_SAFE_INTEGER) throw new Error("Settings revision limit reached.");
      const next: Settings = { revision: settings.revision + 1, voice };
      fs.mkdirSync(directory, { recursive: true });
      const temporary = path.join(directory, `.settings-${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, JSON.stringify(next) + "\n", { flag: "wx", mode: 0o600 });
        fs.renameSync(temporary, settingsFile);
      } finally { fs.rmSync(temporary, { force: true }); }
      settings = next;
      return publish();
    }),
    ctx.handle("download", () => {
      assertActive();
      if (install.kind === "missing" || install.kind === "failed") { startDownload(); return publish(); }
      return snapshot();
    }),
    ctx.handle("remove", async () => {
      assertActive();
      if (downloading) throw new Error("Wait for the download to finish before removing it.");
      if (install.kind !== "installed" && install.kind !== "failed") return snapshot();
      await unloadEngine();
      assertActive();
      const leftover = removeVoice(directory);
      install = { kind: "missing" };
      const state = publish();
      if (leftover) console.warn("[pronunciation] Some runtime files are still in use; they will be deleted the next time the app starts.");
      return state;
    }),
    ctx.handle("speak", async (value): Promise<SpeakResult> => {
      assertActive();
      const text = input(value).text;
      if (typeof text !== "string" || !isHanPhrase(text)) throw new Error("Only Chinese characters can be pronounced.");
      if (install.kind === "unsupported") throw new Error(install.reason);
      if (install.kind !== "installed") throw new Error(NOT_INSTALLED);
      const speaker = VOICES.find(voice => voice.id === settings.voice)!.speaker;
      const loading = engine ??= Engine.load(directory, options.runtime);
      let loaded: Engine;
      try { loaded = await loading; }
      catch (error) {
        if (engine === loading) engine = undefined;
        throw error;
      }
      assertActive();
      const samples = await loaded.synthesize(text, speaker);
      return { wav: Buffer.from(encodeWav(samples, SAMPLE_RATE)).toString("base64") };
    }),
  ];

  return () => {
    if (disposed) return;
    disposed = true;
    handlers.forEach(unregister => unregister());
    void unloadEngine().catch(error => console.error("[pronunciation] Could not unload the voice model.", error));
  };
}
