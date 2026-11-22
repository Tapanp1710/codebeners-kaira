/**
 * KAIRA live voice agent: shared protocol and client state model (backend API 1.2.0, docs/VOICE_AGENT.md).
 * This file is the contract between the voice engine (components/agent/agent-provider.tsx, lib/agent/*)
 * and the UI (app shell, agent home, activity feed). Change it only together with the backend contract.
 */

// ---------------------------------------------------------------- REST
export type AgentSessionTicket = {
  session_id: string;
  ticket: string;
  ws_url: string;
  expires_in: number;
  voice_configured: boolean;
  stt_model: string;
  tts_model: string;
};

export type AgentTurnResponse = {
  turn_id: string;
  reply: string;
  language: string;
  ignored: boolean;
  replayed: boolean;
  duration_ms: number;
  events: ServerEvent[];
};

export type ConversationMessage = {
  turn_id: string;
  role: "user" | "assistant";
  text: string;
  language: string | null;
  at: string;
  facts?: Array<Record<string, unknown>> | null;
};

// ---------------------------------------------------------------- WebSocket: server -> client (JSON frames)
export type ToolStatus =
  | "completed"
  | "needs_clarification"
  | "needs_confirmation"
  | "needs_owner_approval"
  | "error"
  | "rejected"
  | "unsupported"
  | "drafted";

export type ServerEvent =
  | { type: "status"; stt?: "connected" | "reconnecting"; listening?: boolean; muted?: boolean; reason?: string }
  | { type: "vad"; speech: boolean }
  | { type: "transcript.partial"; text: string; language: string | null; first_partial_ms?: number | null }
  | { type: "transcript.final"; text: string; language: string | null; language_confidence?: number | null }
  | { type: "transcript.echo"; text: string }
  | { type: "turn.started"; turn_id: string; text: string; language: string }
  | { type: "thinking"; turn_id: string }
  | { type: "tool.started"; turn_id: string; tool: string; kind: "read" | "write"; arguments: Record<string, unknown> }
  | {
      type: "tool.completed";
      turn_id: string;
      tool: string;
      kind: "read" | "write";
      status: ToolStatus | string;
      summary?: string | null;
      result: Record<string, unknown>;
      refresh: Array<"financial" | "customers" | string>;
      replayed?: boolean;
    }
  | { type: "navigate"; turn_id?: string; path: string }
  | { type: "navigate_hint"; turn_id?: string; path: string }
  | { type: "focus"; turn_id?: string; entity: string; id: string }
  | { type: "reply"; turn_id: string; text: string; language: string; duration_ms?: number; replayed?: boolean }
  | { type: "ignored"; turn_id: string; text: string }
  | { type: "turn.completed"; turn_id: string; ignored: boolean; response_ms: number; llm_calls: number; tools: string[] }
  | { type: "turn.cancelled"; turn_id: string }
  | { type: "turn.failed"; turn_id: string; message?: string }
  | { type: "tts.start"; turn_id: string; sample_rate: number; speaker: string; language: string }
  | { type: "tts.first_audio"; turn_id: string; ms_from_utterance_end: number }
  | { type: "tts.end"; turn_id: string }
  | { type: "tts.stop"; reason: "speech" | "user" | "new_turn" | string }
  | { type: "error"; source: "stt" | "tts" | "config" | string; code: string; message: string; fatal: boolean }
  | { type: "pong" };

// ---------------------------------------------------------------- WebSocket: client -> server
// Binary frames: Int16 little-endian mono PCM at 16 000 Hz (send continuously while live and not muted).
export type ClientMessage =
  | { type: "mute" }
  | { type: "unmute" }
  | { type: "interrupt" }
  | { type: "ping" }
  | { type: "text"; text: string; turn_id: string };

export const MIC_SAMPLE_RATE = 16_000;

// ---------------------------------------------------------------- client state model
/** What the orb shows. Derived by the voice engine from connection, VAD, turn and playback state. */
export type OrbState =
  | "off" // live session not enabled
  | "connecting"
  | "listening" // mic open, nobody speaking
  | "hearing" // user speech detected (VAD)
  | "thinking" // final transcript received, LLM working
  | "retrieving" // a read tool is running
  | "executing" // a write tool is running
  | "speaking" // TTS playing
  | "muted"
  | "reconnecting"
  | "error";

export type ActivityItem = {
  id: string; // `${turn_id}:${index}`
  turn_id: string;
  tool: string;
  kind: "read" | "write";
  label: string; // human label, e.g. "Recording payment"
  state: "running" | "completed" | "needs_clarification" | "needs_confirmation" | "failed";
  summary?: string | null;
  result?: Record<string, unknown>;
  started_at: number;
  finished_at?: number;
};

export type TranscriptEntry = {
  id: string; // turn_id (or a local id for messages not yet acknowledged)
  role: "user" | "assistant";
  text: string;
  language: string | null;
  at: string;
  ignored?: boolean;
  mode?: "voice" | "text";
};

export type AgentMetrics = {
  first_partial_ms?: number;
  response_ms?: number; // utterance end -> turn.completed
  first_audio_ms?: number; // utterance end -> first TTS audio
  llm_calls?: number;
};

export type AgentContextValue = {
  /** Live session switch (explicit user action; the browser asks for microphone permission on enable). */
  live: boolean;
  enable: () => Promise<void>;
  disable: () => void;
  muted: boolean;
  setMuted: (muted: boolean) => void;
  /** Stop KAIRA speaking now (barge-in button). */
  interrupt: () => void;
  /** Typed input into the same conversation (works without the microphone and without live voice). */
  sendText: (text: string) => Promise<void>;

  orb: OrbState;
  /** 0..1 smoothed levels for the orb animation. */
  micLevel: number;
  outputLevel: number;
  partial: string; // live caption of the current utterance
  transcript: TranscriptEntry[]; // conversation history (persisted on the server)
  activity: ActivityItem[]; // tool runs, newest last
  lastReply: string | null;
  metrics: AgentMetrics;
  error: { code: string; message: string; fatal: boolean } | null;
  voiceConfigured: boolean | null; // null until known
};
