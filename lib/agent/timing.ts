/**
 * Pure timing helpers for the voice engine: reconnect backoff and gapless playback scheduling.
 */

export type BackoffOptions = {
  baseMs: number;
  maxMs: number;
  /** Fraction of the delay that is randomised (0 = none, 1 = full jitter). */
  jitter: number;
};

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, maxMs: 15_000, jitter: 0.5 };

/**
 * Delay before reconnect attempt `attempt` (0-based): exponential growth capped at `maxMs`, with the top `jitter`
 * fraction randomised so many tabs do not reconnect in lockstep. `random` is injectable for tests.
 */
export function backoffDelay(attempt: number, options: BackoffOptions = DEFAULT_BACKOFF, random: () => number = Math.random): number {
  const exp = Math.min(options.maxMs, options.baseMs * 2 ** Math.max(0, attempt));
  const fixed = exp * (1 - options.jitter);
  return Math.round(fixed + exp * options.jitter * random());
}

export type ScheduleOptions = {
  /** Minimum time between "now" and a chunk's start for it to be scheduled back-to-back (s). */
  minLeadSec: number;
  /** Lead used after an underrun (first chunk, or the queue ran dry): absorbs network jitter (s). */
  startLeadSec: number;
};

export const DEFAULT_SCHEDULE: ScheduleOptions = { minLeadSec: 0.02, startLeadSec: 0.08 };

/**
 * Where to start the next PCM chunk. Chunks are placed back-to-back (`nextStart`) for gapless playback; if that
 * time is already (nearly) in the past, the queue underran and playback restarts `startLeadSec` from now.
 * Returns the chunk's start time and the start time for the chunk after it.
 */
export function planChunk(
  nextStart: number,
  now: number,
  durationSec: number,
  options: ScheduleOptions = DEFAULT_SCHEDULE,
): { startAt: number; nextStart: number; underrun: boolean } {
  const underrun = nextStart < now + options.minLeadSec;
  const startAt = underrun ? now + options.startLeadSec : nextStart;
  return { startAt, nextStart: startAt + durationSec, underrun };
}

/** Seconds of audio still queued after `now`. */
export function bufferedAhead(nextStart: number, now: number): number {
  return Math.max(0, nextStart - now);
}
