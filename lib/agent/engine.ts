/**
 * The live voice engine: owns the AudioContext, microphone, client VAD, pre-roll, WebSocket and playback, and
 * folds everything into one state through the pure reducer (./reducer). It is a small external store
 * (subscribe/getSnapshot) consumed by components/agent/agent-provider.tsx via useSyncExternalStore.
 *
 * Lifecycle: attach() on mount (history, readiness, "resume" hint), enable()/disable() from explicit user actions,
 * detach() on unmount (releases mic/socket/audio, keeps the user's live preference for a reload).
 */
import { ApiError } from "@/lib/api/errors";

import {
  buildSocketUrl,
  getAgentConversation,
  newTurnId,
  postAgentTurn,
  readVoiceProviderReady,
  startAgentSession,
} from "./api";
import { MicCapture, MicError, micSupportError, type MicFrame } from "./mic";
import { PcmPlayer } from "./player";
import { rmsToLevel, smoothLevel } from "./pcm";
import { MIC_SAMPLE_RATE, type AgentSessionTicket, type ServerEvent } from "./protocol";
import {
  eventIntents,
  initialAgentState,
  reduceAgentEvent,
  type AgentEngineState,
  type AgentEvent,
  type AgentIntent,
} from "./reducer";
import { PreRollBuffer } from "./ring-buffer";
import { AgentSocket, FatalSocketError, type SocketLike } from "./socket";
import { EnergyVad } from "./vad";

export const PREROLL_MS = 400;
/** Sustained user speech over KAIRA's voice for this long stops playback locally and sends an interrupt. */
export const LOCAL_BARGE_STOP_MS = 600;
const LEVEL_INTERVAL_MS = 50;
const STORAGE_LIVE = "kaira.agent.live";
const STORAGE_SESSION = "kaira.agent.session";

export type EngineDeps = {
  startSession: (resumeSessionId: string | null) => Promise<AgentSessionTicket>;
  postTurn: typeof postAgentTurn;
  getConversation: typeof getAgentConversation;
  readVoiceReady: () => Promise<boolean | null>;
  createSocket: (url: string) => SocketLike;
  createAudioContext: () => AudioContext;
  createMic: () => MicCapture;
  storage: () => Storage | null;
  origin: () => string;
};

function browserStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null; // blocked storage (privacy mode, sandboxed iframe)
  }
}

export const defaultEngineDeps: EngineDeps = {
  startSession: startAgentSession,
  postTurn: postAgentTurn,
  getConversation: getAgentConversation,
  readVoiceReady: readVoiceProviderReady,
  createSocket: (url) => new WebSocket(url),
  createAudioContext: () => new AudioContext({ latencyHint: "interactive" }),
  createMic: () => new MicCapture(),
  storage: browserStorage,
  origin: () => (typeof window !== "undefined" ? window.location.origin : "http://localhost"),
};

function errorMessage(error: unknown, fallback: string): { code: string; message: string } {
  if (error instanceof ApiError) return { code: error.code, message: error.message || fallback };
  return { code: "request_failed", message: fallback };
}

export class AgentEngine {
  private state: AgentEngineState = initialAgentState;
  private readonly listeners = new Set<() => void>();
  private intentHandler: ((intent: AgentIntent) => void) | null = null;

  private ctx: AudioContext | null = null;
  private mic: MicCapture | null = null;
  private player: PcmPlayer | null = null;
  private socket: AgentSocket | null = null;
  private readonly vad = new EnergyVad();
  private readonly preRoll = new PreRollBuffer((MIC_SAMPLE_RATE * PREROLL_MS) / 1000);
  private enableSeq = 0;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private lastMicRms = 0;
  private bargeStartedAt: number | null = null;
  private ducked = false;
  /** Typed turns sent over the socket and not finished yet (replayed over REST if the socket drops). */
  private readonly pendingTextTurns = new Map<string, string>();
  /** Typed turns currently running over REST. */
  private readonly restTurns = new Set<string>();

  constructor(private readonly deps: EngineDeps = defaultEngineDeps) {}

  // ------------------------------------------------------------------ store
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AgentEngineState => this.state;

  setIntentHandler(handler: ((intent: AgentIntent) => void) | null): void {
    this.intentHandler = handler;
  }

  private dispatch(event: AgentEvent): void {
    const next = reduceAgentEvent(this.state, event);
    const intents = eventIntents(event);
    if (next !== this.state) {
      this.state = next;
      this.listeners.forEach((l) => l());
    }
    for (const intent of intents) this.intentHandler?.(intent);
  }

  // ------------------------------------------------------------------ lifecycle
  attach(): void {
    const storage = this.deps.storage();
    // A reload never re-opens the microphone by itself; it only offers to resume.
    if (storage?.getItem(STORAGE_LIVE) === "1" && !this.state.live) this.dispatch({ type: "local.resume_available", value: true });
    this.deps
      .getConversation()
      .then((messages) => this.dispatch({ type: "local.history", messages }))
      .catch(() => {
        /* history is optional; the live session and typed turns still work */
      });
    if (this.state.voiceConfigured === null) {
      void this.deps.readVoiceReady().then((value) => {
        if (value !== null && this.state.voiceConfigured === null) this.dispatch({ type: "local.voice_configured", value });
      });
    }
  }

  /** Releases every device and connection (unmount). The live preference stays stored for a reload. */
  detach(): void {
    this.enableSeq++;
    this.teardown();
    if (this.state.live) this.dispatch({ type: "local.live", live: false });
  }

  // ------------------------------------------------------------------ public actions
  /** Must be called from a user gesture (click): creates/resumes audio there, then asks for the microphone. */
  enable = async (): Promise<void> => {
    if (this.state.live) return;
    const unsupported = micSupportError();
    if (unsupported) return this.dispatch({ type: "local.error", error: unsupported.toAgentError() });
    if (this.state.voiceConfigured === false) {
      return this.dispatch({
        type: "local.error",
        error: { code: "voice_not_configured", message: "Live voice is not set up on the server yet. Typed input still works.", fatal: true },
      });
    }
    const seq = ++this.enableSeq;
    // Synchronously inside the gesture: satisfies the autoplay policy for playback and capture alike.
    let ctx: AudioContext;
    try {
      ctx = this.ensureContext();
    } catch {
      return this.dispatch({
        type: "local.error",
        error: { code: "audio_unsupported", message: "This browser could not start audio for live voice.", fatal: true },
      });
    }
    const resumed = ctx.state === "suspended" ? ctx.resume().catch(() => {}) : Promise.resolve();
    this.dispatch({ type: "local.live", live: true });
    this.dispatch({ type: "local.connection", state: "connecting" });
    this.deps.storage()?.setItem(STORAGE_LIVE, "1");

    const mic = this.deps.createMic();
    this.mic = mic;
    try {
      await mic.start(ctx, this.onMicFrame, this.onMicEnded);
      await resumed;
    } catch (error) {
      if (seq !== this.enableSeq) return;
      const micError = error instanceof MicError ? error : new MicError("mic_failed", "The microphone could not be started.");
      this.failLive(micError.code, micError.message);
      return;
    }
    if (seq !== this.enableSeq) {
      mic.stop();
      return;
    }
    if (this.state.muted) mic.setEnabled(false);

    const socket: AgentSocket = new AgentSocket(
      {
        requestTicket: this.requestTicket,
        createSocket: this.deps.createSocket,
        buildUrl: (wsUrl, ticket) => buildSocketUrl(wsUrl, ticket, this.deps.origin()),
      },
      {
        onStatus: (status) => {
          if (this.socket !== socket) return;
          this.dispatch({ type: "local.connection", state: status });
          if (status === "open") this.flushPreRoll();
          else if (status === "reconnecting") this.recoverPendingTurns();
        },
        onEvent: (event) => this.socket === socket && this.handleServerEvent(event),
        onAudio: (pcm) => this.socket === socket && this.player?.push(pcm),
        onSession: (ticket) => {
          this.deps.storage()?.setItem(STORAGE_SESSION, ticket.session_id);
          this.dispatch({ type: "local.voice_configured", value: ticket.voice_configured });
        },
        onFatal: (code, message) => this.socket === socket && this.failLive(code, message),
      },
    );
    this.socket = socket;
    if (this.state.muted) socket.setMuted(true);
    socket.connect(this.deps.storage()?.getItem(STORAGE_SESSION) ?? null);
    this.startLevels();
  };

  disable = (): void => {
    this.enableSeq++;
    this.teardown();
    this.deps.storage()?.removeItem(STORAGE_LIVE);
    this.dispatch({ type: "local.live", live: false });
    this.dispatch({ type: "local.resume_available", value: false });
  };

  setMuted = (muted: boolean): void => {
    if (muted === this.state.muted) return;
    this.dispatch({ type: "local.muted", muted });
    this.socket?.setMuted(muted);
    this.mic?.setEnabled(!muted);
    if (muted) {
      this.vad.reset();
      this.preRoll.clear();
      this.lastMicRms = 0;
      this.bargeStartedAt = null;
      if (this.ducked) this.unduck();
    }
  };

  interrupt = (): void => {
    this.player?.stop();
    this.socket?.send({ type: "interrupt" });
    this.dispatch({ type: "tts.stop", reason: "user" });
  };

  /** Typed input. Over the open socket when live; otherwise POST /agent/turn. Errors end up in `error`. */
  sendText = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const turnId = newTurnId();
    this.dispatch({ type: "local.turn_pending", turn_id: turnId, text: trimmed, at: new Date().toISOString(), mode: "text" });
    if (this.socket?.isOpen && this.socket.send({ type: "text", text: trimmed, turn_id: turnId })) {
      this.pendingTextTurns.set(turnId, trimmed);
      return;
    }
    await this.runRestTurn(turnId, trimmed);
  };

  // ------------------------------------------------------------------ internals
  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = this.deps.createAudioContext();
      this.player = new PcmPlayer(this.ctx);
    }
    return this.ctx;
  }

  private requestTicket = async (resumeSessionId: string | null): Promise<AgentSessionTicket> => {
    try {
      const ticket = await this.deps.startSession(resumeSessionId);
      if (!ticket.voice_configured) {
        throw new FatalSocketError("voice_not_configured", "Live voice is not set up on the server yet. Typed input still works.");
      }
      return ticket;
    } catch (error) {
      if (error instanceof FatalSocketError) throw error;
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
        // A resume id the server no longer knows is not fatal: start a fresh session instead.
        if (resumeSessionId && (error.status === 404 || error.status === 422)) {
          this.deps.storage()?.removeItem(STORAGE_SESSION);
          return this.requestTicket(null);
        }
        throw new FatalSocketError(error.code, error.message || "KAIRA refused to start a live session.");
      }
      throw error; // network, timeout, 5xx, 429: retried with backoff
    }
  };

  private async runRestTurn(turnId: string, text: string): Promise<void> {
    this.restTurns.add(turnId);
    try {
      const out = await this.deps.postTurn(text, turnId);
      let sawReply = false;
      let sawIgnored = false;
      for (const event of out.events) {
        // A typed REST turn has no audio; speech events would leave the orb "speaking".
        if (event.type.startsWith("tts.")) continue;
        if (event.type === "reply") sawReply = true;
        if (event.type === "ignored") sawIgnored = true;
        this.dispatch(event);
      }
      if (out.ignored && !sawIgnored) this.dispatch({ type: "ignored", turn_id: turnId, text });
      if (!out.ignored && !sawReply && out.reply) {
        this.dispatch({ type: "reply", turn_id: turnId, text: out.reply, language: out.language });
      }
      this.dispatch({ type: "local.turn_done", turn_id: turnId });
    } catch (error) {
      const { code, message } = errorMessage(error, "KAIRA could not answer that. Please try again.");
      this.dispatch({ type: "local.turn_failed", turn_id: turnId, code, message });
    } finally {
      this.restTurns.delete(turnId);
    }
  }

  /** The socket dropped: replay unfinished typed turns over REST (same turn_id, so no tool runs twice). */
  private recoverPendingTurns(): void {
    const turnId = this.state.turnId;
    if (turnId && !this.pendingTextTurns.has(turnId) && !this.restTurns.has(turnId)) {
      // A voice turn in flight cannot be recovered; stop showing it as in progress.
      this.dispatch({ type: "local.turn_done", turn_id: turnId });
    }
    if (this.state.speaking) {
      this.player?.stop();
      this.dispatch({ type: "tts.stop", reason: "new_turn" });
    }
    const pending = [...this.pendingTextTurns];
    this.pendingTextTurns.clear();
    for (const [turnId, text] of pending) void this.runRestTurn(turnId, text);
  }

  private handleServerEvent(event: ServerEvent): void {
    switch (event.type) {
      case "tts.start":
        this.ensureContext();
        this.player?.begin(event.sample_rate);
        this.ducked = false;
        this.bargeStartedAt = null;
        break;
      case "tts.end":
        this.player?.end(() => this.dispatch({ type: "local.playback_drained" }));
        break;
      case "tts.stop":
        this.player?.stop();
        this.ducked = false;
        break;
      case "turn.completed":
      case "turn.cancelled":
      case "turn.failed":
        this.pendingTextTurns.delete(event.turn_id);
        break;
    }
    this.dispatch(event);
    if (event.type === "error" && event.fatal) {
      this.enableSeq++;
      this.teardown();
      this.deps.storage()?.removeItem(STORAGE_LIVE);
    }
  }

  private onMicFrame = (frame: MicFrame): void => {
    if (!this.state.live || this.state.muted) return;
    this.lastMicRms = frame.rms;
    const frameMs = (frame.pcm.byteLength / 2 / MIC_SAMPLE_RATE) * 1000;
    // While KAIRA speaks, residual echo is likely: require a louder signal.
    this.vad.sensitivityScale = this.state.speaking ? 2 : 1;
    const result = this.vad.process(frame.rms, frameMs);
    if (result.changed) this.dispatch({ type: "local.vad", speech: result.speech });
    this.localBargeIn(result.speech);

    const socket = this.socket;
    if (socket?.isOpen) {
      this.flushPreRoll();
      socket.sendAudio(frame.pcm);
    } else {
      // Little-endian platforms (all browsers in practice): the view reads the frame's samples directly.
      this.preRoll.push(new Int16Array(frame.pcm));
    }
  };

  private localBargeIn(speech: boolean): void {
    const now = Date.now();
    if (speech && this.state.speaking) {
      if (this.bargeStartedAt === null) {
        this.bargeStartedAt = now;
        this.ducked = true;
        this.player?.duck(true); // immediate, before the server's VAD round trip
      } else if (now - this.bargeStartedAt >= LOCAL_BARGE_STOP_MS) {
        this.player?.stop();
        this.socket?.send({ type: "interrupt" });
        this.ducked = false;
        this.bargeStartedAt = null;
        this.dispatch({ type: "local.barge_in" });
      }
      return;
    }
    if (!speech) {
      this.bargeStartedAt = null;
      if (this.ducked) this.unduck();
    }
  }

  private unduck(): void {
    this.ducked = false;
    this.player?.duck(false);
  }

  private flushPreRoll(): void {
    if (this.preRoll.size === 0 || !this.socket?.isOpen || this.state.muted) {
      this.preRoll.clear();
      return;
    }
    const samples = this.preRoll.drain();
    this.socket.sendAudio(samples.buffer);
  }

  private onMicEnded = (): void => {
    this.failLive("mic_lost", "The microphone stopped (unplugged or access revoked). Turn live voice on again.");
  };

  private failLive(code: string, message: string): void {
    this.enableSeq++;
    this.teardown();
    this.deps.storage()?.removeItem(STORAGE_LIVE);
    this.dispatch({ type: "local.live", live: false });
    this.dispatch({ type: "local.error", error: { code, message, fatal: true } });
  }

  private startLevels(): void {
    if (this.levelTimer) return;
    let mic = 0;
    let out = 0;
    this.levelTimer = setInterval(() => {
      mic = this.state.muted ? 0 : smoothLevel(mic, rmsToLevel(this.lastMicRms));
      out = smoothLevel(out, rmsToLevel(this.player?.level() ?? 0));
      const m = Math.round(mic * 50) / 50;
      const o = Math.round(out * 50) / 50;
      this.dispatch({ type: "local.levels", mic: m, output: o });
    }, LEVEL_INTERVAL_MS);
  }

  private stopLevels(): void {
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = null;
    this.lastMicRms = 0;
    this.dispatch({ type: "local.levels", mic: 0, output: 0 });
  }

  /** Stops and releases mic, socket, playback and the AudioContext. Idempotent. */
  private teardown(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.disconnect();
    this.mic?.stop();
    this.mic = null;
    this.player?.dispose();
    this.player = null;
    if (this.ctx && this.ctx.state !== "closed") void this.ctx.close().catch(() => {});
    this.ctx = null;
    this.vad.reset();
    this.preRoll.clear();
    this.bargeStartedAt = null;
    this.ducked = false;
    this.stopLevels();
    const pending = [...this.pendingTextTurns];
    this.pendingTextTurns.clear();
    for (const [turnId, text] of pending) void this.runRestTurn(turnId, text);
  }
}
