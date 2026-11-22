/**
 * AgentEngine wiring with fakes for the microphone, AudioContext, WebSocket and REST calls: enable/disable cleanup,
 * pre-roll flush, mute, playback lifecycle, local barge-in, typed REST fallback, fatal errors and the reload hint.
 * No real microphone, audio device or backend is involved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentEngine,
  LIVE_ELSEWHERE_MESSAGE,
  LOCAL_BARGE_STOP_MS,
  PREROLL_MS,
  TURN_STOPPED_CODE,
  TURN_STOPPED_MESSAGE,
  type EngineDeps,
} from "@/lib/agent/engine";
import type { MicCapture } from "@/lib/agent/mic";
import { deriveOrb, type AgentIntent } from "@/lib/agent/reducer";
import { ApiError } from "@/lib/api/errors";

import { FakeAudioContext, FakeMic, FakeNetwork, FakeSocket, FakeTabLock, ticket } from "./agent-engine-fakes";

let mic: FakeMic;
let ctx: FakeAudioContext;
let lock: FakeTabLock;
let network: FakeNetwork;

function makeEngine(overrides: Partial<EngineDeps> = {}) {
  mic = new FakeMic();
  lock = new FakeTabLock();
  network = new FakeNetwork();
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
    createTabLock: () => lock,
    network,
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
    // Frames before the socket opens go to the 1.5 s pre-roll (oldest dropped): 20 frames of 100 ms -> last 15.
    for (let i = 1; i <= 20; i++) mic.frame(i, 0.001);
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    expect(ws().url).toBe("ws://backend.test/api/v1/agent/live?ticket=tk1");
    ws().serverOpen();
    expect(deriveOrb(engine.getSnapshot())).toBe("listening");
    mic.frame(21, 0.001);
    const sent = ws().binary();
    // Flushed in 250 ms chunks (each well under the server's 1 s frame cap), oldest first, before the live frame.
    expect(sent.map((b) => b.byteLength)).toEqual([8000, 8000, 8000, 8000, 8000, 8000, 3200]);
    const preroll = new Int16Array(sent.slice(0, 6).flatMap((b) => Array.from(new Int16Array(b))));
    expect(preroll.length).toBe((16000 * PREROLL_MS) / 1000);
    expect(preroll[0]).toBe(6);
    expect(preroll[1599]).toBe(6);
    expect(preroll[1600]).toBe(7);
    expect(preroll[preroll.length - 1]).toBe(20);
    expect(new Int16Array(sent[6])[0]).toBe(21);
    expect(lock.held).toBe(true);
    expect(window.sessionStorage.getItem("kaira.agent.live")).toBe("1");

    engine.disable();
    expect(mic.stopped).toBe(true);
    expect(ws().closedWith).toBe(1000);
    expect(ctx.closed).toBe(true);
    expect(engine.getSnapshot().live).toBe(false);
    expect(deriveOrb(engine.getSnapshot())).toBe("off");
    expect(window.sessionStorage.getItem("kaira.agent.live")).toBeNull();
    expect(lock.held).toBe(false);
    expect(network.subscribers).toBe(0);
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
    await expect(engine.sendText("hi")).resolves.toEqual({ ok: false, error: "You appear to be offline." });
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

  it("sendText resolves ok for a sent socket turn and for an answered REST turn", async () => {
    const { engine } = makeEngine();
    await expect(engine.sendText("hello")).resolves.toEqual({ ok: true }); // REST (not live)
    await goLive(engine);
    await expect(engine.sendText("hello again")).resolves.toEqual({ ok: true }); // over the socket
    await expect(engine.sendText("   ")).resolves.toMatchObject({ ok: false });
    engine.disable();
  });

  it("disable() does not replay a typed turn still waiting on the socket: it is marked failed", async () => {
    const { engine, deps } = makeEngine();
    await goLive(engine);
    await engine.sendText("record 500 from Ramesh");
    const msg = ws().json().find((m) => m.type === "text");
    const turnId = String(msg?.turn_id);
    ws().serverJson({ type: "turn.started", turn_id: turnId, text: "record 500 from Ramesh", language: "en-IN" });
    ws().serverJson({ type: "tool.started", turn_id: turnId, tool: "record_payment", kind: "write", arguments: {} });
    expect(deriveOrb(engine.getSnapshot())).toBe("executing");
    engine.disable();
    await Promise.resolve();
    expect(deps.postTurn).not.toHaveBeenCalled();
    const s = engine.getSnapshot();
    expect(s.error).toEqual({ code: TURN_STOPPED_CODE, message: TURN_STOPPED_MESSAGE, fatal: false });
    expect(s.turnId).toBeNull();
    expect(s.runningTools).toEqual({});
    expect(s.activity[0].state).toBe("failed");
    expect(deriveOrb(s)).toBe("off");
  });

  it("detach() (leaving the page) does not replay a waiting typed turn either", async () => {
    const { engine, deps } = makeEngine();
    await goLive(engine);
    await engine.sendText("Ramesh paid 5000 today");
    engine.detach();
    await Promise.resolve();
    expect(deps.postTurn).not.toHaveBeenCalled();
    expect(engine.getSnapshot().error?.code).toBe(TURN_STOPPED_CODE);
    expect(engine.getSnapshot().turnId).toBeNull();
  });

  it("a fatal server error still replays a waiting typed turn over REST (the user did not turn it off)", async () => {
    const { engine, deps } = makeEngine();
    await goLive(engine);
    await engine.sendText("how much does Ramesh owe");
    const msg = ws().json().find((m) => m.type === "text");
    ws().serverJson({ type: "error", source: "session", code: "SESSION_REPLACED", message: "moved", fatal: true });
    await vi.waitFor(() => expect(deps.postTurn).toHaveBeenCalledWith("how much does Ramesh owe", msg?.turn_id));
  });

  it("a typed turn refused with RATE_LIMITED is dropped and failed, never replayed later", async () => {
    const { engine, deps } = makeEngine();
    await goLive(engine);
    await engine.sendText("and Lakshmi Stores?");
    const msg = ws().json().find((m) => m.type === "text");
    ws().serverJson({
      type: "error",
      source: "session",
      code: "RATE_LIMITED",
      message: "Too many requests. Wait a moment.",
      fatal: false,
      turn_id: msg?.turn_id,
    });
    let s = engine.getSnapshot();
    expect(s.error).toEqual({ code: "RATE_LIMITED", message: "Too many requests. Wait a moment.", fatal: false });
    expect(s.turnId).toBeNull();
    expect(deriveOrb(s)).toBe("listening");
    // Neither a dropped socket nor turning live voice off resends it.
    ws().serverClose(1006);
    await Promise.resolve();
    engine.disable();
    await Promise.resolve();
    expect(deps.postTurn).not.toHaveBeenCalled();
    s = engine.getSnapshot();
    expect(s.error?.code).toBe("RATE_LIMITED"); // not overwritten by a "stopped" failure for the same turn
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

describe("first syllable: nothing gates the stream", () => {
  it("streams every frame while live, silent or loud, whatever the client VAD says", async () => {
    const { engine } = makeEngine();
    await goLive(engine);
    // Quiet room (client VAD: no speech), then a loud onset, then quiet again: every frame goes out, in order.
    const values = [1, 2, 3, 4, 5, 6, 7, 8];
    const levels = [0.0005, 0.0005, 0.0005, 0.3, 0.3, 0.0005, 0.0005, 0.0005];
    values.forEach((v, i) => mic.frame(v, levels[i]));
    expect(ws().binary().map((b) => new Int16Array(b)[0])).toEqual(values);
    engine.disable();
  });

  it("keeps the pre-roll through a reconnect and flushes it, in order, on the new socket", async () => {
    const { engine, deps } = makeEngine();
    await goLive(engine);
    const first = ws();
    mic.frame(1, 0.001);
    first.serverClose(1006);
    expect(engine.getSnapshot().connection).toBe("reconnecting");
    mic.frame(2, 0.2); // the user keeps talking while the socket is down
    mic.frame(3, 0.2);
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2), { timeout: 3000 });
    expect(deps.startSession).toHaveBeenLastCalledWith(ticket().session_id);
    ws().serverOpen();
    mic.frame(4, 0.2);
    const samples = ws()
      .binary()
      .flatMap((b) => Array.from(new Int16Array(b)));
    expect(samples.length).toBe(3 * 1600);
    expect([samples[0], samples[1600], samples[3200]]).toEqual([2, 3, 4]);
    expect(first.binary()).toHaveLength(1);
    engine.disable();
  });

  it("mute drops the pre-roll and sends nothing until unmuted", async () => {
    const { engine } = makeEngine();
    await engine.enable();
    mic.frame(1, 0.2);
    engine.setMuted(true);
    mic.frame(2, 0.2);
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    ws().serverOpen();
    expect(ws().binary()).toHaveLength(0);
    expect(ws().json()).toContainEqual({ type: "mute" });
    engine.setMuted(false);
    mic.frame(3, 0.2);
    expect(ws().binary().map((b) => new Int16Array(b)[0])).toEqual([3]);
    engine.disable();
  });
});

describe("cross-tab: one live microphone session per browser", () => {
  it("another tab holding the session: enable refuses without opening the mic and typed input keeps working", async () => {
    const { engine, deps } = makeEngine();
    lock.available = false;
    await engine.enable();
    expect(mic.started).toBe(false);
    expect(FakeSocket.instances).toHaveLength(0);
    expect(ctx.closed).toBe(true);
    expect(deps.startSession).not.toHaveBeenCalled();
    const s = engine.getSnapshot();
    expect(s.live).toBe(false);
    expect(s.liveElsewhere).toBe(true);
    expect(s.error).toEqual({ code: "live_elsewhere", message: LIVE_ELSEWHERE_MESSAGE, fatal: false });
    expect(deriveOrb(s)).toBe("off");
    expect(window.sessionStorage.getItem("kaira.agent.live")).toBeNull();

    await engine.sendText("how much does Ramesh owe me?");
    expect(deps.postTurn).toHaveBeenCalledTimes(1);
    expect(engine.getSnapshot().lastReply).toBe("echo how much does Ramesh owe me?");
  });

  it("follows the other tab via watch(): notice shown on attach, cleared when it lets go; enable then works", async () => {
    const { engine } = makeEngine();
    lock.available = false;
    engine.attach();
    expect(engine.getSnapshot().liveElsewhere).toBe(true);
    await engine.enable();
    expect(engine.getSnapshot().error?.code).toBe("live_elsewhere");
    lock.setElsewhere(false);
    expect(engine.getSnapshot().liveElsewhere).toBe(false);
    expect(engine.getSnapshot().error).toBeNull();
    await goLive(engine);
    expect(engine.getSnapshot().live).toBe(true);
    expect(lock.held).toBe(true);
    engine.detach();
    expect(lock.held).toBe(false);
    expect(lock.disposed).toBe(true);
    expect(lock.watchers).toBe(0);
  });

  it("releases the lock on a fatal error and on a lost microphone", async () => {
    const { engine } = makeEngine();
    await goLive(engine);
    ws().serverJson({ type: "error", source: "config", code: "X", message: "x", fatal: true });
    expect(lock.held).toBe(false);
    await goLive(engine);
    expect(lock.held).toBe(true);
    mic.onEnded?.();
    expect(lock.held).toBe(false);
    expect(engine.getSnapshot().error?.code).toBe("mic_lost");
  });

  it("disable while the lock request is pending releases it once granted and never opens the mic", async () => {
    const { engine } = makeEngine();
    let open!: () => void;
    lock.gate = new Promise<void>((r) => (open = r));
    const p = engine.enable();
    engine.disable();
    open();
    await p;
    expect(lock.held).toBe(false);
    expect(mic.started).toBe(false);
    expect(engine.getSnapshot().live).toBe(false);
  });
});

describe("network loss", () => {
  it("offline drops the socket at once and waits; online reconnects with a fresh ticket and the session id", async () => {
    const { engine, deps } = makeEngine();
    await goLive(engine);
    const first = ws();
    network.set(false);
    expect(first.closedWith).toBe(4000);
    expect(engine.getSnapshot().connection).toBe("reconnecting");
    expect(deriveOrb(engine.getSnapshot())).toBe("reconnecting");
    mic.frame(9, 0.2); // kept in the pre-roll
    await new Promise((r) => setTimeout(r, 50));
    expect(FakeSocket.instances).toHaveLength(1);
    expect(deps.startSession).toHaveBeenCalledTimes(1);
    network.set(true);
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    expect(deps.startSession).toHaveBeenLastCalledWith(ticket().session_id);
    ws().serverOpen();
    expect(new Int16Array(ws().binary()[0])[0]).toBe(9);
    expect(deriveOrb(engine.getSnapshot())).toBe("listening");
    engine.disable();
  });

  it("a typed turn on a silently dead socket is replayed once over REST with the same turn_id", async () => {
    const { engine, deps } = makeEngine();
    await goLive(engine);
    vi.useFakeTimers();
    const dead = ws();
    await engine.sendText("Ramesh paid 5000 today");
    const sentText = dead.json().find((m) => m.type === "text");
    expect(dead.json().filter((m) => m.type === "ping")).toHaveLength(1); // probe right after the turn
    expect(deps.postTurn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000); // no pong
    expect(dead.closedWith).toBe(4000);
    expect(deps.postTurn).toHaveBeenCalledTimes(1);
    expect(deps.postTurn).toHaveBeenCalledWith("Ramesh paid 5000 today", sentText?.turn_id);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.postTurn).toHaveBeenCalledTimes(1);
    const users = engine.getSnapshot().transcript.filter((e) => e.role === "user");
    expect(users).toHaveLength(1);
    engine.disable();
  });

  it("a pong keeps the socket: nothing is replayed", async () => {
    const { engine, deps } = makeEngine();
    await goLive(engine);
    vi.useFakeTimers();
    await engine.sendText("hello");
    ws().serverJson({ type: "pong" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ws().closedWith).toBeNull();
    expect(deps.postTurn).not.toHaveBeenCalled();
    engine.disable();
  });
});

describe("playback and listening", () => {
  it("listening resumes after tts.end even if the audio sources never report ended", async () => {
    const { engine } = makeEngine();
    await goLive(engine);
    vi.useFakeTimers();
    ws().serverJson({ type: "tts.start", turn_id: "t1", sample_rate: 16000, speaker: "s", language: "en-IN" });
    ws().serverBinary(new ArrayBuffer(3200));
    ws().serverJson({ type: "tts.end", turn_id: "t1" });
    expect(deriveOrb(engine.getSnapshot())).toBe("speaking");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(deriveOrb(engine.getSnapshot())).toBe("listening");
    expect(ctx.sources[0].stopped).toBe(true);
    engine.disable();
  });

  it("after a local barge-in, late frames of the interrupted reply are not played; the next reply is", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const { engine } = makeEngine();
    await goLive(engine);
    for (let i = 0; i < 3; i++) mic.frame(0, 0.001);
    ws().serverJson({ type: "tts.start", turn_id: "t1", sample_rate: 16000, speaker: "s", language: "en-IN" });
    ws().serverBinary(new ArrayBuffer(3200));
    mic.frame(5000, 0.3);
    now.mockReturnValue(1_000 + LOCAL_BARGE_STOP_MS);
    mic.frame(5000, 0.3);
    expect(ws().json()).toContainEqual({ type: "interrupt" });
    ws().serverBinary(new ArrayBuffer(3200));
    expect(ctx.sources).toHaveLength(1);
    ws().serverJson({ type: "tts.stop", reason: "user" });
    ws().serverJson({ type: "tts.start", turn_id: "t2", sample_rate: 16000, speaker: "s", language: "en-IN" });
    ws().serverBinary(new ArrayBuffer(3200));
    expect(ctx.sources).toHaveLength(2);
    expect(deriveOrb(engine.getSnapshot())).toBe("speaking");
    engine.disable();
    now.mockRestore();
  });

  it("resumes a suspended or interrupted AudioContext while live, not after disable", async () => {
    const { engine } = makeEngine();
    await goLive(engine);
    const c = ctx;
    const before = c.resumes;
    c.state = "suspended";
    c.onstatechange?.();
    expect(c.resumes).toBe(before + 1);
    (c as unknown as { state: string }).state = "interrupted";
    c.onstatechange?.();
    expect(c.resumes).toBe(before + 2);
    engine.disable();
    expect(c.onstatechange).toBeNull();
  });
});

describe("levels store", () => {
  it("without a levels subscriber, levels update the main state (compatibility)", async () => {
    const { engine } = makeEngine();
    await goLive(engine);
    mic.frame(1000, 0.2);
    await vi.waitFor(() => expect(engine.getSnapshot().micLevel).toBeGreaterThan(0));
    expect(engine.getLevels().mic).toBe(engine.getSnapshot().micLevel);
    engine.disable();
    expect(engine.getLevels()).toEqual({ mic: 0, output: 0 });
  });

  it("with a levels subscriber, only the levels store changes; the main state is not touched 20x/s", async () => {
    const { engine } = makeEngine();
    await goLive(engine);
    for (let i = 0; i < 4; i++) mic.frame(1000, 0.01); // settle the client VAD on a quiet room first
    let levelNotifications = 0;
    let stateNotifications = 0;
    const unsubLevels = engine.subscribeLevels(() => levelNotifications++);
    const unsubState = engine.subscribe(() => stateNotifications++);
    for (let i = 0; i < 10; i++) {
      mic.frame(1000, 0.01);
      await new Promise((r) => setTimeout(r, 30));
    }
    await vi.waitFor(() => expect(engine.getLevels().mic).toBeGreaterThan(0));
    expect(levelNotifications).toBeGreaterThan(2);
    expect(engine.getSnapshot().micLevel).toBe(0);
    expect(stateNotifications).toBe(0);
    unsubLevels();
    unsubState();
    engine.disable();
  });
});
