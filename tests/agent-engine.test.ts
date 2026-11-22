/**
 * AgentEngine wiring with fakes for the microphone, AudioContext, WebSocket and REST calls: enable/disable cleanup,
 * pre-roll flush, mute, playback lifecycle, local barge-in, typed REST fallback, fatal errors and the reload hint.
 * No real microphone, audio device or backend is involved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentEngine, LOCAL_BARGE_STOP_MS, type EngineDeps } from "@/lib/agent/engine";
import type { MicCapture } from "@/lib/agent/mic";
import { deriveOrb, type AgentIntent } from "@/lib/agent/reducer";
import { ApiError } from "@/lib/api/errors";

import { FakeAudioContext, FakeMic, FakeSocket, ticket } from "./agent-engine-fakes";

let mic: FakeMic;
let ctx: FakeAudioContext;

function makeEngine(overrides: Partial<EngineDeps> = {}) {
  mic = new FakeMic();
  const deps: EngineDeps = {
    startSession: vi.fn(async () => ticket()),
    postTurn: vi.fn(async (text: string, turnId: string) => ({
      turn_id: turnId, reply: `echo ${text}`, language: "en-IN", ignored: false, replayed: false, duration_ms: 5, events: [],
    })),
    getConversation: vi.fn(async () => []),
    readVoiceReady: vi.fn(async () => true),
    createSocket: (url) => new FakeSocket(url),
    createAudioContext: () => {
      ctx = new FakeAudioContext();
      return ctx as unknown as AudioContext;
    },
    createMic: () => mic as unknown as MicCapture,
    storage: () => window.sessionStorage,
    origin: () => "http://localhost:3000",
    ...overrides,
  };
  const engine = new AgentEngine(deps);
  const intents: AgentIntent[] = [];
  engine.setIntentHandler((i) => intents.push(i));
  return { engine, deps, intents };
}

const ws = () => FakeSocket.instances[FakeSocket.instances.length - 1];

beforeEach(() => {
  FakeSocket.instances = [];
  window.sessionStorage.clear();
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", class {});
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: vi.fn() }, configurable: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function goLive(engine: AgentEngine) {
  await engine.enable();
  await vi.waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));
  ws().serverOpen();
}

describe("AgentEngine live session", () => {
  it("enable opens mic + socket, flushes the pre-roll, streams frames; disable releases everything", async () => {
    const { engine } = makeEngine();
    const p = engine.enable();
    expect(engine.getSnapshot().live).toBe(true);
    expect(deriveOrb(engine.getSnapshot())).toBe("connecting");
    await p;
    expect(mic.started).toBe(true);
    // Frames before the socket opens go to the 400 ms pre-roll (oldest dropped).
    for (let i = 1; i <= 6; i++) mic.frame(i, 0.001);
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    expect(ws().url).toBe("ws://backend.test/api/v1/agent/live?ticket=tk1");
    ws().serverOpen();
    expect(deriveOrb(engine.getSnapshot())).toBe("listening");
    mic.frame(7, 0.001);
    const sent = ws().binary();
    expect(sent).toHaveLength(2);
    const preroll = new Int16Array(sent[0]);
    expect(preroll.length).toBe(6400);
    expect(preroll[0]).toBe(3);
    expect(preroll[6399]).toBe(6);
    expect(new Int16Array(sent[1])[0]).toBe(7);
    expect(window.sessionStorage.getItem("kaira.agent.live")).toBe("1");

    engine.disable();
    expect(mic.stopped).toBe(true);
    expect(ws().closedWith).toBe(1000);
    expect(ctx.closed).toBe(true);
    expect(engine.getSnapshot().live).toBe(false);
    expect(deriveOrb(engine.getSnapshot())).toBe("off");
    expect(window.sessionStorage.getItem("kaira.agent.live")).toBeNull();
  });

  it("mute stops frames and tells the server", async () => {
    const { engine } = makeEngine();
    await goLive(engine);
    engine.setMuted(true);
    expect(mic.enabled).toBe(false);
    mic.frame(1, 0.2);
    expect(ws().binary()).toHaveLength(0);
    expect(ws().json()).toContainEqual({ type: "mute" });
    expect(deriveOrb(engine.getSnapshot())).toBe("muted");
    engine.setMuted(false);
    expect(ws().json()).toContainEqual({ type: "unmute" });
    engine.disable();
  });

  it("plays TTS frames gaplessly, finishes on tts.end and stops instantly on tts.stop", async () => {
    const { engine } = makeEngine();
    await goLive(engine);
    ws().serverJson({ type: "tts.start", turn_id: "t1", sample_rate: 16000, speaker: "s", language: "en-IN" });
    ws().serverBinary(new ArrayBuffer(3200)); // 100 ms
    ws().serverBinary(new ArrayBuffer(3200));
    expect(ctx.sources.map((s) => s.startedAt)).toEqual([0.08, expect.closeTo(0.18, 6)]);
    expect(deriveOrb(engine.getSnapshot())).toBe("speaking");
    ws().serverJson({ type: "tts.end", turn_id: "t1" });
    expect(deriveOrb(engine.getSnapshot())).toBe("speaking");
    ctx.sources.forEach((s) => s.onended?.());
    expect(deriveOrb(engine.getSnapshot())).toBe("listening");

    ws().serverJson({ type: "tts.start", turn_id: "t2", sample_rate: 22050, speaker: "s", language: "en-IN" });
    ws().serverBinary(new ArrayBuffer(4410));
    ws().serverJson({ type: "tts.stop", reason: "speech" });
    expect(ctx.sources.at(-1)?.stopped).toBe(true);
    ws().serverBinary(new ArrayBuffer(4410)); // late frame of the stopped reply is dropped
    expect(ctx.sources).toHaveLength(3);
    expect(deriveOrb(engine.getSnapshot())).toBe("listening");
    engine.disable();
  });

  it("local barge-in ducks at once and stops + interrupts after sustained speech", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const { engine } = makeEngine();
    await goLive(engine);
    for (let i = 0; i < 3; i++) mic.frame(0, 0.001); // calibrate on a quiet room
    ws().serverJson({ type: "tts.start", turn_id: "t1", sample_rate: 16000, speaker: "s", language: "en-IN" });
    ws().serverBinary(new ArrayBuffer(32000));
    mic.frame(5000, 0.3);
    expect(engine.getSnapshot().localSpeaking).toBe(true);
    expect(engine.getSnapshot().speaking).toBe(true);
    expect(ws().json()).not.toContainEqual({ type: "interrupt" });
    now.mockReturnValue(1_000 + LOCAL_BARGE_STOP_MS);
    mic.frame(5000, 0.3);
    expect(ws().json()).toContainEqual({ type: "interrupt" });
    expect(ctx.sources[0].stopped).toBe(true);
    expect(deriveOrb(engine.getSnapshot())).toBe("hearing");
    engine.disable();
    now.mockRestore();
  });

  it("runs intents for refresh and navigate events", async () => {
    const { engine, intents } = makeEngine();
    await goLive(engine);
    ws().serverJson({
      type: "tool.completed", turn_id: "t", tool: "record_customer_payment", kind: "write", status: "completed",
      result: {}, refresh: ["financial", "customers"],
    });
    ws().serverJson({ type: "navigate", turn_id: "t", path: "/receivables" });
    ws().serverJson({ type: "navigate", turn_id: "t", path: "//evil.example" });
    expect(intents).toEqual([
      { kind: "invalidate", scope: "financial" },
      { kind: "invalidate", scope: "customers" },
      { kind: "navigate", path: "/receivables" },
    ]);
    engine.disable();
  });

  it("a fatal server error tears the session down and shows the error", async () => {
    const { engine } = makeEngine();
    await goLive(engine);
    ws().serverJson({ type: "error", source: "config", code: "PROVIDER_NOT_CONFIGURED", message: "no key", fatal: true });
    expect(mic.stopped).toBe(true);
    expect(engine.getSnapshot().live).toBe(false);
    expect(deriveOrb(engine.getSnapshot())).toBe("error");
    expect(window.sessionStorage.getItem("kaira.agent.live")).toBeNull();
  });

  it("voice_configured=false from the session response stops with a clear error", async () => {
    const { engine } = makeEngine({ startSession: vi.fn(async () => ticket(1, false)) });
    await engine.enable();
    await vi.waitFor(() => expect(engine.getSnapshot().error?.code).toBe("voice_not_configured"));
    expect(mic.stopped).toBe(true);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("a 403 from POST /agent/session is fatal", async () => {
    const { engine } = makeEngine({
      startSession: vi.fn(async () => {
        throw new ApiError(403, { code: "FORBIDDEN", message: "Not allowed" });
      }),
    });
    await engine.enable();
    await vi.waitFor(() => expect(engine.getSnapshot().error).toMatchObject({ code: "FORBIDDEN", fatal: true }));
    expect(engine.getSnapshot().live).toBe(false);
  });

  it("reports microphone permission denial", async () => {
    const { engine } = makeEngine();
    const { MicError } = await import("@/lib/agent/mic");
    mic.failWith = new MicError("mic_permission_denied", "blocked");
    await engine.enable();
    expect(engine.getSnapshot().error).toEqual({ code: "mic_permission_denied", message: "blocked", fatal: true });
    expect(engine.getSnapshot().live).toBe(false);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("refuses without a secure context", async () => {
    vi.stubGlobal("isSecureContext", false);
    const { engine } = makeEngine();
    await engine.enable();
    expect(engine.getSnapshot().error?.code).toBe("insecure_context");
    expect(mic.started).toBe(false);
  });
});

describe("typed turns", () => {
  it("falls back to POST /agent/turn without a socket and feeds events through the reducer", async () => {
    const postTurn = vi.fn(async (_text: string, turnId: string) => ({
      turn_id: turnId, reply: "Ramesh owes 1,200.", language: "en-IN", ignored: false, replayed: false, duration_ms: 10,
      events: [
        { type: "turn.started" as const, turn_id: turnId, text: "how much does Ramesh owe", language: "en-IN" },
        { type: "tool.started" as const, turn_id: turnId, tool: "customer_balance", kind: "read" as const, arguments: {} },
        { type: "tool.completed" as const, turn_id: turnId, tool: "customer_balance", kind: "read" as const, status: "completed", result: {}, refresh: [] },
        { type: "reply" as const, turn_id: turnId, text: "Ramesh owes 1,200.", language: "en-IN" },
        { type: "tts.start" as const, turn_id: turnId, sample_rate: 22050, speaker: "s", language: "en-IN" },
      ],
    }));
    const { engine } = makeEngine({ postTurn });
    await engine.sendText("  how much does Ramesh owe ");
    const [text, turnId] = postTurn.mock.calls[0];
    expect(text).toBe("how much does Ramesh owe");
    expect(turnId).toMatch(/^[0-9a-f]{32}$/);
    const s = engine.getSnapshot();
    expect(s.transcript.map((e) => [e.role, e.text, e.mode])).toEqual([
      ["user", "how much does Ramesh owe", "text"],
      ["assistant", "Ramesh owes 1,200.", undefined],
    ]);
    expect(s.activity[0]).toMatchObject({ label: "Checking customer balance", state: "completed" });
    expect(s.lastReply).toBe("Ramesh owes 1,200.");
    expect(deriveOrb(s)).toBe("off"); // tts events of a REST turn are ignored; the turn is done
  });

  it("synthesises the reply when the REST events omit it, and ignores blank input", async () => {
    const { engine, deps } = makeEngine();
    await engine.sendText("   ");
    expect(deps.postTurn).not.toHaveBeenCalled();
    await engine.sendText("hello");
    expect(engine.getSnapshot().lastReply).toBe("echo hello");
  });

  it("reports a failed REST turn without throwing", async () => {
    const { engine } = makeEngine({
      postTurn: vi.fn(async () => {
        throw new ApiError(0, { code: "NETWORK_ERROR", message: "You appear to be offline." });
      }),
    });
    await expect(engine.sendText("hi")).resolves.toBeUndefined();
    expect(engine.getSnapshot().error).toEqual({ code: "NETWORK_ERROR", message: "You appear to be offline.", fatal: false });
    expect(engine.getSnapshot().turnId).toBeNull();
  });

  it("sends over the open socket, and replays over REST with the same turn_id if the socket drops", async () => {
    const { engine, deps } = makeEngine();
    await goLive(engine);
    await engine.sendText("record 500 from Ramesh");
    const msg = ws().json().find((m) => m.type === "text");
    expect(msg).toMatchObject({ type: "text", text: "record 500 from Ramesh" });
    expect(deps.postTurn).not.toHaveBeenCalled();
    ws().serverClose(1006);
    await vi.waitFor(() => expect(deps.postTurn).toHaveBeenCalledWith("record 500 from Ramesh", msg?.turn_id));
    engine.disable();
  });
});

describe("mount", () => {
  it("loads history, readiness, and offers resume after a reload without opening the mic", async () => {
    window.sessionStorage.setItem("kaira.agent.live", "1");
    const { engine } = makeEngine({
      getConversation: vi.fn(async () => [{ turn_id: "h", role: "assistant" as const, text: "Welcome back", language: null, at: "2026-11-22T00:00:00Z" }]),
      readVoiceReady: vi.fn(async () => false),
    });
    engine.attach();
    await vi.waitFor(() => expect(engine.getSnapshot().transcript).toHaveLength(1));
    await vi.waitFor(() => expect(engine.getSnapshot().voiceConfigured).toBe(false));
    expect(engine.getSnapshot().resumeAvailable).toBe(true);
    expect(mic.started).toBe(false);
    // Voice not configured: enable explains instead of opening the mic.
    await engine.enable();
    expect(engine.getSnapshot().error?.code).toBe("voice_not_configured");
    expect(mic.started).toBe(false);
  });

  it("detach releases devices but keeps the live preference for a reload", async () => {
    const { engine } = makeEngine();
    await goLive(engine);
    engine.detach();
    expect(mic.stopped).toBe(true);
    expect(ws().closedWith).toBe(1000);
    expect(window.sessionStorage.getItem("kaira.agent.live")).toBe("1");
  });
});
