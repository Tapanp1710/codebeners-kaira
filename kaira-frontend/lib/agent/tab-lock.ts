/**
 * Cross-tab ownership of the live microphone session: only ONE tab of this browser profile (the cookie session,
 * i.e. one signed-in user) may stream the microphone to KAIRA at a time.
 *
 * - Ownership is a Web Locks API lock (`navigator.locks`, exclusive, `ifAvailable`): the browser releases it by
 *   itself when the holding tab closes, crashes or navigates away, so a dead tab can never block live voice.
 * - A BroadcastChannel tells the other tabs when a tab starts/stops holding it ("live voice is active in another
 *   tab"); a tab opened later asks (`navigator.locks.query()`, or a "query" message without Web Locks). While a tab
 *   believes another one holds the lock it re-checks with `query()` every few seconds, so a crashed holder that
 *   could not say goodbye is noticed.
 * - Without Web Locks (very old browsers) the BroadcastChannel state alone decides, best effort. Without either, a
 *   tab always gets the lock (no cross-tab protection is possible there).
 *
 * Environment access is injected (`TabLockEnv`) so the class is testable without a browser.
 */

export const LIVE_LOCK_NAME = "kaira.agent.live-mic";
export const LIVE_CHANNEL_NAME = "kaira.agent.live";
/** While another tab is believed to hold the lock, re-check this often (catches a crashed holder). */
export const ELSEWHERE_RECHECK_MS = 5_000;

type LockManagerLike = {
  request: (name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => unknown) => Promise<unknown>;
  query?: () => Promise<{ held?: Array<{ name?: string }> }>;
};

type ChannelLike = {
  postMessage: (message: unknown) => void;
  close: () => void;
  onmessage: ((event: MessageEvent) => void) | null;
};

export type TabLockEnv = {
  locks: LockManagerLike | null;
  createChannel: ((name: string) => ChannelLike) | null;
  tabId: string;
};

type ChannelMessage = { type: "held" | "released" | "query"; tab: string };

export type LiveTabLock = {
  /** Tries to take the live session for this tab. Resolves true if this tab now holds it. Never rejects. */
  acquire(): Promise<boolean>;
  /** Gives it up (idempotent). */
  release(): void;
  /** True while this tab holds it. */
  readonly held: boolean;
  /** Notifies whenever "another tab holds the live session" changes. Returns an unsubscribe function. */
  watch(listener: (heldElsewhere: boolean) => void): () => void;
  /** Releases and stops listening (unmount). */
  dispose(): void;
};

function randomTabId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function browserTabLockEnv(): TabLockEnv {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManagerLike }) : null;
  const locks = nav?.locks && typeof nav.locks.request === "function" ? nav.locks : null;
  const createChannel =
    typeof BroadcastChannel !== "undefined" ? (name: string) => new BroadcastChannel(name) as unknown as ChannelLike : null;
  return { locks, createChannel, tabId: randomTabId() };
}

export class BrowserTabLock implements LiveTabLock {
  private holding = false;
  private releaseLock: (() => void) | null = null;
  private elsewhere = false;
  private readonly listeners = new Set<(heldElsewhere: boolean) => void>();
  private channel: ChannelLike | null = null;
  private recheckTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  /** Without Web Locks: the tab that announced it holds the session. */
  private knownHolder: string | null = null;
  /** An acquire() in flight: concurrent calls share it instead of racing for the lock against themselves. */
  private pending: Promise<boolean> | null = null;

  constructor(private readonly env: TabLockEnv = browserTabLockEnv()) {
    if (env.createChannel) {
      try {
        this.channel = env.createChannel(LIVE_CHANNEL_NAME);
        this.channel.onmessage = (event) => this.onMessage(event.data);
      } catch {
        this.channel = null;
      }
    }
    void this.refresh();
  }

  get held(): boolean {
    return this.holding;
  }

  acquire(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.holding) return Promise.resolve(true);
    if (this.pending) return this.pending;
    const attempt = this.request().finally(() => {
      if (this.pending === attempt) this.pending = null;
    });
    this.pending = attempt;
    return attempt;
  }

  private request(): Promise<boolean> {
    const locks = this.env.locks;
    if (!locks) {
      if (this.knownHolder && this.knownHolder !== this.env.tabId) return Promise.resolve(false);
      this.markHeld();
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      locks
        .request(LIVE_LOCK_NAME, { ifAvailable: true }, (lock) => {
          if (!lock || this.disposed) {
            resolve(false);
            if (!lock) this.setElsewhere(true);
            return undefined;
          }
          // Held until release() resolves this promise (or the tab goes away).
          const until = new Promise<void>((done) => (this.releaseLock = done));
          this.markHeld();
          resolve(true);
          return until;
        })
        .catch(() => resolve(false));
    });
  }

  release(): void {
    if (!this.holding) return;
    this.holding = false;
    const done = this.releaseLock;
    this.releaseLock = null;
    done?.();
    this.post("released");
  }

  watch(listener: (heldElsewhere: boolean) => void): () => void {
    this.listeners.add(listener);
    listener(this.elsewhere);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.release();
    this.disposed = true;
    this.listeners.clear();
    this.stopRecheck();
    if (this.channel) {
      this.channel.onmessage = null;
      try {
        this.channel.close();
      } catch {
        /* already closed */
      }
    }
    this.channel = null;
  }

  // ------------------------------------------------------------------ internals
  private markHeld(): void {
    this.holding = true;
    this.knownHolder = this.env.tabId;
    this.setElsewhere(false);
    this.post("held");
  }

  private post(type: ChannelMessage["type"]): void {
    try {
      this.channel?.postMessage({ type, tab: this.env.tabId } satisfies ChannelMessage);
    } catch {
      /* channel closed */
    }
  }

  private onMessage(data: unknown): void {
    if (this.disposed || typeof data !== "object" || data === null) return;
    const msg = data as Partial<ChannelMessage>;
    if (typeof msg.tab !== "string" || msg.tab === this.env.tabId) return;
    if (msg.type === "held") {
      this.knownHolder = msg.tab;
      this.setElsewhere(true);
    } else if (msg.type === "released") {
      if (this.knownHolder === msg.tab) this.knownHolder = null;
      // With Web Locks, confirm (another tab may have taken it meanwhile); otherwise trust the message.
      if (this.env.locks?.query) void this.refresh();
      else this.setElsewhere(false);
    } else if (msg.type === "query" && this.holding) {
      this.post("held");
    }
  }

  /** Re-reads who holds the lock. */
  private async refresh(): Promise<void> {
    const query = this.env.locks?.query;
    if (!query) {
      this.post("query");
      return;
    }
    try {
      const snapshot = await query.call(this.env.locks);
      if (this.disposed) return;
      const heldBySomeone = (snapshot.held ?? []).some((l) => l.name === LIVE_LOCK_NAME);
      this.setElsewhere(heldBySomeone && !this.holding);
    } catch {
      /* query unsupported or failed: keep the current belief */
    }
  }

  private setElsewhere(value: boolean): void {
    if (value) this.startRecheck();
    else this.stopRecheck();
    if (value === this.elsewhere) return;
    this.elsewhere = value;
    for (const listener of this.listeners) listener(value);
  }

  private startRecheck(): void {
    if (this.recheckTimer || !this.env.locks?.query || this.disposed) return;
    this.recheckTimer = setInterval(() => void this.refresh(), ELSEWHERE_RECHECK_MS);
  }

  private stopRecheck(): void {
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    this.recheckTimer = null;
  }
}
