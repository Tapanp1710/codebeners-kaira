/**
 * Pure state machine of the live voice agent.
 *
 * `reduceAgentEvent(state, event)` folds server events (lib/agent/protocol.ts ServerEvent, from the WebSocket or
 * from a typed POST /agent/turn) and local engine events (mic, socket, playback) into one immutable state.
 * `deriveOrb(state)` turns that state into the orb's visual state, and `eventIntents(event)` lists the side effects
 * an event asks for (query invalidation, navigation). Nothing here touches the DOM, timers or the network.
 */
import { toolLabel } from "./labels";
import type {
  ActivityItem,
  AgentMetrics,
  ConversationMessage,
  OrbState,
  ServerEvent,
  TranscriptEntry,
} from "./protocol";

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export type AgentError = { code: string; message: string; fatal: boolean };

/** Events produced by the engine itself (never sent by the server). */
export type LocalEvent =
  | { type: "local.live"; live: boolean }
  | { type: "local.connection"; state: ConnectionState }
  | { type: "local.muted"; muted: boolean }
  | { type: "local.vad"; speech: boolean }
  | { type: "local.barge_in" }
  | { type: "local.playback_drained" }
  | { type: "local.turn_pending"; turn_id: string; text: string; at: string; mode: "voice" | "text" }
  | { type: "local.turn_done"; turn_id: string }
  | { type: "local.turn_failed"; turn_id: string; code: string; message: string }
  | { type: "local.history"; messages: ConversationMessage[] }
  | { type: "local.voice_configured"; value: boolean }
  | { type: "local.error"; error: AgentError | null }
  | { type: "local.resume_available"; value: boolean }
  | { type: "local.live_elsewhere"; value: boolean }
  | { type: "local.levels"; mic: number; output: number };

export type AgentEvent = ServerEvent | LocalEvent;

export type AgentEngineState = {
  live: boolean;
  connection: ConnectionState;
  sttReconnecting: boolean;
  muted: boolean;
  /** Server VAD (authoritative). */
  userSpeaking: boolean;
  /** Client energy VAD (early, approximate). */
  localSpeaking: boolean;
  /** Turn currently being processed (null when idle). */
  turnId: string | null;
  /** A final transcript arrived and its turn has not started or finished yet. */
  awaitingTurn: boolean;
  /** Running tools, keyed by activity id. */
  runningTools: Record<string, "read" | "write">;
  speaking: boolean;
  ttsTurnId: string | null;
  ttsEnded: boolean;
  partial: string;
  transcript: TranscriptEntry[];
  activity: ActivityItem[];
  lastReply: string | null;
  metrics: AgentMetrics;
  error: AgentError | null;
  voiceConfigured: boolean | null;
  resumeAvailable: boolean;
  /** Another tab of this browser holds the live microphone session (only one tab may). */
  liveElsewhere: boolean;
  micLevel: number;
  outputLevel: number;
};

export const MAX_TRANSCRIPT = 200;
/** Error code shown when enable() is refused because another tab holds the live session. */
export const LIVE_ELSEWHERE_CODE = "live_elsewhere";
export const MAX_ACTIVITY = 50;
/** Server error code of a turn refused by the per-user AI rate limit. */
export const RATE_LIMITED_CODE = "RATE_LIMITED";

export const initialAgentState: AgentEngineState = {
  live: false,
  connection: "idle",
  sttReconnecting: false,
  muted: false,
  userSpeaking: false,
  localSpeaking: false,
  turnId: null,
  awaitingTurn: false,
  runningTools: {},
  speaking: false,
  ttsTurnId: null,
  ttsEnded: false,
  partial: "",
  transcript: [],
  activity: [],
  lastReply: null,
  metrics: {},
  error: null,
  voiceConfigured: null,
  resumeAvailable: false,
  liveElsewhere: false,
  micLevel: 0,
  outputLevel: 0,
};

/** Transcript entry ids: one user and one assistant entry per turn, so React keys stay unique. */
export const userEntryId = (turnId: string) => `${turnId}:user`;
export const assistantEntryId = (turnId: string) => `${turnId}:assistant`;

function upsertEntry(list: TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] {
  const i = list.findIndex((e) => e.id === entry.id);
  if (i === -1) return [...list, entry].slice(-MAX_TRANSCRIPT);
  const next = list.slice();
  // Keep what was already known (e.g. the typed mode) unless the new entry says otherwise.
  next[i] = { ...list[i], ...entry, mode: entry.mode ?? list[i].mode, ignored: entry.ignored ?? list[i].ignored };
  return next;
}

function nowIso() {
  return new Date().toISOString();
}

function activityStateFor(status: string): ActivityItem["state"] {
  switch (status) {
    case "completed":
    case "drafted":
      return "completed";
    case "needs_clarification":
      return "needs_clarification";
    case "needs_confirmation":
    case "needs_owner_approval":
      return "needs_confirmation";
    default:
      // error, rejected, unsupported and anything unknown
      return "failed";
  }
}

/**
 * Ends a turn: clears turn flags, and marks tools of that turn still shown as running as failed. `turnId` null ends
 * whatever is in progress. A pending final transcript (`awaitingTurn`) is cleared whenever no other turn is current:
 * the server can end a turn it never announced (turn.failed, a replayed answer, a refusal), and the orb must not
 * stay on "thinking".
 */
function endTurn(state: AgentEngineState, turnId: string | null, failTools: boolean): AgentEngineState {
  const finishedAt = Date.now();
  const activity = failTools
    ? state.activity.map((a) =>
        a.state === "running" && (turnId === null || a.turn_id === turnId) ? { ...a, state: "failed" as const, finished_at: finishedAt } : a,
      )
    : state.activity;
  const runningTools = { ...state.runningTools };
  for (const a of state.activity) if (turnId === null || a.turn_id === turnId) delete runningTools[a.id];
  const sameTurn = turnId === null || state.turnId === turnId;
  return {
    ...state,
    activity,
    runningTools,
    turnId: sameTurn ? null : state.turnId,
    awaitingTurn: sameTurn || state.turnId === null ? false : state.awaitingTurn,
  };
}

function stopSpeaking(state: AgentEngineState): AgentEngineState {
  return { ...state, speaking: false, ttsTurnId: null, ttsEnded: false, outputLevel: 0 };
}

export function reduceAgentEvent(state: AgentEngineState, event: AgentEvent): AgentEngineState {
  switch (event.type) {
    // ------------------------------------------------------------ server: connection / speech detection
    case "status": {
      const next = { ...state };
      if (event.stt) next.sttReconnecting = event.stt === "reconnecting";
      if (typeof event.muted === "boolean") next.muted = event.muted;
      return next;
    }
    case "vad":
      return { ...state, userSpeaking: event.speech };
    case "transcript.partial": {
      const metrics =
        typeof event.first_partial_ms === "number" ? { ...state.metrics, first_partial_ms: event.first_partial_ms } : state.metrics;
      return { ...state, partial: event.text, metrics };
    }
    case "transcript.final":
      return { ...state, partial: "", awaitingTurn: event.text.trim().length > 0, userSpeaking: false };
    case "transcript.echo":
      // KAIRA heard itself; no turn will start.
      return { ...state, partial: "", awaitingTurn: false };

    // ------------------------------------------------------------ server: turn lifecycle
    case "turn.started": {
      const existing = state.transcript.find((e) => e.id === userEntryId(event.turn_id));
      const transcript = upsertEntry(state.transcript, {
        id: userEntryId(event.turn_id),
        role: "user",
        text: event.text,
        language: event.language ?? null,
        at: existing?.at ?? nowIso(),
        mode: existing?.mode ?? "voice",
      });
      const error = state.error && !state.error.fatal ? null : state.error;
      return { ...state, transcript, turnId: event.turn_id, awaitingTurn: false, partial: "", error };
    }
    case "thinking":
      return { ...state, turnId: event.turn_id, awaitingTurn: false };
    case "tool.started": {
      const index = state.activity.filter((a) => a.turn_id === event.turn_id).length;
      const item: ActivityItem = {
        id: `${event.turn_id}:${index}`,
        turn_id: event.turn_id,
        tool: event.tool,
        kind: event.kind,
        label: toolLabel(event.tool),
        state: "running",
        started_at: Date.now(),
      };
      return {
        ...state,
        turnId: event.turn_id,
        awaitingTurn: false,
        activity: [...state.activity, item].slice(-MAX_ACTIVITY),
        runningTools: { ...state.runningTools, [item.id]: event.kind },
      };
    }
    case "tool.completed": {
      const finishedAt = Date.now();
      // The latest running item for this tool in this turn.
      let idx = -1;
      for (let i = state.activity.length - 1; i >= 0; i--) {
        const a = state.activity[i];
        if (a.turn_id === event.turn_id && a.tool === event.tool && a.state === "running") {
          idx = i;
          break;
        }
      }
      const done = {
        state: activityStateFor(event.status),
        summary: event.summary ?? null,
        result: event.result,
        finished_at: finishedAt,
      };
      if (idx === -1) {
        // Replayed turn or a tool.started we never saw: show it as a finished item.
        const index = state.activity.filter((a) => a.turn_id === event.turn_id).length;
        const item: ActivityItem = {
          id: `${event.turn_id}:${index}`,
          turn_id: event.turn_id,
          tool: event.tool,
          kind: event.kind,
          label: toolLabel(event.tool),
          started_at: finishedAt,
          ...done,
        };
        return { ...state, activity: [...state.activity, item].slice(-MAX_ACTIVITY) };
      }
      const activity = state.activity.slice();
      activity[idx] = { ...activity[idx], ...done };
      const runningTools = { ...state.runningTools };
      delete runningTools[activity[idx].id];
      return { ...state, activity, runningTools };
    }
    case "reply": {
      const transcript = upsertEntry(state.transcript, {
        id: assistantEntryId(event.turn_id),
        role: "assistant",
        text: event.text,
        language: event.language ?? null,
        at: nowIso(),
      });
      // A replayed answer (the turn already ran) may come without turn.started: it ends the wait for one.
      const awaitingTurn = event.replayed ? false : state.awaitingTurn;
      return { ...state, transcript, lastReply: event.text, awaitingTurn };
    }
    case "ignored": {
      // Not addressed to KAIRA: mark the user's words, say nothing, do nothing.
      const id = userEntryId(event.turn_id);
      const existing = state.transcript.find((e) => e.id === id);
      const transcript = upsertEntry(state.transcript, {
        id,
        role: "user",
        text: existing?.text ?? event.text,
        language: existing?.language ?? null,
        at: existing?.at ?? nowIso(),
        ignored: true,
        mode: existing?.mode ?? "voice",
      });
      return { ...state, transcript };
    }
    case "turn.completed": {
      const ended = endTurn(state, event.turn_id, true);
      const metrics: AgentMetrics = { ...ended.metrics, response_ms: event.response_ms, llm_calls: event.llm_calls };
      let transcript = ended.transcript;
      if (event.ignored) {
        const existing = transcript.find((e) => e.id === userEntryId(event.turn_id));
        if (existing) transcript = upsertEntry(transcript, { ...existing, ignored: true });
      }
      return { ...ended, metrics, transcript };
    }
    case "turn.cancelled":
      return endTurn(state, event.turn_id, true);
    case "turn.failed": {
      const ended = endTurn(state, event.turn_id, true);
      return {
        ...ended,
        error: { code: "turn_failed", message: event.message || "KAIRA could not finish that request.", fatal: false },
      };
    }

    // ------------------------------------------------------------ server: speech output
    case "tts.start":
      return { ...state, speaking: true, ttsTurnId: event.turn_id, ttsEnded: false };
    case "tts.first_audio":
      return { ...state, metrics: { ...state.metrics, first_audio_ms: event.ms_from_utterance_end } };
    case "tts.end":
      // All audio was sent; playback continues until the player reports it drained (local.playback_drained).
      return state.speaking && state.ttsTurnId === event.turn_id ? { ...state, ttsEnded: true } : state;
    case "tts.stop":
      return stopSpeaking(state);

    case "error": {
      const error: AgentError = { code: event.code, message: event.message, fatal: event.fatal };
      if (!event.fatal) {
        // A refused turn (RATE_LIMITED, or any error naming its turn) never starts: stop waiting for it.
        if (event.turn_id) return { ...endTurn(state, event.turn_id, true), error };
        if (event.code === RATE_LIMITED_CODE) return { ...state, error, awaitingTurn: false };
        return { ...state, error };
      }
      // A fatal error ends the live session (the engine closes the socket and the microphone) and any turn shown.
      return {
        ...stopSpeaking(endTurn(state, null, true)),
        error,
        live: false,
        connection: "closed",
        userSpeaking: false,
        localSpeaking: false,
        partial: "",
      };
    }

    case "navigate":
    case "navigate_hint":
    case "focus":
    case "pong":
      return state; // side effects only (see eventIntents)

    // ------------------------------------------------------------ local
    case "local.live":
      if (event.live) return { ...state, live: true, error: null, resumeAvailable: false };
      // Live voice ended: no turn of this session is shown as running any more (orb off, not executing/thinking).
      return {
        ...stopSpeaking(endTurn(state, null, true)),
        live: false,
        connection: "idle",
        sttReconnecting: false,
        userSpeaking: false,
        localSpeaking: false,
        partial: "",
        micLevel: 0,
        awaitingTurn: false,
      };
    case "local.connection":
      return {
        ...state,
        connection: event.state,
        sttReconnecting: event.state === "open" ? state.sttReconnecting : false,
        userSpeaking: event.state === "open" ? state.userSpeaking : false,
      };
    case "local.muted":
      return { ...state, muted: event.muted, localSpeaking: event.muted ? false : state.localSpeaking, micLevel: event.muted ? 0 : state.micLevel };
    case "local.vad":
      return { ...state, localSpeaking: event.speech };
    case "local.barge_in":
      return { ...stopSpeaking(state), localSpeaking: true };
    case "local.playback_drained":
      return state.speaking && state.ttsEnded ? stopSpeaking(state) : state;
    case "local.turn_pending": {
      const transcript = upsertEntry(state.transcript, {
        id: userEntryId(event.turn_id),
        role: "user",
        text: event.text,
        language: null,
        at: event.at,
        mode: event.mode,
      });
      const error = state.error && !state.error.fatal ? null : state.error;
      return { ...state, transcript, turnId: event.turn_id, awaitingTurn: false, error };
    }
    case "local.turn_done":
      return endTurn(state, event.turn_id, false);
    case "local.turn_failed": {
      const ended = endTurn(state, event.turn_id, true);
      return { ...ended, error: { code: event.code, message: event.message, fatal: false } };
    }
    case "local.history": {
      const history: TranscriptEntry[] = event.messages.map((m) => ({
        id: m.role === "user" ? userEntryId(m.turn_id) : assistantEntryId(m.turn_id),
        role: m.role,
        text: m.text,
        language: m.language ?? null,
        at: m.at,
      }));
      const known = new Set(history.map((h) => h.id));
      // Entries created in this tab before the history arrived (not yet stored server-side) stay at the end.
      const transcript = [...history, ...state.transcript.filter((e) => !known.has(e.id))].slice(-MAX_TRANSCRIPT);
      const lastAssistant = [...history].reverse().find((h) => h.role === "assistant");
      return { ...state, transcript, lastReply: state.lastReply ?? lastAssistant?.text ?? null };
    }
    case "local.voice_configured":
      return { ...state, voiceConfigured: event.value };
    case "local.error":
      return { ...state, error: event.error };
    case "local.resume_available":
      return { ...state, resumeAvailable: event.value };
    case "local.live_elsewhere": {
      if (event.value === state.liveElsewhere) return state;
      // The other tab let go: the "active in another tab" notice no longer applies.
      const error = !event.value && state.error?.code === LIVE_ELSEWHERE_CODE ? null : state.error;
      return { ...state, liveElsewhere: event.value, error };
    }
    case "local.levels":
      return state.micLevel === event.mic && state.outputLevel === event.output
        ? state
        : { ...state, micLevel: event.mic, outputLevel: event.output };
    default:
      // Unknown server event types (newer backend) are ignored.
      return state;
  }
}

/** The orb's visual state, derived from the engine state (priority order matters). */
export function deriveOrb(state: AgentEngineState): OrbState {
  if (state.speaking) return "speaking";
  const kinds = Object.values(state.runningTools);
  if (kinds.includes("write")) return "executing";
  if (kinds.includes("read")) return "retrieving";
  if (state.turnId !== null || state.awaitingTurn) return "thinking";
  if (state.error?.fatal) return "error";
  if (!state.live) return "off";
  if (state.connection === "reconnecting" || state.sttReconnecting) return "reconnecting";
  if (state.connection === "connecting" || state.connection === "idle") return "connecting";
  if (state.muted) return "muted";
  if (state.userSpeaking || state.localSpeaking) return "hearing";
  return "listening";
}

// ---------------------------------------------------------------- side-effect intents
export type AgentIntent = { kind: "invalidate"; scope: "financial" | "customers" } | { kind: "navigate"; path: string };

/**
 * True for an in-app path the router may open: starts with a single "/", no protocol-relative "//" or "/\", no
 * backslashes or control characters.
 */
export function isSafeInternalPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 2048) return false;
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return false;
  return true;
}

/** Side effects requested by one event. The engine executes them; tests assert them. */
export function eventIntents(event: AgentEvent): AgentIntent[] {
  if (event.type === "tool.completed") {
    const out: AgentIntent[] = [];
    const refresh = Array.isArray(event.refresh) ? event.refresh : [];
    if (refresh.includes("financial")) out.push({ kind: "invalidate", scope: "financial" });
    if (refresh.includes("customers")) out.push({ kind: "invalidate", scope: "customers" });
    return out;
  }
  if (event.type === "navigate" && isSafeInternalPath(event.path)) return [{ kind: "navigate", path: event.path }];
  return [];
}
