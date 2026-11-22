// @vitest-environment node
/** Bounded queue, pre-roll ring buffer, client VAD hangover, reconnect backoff and playback scheduling math. */
import { describe, expect, it } from "vitest";

import { BoundedQueue, PreRollBuffer } from "@/lib/agent/ring-buffer";
import { backoffDelay, bufferedAhead, planChunk } from "@/lib/agent/timing";
import { EnergyVad } from "@/lib/agent/vad";

describe("BoundedQueue", () => {
  it("drops the oldest items when full and counts them", () => {
    const q = new BoundedQueue<number>(3);
    for (let i = 1; i <= 5; i++) q.push(i);
    expect(q.size).toBe(3);
    expect(q.dropped).toBe(2);
    expect(q.shift()).toBe(3);
    expect(q.drain()).toEqual([4, 5]);
    expect(q.size).toBe(0);
  });
  it("rejects a zero capacity", () => {
    expect(() => new BoundedQueue(0)).toThrow();
  });
});

describe("PreRollBuffer (400 ms at 16 kHz)", () => {
  it("keeps only the newest samples, in order, across frames", () => {
    const b = new PreRollBuffer(6400);
    for (let f = 0; f < 6; f++) b.push(new Int16Array(1600).fill(f)); // 600 ms
    expect(b.size).toBe(6400);
    const out = b.drain();
    expect(out.length).toBe(6400);
    expect(out[0]).toBe(2);
    expect(out[6399]).toBe(5);
    expect(Array.from(new Set(out))).toEqual([2, 3, 4, 5]);
    expect(b.size).toBe(0);
  });

  it("handles a frame larger than the capacity and partial fills", () => {
    const b = new PreRollBuffer(4);
    b.push(Int16Array.from([1, 2]));
    expect(Array.from(b.drain())).toEqual([1, 2]);
    b.push(Int16Array.from([1, 2, 3, 4, 5, 6]));
    expect(Array.from(b.drain())).toEqual([3, 4, 5, 6]);
    b.push(Int16Array.from([7, 8, 9]));
    b.push(Int16Array.from([10, 11]));
    expect(Array.from(b.drain())).toEqual([8, 9, 10, 11]);
  });

  it("clear() empties it", () => {
    const b = new PreRollBuffer(4);
    b.push(Int16Array.from([1]));
    b.clear();
    expect(b.drain().length).toBe(0);
  });
});

describe("EnergyVad", () => {
  const frame = 100;
  it("needs the attack time before speech starts", () => {
    const vad = new EnergyVad({ attackMs: 200, hangoverMs: 500 });
    for (let i = 0; i < 5; i++) vad.process(0.001, frame); // quiet room
    expect(vad.process(0.2, frame)).toEqual({ speech: false, changed: false });
    expect(vad.process(0.2, frame)).toEqual({ speech: true, changed: true });
  });

  it("holds speech through short pauses (hangover) and ends after it", () => {
    const vad = new EnergyVad({ attackMs: 100, hangoverMs: 300, calibrationMs: 0 });
    vad.process(0.2, frame);
    expect(vad.speaking).toBe(true);
    expect(vad.process(0.001, frame).speech).toBe(true);
    expect(vad.process(0.001, frame).speech).toBe(true);
    // Talking again resets the hangover.
    expect(vad.process(0.2, frame).speech).toBe(true);
    expect(vad.process(0.001, frame).speech).toBe(true);
    expect(vad.process(0.001, frame).speech).toBe(true);
    expect(vad.process(0.001, frame)).toEqual({ speech: false, changed: true });
  });

  it("calibrates on a noisy background instead of reporting it as speech", () => {
    const vad = new EnergyVad({ attackMs: 100 });
    for (let i = 0; i < 20; i++) expect(vad.process(0.03, frame).speech).toBe(false);
    expect(vad.threshold()).toBeGreaterThan(0.08);
    expect(vad.process(0.06, frame).speech).toBe(false);
    expect(vad.process(0.3, frame).speech).toBe(true);
  });

  it("sensitivityScale raises the threshold (used while KAIRA speaks)", () => {
    const vad = new EnergyVad({ attackMs: 100, minThreshold: 0.02 });
    vad.process(0.001, frame);
    vad.process(0.001, frame);
    vad.sensitivityScale = 2;
    expect(vad.threshold()).toBeCloseTo(0.04);
    expect(vad.process(0.03, frame).speech).toBe(false);
    expect(vad.process(0.05, frame).speech).toBe(true);
    vad.reset();
    expect(vad.speaking).toBe(false);
  });
});

describe("backoffDelay", () => {
  const opts = { baseMs: 500, maxMs: 15_000, jitter: 0.5 };
  it("grows exponentially and is capped", () => {
    expect(backoffDelay(0, opts, () => 1)).toBe(500);
    expect(backoffDelay(1, opts, () => 1)).toBe(1000);
    expect(backoffDelay(3, opts, () => 1)).toBe(4000);
    expect(backoffDelay(10, opts, () => 1)).toBe(15_000);
    expect(backoffDelay(50, opts, () => 1)).toBe(15_000);
  });
  it("randomises the jitter fraction only", () => {
    expect(backoffDelay(2, opts, () => 0)).toBe(1000);
    expect(backoffDelay(2, opts, () => 0.5)).toBe(1500);
    expect(backoffDelay(2, { ...opts, jitter: 0 }, () => 0.9)).toBe(2000);
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(4, opts);
      expect(d).toBeGreaterThanOrEqual(4000);
      expect(d).toBeLessThanOrEqual(8000);
    }
  });
});

describe("planChunk (gapless playback scheduling)", () => {
  const opts = { minLeadSec: 0.02, startLeadSec: 0.08 };
  it("starts the first chunk after the start lead", () => {
    expect(planChunk(0, 10, 0.1, opts)).toEqual({ startAt: 10.08, nextStart: 10.18, underrun: true });
  });
  it("places following chunks back-to-back", () => {
    let next = 0;
    const starts: number[] = [];
    for (let i = 0; i < 4; i++) {
      const p = planChunk(next, 10 + i * 0.01, 0.1, opts); // chunks arrive faster than they play
      starts.push(p.startAt);
      next = p.nextStart;
    }
    starts.forEach((s, i) => expect(s).toBeCloseTo(10.08 + i * 0.1, 9));
  });
  it("re-buffers after an underrun instead of scheduling in the past", () => {
    const p = planChunk(10.5, 11, 0.1, opts);
    expect(p.underrun).toBe(true);
    expect(p.startAt).toBeCloseTo(11.08);
    // Exactly at the minimum lead is still on time.
    expect(planChunk(11.02, 11, 0.1, opts).underrun).toBe(false);
  });
  it("reports buffered time ahead", () => {
    expect(bufferedAhead(12, 11.5)).toBe(0.5);
    expect(bufferedAhead(11, 11.5)).toBe(0);
  });
});
