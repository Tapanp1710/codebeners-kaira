/**
 * Lightweight client-side voice activity detector (energy threshold + attack + hangover).
 *
 * It never performs recognition and never gates what is streamed (the server's Sarvam VAD is authoritative and
 * needs the silence too). It only drives the orb's "hearing" state and early local barge-in (ducking playback the
 * moment the user starts talking over KAIRA).
 */
export type VadOptions = {
  /** Absolute floor for the speech threshold (RMS on the float scale). */
  minThreshold: number;
  /** Speech must exceed the tracked noise floor by this factor. */
  noiseRatio: number;
  /** Continuous loud audio needed before speech starts (ms). */
  attackMs: number;
  /** Quiet audio needed before speech ends (ms). */
  hangoverMs: number;
  /** Noise floor smoothing per frame while not speaking (0..1). */
  noiseAdapt: number;
  /** Slow upward drift of the noise floor while loud, so a constant loud background stops counting as speech. */
  noiseRise: number;
  /** Initial period that only measures the background and never reports speech (ms). */
  calibrationMs: number;
};

export const DEFAULT_VAD_OPTIONS: VadOptions = {
  minThreshold: 0.015,
  noiseRatio: 3,
  attackMs: 100,
  hangoverMs: 600,
  noiseAdapt: 0.05,
  noiseRise: 0.003,
  calibrationMs: 200,
};

export type VadResult = { speech: boolean; changed: boolean };

export class EnergyVad {
  private readonly opts: VadOptions;
  private speech = false;
  private loudMs = 0;
  private quietMs = 0;
  private noiseFloor: number | null = null;
  private calibratedMs = 0;
  /** Extra multiplier on the threshold (raised while KAIRA is speaking to resist residual echo). */
  sensitivityScale = 1;

  constructor(options: Partial<VadOptions> = {}) {
    this.opts = { ...DEFAULT_VAD_OPTIONS, ...options };
  }

  get speaking() {
    return this.speech;
  }

  threshold(): number {
    const floor = this.noiseFloor ?? 0;
    return Math.max(this.opts.minThreshold, floor * this.opts.noiseRatio) * this.sensitivityScale;
  }

  /** Feeds one frame's RMS and its duration. */
  process(frameRms: number, frameMs: number): VadResult {
    if (this.calibratedMs < this.opts.calibrationMs) {
      this.calibratedMs += frameMs;
      this.noiseFloor = this.noiseFloor === null ? frameRms : this.noiseFloor + (frameRms - this.noiseFloor) * 0.5;
      return { speech: false, changed: false };
    }
    const loud = frameRms > this.threshold();
    const floor = this.noiseFloor;
    if (floor === null) this.noiseFloor = loud ? null : frameRms;
    else if (!this.speech && !loud) this.noiseFloor = floor + (frameRms - floor) * this.opts.noiseAdapt;
    else if (frameRms > floor) this.noiseFloor = floor + (frameRms - floor) * this.opts.noiseRise;
    const before = this.speech;
    if (loud) {
      this.loudMs += frameMs;
      this.quietMs = 0;
      if (!this.speech && this.loudMs >= this.opts.attackMs) this.speech = true;
    } else {
      this.loudMs = 0;
      if (this.speech) {
        this.quietMs += frameMs;
        if (this.quietMs >= this.opts.hangoverMs) {
          this.speech = false;
          this.quietMs = 0;
        }
      }
    }
    return { speech: this.speech, changed: before !== this.speech };
  }

  reset(): void {
    this.speech = false;
    this.loudMs = 0;
    this.quietMs = 0;
    this.noiseFloor = null;
    this.calibratedMs = 0;
  }
}
