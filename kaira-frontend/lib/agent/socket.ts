/**
 * Live agent WebSocket client: ticket -> connect -> ping -> reconnect with backoff (fresh ticket +
 * resume_session_id each time) until disconnect() or a fatal error. Outgoing mic audio goes through a bounded
 * backlog that drops the oldest frames when the socket is backed up.
 *
 * Dead connections: a socket can stay "OPEN" for minutes after the network silently went away. Every ping arms a
 * watchdog; if nothing at all arrives from the server within PONG_TIMEOUT_MS the socket is treated as lost and
 * reconnected (which also lets the engine replay unfinished typed turns over REST). probe() pings at once (used
 * right after sending a typed turn). setOffline(true) (browser `offline` event) drops the socket at once and pauses
 * reconnect attempts so they are not burned while there is no network; setOffline(false) reconnects immediately.
 *
 * Dependencies (ticket request, WebSocket constructor, randomness) are injected so the class can be tested
 * without a network.
 */
import { parseServerFrame } from "./api";
import { BoundedQueue } from "./ring-buffer";
import { backoffDelay, DEFAULT_BACKOFF, type BackoffOptions } from "./timing";
import type { AgentSessionTicket, ClientMessage, ServerEvent } from "./protocol";

/** The subset of the browser WebSocket used here. */
export type SocketLike = {
  binaryType: BinaryType;
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: ((ev: Event) => unknown) | null;
  onclose: ((ev: CloseEvent) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
};

export type SocketStatus = "connecting" | "open" | "reconnecting" | "closed";

/** Thrown by `requestTicket` for errors that retrying will not fix (e.g. 401/403/422). */
export class FatalSocketError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FatalSocketError";
  }
}

export type AgentSocketDeps = {
  requestTicket: (resumeSessionId: string | null) => Promise<AgentSessionTicket>;
  createSocket: (url: string) => SocketLike;
  buildUrl: (wsUrl: string, ticket: string) => string;
  random?: () => number;
};

export type AgentSocketHandlers = {
  onStatus: (status: SocketStatus) => void;
  onEvent: (event: ServerEvent) => void;
  onAudio: (pcm: ArrayBuffer) => void;
  onSession: (ticket: AgentSessionTicket) => void;
  onFatal: (code: string, message: string) => void;
};

const OPEN = 1;
export const PING_INTERVAL_MS = 20_000;
/** No frame at all from the server this long after a ping: the connection is considered dead. */
export const PONG_TIMEOUT_MS = 10_000;
/** Stop handing frames to the socket above this many queued bytes (~2 s of 16 kHz Int16 audio). */
export const HIGH_WATER_BYTES = 64_000;
/** Backlog kept while backed up: 20 frames of ~100 ms. */
export const BACKLOG_FRAMES = 20;
/** Consecutive failed attempts before giving up. */
export const MAX_RECONNECT_ATTEMPTS = 8;

export class AgentSocket {
  private ws: SocketLike | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private offline = false;
  /** A reconnect is due but waits for the network to come back. */
  private waitingForNetwork = false;
  /** Generation of open(): a stale attempt (superseded or disconnected meanwhile) abandons itself. */
  private openSeq = 0;
  private sessionId: string | null = null;
  private muted = false;
  private fatalSeen = false;
  private readonly backlog = new BoundedQueue<ArrayBuffer>(BACKLOG_FRAMES);
  private readonly backoff: BackoffOptions;

  constructor(
    private readonly deps: AgentSocketDeps,
    private readonly handlers: AgentSocketHandlers,
    backoff: BackoffOptions = DEFAULT_BACKOFF,
  ) {
    this.backoff = backoff;
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === OPEN;
  }

  get droppedFrames(): number {
    return this.backlog.dropped;
  }

  /** Starts (or resumes, with a known session id) the live session. */
  connect(resumeSessionId: string | null = null): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.fatalSeen = false;
    this.attempt = 0;
    this.sessionId = resumeSessionId;
    void this.open("connecting");
  }

  /** Closes on purpose; no reconnect. */
  disconnect(): void {
    this.stopped = true;
    this.openSeq++;
    this.clearTimers();
    this.backlog.clear();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close(1000, "client closed");
      } catch {
        /* already closed */
      }
    }
    this.handlers.onStatus("closed");
  }

  /** Pings now and arms the dead-connection watchdog (no-op if not open or a ping is already outstanding). */
  probe(): void {
    if (!this.isOpen || this.pongTimer) return;
    this.ping();
  }

  /**
   * Browser connectivity changed. Offline: the current socket is dropped at once (the UI shows reconnecting) and
   * reconnecting waits. Online: reconnect now, with a fresh attempt budget.
   */
  setOffline(offline: boolean): void {
    if (offline === this.offline) return;
    this.offline = offline;
    if (this.stopped) return;
    if (offline) {
      if (this.ws) this.dropConnection();
      return;
    }
    if (this.waitingForNetwork || this.reconnectTimer) {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.waitingForNetwork = false;
      this.attempt = 0;
      void this.open("reconnecting");
    } else {
      this.probe();
    }
  }

  /** Sends a JSON control message if open. Returns whether it was sent. */
  send(message: ClientMessage): boolean {
    if (!this.isOpen) return false;
    this.ws!.send(JSON.stringify(message));
    return true;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.backlog.clear();
    this.send({ type: muted ? "mute" : "unmute" });
  }

  /** Queues one mic frame (Int16 LE bytes). Frames are dropped oldest-first when the socket is backed up. */
  sendAudio(frame: ArrayBuffer): void {
    if (this.muted || !this.isOpen) return;
    this.backlog.push(frame);
    this.flush();
  }

  private flush(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return;
    while (this.backlog.size > 0 && ws.bufferedAmount < HIGH_WATER_BYTES) ws.send(this.backlog.shift()!);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.clearPong();
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.waitingForNetwork = false;
  }

  private clearPong(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private ping(): void {
    if (!this.send({ type: "ping" })) return;
    if (this.pongTimer) return;
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      if (!this.stopped && this.ws) this.dropConnection();
    }, PONG_TIMEOUT_MS);
  }

  /** Abandons the current socket (dead or offline) and reconnects like after an unexpected close. */
  private dropConnection(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close(4000, "connection lost");
      } catch {
        /* already closed */
      }
    }
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.clearPong();
    this.scheduleReconnect();
  }

  private fatal(code: string, message: string): void {
    this.fatalSeen = true;
    this.disconnect();
    this.handlers.onFatal(code, message);
  }

  private async open(status: "connecting" | "reconnecting"): Promise<void> {
    const seq = ++this.openSeq;
    this.handlers.onStatus(status);
    let ticket: AgentSessionTicket;
    try {
      ticket = await this.deps.requestTicket(this.sessionId);
    } catch (error) {
      if (this.stopped || seq !== this.openSeq) return;
      if (error instanceof FatalSocketError) return this.fatal(error.code, error.message);
      return this.scheduleReconnect();
    }
    if (this.stopped || seq !== this.openSeq) return;
    this.sessionId = ticket.session_id;
    this.handlers.onSession(ticket);

    let ws: SocketLike;
    try {
      ws = this.deps.createSocket(this.deps.buildUrl(ticket.ws_url, ticket.ticket));
    } catch {
      return this.fatal("SOCKET_URL_INVALID", "KAIRA's live voice address is not valid.");
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.handlers.onStatus("open");
      if (this.muted) ws.send(JSON.stringify({ type: "mute" } satisfies ClientMessage));
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      this.clearPong(); // anything from the server proves the connection is alive
      if (typeof ev.data === "string") {
        const event = parseServerFrame(ev.data);
        if (!event) return;
        if (event.type === "error" && event.fatal) this.fatalSeen = true;
        this.handlers.onEvent(event);
        if (event.type === "error" && event.fatal) {
          // The server ends the session; never reconnect.
          this.disconnect();
        }
      } else if (ev.data instanceof ArrayBuffer) {
        this.handlers.onAudio(ev.data);
      }
    };
    ws.onerror = () => {
      /* followed by onclose */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.clearPong();
      if (this.stopped || this.fatalSeen) return;
      // Any close we did not ask for (including a 1000 without a fatal error, or 1008 for an expired ticket)
      // reconnects with a fresh ticket while the user still wants the live session.
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    if (this.offline) {
      // No network: wait for setOffline(false) instead of spending the attempt budget.
      this.waitingForNetwork = true;
      this.handlers.onStatus("reconnecting");
      return;
    }
    if (this.attempt >= MAX_RECONNECT_ATTEMPTS) {
      return this.fatal("CONNECTION_LOST", "Lost the connection to KAIRA's live voice. Turn live voice on again to retry.");
    }
    const delay = backoffDelay(this.attempt, this.backoff, this.deps.random);
    this.attempt++;
    this.handlers.onStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.open("reconnecting");
    }, delay);
  }
}
