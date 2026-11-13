import assert from "node:assert/strict";
import { test } from "node:test";
import { createSpeechPlayer, stopActivePlayback, type LoadedAudio, type PlayerMedia, type PlayerState } from "../src/player.ts";
import type { PlaybackRate } from "../src/speech/limits.ts";

function fixture(load: () => Promise<LoadedAudio>) {
  let plays = 0, pauses = 0, revoked = 0;
  let state: PlayerState = { phase: "idle" };
  const transitions: PlayerState[] = [];
  const startedRates: PlaybackRate[] = [];
  const endedRates: PlaybackRate[] = [];
  const media: PlayerMedia = { src: "", currentTime: 0, playbackRate: 1, preservesPitch: true, onended: null, onerror: null, play: async () => { plays++; }, pause: () => { pauses++; }, load: () => {} };
  const player = createSpeechPlayer({
    load, audio: () => media, createURL: () => "blob:test", revokeURL: () => { revoked++; },
    changed: next => { state = next; transitions.push(next); },
    started: rate => startedRates.push(rate), ended: rate => endedRates.push(rate),
  });
  const end = () => media.onended!.call(media as HTMLAudioElement, new Event("ended"));
  return { player, media, end, state: () => state, transitions, startedRates, endedRates, plays: () => plays, pauses: () => pauses, revoked: () => revoked };
}
const loaded = async (): Promise<LoadedAudio> => ({ blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" }) });

test("replay reuses audio; stop and disposal release playback resources", async () => {
  let requests = 0;
  const f = fixture(async () => { requests++; return loaded(); });
  await f.player.play();
  assert.equal(f.state().phase, "playing");
  f.player.stop();
  assert.equal(f.state().phase, "ready");
  await f.player.play();
  assert.equal(requests, 1);
  assert.equal(f.plays(), 2);
  f.player.dispose();
  assert.equal(f.revoked(), 1);
  assert.equal(stopActivePlayback(), false);
});

test("pause keeps the attempt: resuming and reaching the end completes one full playback", async () => {
  const f = fixture(loaded);
  await f.player.play(0.75);
  f.media.currentTime = 1.5;
  f.player.pause();
  assert.equal(f.state().phase, "paused");
  await f.player.resume();
  assert.equal(f.state().phase, "playing");
  assert.equal(f.media.currentTime, 1.5, "resume does not seek");
  assert.deepEqual(f.startedRates, [0.75], "resuming is not a new start");
  f.end();
  assert.deepEqual(f.endedRates, [0.75]);
  assert.equal(f.state().phase, "ready");
  f.player.dispose();
});

test("stopping while paused abandons the attempt; its end cannot complete it", async () => {
  const f = fixture(loaded);
  await f.player.play();
  const staleEnd = f.media.onended!;
  f.player.pause();
  assert.equal(stopActivePlayback(), true);
  assert.equal(f.state().phase, "ready");
  staleEnd.call(f.media as HTMLAudioElement, new Event("ended"));
  assert.deepEqual(f.endedRates, []);
  await f.player.resume();
  assert.equal(f.state().phase, "ready", "nothing to resume after Stop");
  f.player.dispose();
});

test("late response after Stop cannot start playback", async () => {
  let finish!: (value: LoadedAudio) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const run = f.player.play();
  assert.equal(stopActivePlayback(), true);
  finish(await loaded());
  await run;
  assert.equal(f.plays(), 0);
  f.player.dispose();
});

test("Stop during a pending play permission prevents late playback", async () => {
  const f = fixture(loaded);
  let finish!: () => void;
  f.media.play = () => new Promise<void>(resolve => { finish = resolve; });
  const playing = f.player.play();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(stopActivePlayback(), true);
  finish();
  await playing;
  assert.equal(f.state().phase, "ready");
  assert.ok(f.pauses() > 0);
  f.player.dispose();
});

test("only a current natural end completes; stopped and disposed callbacks cannot", async () => {
  const f = fixture(loaded);
  await f.player.play();
  const oldEnd = f.media.onended!;
  f.player.stop();
  oldEnd.call(f.media as HTMLAudioElement, new Event("ended"));
  assert.equal(f.endedRates.length, 0);
  await f.player.play();
  f.end();
  assert.equal(f.endedRates.length, 1);
  const lastEnd = f.media.onended!;
  f.player.dispose();
  lastEnd.call(f.media as HTMLAudioElement, new Event("ended"));
  assert.equal(f.endedRates.length, 1);
});

test("starting another player stops the active one; idle players do not steal ownership", async () => {
  const first = fixture(loaded);
  const second = fixture(loaded);
  await first.player.play();
  await second.player.play();
  assert.equal(first.state().phase, "ready");
  assert.equal(second.state().phase, "playing");
  const unused = fixture(loaded);
  assert.equal(second.state().phase, "playing", "creating a player must not interrupt audio");
  assert.equal(stopActivePlayback(), true);
  assert.equal(second.state().phase, "ready");
  unused.player.dispose(); first.player.dispose(); second.player.dispose();
});

test("play permission failure is retryable and never completes", async () => {
  const f = fixture(loaded);
  f.media.play = async () => { throw new Error("permission denied"); };
  await f.player.play();
  assert.equal(f.state().phase, "error");
  assert.deepEqual(f.endedRates, []);
  f.player.dispose();
});

test("decoder error plus rejected play reports one failure per attempt", async () => {
  const f = fixture(loaded);
  f.media.play = async () => {
    f.media.onerror!.call(f.media as HTMLAudioElement, new Event("error"));
    throw new Error("decoder failed");
  };
  await f.player.play();
  assert.equal(f.transitions.filter(s => s.phase === "error").length, 1);
  await f.player.play();
  assert.equal(f.transitions.filter(s => s.phase === "error").length, 2);
  assert.deepEqual(f.endedRates, []);
  f.player.dispose();
});

test("switching speeds restarts the same recording with pitch preservation and rejects the old end", async () => {
  let requests = 0;
  const f = fixture(async () => { requests++; return loaded(); });
  await f.player.play();
  const oldEnd = f.media.onended!;
  f.media.currentTime = 0.5;
  await f.player.play(0.75);
  assert.equal(requests, 1);
  assert.equal(f.media.currentTime, 0);
  assert.equal(f.media.playbackRate, 0.75);
  assert.equal(f.media.preservesPitch, true);
  oldEnd.call(f.media as HTMLAudioElement, new Event("ended"));
  assert.deepEqual(f.endedRates, []);
  f.end();
  assert.deepEqual(f.endedRates, [0.75]);
  await f.player.play();
  assert.equal(f.media.playbackRate, 1);
  assert.deepEqual(f.startedRates, [1, 0.75, 1]);
  f.player.dispose();
});

test("choosing slow speed while audio loads reuses the pending request", async () => {
  let requests = 0, finish!: (value: LoadedAudio) => void;
  const f = fixture(() => { requests++; return new Promise(resolve => { finish = resolve; }); });
  const normal = f.player.play();
  await f.player.play(0.75);
  finish(await loaded());
  await normal;
  assert.equal(requests, 1);
  assert.equal(f.media.playbackRate, 0.75);
  assert.deepEqual(f.startedRates, [0.75]);
  f.player.dispose();
});

test("a superseded play promise cannot pause a newer speed on the same media", async () => {
  const f = fixture(loaded);
  const finish: Array<() => void> = [];
  f.media.play = () => new Promise<void>(resolve => { finish.push(resolve); });
  const old = f.player.play();
  await new Promise(resolve => setTimeout(resolve, 0));
  const slow = f.player.play(0.75);
  finish[1]!();
  await slow;
  const pauses = f.pauses();
  finish[0]!();
  await old;
  assert.equal(f.pauses(), pauses);
  assert.equal(f.state().phase, "playing");
  assert.deepEqual(f.startedRates, [0.75]);
  f.player.dispose();
});

test("failed loading reports the readable message and records no started speed", async () => {
  const f = fixture(async () => { throw new Error("Add your ElevenLabs API key in Listening settings."); });
  await f.player.play(0.75);
  assert.deepEqual(f.startedRates, []);
  assert.deepEqual(f.state(), { phase: "error", message: "Add your ElevenLabs API key in Listening settings." });
  f.player.dispose();
});
