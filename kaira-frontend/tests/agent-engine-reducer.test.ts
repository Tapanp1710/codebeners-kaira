// @vitest-environment node
/** The pure agent state machine: every server event type, local engine events, orb derivation and intents. */
import { describe, expect, it } from "vitest";

import { toolLabel } from "@/lib/agent/labels";
import type { ServerEvent } from "@/lib/agent/protocol";
import {
  assistantEntryId,
  deriveOrb,
  eventIntents,
  initialAgentState,
  isSafeInternalPath,
  MAX_ACTIVITY,
  reduceAgentEvent,
  userEntryId,
  type AgentEngineState,
  type AgentEvent,
} from "@/lib/agent/reducer";

const run = (events: AgentEvent[], from: AgentEngineState = initialAgentState) => events.reduce(reduceAgentEvent, from);
const liveOpen = run([
  { type: "local.live", live: true },
  { type: "local.connection", state: "open" },
]);

describe("connection, mute and listening", () => {
  it("starts off and reaches listening once live and open", () => {
    expect(deriveOrb(initialAgentState)).toBe("off");
    const connecting = run([{ type: "local.live", live: true }, { type: "local.connection", state: "connecting" }]);
    expect(deriveOrb(connecting)).toBe("connecting");
    expect(deriveOrb(liveOpen)).toBe("listening");
  });

  it("shows reconnecting for the socket and for the server's STT reconnect", () => {
    expect(deriveOrb(reduceAgentEvent(liveOpen, { type: "local.connection", state: "reconnecting" }))).toBe("reconnecting");
    const stt = reduceAgentEvent(liveOpen, { type: "status", stt: "reconnecting", listening: false });
    expect(stt.sttReconnecting).toBe(true);
    expect(deriveOrb(stt)).toBe("reconnecting");
    expect(deriveOrb(reduceAgentEvent(stt, { type: "status", stt: "connected", listening: true }))).toBe("listening");
  });

  it("mutes locally and follows the server's muted status", () => {
    const muted = reduceAgentEvent(liveOpen, { type: "local.muted", muted: true });
    expect(deriveOrb(muted)).toBe("muted");
    expect(muted.micLevel).toBe(0);
    expect(reduceAgentEvent(muted, { type: "status", muted: false, listening: true }).muted).toBe(false);
  });

  it("disabling resets live-only state", () => {
    const s = run([{ type: "vad", speech: true }, { type: "transcript.partial", text: "hel", language: null }, { type: "local.live", live: false }], liveOpen);
    expect(s.live).toBe(false);
    expect(s.partial).toBe("");
    expect(s.userSpeaking).toBe(false);
    expect(deriveOrb(s)).toBe("off");
  });

  it("enabling clears a previous error and the resume hint", () => {
    const s = run([
      { type: "local.error", error: { code: "mic_permission_denied", message: "x", fatal: true } },
      { type: "local.resume_available", value: true },
    ]);
    expect(deriveOrb(s)).toBe("error");
    expect(s.resumeAvailable).toBe(true);
    const on = reduceAgentEvent(s, { type: "local.live", live: true });
    expect(on.error).toBeNull();
    expect(on.resumeAvailable).toBe(false);
  });

  it("pong changes nothing", () => {
    expect(reduceAgentEvent(liveOpen, { type: "pong" })).toBe(liveOpen);
  });

  it("ignores unknown event types from a newer backend", () => {
    const unknown = { type: "something.new" } as unknown as AgentEvent;
    expect(reduceAgentEvent(liveOpen, unknown)).toBe(liveOpen);
  });
});

describe("hearing and transcripts", () => {
  it("hears on server VAD and on the client VAD", () => {
    expect(deriveOrb(reduceAgentEvent(liveOpen, { type: "vad", speech: true }))).toBe("hearing");
    expect(deriveOrb(reduceAgentEvent(liveOpen, { type: "local.vad", speech: true }))).toBe("hearing");
    const stopped = run([{ type: "vad", speech: true }, { type: "vad", speech: false }], liveOpen);
    expect(deriveOrb(stopped)).toBe("listening");
  });

  it("shows partials and records first_partial_ms, then thinks after the final", () => {
    let s = reduceAgentEvent(liveOpen, { type: "transcript.partial", text: "Ramesh paid", language: "en-IN", first_partial_ms: 180 });
    expect(s.partial).toBe("Ramesh paid");
    expect(s.metrics.first_partial_ms).toBe(180);
    s = reduceAgentEvent(s, { type: "transcript.final", text: "Ramesh paid 500", language: "en-IN", language_confidence: 0.9 });
    expect(s.partial).toBe("");
    expect(deriveOrb(s)).toBe("thinking");
    // Partials never create transcript entries.
    expect(s.transcript).toHaveLength(0);
  });

  it("drops an echo of KAIRA's own speech", () => {
    const s = run([{ type: "transcript.final", text: "Done", language: "en-IN" }, { type: "transcript.echo", text: "Done" }], liveOpen);
    expect(deriveOrb(s)).toBe("listening");
    expect(s.transcript).toHaveLength(0);
  });

  it("an empty final does not start thinking", () => {
    expect(deriveOrb(reduceAgentEvent(liveOpen, { type: "transcript.final", text: "  ", language: null }))).toBe("listening");
  });
});

describe("a full voice turn", () => {
  const events: ServerEvent[] = [
    { type: "transcript.final", text: "Ramesh paid 500", language: "en-IN" },
    { type: "turn.started", turn_id: "t1", text: "Ramesh paid 500", language: "en-IN" },
    { type: "thinking", turn_id: "t1" },
    { type: "tool.started", turn_id: "t1", tool: "get_customer", kind: "read", arguments: { name: "Ramesh" } },
  ];

  it("walks thinking -> retrieving -> executing -> speaking -> listening", () => {
    let s = run(events.slice(0, 3), liveOpen);
    expect(deriveOrb(s)).toBe("thinking");
    expect(s.transcript).toEqual([
      expect.objectContaining({ id: userEntryId("t1"), role: "user", text: "Ramesh paid 500", mode: "voice" }),
    ]);

    s = reduceAgentEvent(s, events[3]);
    expect(deriveOrb(s)).toBe("retrieving");
    expect(s.activity[0]).toMatchObject({ id: "t1:0", label: "Looking up customer", state: "running", kind: "read" });

    s = reduceAgentEvent(s, {
      type: "tool.completed", turn_id: "t1", tool: "get_customer", kind: "read", status: "completed",
      summary: "Found Ramesh", result: { id: "c1" }, refresh: [],
    });
    expect(deriveOrb(s)).toBe("thinking");
    expect(s.activity[0]).toMatchObject({ state: "completed", summary: "Found Ramesh", result: { id: "c1" } });

    s = reduceAgentEvent(s, { type: "tool.started", turn_id: "t1", tool: "record_customer_payment", kind: "write", arguments: {} });
    expect(deriveOrb(s)).toBe("executing");
    expect(s.activity[1]).toMatchObject({ id: "t1:1", label: "Recording payment" });
    s = reduceAgentEvent(s, {
      type: "tool.completed", turn_id: "t1", tool: "record_customer_payment", kind: "write", status: "completed",
      summary: "Recorded", result: {}, refresh: ["financial"],
    });

    s = reduceAgentEvent(s, { type: "reply", turn_id: "t1", text: "Recorded 500 from Ramesh.", language: "en-IN" });
    expect(s.lastReply).toBe("Recorded 500 from Ramesh.");
    expect(s.transcript[1]).toMatchObject({ id: assistantEntryId("t1"), role: "assistant" });

    s = reduceAgentEvent(s, { type: "tts.start", turn_id: "t1", sample_rate: 22050, speaker: "anushka", language: "en-IN" });
    expect(deriveOrb(s)).toBe("speaking");
    s = reduceAgentEvent(s, { type: "tts.first_audio", turn_id: "t1", ms_from_utterance_end: 900 });
    expect(s.metrics.first_audio_ms).toBe(900);
    s = reduceAgentEvent(s, { type: "turn.completed", turn_id: "t1", ignored: false, response_ms: 1400, llm_calls: 2, tools: ["get_customer"] });
    expect(s.metrics).toMatchObject({ response_ms: 1400, llm_calls: 2 });
    expect(deriveOrb(s)).toBe("speaking");

    // tts.end: audio was all sent, keep speaking until playback drains.
    s = reduceAgentEvent(s, { type: "tts.end", turn_id: "t1" });
    expect(deriveOrb(s)).toBe("speaking");
    s = reduceAgentEvent(s, { type: "local.playback_drained" });
    expect(deriveOrb(s)).toBe("listening");
  });

  it("maps every tool status to an activity state", () => {
    const cases: Array<[string, string]> = [
      ["completed", "completed"], ["drafted", "completed"], ["needs_clarification", "needs_clarification"],
      ["needs_confirmation", "needs_confirmation"], ["needs_owner_approval", "needs_confirmation"],
      ["error", "failed"], ["rejected", "failed"], ["unsupported", "failed"], ["weird", "failed"],
    ];
    for (const [status, state] of cases) {
      const s = run([
        { type: "tool.started", turn_id: "t", tool: "x", kind: "write", arguments: {} },
        { type: "tool.completed", turn_id: "t", tool: "x", kind: "write", status, result: {}, refresh: [] },
      ]);
      expect(s.activity[0].state).toBe(state);
      expect(s.runningTools).toEqual({});
    }
  });

  it("shows a replayed tool.completed without a start as a finished item", () => {
    const s = reduceAgentEvent(initialAgentState, {
      type: "tool.completed", turn_id: "t9", tool: "record_customer_payment", kind: "write", status: "completed",
      result: {}, refresh: ["financial"], replayed: true,
    });
    expect(s.activity).toEqual([expect.objectContaining({ id: "t9:0", state: "completed", label: "Recording payment" })]);
  });

  it("bounds the activity list", () => {
    let s = initialAgentState;
    for (let i = 0; i < MAX_ACTIVITY + 10; i++) s = reduceAgentEvent(s, { type: "tool.started", turn_id: `t${i}`, tool: "x", kind: "read", arguments: {} });
    expect(s.activity).toHaveLength(MAX_ACTIVITY);
  });
});

describe("barge-in", () => {
  const speaking = run(
    [
      { type: "turn.started", turn_id: "t1", text: "hi", language: "en-IN" },
      { type: "tts.start", turn_id: "t1", sample_rate: 22050, speaker: "s", language: "en-IN" },
    ],
    liveOpen,
  );

  it("server tts.stop silences immediately", () => {
    for (const reason of ["speech", "user", "new_turn"]) {
      const s = reduceAgentEvent(speaking, { type: "tts.stop", reason });
      expect(s.speaking).toBe(false);
      expect(s.outputLevel).toBe(0);
    }
  });

  it("local barge-in stops speaking and shows hearing", () => {
    const s = reduceAgentEvent(reduceAgentEvent(speaking, { type: "turn.completed", turn_id: "t1", ignored: false, response_ms: 1, llm_calls: 1, tools: [] }), { type: "local.barge_in" });
    expect(s.speaking).toBe(false);
    expect(deriveOrb(s)).toBe("hearing");
  });

  it("a late tts.end of an interrupted reply does not resurrect speaking", () => {
    const s = run([{ type: "tts.stop", reason: "speech" }, { type: "tts.end", turn_id: "t1" }, { type: "local.playback_drained" }], speaking);
    expect(s.speaking).toBe(false);
  });

  it("tts.end of another turn is ignored", () => {
    const s = reduceAgentEvent(speaking, { type: "tts.end", turn_id: "other" });
    expect(s.ttsEnded).toBe(false);
    expect(reduceAgentEvent(s, { type: "local.playback_drained" }).speaking).toBe(true);
  });
});

describe("ignored, cancelled and failed turns", () => {
  it("marks an ignored utterance and does not reply", () => {
    const s = run(
      [
        { type: "transcript.final", text: "bring the chai", language: "hi-IN" },
        { type: "turn.started", turn_id: "t2", text: "bring the chai", language: "hi-IN" },
        { type: "ignored", turn_id: "t2", text: "bring the chai" },
        { type: "turn.completed", turn_id: "t2", ignored: true, response_ms: 300, llm_calls: 1, tools: [] },
      ],
      liveOpen,
    );
    expect(s.transcript).toEqual([expect.objectContaining({ id: userEntryId("t2"), ignored: true })]);
    expect(s.lastReply).toBeNull();
    expect(deriveOrb(s)).toBe("listening");
  });

  it("an ignored event without turn.started still records the words", () => {
    const s = reduceAgentEvent(liveOpen, { type: "ignored", turn_id: "t3", text: "hello mom" });
    expect(s.transcript[0]).toMatchObject({ text: "hello mom", ignored: true, role: "user" });
  });

  it("turn.completed with ignored marks the existing entry", () => {
    const s = run([
      { type: "turn.started", turn_id: "t4", text: "x", language: "en-IN" },
      { type: "turn.completed", turn_id: "t4", ignored: true, response_ms: 1, llm_calls: 0, tools: [] },
    ]);
    expect(s.transcript[0].ignored).toBe(true);
  });

  it("cancelled turns end and running tools are marked failed", () => {
    const s = run([
      { type: "turn.started", turn_id: "t5", text: "x", language: "en-IN" },
      { type: "tool.started", turn_id: "t5", tool: "get_customer", kind: "read", arguments: {} },
      { type: "turn.cancelled", turn_id: "t5" },
    ], liveOpen);
    expect(s.turnId).toBeNull();
    expect(s.activity[0].state).toBe("failed");
    expect(deriveOrb(s)).toBe("listening");
  });

  it("failed turns report a non-fatal error that the next turn clears", () => {
    let s = run([
      { type: "turn.started", turn_id: "t6", text: "x", language: "en-IN" },
      { type: "turn.failed", turn_id: "t6", message: "LLM timeout" },
    ], liveOpen);
    expect(s.error).toEqual({ code: "turn_failed", message: "LLM timeout", fatal: false });
    expect(deriveOrb(s)).toBe("listening");
    s = reduceAgentEvent(s, { type: "turn.started", turn_id: "t7", text: "y", language: "en-IN" });
    expect(s.error).toBeNull();
  });
});

describe("errors", () => {
  it("non-fatal server errors are shown but keep the session", () => {
    const s = reduceAgentEvent(liveOpen, { type: "error", source: "tts", code: "TTS_FAILED", message: "no audio", fatal: false });
    expect(s.error?.fatal).toBe(false);
    expect(s.live).toBe(true);
    expect(deriveOrb(s)).toBe("listening");
  });

  it("fatal server errors end the live session and show the error", () => {
    const s = reduceAgentEvent(liveOpen, {
      type: "error", source: "config", code: "PROVIDER_NOT_CONFIGURED", message: "Live voice needs SARVAM_API_KEY", fatal: true,
    });
    expect(s.live).toBe(false);
    expect(s.error).toMatchObject({ code: "PROVIDER_NOT_CONFIGURED", fatal: true });
    expect(deriveOrb(s)).toBe("error");
  });
});

describe("typed turns and history", () => {
  it("a pending typed turn shows the user's words and thinks; turn.started keeps the text mode", () => {
    let s = reduceAgentEvent(initialAgentState, { type: "local.turn_pending", turn_id: "a1", text: "hi", at: "2026-11-22T10:00:00Z", mode: "text" });
    expect(deriveOrb(s)).toBe("thinking");
    s = reduceAgentEvent(s, { type: "turn.started", turn_id: "a1", text: "hi", language: "en-IN" });
    expect(s.transcript).toHaveLength(1);
    expect(s.transcript[0]).toMatchObject({ mode: "text", at: "2026-11-22T10:00:00Z", language: "en-IN" });
    s = reduceAgentEvent(s, { type: "local.turn_done", turn_id: "a1" });
    expect(deriveOrb(s)).toBe("off");
  });

  it("a failed typed turn reports the error", () => {
    const s = run([
      { type: "local.turn_pending", turn_id: "a2", text: "hi", at: "x", mode: "text" },
      { type: "local.turn_failed", turn_id: "a2", code: "NETWORK_ERROR", message: "offline" },
    ]);
    expect(s.turnId).toBeNull();
    expect(s.error).toEqual({ code: "NETWORK_ERROR", message: "offline", fatal: false });
  });

  it("loads history before local entries and sets the last reply", () => {
    const s = run([
      { type: "local.turn_pending", turn_id: "new", text: "now", at: "x", mode: "text" },
      {
        type: "local.history",
        messages: [
          { turn_id: "h1", role: "user", text: "old q", language: "en-IN", at: "2026-11-21T10:00:00Z" },
          { turn_id: "h1", role: "assistant", text: "old a", language: null, at: "2026-11-21T10:00:01Z" },
        ],
      },
    ]);
    expect(s.transcript.map((e) => e.id)).toEqual([userEntryId("h1"), assistantEntryId("h1"), userEntryId("new")]);
    expect(s.lastReply).toBe("old a");
  });

  it("stores voiceConfigured and levels", () => {
    expect(reduceAgentEvent(initialAgentState, { type: "local.voice_configured", value: false }).voiceConfigured).toBe(false);
    const lv = reduceAgentEvent(initialAgentState, { type: "local.levels", mic: 0.4, output: 0.2 });
    expect([lv.micLevel, lv.outputLevel]).toEqual([0.4, 0.2]);
    expect(reduceAgentEvent(lv, { type: "local.levels", mic: 0.4, output: 0.2 })).toBe(lv);
  });
});

describe("side-effect intents", () => {
  const done = (refresh: string[]): ServerEvent => ({
    type: "tool.completed", turn_id: "t", tool: "x", kind: "write", status: "completed", result: {}, refresh,
  });

  it("asks for query invalidation from refresh", () => {
    expect(eventIntents(done(["financial"]))).toEqual([{ kind: "invalidate", scope: "financial" }]);
    expect(eventIntents(done(["customers"]))).toEqual([{ kind: "invalidate", scope: "customers" }]);
    expect(eventIntents(done(["financial", "customers", "other"]))).toHaveLength(2);
    expect(eventIntents(done([]))).toEqual([]);
  });

  it("navigates only to internal paths", () => {
    expect(eventIntents({ type: "navigate", turn_id: "t", path: "/customers/123" })).toEqual([{ kind: "navigate", path: "/customers/123" }]);
    for (const path of ["//evil.example", "https://evil.example", "javascript:alert(1)", "/\\evil.example", "customers", "", "/a\nb"]) {
      expect(eventIntents({ type: "navigate", path })).toEqual([]);
    }
    expect(isSafeInternalPath(42)).toBe(false);
  });

  it("hints and focus do not navigate; reducer state is unchanged by them", () => {
    expect(eventIntents({ type: "navigate_hint", path: "/dashboard" })).toEqual([]);
    expect(eventIntents({ type: "focus", entity: "customer", id: "c1" })).toEqual([]);
    expect(reduceAgentEvent(liveOpen, { type: "navigate", path: "/dashboard" })).toBe(liveOpen);
    expect(reduceAgentEvent(liveOpen, { type: "focus", entity: "customer", id: "c1" })).toBe(liveOpen);
  });
});

describe("toolLabel", () => {
  it("uses plain English", () => {
    expect(toolLabel("record_customer_payment")).toBe("Recording payment");
    expect(toolLabel("get_customer")).toBe("Looking up customer");
    expect(toolLabel("list_overdue_invoices")).toBe("Checking overdue invoices");
    expect(toolLabel("fetchThing")).toBe("Fetch thing");
    expect(toolLabel("")).toBe("Working");
  });
});

describe("turn endings the server never announced", () => {
  const heard = run([{ type: "transcript.final", text: "how much does Ramesh owe", language: "en-IN" }], liveOpen);

  it("a final transcript thinks until its turn starts", () => {
    expect(heard.awaitingTurn).toBe(true);
    expect(deriveOrb(heard)).toBe("thinking");
  });

  it("turn.failed without turn.started stops thinking", () => {
    const s = reduceAgentEvent(heard, { type: "turn.failed", turn_id: "t9", message: "Something went wrong" });
    expect(s.awaitingTurn).toBe(false);
    expect(deriveOrb(s)).toBe("listening");
    expect(s.error?.code).toBe("turn_failed");
  });

  it("turn.completed / turn.cancelled without turn.started stop thinking", () => {
    const events: ServerEvent[] = [
      { type: "turn.completed", turn_id: "t9", ignored: false, response_ms: 5, llm_calls: 0, tools: [] },
      { type: "turn.cancelled", turn_id: "t9" },
    ];
    for (const ev of events) expect(deriveOrb(reduceAgentEvent(heard, ev))).toBe("listening");
  });

  it("a replayed reply without turn.started stops thinking; a fresh reply does not end the wait by itself", () => {
    const replayed = reduceAgentEvent(heard, { type: "reply", turn_id: "t9", text: "Ramesh owes 1,200.", language: "en-IN", replayed: true });
    expect(replayed.awaitingTurn).toBe(false);
    expect(deriveOrb(replayed)).toBe("listening");
    expect(reduceAgentEvent(heard, { type: "reply", turn_id: "t9", text: "x", language: "en-IN" }).awaitingTurn).toBe(true);
  });

  it("a RATE_LIMITED refusal (no turn id) stops thinking; other non-fatal errors keep waiting", () => {
    const limited = reduceAgentEvent(heard, { type: "error", source: "session", code: "RATE_LIMITED", message: "Too many requests.", fatal: false });
    expect(limited.awaitingTurn).toBe(false);
    expect(deriveOrb(limited)).toBe("listening");
    expect(limited.error?.code).toBe("RATE_LIMITED");
    const stt = reduceAgentEvent(heard, { type: "error", source: "stt", code: "PROVIDER_TIMEOUT", message: "slow", fatal: false });
    expect(stt.awaitingTurn).toBe(true);
  });

  it("a non-fatal error naming a turn ends that turn", () => {
    const typed = run([{ type: "local.turn_pending", turn_id: "t5", text: "and Lakshmi?", at: "2026-11-22T10:00:00Z", mode: "text" }], liveOpen);
    expect(deriveOrb(typed)).toBe("thinking");
    const s = reduceAgentEvent(typed, {
      type: "error",
      source: "session",
      code: "RATE_LIMITED",
      message: "Too many requests.",
      fatal: false,
      turn_id: "t5",
    });
    expect(s.turnId).toBeNull();
    expect(deriveOrb(s)).toBe("listening");
  });

  it("an older turn ending while another is current keeps the current one", () => {
    const busy = run(
      [
        { type: "turn.started", turn_id: "t2", text: "b", language: "en-IN" },
        { type: "transcript.final", text: "c", language: "en-IN" },
      ],
      liveOpen,
    );
    const s = reduceAgentEvent(busy, { type: "turn.completed", turn_id: "t1", ignored: false, response_ms: 1, llm_calls: 1, tools: [] });
    expect(s.turnId).toBe("t2");
    expect(s.awaitingTurn).toBe(true);
  });
});

describe("teardown ends the turn shown", () => {
  const executing = run(
    [
      { type: "turn.started", turn_id: "t1", text: "record 500 from Ramesh", language: "en-IN" },
      { type: "tool.started", turn_id: "t1", tool: "record_payment", kind: "write", arguments: {} },
    ],
    liveOpen,
  );

  it("local.live false clears the turn, running tools and the wait, and fails running activity", () => {
    expect(deriveOrb(executing)).toBe("executing");
    const s = reduceAgentEvent(executing, { type: "local.live", live: false });
    expect(s.turnId).toBeNull();
    expect(s.awaitingTurn).toBe(false);
    expect(s.runningTools).toEqual({});
    expect(s.activity[0].state).toBe("failed");
    expect(deriveOrb(s)).toBe("off");
  });

  it("a fatal error clears the turn too and shows the error", () => {
    const s = reduceAgentEvent(executing, { type: "error", source: "session", code: "SESSION_REPLACED", message: "moved", fatal: true });
    expect(s.turnId).toBeNull();
    expect(s.runningTools).toEqual({});
    expect(s.activity[0].state).toBe("failed");
    expect(deriveOrb(s)).toBe("error");
  });
});
