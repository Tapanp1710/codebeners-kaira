/**
 * PCM math shared by the voice engine (pure functions, no Web Audio objects).
 *
 * The microphone path runs in public/worklets/kaira-mic-worklet.js, which cannot import TypeScript; it carries a
 * line-for-line copy of `StreamingResampler`, `floatToInt16` and `rms` below. tests/agent-engine-pcm.test.ts loads
 * that worklet file and checks its output against these functions so the two copies cannot drift apart.
 */

/** Clamps a float sample to [-1, 1] and converts it to a signed 16-bit integer (asymmetric range, no wrap). */
export function floatSampleToInt16(sample: number): number {
  const s = sample > 1 ? 1 : sample < -1 ? -1 : Number.isNaN(sample) ? 0 : sample;
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
}

/** Float32 [-1, 1] -> Int16 PCM. */
export function floatToInt16(input: ArrayLike<number>): Int16Array<ArrayBuffer> {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = floatSampleToInt16(input[i]);
  return out;
}

/** Int16 PCM -> Float32 [-1, 1). */
export function int16ToFloat(input: ArrayLike<number>): Float32Array<ArrayBuffer> {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i] / 0x8000;
  return out;
}

/**
 * Decodes little-endian Int16 bytes into Float32 samples. A frame with an odd byte count leaves one byte over; it is
 * returned as `carry` and must be passed back with the next frame so sample alignment is never lost.
 */
export function decodePcm16le(bytes: ArrayBuffer, carry: number | null = null): { samples: Float32Array<ArrayBuffer>; carry: number | null } {
  const src = new Uint8Array(bytes);
  const total = src.length + (carry === null ? 0 : 1);
  const count = total >> 1;
  const samples = new Float32Array(count);
  const byteAt = (i: number) => (carry === null ? src[i] : i === 0 ? carry : src[i - 1]);
  for (let i = 0; i < count; i++) {
    const lo = byteAt(2 * i);
    const hi = byteAt(2 * i + 1);
    let v = (hi << 8) | lo;
    if (v >= 0x8000) v -= 0x10000;
    samples[i] = v / 0x8000;
  }
  const nextCarry = total % 2 === 1 ? byteAt(total - 1) : null;
  return { samples, carry: nextCarry };
}

/** Encodes Int16 samples as little-endian bytes (explicitly, independent of the platform's endianness). */
export function encodePcm16le(samples: Int16Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true);
  return buffer;
}

/** Averages the channels of one render quantum into a mono signal. */
export function downmix(channels: ArrayLike<number>[]): Float32Array<ArrayBuffer> {
  if (channels.length === 0) return new Float32Array(0);
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  if (channels.length > 1) for (let i = 0; i < n; i++) out[i] /= channels.length;
  return out;
}

/** Root mean square of float samples (0 for an empty input). */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Root mean square of Int16 samples, on the float scale. */
export function rmsInt16(samples: ArrayLike<number>): number {
  return rms(int16ToFloat(samples));
}

/** Maps an RMS value to a 0..1 display level on a log scale (-60 dBFS -> 0, -10 dBFS -> 1). */
export function rmsToLevel(value: number): number {
  if (!(value > 0)) return 0;
  const db = 20 * Math.log10(value);
  const level = (db + 60) / 50;
  return level < 0 ? 0 : level > 1 ? 1 : level;
}

/** Exponential smoothing for orb levels: fast attack, slower release. */
export function smoothLevel(previous: number, target: number, attack = 0.6, release = 0.2): number {
  const k = target > previous ? attack : release;
  const next = previous + (target - previous) * k;
  return next < 0.001 ? 0 : next;
}

/**
 * Biquad low-pass coefficients (RBJ audio-EQ cookbook), normalised by a0. Used as the anti-alias filter before
 * downsampling to 16 kHz.
 */
export function lowpassCoefficients(cutoffHz: number, sampleRate: number, q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cos) / 2 / a0,
    b1: (1 - cos) / a0,
    b2: (1 - cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * Streaming resampler: two cascaded biquad low-pass sections (only when downsampling) followed by linear
 * interpolation. State carries across chunks, so feeding a signal in arbitrary chunk sizes yields the same output as
 * feeding it at once.
 */
export class StreamingResampler {
  readonly inRate: number;
  readonly outRate: number;
  private readonly step: number;
  private pos = 0; // read position in the extended chunk [prev, ...chunk]
  private prev: number | null = null;
  private readonly filter: ReturnType<typeof lowpassCoefficients> | null;
  // Direct form I state for two sections: [x1, x2, y1, y2] each.
  private readonly s1 = [0, 0, 0, 0];
  private readonly s2 = [0, 0, 0, 0];

  constructor(inRate: number, outRate: number) {
    if (!(inRate > 0) || !(outRate > 0)) throw new Error("Sample rates must be positive.");
    this.inRate = inRate;
    this.outRate = outRate;
    this.step = inRate / outRate;
    // Cut-off at 45% of the output rate (7.2 kHz for 16 kHz output), below the new Nyquist frequency.
    this.filter = inRate > outRate ? lowpassCoefficients(outRate * 0.45, inRate) : null;
  }

  private applyFilter(x: number, s: number[]): number {
    const f = this.filter!;
    const y = f.b0 * x + f.b1 * s[0] + f.b2 * s[1] - f.a1 * s[2] - f.a2 * s[3];
    s[1] = s[0];
    s[0] = x;
    s[3] = s[2];
    s[2] = y;
    return y;
  }

  /** Resamples one chunk. Returns the output samples that are complete so far. */
  process(input: ArrayLike<number>): Float32Array<ArrayBuffer> {
    const n = input.length;
    if (n === 0) return new Float32Array(0);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = this.filter ? this.applyFilter(this.applyFilter(input[i], this.s1), this.s2) : input[i];
    }
    if (this.inRate === this.outRate) return x;
    // Extended chunk: index 0 is the last sample of the previous chunk (or x[0] for the very first chunk).
    const prev = this.prev ?? x[0];
    const at = (i: number) => (i === 0 ? prev : x[i - 1]);
    const out: number[] = [];
    let pos = this.pos;
    while (pos < n) {
      const i = Math.floor(pos);
      const frac = pos - i;
      out.push(frac === 0 ? at(i) : at(i) * (1 - frac) + at(i + 1) * frac);
      pos += this.step;
    }
    this.pos = pos - n;
    this.prev = x[n - 1];
    return Float32Array.from(out);
  }
}

/** Number of output samples a resampler produces for `inputSamples` input samples (within one sample). */
export function expectedResampledLength(inputSamples: number, inRate: number, outRate: number): number {
  return Math.round((inputSamples * outRate) / inRate);
}
