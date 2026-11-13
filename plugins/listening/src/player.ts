import type { PlaybackRate } from "./speech/limits.ts";

export type PlayerPhase = "idle" | "loading" | "playing" | "paused" | "ready" | "error";
export type PlayerState = { phase: PlayerPhase; rate?: PlaybackRate; message?: string };
export type PlayerMedia = Pick<HTMLAudioElement, "play" | "pause" | "currentTime" | "onended" | "onerror" | "src" | "load" | "playbackRate" | "preservesPitch">;
export interface LoadedAudio { blob: Blob; warning?: string }

/** One window plays one clip at a time: starting playback stops whichever player was active. */
let stopActive: (() => boolean) | undefined;
export function stopActivePlayback(): boolean { return stopActive?.() ?? false; }

/**
 * Plays one spoken text. Every Play restarts from the beginning at its speed; Pause keeps
 * the position and the attempt, so a paused-then-resumed playback still ends naturally.
 * A token fences stale network responses, play() promises and end/error events.
 */
export function createSpeechPlayer(deps: {
  load(): Promise<LoadedAudio>;
  audio(): PlayerMedia;
  createURL(blob: Blob): string;
  revokeURL(url: string): void;
  changed(state: PlayerState): void;
  /** Playback actually started at this rate (not merely requested). */
  started?(rate: PlaybackRate): void;
  /** A full playback reached its natural end. */
  ended?(rate: PlaybackRate): void;
}) {
  let token = 0, disposed = false;
  let requestedRate: PlaybackRate = 1;
  let media: PlayerMedia | undefined, url: string | undefined;
  let state: PlayerState = { phase: "idle" };
  const update = (next: PlayerState) => { state = next; if (!disposed) deps.changed(next); };
  function release() {
    if (media) { media.pause(); media.onended = null; media.onerror = null; media.src = ""; media.load(); }
    media = undefined;
    if (url) deps.revokeURL(url);
    url = undefined;
  }
  function claim() {
    if (stopActive !== stop) stopActive?.();
    stopActive = stop;
  }
  function stop(): boolean {
    const active = state.phase === "loading" || state.phase === "playing" || state.phase === "paused";
    token++;
    media?.pause();
    if (active) update({ phase: media ? "ready" : "idle", ...(state.rate ? { rate: state.rate } : {}) });
    return active;
  }
  function fail(message: string) { release(); update({ phase: "error", message }); }
  async function begin(current: number, rate: PlaybackRate, fromStart: boolean) {
    const target = media;
    if (!target || disposed || current !== token) return;
    if (fromStart) target.currentTime = 0;
    target.playbackRate = rate;
    target.preservesPitch = true;
    // Pending play() permission counts as active, so Stop can still cancel it.
    if (fromStart) update({ phase: "loading", rate });
    target.onended = () => { if (!disposed && current === token) { update({ phase: "ready", rate }); deps.ended?.(rate); } };
    target.onerror = () => {
      if (disposed || current !== token) return;
      // A decoder error can also reject play(); invalidate it so one attempt reports one error.
      token++;
      fail("Audio could not be played. Press Play to try again.");
    };
    try {
      await target.play();
      if (disposed || current !== token) {
        // A superseded play() can settle after a newer one on the same element; never pause the newer one.
        if (disposed || target !== media) target.pause();
        return;
      }
      update({ phase: "playing", rate });
      if (fromStart) deps.started?.(rate);
    } catch {
      if (current === token && !disposed) fail("Audio could not start. Press Play to try again.");
    }
  }
  async function play(rate: PlaybackRate = 1) {
    if (disposed) return;
    requestedRate = rate;
    if (state.phase === "loading" && !media) {
      // Choose the eventual speed without fetching the same audio twice.
      update({ ...state, rate });
      return;
    }
    claim();
    media?.pause();
    const current = ++token;
    if (media) { await begin(current, rate, true); return; }
    update({ phase: "loading", rate });
    try {
      const loaded = await deps.load();
      if (disposed || current !== token) return;
      url = deps.createURL(loaded.blob);
      media = deps.audio();
      media.src = url;
      update({ phase: "ready", rate: requestedRate, ...(loaded.warning ? { message: loaded.warning } : {}) });
      await begin(current, requestedRate, true);
    } catch (error) {
      if (current === token && !disposed) update({ phase: "error", message: error instanceof Error && error.message ? error.message : "Speech is unavailable. Try again." });
    }
  }
  function pause() {
    if (disposed || state.phase !== "playing" || !media) return;
    media.pause();
    update({ ...state, phase: "paused" });
  }
  async function resume() {
    if (disposed || state.phase !== "paused" || !media) return;
    claim();
    await begin(token, state.rate ?? 1, false);
  }
  return {
    play, pause, resume, stop,
    state: () => state,
    dispose() { stop(); disposed = true; release(); if (stopActive === stop) stopActive = undefined; },
  };
}
export type SpeechPlayer = ReturnType<typeof createSpeechPlayer>;
