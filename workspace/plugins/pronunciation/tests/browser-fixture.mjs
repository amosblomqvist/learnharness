// Browser fixture: the real frontend with a mocked plugin backend. Bundled by tests/browser.mjs.
import { activate } from "../src/main.ts";
import { encodeWav } from "../src/wav.ts";

const state = { epoch: "fixture", sequence: 1, settings: { revision: 0, voice: "zf_001" }, install: { kind: "installed" }, downloadBytes: 1 };
const wav = encodeWav(Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 8) * 0.2), 24_000);
let binary = "";
for (const byte of wav) binary += String.fromCharCode(byte);
const clip = btoa(binary);

const fixture = window.fixture = { mode: "ok", calls: [], plays: [] };
// Record every play() and, in "block" mode, refuse the clip as a browser would.
const play = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function () {
  const kind = this.src.startsWith("data:") ? "unlock" : this.src.startsWith("blob:") ? "clip" : "other";
  const entry = { kind, result: "pending" };
  fixture.plays.push(entry);
  if (kind === "clip" && fixture.mode === "block") { entry.result = "NotAllowedError"; return Promise.reject(new DOMException("Blocked by fixture.", "NotAllowedError")); }
  const started = play.call(this);
  started.then(() => { entry.result = "played"; }, error => { entry.result = error.name; });
  return started;
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ctx = {
  manifest: { id: "pronunciation" }, signal: new AbortController().signal, cleanup() {},
  async call(operation, input) {
    fixture.calls.push({ operation, input });
    if (operation === "get-state") return state;
    if (operation !== "speak") throw new Error(`Unexpected operation ${operation}`);
    if (fixture.mode === "slow") await delay(3000);
    if (fixture.mode === "error") throw new Error("GPU (DirectML) unavailable: fixture");
    return { wav: clip };
  },
  onNotification() { return () => {}; },
  onResync() { return () => {}; },
  registerSettings() { return () => {}; },
};
activate(ctx).then(() => { window.fixtureReady = true; }, error => { window.fixtureError = String(error); });
