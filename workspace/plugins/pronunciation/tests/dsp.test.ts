import test from "node:test";
import assert from "node:assert/strict";
import { hann, istft, scaleSilence } from "../src/dsp.ts";

test("inverse STFT reconstructs a centered Hann-windowed signal from bin-major Vocos output", () => {
  const nFft = 16, hop = 4, frames = 9, bins = nFft / 2 + 1, padding = nFft / 2;
  const samples = Float32Array.from({ length: (frames - 1) * hop }, (_, i) =>
    0.4 * Math.sin(i / 3) + 0.2 * Math.cos(i * 1.7) + 0.1);
  const window = hann(nFft);
  const mag = new Float32Array(bins * frames), x = mag.slice(), y = mag.slice();
  // A direct forward DFT constructs the spectrum independently of the inverse FFT.
  for (let bin = 0; bin < bins; bin++) for (let frame = 0; frame < frames; frame++) {
    let re = 0, im = 0;
    for (let i = 0; i < nFft; i++) {
      const sample = (samples[frame * hop + i - padding] ?? 0) * window[i]!;
      const phase = -2 * Math.PI * bin * i / nFft;
      re += sample * Math.cos(phase);
      im += sample * Math.sin(phase);
    }
    const index = bin * frames + frame, phase = Math.atan2(im, re);
    mag[index] = Math.hypot(re, im);
    x[index] = Math.cos(phase);
    y[index] = Math.sin(phase);
  }
  const reconstructed = istft(mag, x, y, bins, frames, { nFft, hop });
  assert.equal(reconstructed.length, samples.length);
  assert.ok(reconstructed.every((sample, index) => Math.abs(sample - samples[index]!) < 1e-6));
});

test("pause shortening keeps speech and short pauses, including the sherpa trailing boundary", () => {
  const samples = Float32Array.of(0, 0, 0, 0, 0, 0.4, 0, 0, -0.4, 0, 0, 0, 0.5, 0, 0, 0);
  assert.deepEqual(scaleSilence(samples, 15), Float32Array.of(0, 0.4, 0, 0, -0.4, 0.5, 0, 0, 0));
  assert.equal(scaleSilence(samples, 15, 1), samples);
  assert.deepEqual(scaleSilence(Float32Array.of(0.5, 0, 0, 0, 0, 0), 15), Float32Array.of(0.5, 0));
});
