import { createSpeechPlayer, type LoadedAudio, type PlayerState } from "./player.ts";
import type { PlaybackRate } from "./speech/limits.ts";

export interface AudioControlOptions {
  text: string;
  language: string;
  load(text: string, language: string): Promise<LoadedAudio>;
  signal: AbortSignal;
  /** Pending questions explain the gate; answered replays do not. */
  mode: "pending" | "replay";
  completed?(): boolean;
  onStarted?(rate: PlaybackRate): void;
  onEnded?(rate: PlaybackRate): void;
  onFailed?(): void;
  /** Shown after two failures, while audio is failing. */
  continueAnotherWay?: { available(): boolean; run(): void };
}

const HEADPHONES = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/></svg>';

function button(document: Document, label: string, testId: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "lh-listening-button";
  element.textContent = label;
  element.dataset.testid = testId;
  return element;
}

/** Intentionally never renders the spoken text: it is a post-answer transcript. */
export function mountAudioControl(container: HTMLElement, options: AudioControlOptions): () => void {
  const document = container.ownerDocument;
  const root = document.createElement("div");
  root.className = "lh-listening-audio";
  root.dataset.testid = "listening-audio";
  const row = document.createElement("div");
  row.className = "lh-listening-audio__row";
  const label = document.createElement("span");
  label.className = "lh-listening-audio__label";
  label.innerHTML = HEADPHONES;
  label.append(options.mode === "pending" ? "Listen" : "Audio");
  const play = button(document, "Play", "listening-play");
  const slow = button(document, "0.75×", "listening-slow");
  slow.setAttribute("aria-label", "Play at 0.75 times normal speed");
  const pause = button(document, "Pause", "listening-pause");
  const stop = button(document, "Stop", "listening-stop");
  const continueButton = button(document, "Continue another way", "listening-continue");
  const status = document.createElement("p");
  status.className = "lh-listening-audio__status";
  status.setAttribute("role", "status");
  row.append(label, play, slow, pause, stop, continueButton);
  root.append(row, status);
  container.append(root);

  let state: PlayerState = { phase: "idle" };
  const render = () => {
    const busy = state.phase === "loading" || state.phase === "playing" || state.phase === "paused";
    play.textContent = state.phase === "error" ? "Retry" : "Play";
    play.disabled = state.phase === "loading" && state.rate === 1;
    slow.disabled = state.phase === "loading" && state.rate === 0.75;
    pause.hidden = state.phase !== "playing" && state.phase !== "paused";
    pause.textContent = state.phase === "paused" ? "Resume" : "Pause";
    stop.hidden = !busy;
    continueButton.hidden = !(state.phase === "error" && options.continueAnotherWay?.available());
    status.textContent = state.message ?? (
      state.phase === "loading" ? "Preparing audio…"
        : state.phase === "playing" ? (state.rate === 0.75 ? "Listening at 0.75×…" : "Listening…")
          : state.phase === "paused" ? "Paused. Resume to finish this playback."
            : options.mode === "replay" ? "Replay at 1× or 0.75×."
              : options.completed?.() ? "You can answer now, or replay as often as you like."
                : "Play at 1× or 0.75×, then answer. Listen all the way through once before submitting.");
  };
  const player = createSpeechPlayer({
    load: () => options.load(options.text, options.language),
    audio: () => new Audio(),
    createURL: blob => URL.createObjectURL(blob),
    revokeURL: url => URL.revokeObjectURL(url),
    changed: next => {
      if (next.phase === "error" && state.phase !== "error") options.onFailed?.();
      state = next;
      render();
    },
    started: rate => options.onStarted?.(rate),
    ended: rate => { options.onEnded?.(rate); render(); },
  });
  play.addEventListener("click", () => { void player.play(1); });
  slow.addEventListener("click", () => { void player.play(0.75); });
  pause.addEventListener("click", () => { if (state.phase === "paused") void player.resume(); else player.pause(); });
  stop.addEventListener("click", () => { player.stop(); });
  continueButton.addEventListener("click", () => { options.continueAnotherWay?.run(); render(); });
  // Space/Enter on these buttons must not reach the host's submit shortcut.
  root.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); });
  const view = document.defaultView;
  const onPageHide = () => { player.stop(); };
  view?.addEventListener("pagehide", onPageHide);
  render();

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.signal.removeEventListener("abort", dispose);
    view?.removeEventListener("pagehide", onPageHide);
    player.dispose();
    root.remove();
  };
  if (options.signal.aborted) dispose();
  else options.signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}

/** Base64 audio from the backend bridge (ctx.call is JSON-only). */
export function decodeAudio(result: unknown): LoadedAudio {
  if (!result || typeof result !== "object") throw new Error("Speech returned unusable audio. Try again.");
  const { mimeType, audioBase64, warning } = result as Record<string, unknown>;
  if (typeof mimeType !== "string" || !mimeType.startsWith("audio/") || typeof audioBase64 !== "string") throw new Error("Speech returned unusable audio. Try again.");
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return { blob: new Blob([bytes], { type: mimeType }), ...(typeof warning === "string" ? { warning } : {}) };
}
