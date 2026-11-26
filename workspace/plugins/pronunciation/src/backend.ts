import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginBackendContext } from "learnharness-plugin-api";
import type { InstallState, PluginState, SpeakResult } from "./contract.ts";
import { isHanPhrase } from "./han.ts";
import { LINUX, WINDOWS, cleanLeftovers, installVoice, isInstalled, pendingBytes, removeVoice, retireOutdated, type InstallTarget } from "./install.ts";
import { CUDA, DIRECTML, Engine, SAMPLE_RATE, type Accelerator, type OrtModule } from "./engine.ts";
import { encodeWav } from "./wav.ts";

export interface BackendOptions {
  platform?: string;
  arch?: string;
  /** Overrides parts of the platform's install target. */
  install?: Partial<InstallTarget> & { fetch?: typeof globalThis.fetch };
  runtime?: (directory: string, accelerator: Accelerator) => OrtModule;
}

/** Supported platforms: what each downloads and which GPU provider it runs on. */
const PLATFORMS: Record<string, { install: InstallTarget; accelerator: Accelerator }> = {
  "win32/x64": { install: WINDOWS, accelerator: DIRECTML },
  "linux/x64": { install: LINUX, accelerator: CUDA },
};
export const UNSUPPORTED = "Chinese pronunciation needs Windows (x64) with a DirectML-capable GPU, or Linux (x64) with an NVIDIA GPU.";

const PROGRESS_INTERVAL_MS = 250;
export const NOT_INSTALLED = "Download the voice model first: Settings → Chinese pronunciation.";

export function activate(ctx: PluginBackendContext): () => void {
  return activateWith(ctx, {});
}

export function activateWith(ctx: PluginBackendContext, options: BackendOptions): () => void {
  const directory = ctx.dataDirectory;
  const platform = PLATFORMS[`${options.platform ?? process.platform}/${options.arch ?? process.arch}`];
  const { fetch, ...overrides } = options.install ?? {};
  const target: InstallTarget | undefined = platform && { ...platform.install, ...overrides };
  cleanLeftovers(directory);
  // The earlier Kokoro voice kept a voice choice here; there is only one voice now.
  fs.rmSync(path.join(directory, "settings.json"), { force: true });
  if (target && retireOutdated(directory, target)) console.info("[pronunciation] Removed the files of an earlier voice; download the new voice in settings.");
  let install: InstallState = !target
    ? { kind: "unsupported", reason: UNSUPPORTED }
    : isInstalled(directory, target) ? { kind: "installed" } : { kind: "missing" };
  const epoch = randomUUID();
  let sequence = 0;
  let engine: Promise<Engine> | undefined;
  let downloading = false;
  let disposed = false;

  const downloadBytes = () => target ? pendingBytes(directory, target) : 0;
  const snapshot = (): PluginState => ({ epoch, sequence, install: { ...install }, downloadBytes: downloadBytes() });
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

  const startDownload = (target: InstallTarget) => {
    downloading = true;
    install = { kind: "downloading", step: "voice model", received: 0, total: downloadBytes() };
    let last = 0;
    void installVoice({
      target, fetch, dataDirectory: directory, signal: ctx.signal,
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
    ctx.handle("download", () => {
      assertActive();
      if (target && (install.kind === "missing" || install.kind === "failed")) { startDownload(target); return publish(); }
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
      if (!platform) throw new Error(UNSUPPORTED);
      if (install.kind !== "installed") throw new Error(NOT_INSTALLED);
      const loading = engine ??= Engine.load(directory, platform.accelerator, options.runtime);
      let loaded: Engine;
      try { loaded = await loading; }
      catch (error) {
        if (engine === loading) engine = undefined;
        throw error;
      }
      assertActive();
      const samples = await loaded.synthesize(text);
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
