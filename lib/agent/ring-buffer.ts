/**
 * Bounded queues for the voice engine. Both drop the OLDEST data when full, so a stalled socket or a long reconnect
 * never grows memory and the newest audio (what the user is saying now) is kept.
 */

/** Fixed-capacity FIFO of items; pushing into a full queue evicts the oldest item. */
export class BoundedQueue<T> {
  private items: T[] = [];
  dropped = 0;
  constructor(readonly capacity: number) {
    if (!(capacity >= 1)) throw new Error("capacity must be >= 1");
  }
  get size() {
    return this.items.length;
  }
  push(item: T): void {
    this.items.push(item);
    while (this.items.length > this.capacity) {
      this.items.shift();
      this.dropped++;
    }
  }
  shift(): T | undefined {
    return this.items.shift();
  }
  peek(): T | undefined {
    return this.items[0];
  }
  /** Removes and returns everything, oldest first. */
  drain(): T[] {
    const out = this.items;
    this.items = [];
    return out;
  }
  clear(): void {
    this.items = [];
  }
}

/**
 * Pre-roll buffer: keeps the most recent `capacitySamples` of Int16 audio (e.g. 400 ms at 16 kHz = 6 400 samples)
 * across frames of any size. While the socket is not open (connecting/reconnecting) mic frames go here, and the
 * first words are sent as soon as it opens instead of being lost.
 */
export class PreRollBuffer {
  private readonly buf: Int16Array;
  private start = 0; // index of the oldest sample
  private length = 0;

  constructor(readonly capacitySamples: number) {
    if (!(capacitySamples >= 1)) throw new Error("capacitySamples must be >= 1");
    this.buf = new Int16Array(capacitySamples);
  }

  get size() {
    return this.length;
  }

  push(samples: Int16Array): void {
    const cap = this.capacitySamples;
    // Only the last `cap` samples of a large frame can survive.
    const src = samples.length > cap ? samples.subarray(samples.length - cap) : samples;
    for (let i = 0; i < src.length; i++) {
      const end = (this.start + this.length) % cap;
      this.buf[end] = src[i];
      if (this.length < cap) this.length++;
      else this.start = (this.start + 1) % cap;
    }
  }

  /** Returns the buffered samples in order (oldest first) and empties the buffer. */
  drain(): Int16Array<ArrayBuffer> {
    const out = new Int16Array(this.length);
    for (let i = 0; i < this.length; i++) out[i] = this.buf[(this.start + i) % this.capacitySamples];
    this.clear();
    return out;
  }

  clear(): void {
    this.start = 0;
    this.length = 0;
  }
}
