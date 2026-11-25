/**
 * Signal processing after the vocoder, matching sherpa-onnx 2.0.3: Vocos
 * outputs a spectrum (magnitude and phase as cos/sin) that an inverse STFT
 * turns into samples, and long pauses are then shortened.
 */

export interface StftOptions { nFft: number; hop: number }
export const VOCOS_STFT: StftOptions = { nFft: 1024, hop: 256 };

/** In-place radix-2 complex FFT; `sign` +1 computes the unscaled inverse. */
function fft(re: Float64Array, im: Float64Array, sign: 1 | -1): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, angle = sign * 2 * Math.PI / size;
    const stepRe = Math.cos(angle), stepIm = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let wRe = 1, wIm = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k, b = a + half;
        const tRe = re[b]! * wRe - im[b]! * wIm, tIm = re[b]! * wIm + im[b]! * wRe;
        re[b] = re[a]! - tRe; im[b] = im[a]! - tIm;
        re[a] = re[a]! + tRe; im[a] = im[a]! + tIm;
        const next = wRe * stepRe - wIm * stepIm;
        wIm = wRe * stepIm + wIm * stepRe; wRe = next;
      }
    }
  }
}

/** Periodic Hann window, as torch.hann_window and kaldi-native-fbank use. */
export function hann(length: number): Float64Array {
  return Float64Array.from({ length }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / length));
}

/**
 * Inverse STFT of `frames` frames with `bins` = nFft/2+1 bins, laid out
 * bin-major as Vocos returns them ([bins][frames]): value = mag·(x + i·y).
 * Hann-windowed overlap-add, divided by the summed squared window, with the
 * nFft/2 "center" padding removed from both ends.
 */
export function istft(mag: Float32Array, x: Float32Array, y: Float32Array, bins: number, frames: number, options: StftOptions = VOCOS_STFT): Float32Array {
  const { nFft, hop } = options;
  if (nFft & (nFft - 1) || bins !== nFft / 2 + 1) throw new Error("Unexpected vocoder output shape.");
  const size = bins * frames;
  if (mag.length < size || x.length < size || y.length < size) throw new Error("Unexpected vocoder output size.");
  if (frames === 0) return new Float32Array(0);
  const window = hann(nFft);
  const total = nFft + (frames - 1) * hop;
  const out = new Float64Array(total), weight = new Float64Array(total);
  const re = new Float64Array(nFft), im = new Float64Array(nFft);
  for (let frame = 0; frame < frames; frame++) {
    for (let k = 0; k < bins; k++) {
      const index = k * frames + frame, m = mag[index]!;
      re[k] = m * x[index]!;
      im[k] = m * y[index]!;
    }
    // A real signal's spectrum: no imaginary part at DC and Nyquist, mirrored above.
    im[0] = 0; im[nFft / 2] = 0;
    for (let k = 1; k < nFft / 2; k++) { re[nFft - k] = re[k]!; im[nFft - k] = -im[k]!; }
    fft(re, im, 1);
    const start = frame * hop;
    for (let i = 0; i < nFft; i++) {
      out[start + i]! += re[i]! / nFft * window[i]!;
      weight[start + i]! += window[i]! * window[i]!;
    }
  }
  for (let i = 0; i < total; i++) if (weight[i]) out[i]! /= weight[i]!;
  return Float32Array.from(out.subarray(nFft / 2, total - nFft / 2));
}

/** Samples at or below this level count as silence. */
const SILENCE_LEVEL = 0.01;
/** sherpa-onnx's default: pauses keep 20% of their length. */
export const SILENCE_SCALE = 0.2;

/**
 * Shorten every pause longer than 0.2 s (including leading and trailing
 * silence) to `scale` of its length, keeping its start. A port of
 * sherpa-onnx's GeneratedAudio::ScaleSilence for scale ≤ 1.
 */
export function scaleSilence(samples: Float32Array, sampleRate: number, scale = SILENCE_SCALE): Float32Array {
  if (!(scale > 0 && scale <= 1)) throw new Error("The silence scale must be in (0, 1].");
  if (scale === 1) return samples;
  const threshold = Math.trunc(sampleRate * 0.2);
  const pauses: [number, number][] = [];
  let last = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]!) <= SILENCE_LEVEL) { if (last === -1) last = i; continue; }
    if (last !== -1 && i - last >= threshold) pauses.push([last, i]);
    last = -1;
  }
  if (last !== -1 && samples.length - last > threshold) pauses.push([last, samples.length]);
  if (!pauses.length) return samples;
  const parts: Float32Array[] = [];
  let at = 0;
  for (const [start, end] of pauses) {
    // Single-precision, like the C++ `int32_t n = len * scale` with a float scale.
    const kept = Math.trunc(Math.fround(Math.fround(end - start) * Math.fround(scale)));
    parts.push(samples.subarray(at, start), samples.subarray(start, start + kept));
    at = end;
  }
  parts.push(samples.subarray(at));
  const result = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
