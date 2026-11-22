// @vitest-environment node
/**
 * BrowserTabLock (lib/agent/tab-lock.ts): only one tab holds the live microphone session. Two "tabs" share an
 * in-memory Web Locks manager and BroadcastChannel bus that follow the browser semantics used here (exclusive lock,
 * ifAvailable, release when the callback's promise settles, query(); channel messages reach every other channel of
 * the same name, never the sender). No real browser is involved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserTabLock, ELSEWHERE_RECHECK_MS, LIVE_LOCK_NAME, type TabLockEnv } from "@/lib/agent/tab-lock";

class FakeLockManager {
  holder: object | null = null;
  async request(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => unknown) {
    expect(name).toBe(LIVE_LOCK_NAME);
    expect(options.ifAvailable).toBe(true);
    if (this.holder) return callback(null);
    const lock = { name };
    this.holder = lock;
    try {
      return await callback(lock);
    } finally {
      if (this.holder === lock) this.holder = null;
    }
  }
  async query() {
    return { held: this.holder ? [{ name: LIVE_LOCK_NAME }] : [] };
  }
  /** The holding tab crashed: the browser drops its lock without any message. */
  crash() {
    this.holder = null;
  }
}

class Bus {
  channels = new Set<FakeChannel>();
  create = (name: string) => new FakeChannel(this, name);
}

class FakeChannel {
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(
    private readonly bus: Bus,
    readonly name: string,
  ) {
    bus.channels.add(this);
  }
  postMessage(data: unknown) {
    for (const ch of this.bus.channels) {
      if (ch !== this && ch.name === this.name) queueMicrotask(() => ch.onmessage?.({ data } as MessageEvent));
    }
  }
  close() {
    this.bus.channels.delete(this);
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0);

let locks: FakeLockManager;
let bus: Bus;
const env = (tabId: string, withLocks = true): TabLockEnv => ({ locks: withLocks ? locks : null, createChannel: bus.create, tabId });

beforeEach(() => {
  vi.useFakeTimers();
  locks = new FakeLockManager();
  bus = new Bus();
});
afterEach(() => vi.useRealTimers());

describe("BrowserTabLock with Web Locks", () => {
  it("one tab holds it; the other is refused and told live voice is active elsewhere; release hands it over", async () => {
    const a = new BrowserTabLock(env("a"));
    const b = new BrowserTabLock(env("b"));
    const seenByB: boolean[] = [];
    b.watch((v) => seenByB.push(v));
    await flush();

    expect(await a.acquire()).toBe(true);
    expect(a.held).toBe(true);
    await flush();
    expect(seenByB.at(-1)).toBe(true);

    expect(await b.acquire()).toBe(false);
    expect(b.held).toBe(false);

    a.release();
    expect(a.held).toBe(false);
    await flush();
    expect(seenByB.at(-1)).toBe(false);
    expect(await b.acquire()).toBe(true);
    a.dispose();
    b.dispose();
  });

  it("a tab opened later learns that another tab is live (query on start)", async () => {
    const a = new BrowserTabLock(env("a"));
    await a.acquire();
    const late = new BrowserTabLock(env("late"));
    const seen: boolean[] = [];
    late.watch((v) => seen.push(v));
    await flush();
    expect(seen.at(-1)).toBe(true);
    a.dispose();
    late.dispose();
  });

  it("notices a crashed holder (no goodbye message) by re-checking", async () => {
    const a = new BrowserTabLock(env("a"));
    await a.acquire();
    const b = new BrowserTabLock(env("b"));
    const seen: boolean[] = [];
    b.watch((v) => seen.push(v));
    await flush();
    expect(seen.at(-1)).toBe(true);
    locks.crash();
    await vi.advanceTimersByTimeAsync(ELSEWHERE_RECHECK_MS);
    expect(seen.at(-1)).toBe(false);
    expect(await b.acquire()).toBe(true);
    b.dispose();
  });

  it("concurrent acquire() calls in one tab share one request (never refuse themselves)", async () => {
    const a = new BrowserTabLock(env("a"));
    const [x, y] = await Promise.all([a.acquire(), a.acquire()]);
    expect([x, y]).toEqual([true, true]);
    const seen: boolean[] = [];
    a.watch((v) => seen.push(v));
    expect(seen).toEqual([false]);
    a.dispose();
  });

  it("dispose releases the lock and stops listening", async () => {
    const a = new BrowserTabLock(env("a"));
    const b = new BrowserTabLock(env("b"));
    await a.acquire();
    a.dispose();
    await flush();
    expect(locks.holder).toBeNull();
    expect(await a.acquire()).toBe(false); // a disposed lock never takes the session again
    expect(await b.acquire()).toBe(true);
    b.dispose();
  });
});

describe("BrowserTabLock without Web Locks (BroadcastChannel only, best effort)", () => {
  it("refuses while another tab announced it holds the session and accepts after it released", async () => {
    const a = new BrowserTabLock(env("a", false));
    const b = new BrowserTabLock(env("b", false));
    const seen: boolean[] = [];
    b.watch((v) => seen.push(v));
    await flush();
    expect(await a.acquire()).toBe(true);
    await flush();
    expect(seen.at(-1)).toBe(true);
    expect(await b.acquire()).toBe(false);
    a.release();
    await flush();
    expect(seen.at(-1)).toBe(false);
    expect(await b.acquire()).toBe(true);
    a.dispose();
    b.dispose();
  });

  it("a later tab asks, and the holder answers", async () => {
    const a = new BrowserTabLock(env("a", false));
    await a.acquire();
    const late = new BrowserTabLock(env("late", false));
    const seen: boolean[] = [];
    late.watch((v) => seen.push(v));
    await flush();
    await flush();
    expect(seen.at(-1)).toBe(true);
    a.dispose();
    late.dispose();
  });

  it("with neither Web Locks nor BroadcastChannel, a tab always gets the session", async () => {
    const solo = new BrowserTabLock({ locks: null, createChannel: null, tabId: "solo" });
    expect(await solo.acquire()).toBe(true);
    solo.dispose();
  });
});
