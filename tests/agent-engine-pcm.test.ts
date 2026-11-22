// @vitest-environment node
/**
 * PCM math of the voice engine (lib/agent/pcm.ts) and the microphone worklet (public/worklets/kaira-mic-worklet.js),
 * which carries a copy of the same resampler: the worklet is executed with fake AudioWorklet globals and its frames
 * are compared with the TypeScript implementation.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  decodePcm16le,
  downmix,
  encodePcm16le,
  expectedResampledLength,
  floatSampleToInt16,
  floatToInt16,
  int16ToFloat,
  rms,
  rmsToLevel,
  smoothLevel,
  StreamingResampler,
} from "@/lib/agent/pcm";

function sine(freq: number, rate: number, seconds: number, amp = 0.5): Float32Array {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function zeroCrossings(x: ArrayLike<number>): number {
  let c = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0 && x[i] >= 0) || (x[i - 1] >= 0 && x[i] < 0)) c++;
  return c;
}

describe("Int16 conversion", () => {
  it("maps the float range onto Int16 without wrapping", () => {
    expect(floatSampleToInt16(0)).toBe(0);
    expect(floatSampleToInt16(1)).toBe(32767);
    expect(floatSampleToInt16(-1)).toBe(-32768);
    expect(floatSampleToInt16(2)).toBe(32767);
    expect(floatSampleToInt16(-3)).toBe(-32768);
    expect(floatSampleToInt16(Number.NaN)).toBe(0);
    expect(floatSampleToInt16(0.5)).toBe(16384);
    expect(Array.from(floatToInt16([0, 0.25, -0.25]))).toEqual([0, 8192, -8192]);
  });

  it("round-trips through little-endian bytes", () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768, 258]);
    const bytes = new Uint8Array(encodePcm16le(samples));
    // 258 = 0x0102 -> little-endian 02 01
    expect(Array.from(bytes.slice(10))).toEqual([0x02, 0x01]);
    const { samples: decoded, carry } = decodePcm16le(bytes.buffer);
    expect(carry).toBeNull();
    expect(Array.from(decoded)).toEqual(Array.from(int16ToFloat(samples)));
  });

  it("carries an odd trailing byte into the next frame", () => {
    const all = new Uint8Array(encodePcm16le(Int16Array.from([1000, -2000, 3000])));
    const a = decodePcm16le(all.slice(0, 3).buffer); // 1.5 samples
    expect(a.samples.length).toBe(1);
    expect(a.carry).toBe(all[2]);
    const b = decodePcm16le(all.slice(3).buffer, a.carry);
    expect(b.carry).toBeNull();
    expect(Array.from(b.samples).map((v) => Math.round(v * 32768))).toEqual([-2000, 3000]);
  });
});

describe("downmix / rms / levels", () => {
  it("averages channels", () => {
    expect(Array.from(downmix([Float32Array.from([1, 0]), Float32Array.from([0, 1])]))).toEqual([0.5, 0.5]);
    expect(Array.from(downmix([Float32Array.from([0.25])]))).toEqual([0.25]);
    expect(downmix([]).length).toBe(0);
  });

  it("computes RMS", () => {
    expect(rms([])).toBe(0);
    expect(rms([0.5, -0.5])).toBeCloseTo(0.5);
    expect(rms(sine(440, 16000, 1, 1))).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it("maps RMS to a 0..1 log level and smooths it", () => {
    expect(rmsToLevel(0)).toBe(0);
    expect(rmsToLevel(0.001)).toBe(0); // -60 dBFS
    expect(rmsToLevel(10 ** (-35 / 20))).toBeCloseTo(0.5);
    expect(rmsToLevel(1)).toBe(1);
    expect(smoothLevel(0, 1)).toBeCloseTo(0.6);
    expect(smoothLevel(1, 0)).toBeCloseTo(0.8);
    expect(smoothLevel(0.0005, 0)).toBe(0);
  });
});

describe("StreamingResampler", () => {
  it("produces 16 kHz output of the expected length from 48 kHz and 44.1 kHz", () => {
    for (const rate of [48000, 44100]) {
      const r = new StreamingResampler(rate, 16000);
      let total = 0;
      const input = sine(440, rate, 1);
      for (let i = 0; i < input.length; i += 128) total += r.process(input.subarray(i, i + 128)).length;
      expect(Math.abs(total - expectedResampledLength(input.length, rate, 16000))).toBeLessThanOrEqual(1);
    }
  });

  it("is independent of the chunk size", () => {
    const input = sine(1000, 48000, 0.25);
    const whole = new StreamingResampler(48000, 16000).process(input);
    const r = new StreamingResampler(48000, 16000);
    const parts: number[] = [];
    for (let i = 0; i < input.length; i += 77) parts.push(...r.process(input.subarray(i, i + 77)));
    expect(parts.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) expect(parts[i]).toBeCloseTo(whole[i], 6);
  });

  it("preserves an in-band tone's frequency and amplitude", () => {
    const out = new StreamingResampler(48000, 16000).process(sine(1000, 48000, 1));
    // 1 kHz for 1 s -> ~2000 zero crossings.
    expect(Math.abs(zeroCrossings(out) - 2000)).toBeLessThanOrEqual(4);
    expect(rms(out.subarray(1600))).toBeCloseTo(0.5 * Math.SQRT1_2, 1);
  });

  it("attenuates content above the new Nyquist frequency (anti-alias filter)", () => {
    const out = new StreamingResampler(48000, 16000).process(sine(12000, 48000, 0.5));
    expect(rms(out.subarray(800))).toBeLessThan(0.05); // input RMS ~0.35
  });

  it("passes audio through unchanged at equal rates", () => {
    const input = Float32Array.from([0.1, -0.2, 0.3]);
    expect(Array.from(new StreamingResampler(16000, 16000).process(input))).toEqual(Array.from(input));
  });

  it("upsamples by interpolation", () => {
    const out = new StreamingResampler(8000, 16000).process(Float32Array.from([0, 1, 0, -1]));
    expect(out.length).toBe(8);
  });
});

// ------------------------------------------------------------------ the worklet file itself
type Posted = { type: string; pcm: ArrayBuffer; rms: number };

function loadWorklet(rate: number) {
  const src = readFileSync(fileURLToPath(new URL("../public/worklets/kaira-mic-worklet.js", import.meta.url)), "utf8");
  let Processor: (new (options: unknown) => { process: (inputs: Float32Array[][]) => boolean; port: { posted: Posted[] } }) | null = null;
  class FakeAudioWorkletProcessor {
    port = {
      posted: [] as Posted[],
      onmessage: null as unknown,
      postMessage(message: Posted) {
        this.posted.push(message);
      },
    };
  }
  const register = (_name: string, cls: typeof Processor) => {
    Processor = cls;
  };
  new Function("registerProcessor", "AudioWorkletProcessor", "sampleRate", src)(register, FakeAudioWorkletProcessor, rate);
  if (!Processor) throw new Error("worklet did not register a processor");
  return new (Processor as NonNullable<typeof Processor>)({ processorOptions: { targetRate: 16000, frameSamples: 1600 } });
}

describe("kaira-mic-worklet.js", () => {
  it("emits 100 ms Int16 LE frames identical to the TypeScript resampler", () => {
    const rate = 48000;
    const proc = loadWorklet(rate);
    const left = sine(440, rate, 0.5, 0.6);
    const right = sine(440, rate, 0.5, 0.2);
    for (let i = 0; i < left.length; i += 128) proc.process([[left.subarray(i, i + 128), right.subarray(i, i + 128)]]);

    const frames = proc.port.posted;
    expect(frames.length).toBe(5); // 0.5 s -> 8000 samples -> 5 frames of 1600
    for (const f of frames) {
      expect(f.type).toBe("frame");
      expect(f.pcm.byteLength).toBe(3200);
    }
    const expected = floatToInt16(new StreamingResampler(rate, 16000).process(downmix([left, right])));
    const got = frames.flatMap((f) => Array.from(new Int16Array(f.pcm)));
    expect(got.length).toBeLessThanOrEqual(expected.length);
    for (let i = 0; i < got.length; i++) expect(Math.abs(got[i] - expected[i])).toBeLessThanOrEqual(1);
    // RMS per frame matches the float signal (mono = 0.4 amplitude sine -> ~0.283 once settled).
    expect(frames[4].rms).toBeCloseTo(0.4 * Math.SQRT1_2, 2);
  });

  it("returns true (keeps running) on empty input", () => {
    const proc = loadWorklet(44100);
    expect(proc.process([[]])).toBe(true);
    expect(proc.process([])).toBe(true);
  });
});
