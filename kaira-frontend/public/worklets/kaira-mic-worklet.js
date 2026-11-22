/**
 * KAIRA microphone AudioWorklet (loaded by lib/agent/mic.ts via audioWorklet.addModule).
 *
 * Per render quantum: downmix to mono -> anti-alias low-pass -> linear-interpolation resample to 16 kHz ->
 * Int16. Every `frameSamples` output samples (1 600 = 100 ms) it posts
 *   { type: "frame", pcm: ArrayBuffer (Int16 little-endian, transferred), rms: number }
 * to the main thread. The resampler and conversions are a copy of lib/agent/pcm.ts (StreamingResampler,
 * floatSampleToInt16, rms); tests/agent-engine-pcm.test.ts runs this file and compares the two.
 *
 * Plain JavaScript on purpose: worklet modules are fetched as-is from /public and cannot be bundled TypeScript.
 */
/* global registerProcessor, AudioWorkletProcessor, sampleRate */

function lowpassCoefficients(cutoffHz, rate, q) {
  const w0 = (2 * Math.PI * cutoffHz) / rate;
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

function floatSampleToInt16(sample) {
  const s = sample > 1 ? 1 : sample < -1 ? -1 : Number.isNaN(sample) ? 0 : sample;
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
}

class StreamingResampler {
  constructor(inRate, outRate) {
    this.inRate = inRate;
    this.outRate = outRate;
    this.step = inRate / outRate;
    this.pos = 0;
    this.prev = null;
    this.filter = inRate > outRate ? lowpassCoefficients(outRate * 0.45, inRate, Math.SQRT1_2) : null;
    this.s1 = [0, 0, 0, 0];
    this.s2 = [0, 0, 0, 0];
  }

  applyFilter(x, s) {
    const f = this.filter;
    const y = f.b0 * x + f.b1 * s[0] + f.b2 * s[1] - f.a1 * s[2] - f.a2 * s[3];
    s[1] = s[0];
    s[0] = x;
    s[3] = s[2];
    s[2] = y;
    return y;
  }

  /** Same algorithm as StreamingResampler.process in lib/agent/pcm.ts; calls emit(sample) per output sample. */
  process(input, emit) {
    const n = input.length;
    if (n === 0) return;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = this.filter ? this.applyFilter(this.applyFilter(input[i], this.s1), this.s2) : input[i];
    }
    if (this.inRate === this.outRate) {
      for (let i = 0; i < n; i++) emit(x[i]);
      return;
    }
    const prev = this.prev === null ? x[0] : this.prev;
    let pos = this.pos;
    while (pos < n) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i === 0 ? prev : x[i - 1];
      // Extended index i + 1 is always >= 1, i.e. x[i].
      emit(frac === 0 ? a : a * (1 - frac) + x[i] * frac);
      pos += this.step;
    }
    this.pos = pos - n;
    this.prev = x[n - 1];
  }
}

class KairaMicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.frameSamples = opts.frameSamples || 1600;
    this.resampler = new StreamingResampler(sampleRate, this.targetRate);
    this.frame = new Float32Array(this.frameSamples);
    this.filled = 0;
    this.mono = new Float32Array(128);
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "flush") this.flushFrame();
    };
    this.emit = (sample) => {
      this.frame[this.filled++] = sample;
      if (this.filled === this.frameSamples) this.flushFrame();
    };
  }

  flushFrame() {
    if (this.filled === 0) return;
    const n = this.filled;
    const buffer = new ArrayBuffer(n * 2);
    const view = new DataView(buffer);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const s = this.frame[i];
      sum += s * s;
      view.setInt16(i * 2, floatSampleToInt16(s), true);
    }
    this.filled = 0;
    this.port.postMessage({ type: "frame", pcm: buffer, rms: Math.sqrt(sum / n) }, [buffer]);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || input[0].length === 0) return true;
    const n = input[0].length;
    if (this.mono.length !== n) this.mono = new Float32Array(n);
    const mono = this.mono;
    mono.fill(0);
    for (let c = 0; c < input.length; c++) {
      const ch = input[c];
      for (let i = 0; i < n; i++) mono[i] += ch[i];
    }
    if (input.length > 1) for (let i = 0; i < n; i++) mono[i] /= input.length;
    this.resampler.process(mono, this.emit);
    return true;
  }
}

registerProcessor("kaira-mic", KairaMicProcessor);
