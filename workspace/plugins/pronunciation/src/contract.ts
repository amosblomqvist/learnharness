/** Browser-safe values shared by the frontend and backend. */

/** Notices shown next to the clicked or tapped text. */
export const PREPARING_TEXT = "Preparing audio…";
export const BLOCKED_TEXT = "The browser blocked audio. Tap the text again.";

/** Longest phrase (in characters) sent for one click. */
export const MAX_PHRASE_CHARS = 100;

export type InstallState =
  | { kind: "unsupported"; reason: string }
  | { kind: "missing" }
  | { kind: "downloading"; step: string; received: number; total: number }
  | { kind: "failed"; message: string }
  | { kind: "installed" };

/**
 * `epoch` identifies one backend activation; `sequence` orders its snapshots.
 * `downloadBytes` is what pressing Download fetches now (less when the runtime is kept).
 */
export interface PluginState { epoch: string; sequence: number; install: InstallState; downloadBytes: number }

export interface SpeakResult { wav: string }

const object = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${what}.`);
  return value as Record<string, unknown>;
};
const count = (value: unknown, what: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${what}.`);
  return value;
};
const text = (value: unknown, what: string): string => {
  if (typeof value !== "string") throw new Error(`Invalid ${what}.`);
  return value;
};

export function parseInstall(value: unknown): InstallState {
  const input = object(value, "install state");
  switch (input.kind) {
    case "unsupported": return { kind: "unsupported", reason: text(input.reason, "reason") };
    case "missing": return { kind: "missing" };
    case "installed": return { kind: "installed" };
    case "failed": return { kind: "failed", message: text(input.message, "message") };
    case "downloading": return { kind: "downloading", step: text(input.step, "step"), received: count(input.received, "received bytes"), total: count(input.total, "total bytes") };
    default: throw new Error("Invalid install state.");
  }
}

export function parseState(value: unknown): PluginState {
  const input = object(value, "plugin state");
  return {
    epoch: text(input.epoch, "epoch"), sequence: count(input.sequence, "sequence"),
    install: parseInstall(input.install),
    downloadBytes: count(input.downloadBytes, "download size"),
  };
}

export function parseSpeakResult(value: unknown): SpeakResult {
  const input = object(value, "speech result");
  const wav = text(input.wav, "audio");
  if (!wav) throw new Error("Empty audio.");
  return { wav };
}

const MB = 1024 * 1024;
export const megabytes = (bytes: number): string => `${Math.round(bytes / MB)} MB`;

/** Shown under the download controls. */
export const LICENSE_TEXT = "The voice was trained on the Databaker Chinese Standard Mandarin Speech Corpus, which is licensed for non-commercial use only.";

/** One line describing the install state for the settings page. */
export function describeInstall(install: InstallState, downloadBytes: number): string {
  switch (install.kind) {
    case "unsupported": return install.reason;
    case "missing": return `Not downloaded. The download is about ${megabytes(downloadBytes)}.`;
    case "downloading": return `Downloading ${install.step}… ${megabytes(install.received)} of ${megabytes(install.total)}`;
    case "failed": return `Download failed: ${install.message}`;
    case "installed": return "Ready. Click Chinese text anywhere in the app to hear it.";
  }
}
