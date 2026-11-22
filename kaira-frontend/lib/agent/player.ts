/**
 * Gapless playback of KAIRA's streamed TTS (Int16 LE mono PCM frames at the tts.start sample rate).
 *
 * Each frame becomes an AudioBufferSourceNode scheduled back-to-back (planChunk in ./timing). stop() silences
 * everything at once and drops what is queued (tts.stop / barge-in); end() lets queued audio finish and then calls
 * back (tts.end). Output goes through a gain node (ducking) and an analyser (orb output level).
 */
import { decodePcm16le, rms } from "./pcm";
import { DEFAULT_SCHEDULE, planChunk, type ScheduleOptions } from "./timing";

/** Seconds of audio allowed in the schedule; anything beyond is dropped (bounded memory if the server floods). */
export const MAX_QUEUED_SEC = 30;
const DUCK_GAIN = 0.15;
/**
 * After tts.end, the drained callback fires at the latest this long after the scheduled audio should have finished,
 * even if a source's `onended` never fires (a suspended or interrupted AudioContext), so listening always resumes.
 */
export const DRAIN_GRACE_MS = 750;

export class PcmPlayer {
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private levelBuf: Float32Array<ArrayBuffer> | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private nextStart = 0;
  private sampleRate = 22_050;
  private carry: number | null = null;
  private accepting = false;
  private ended = false;
  private onDrained: (() => void) | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ctx: AudioContext,
    private readonly schedule: ScheduleOptions = DEFAULT_SCHEDULE,
  ) {}

  private ensureGraph(): GainNode {
    if (!this.gain) {
      this.gain = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.gain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
    return this.gain;
  }

  /** tts.start: begin accepting frames for a new reply. */
  begin(sampleRate: number): void {
    this.stop();
    this.ensureGraph();
    this.sampleRate = sampleRate > 0 ? sampleRate : 22_050;
    this.accepting = true;
    this.ended = false;
    this.duck(false);
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
  }

  get active(): boolean {
    return this.accepting || this.sources.size > 0;
  }

  /** One binary frame from the socket. Ignored unless a reply is in progress. */
  push(bytes: ArrayBuffer): void {
    if (!this.accepting) return;
    const { samples, carry } = decodePcm16le(bytes, this.carry);
    this.carry = carry;
    if (samples.length === 0) return;
    const now = this.ctx.currentTime;
    if (this.nextStart - now > MAX_QUEUED_SEC) return;
    const buffer = this.ctx.createBuffer(1, samples.length, this.sampleRate);
    buffer.copyToChannel(samples, 0);
    const { startAt, nextStart } = planChunk(this.nextStart, now, buffer.duration, this.schedule);
    this.nextStart = nextStart;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ensureGraph());
    src.onended = () => {
      src.disconnect();
      this.sources.delete(src);
      this.checkDrained();
    };
    this.sources.add(src);
    src.start(startAt);
  }

  /** tts.end: no more frames will come; `onDrained` runs once the queued audio has played. */
  end(onDrained: () => void): void {
    this.accepting = false;
    this.ended = true;
    this.onDrained = onDrained;
    this.checkDrained();
    if (this.onDrained) {
      const remainingMs = Math.max(0, this.nextStart - this.ctx.currentTime) * 1000;
      this.clearDrainTimer();
      this.drainTimer = setTimeout(() => {
        this.drainTimer = null;
        if (!this.onDrained) return;
        const cb = this.onDrained;
        this.stop(); // whatever is still "queued" is stale by now
        cb();
      }, remainingMs + DRAIN_GRACE_MS);
    }
  }

  private clearDrainTimer(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  private checkDrained(): void {
    if (this.ended && this.sources.size === 0 && this.onDrained) {
      this.clearDrainTimer();
      const cb = this.onDrained;
      this.onDrained = null;
      this.ended = false;
      cb();
    }
  }

  /** tts.stop / barge-in: silence now and drop everything queued. */
  stop(): void {
    this.clearDrainTimer();
    this.accepting = false;
    this.ended = false;
    this.onDrained = null;
    this.carry = null;
    for (const src of this.sources) {
      src.onended = null;
      try {
        src.stop(0);
      } catch {
        /* not started yet or already stopped */
      }
      src.disconnect();
    }
    this.sources.clear();
    this.nextStart = 0;
  }

  /** Lowers the volume while the user may be talking over KAIRA. */
  duck(on: boolean): void {
    if (!this.gain) return;
    const target = on ? DUCK_GAIN : 1;
    this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.015);
  }

  /** Current output RMS (0 when idle). */
  level(): number {
    if (!this.analyser || this.sources.size === 0) return 0;
    if (!this.levelBuf || this.levelBuf.length !== this.analyser.fftSize) this.levelBuf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    return rms(this.levelBuf);
  }

  dispose(): void {
    this.stop();
    this.gain?.disconnect();
    this.analyser?.disconnect();
    this.gain = null;
    this.analyser = null;
  }
}
