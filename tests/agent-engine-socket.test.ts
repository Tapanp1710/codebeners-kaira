// @vitest-environment node
/** AgentSocket: ticket + connect, ping, mute, bounded backlog, reconnect with backoff and fatal handling. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildSocketUrl } from "@/lib/agent/api";
import {
  AgentSocket,
  BACKLOG_FRAMES,
  FatalSocketError,
  HIGH_WATER_BYTES,
  MAX_RECONNECT_ATTEMPTS,
  PING_INTERVAL_MS,
  type SocketStatus,
} from "@/lib/agent/socket";
import type { ServerEvent } from "@/lib/agent/protocol";

import { FakeSocket, ticket } from "./agent-engine-fakes";

function setup(requestTicket = vi.fn(async (resume: string | null) => ticket(resume ? 2 : 1))) {
  const statuses: SocketStatus[] = [];
  const events: ServerEvent[] = [];
  const audio: ArrayBuffer[] = [];
  const fatal: Array<[string, string]> = [];
  const sock = new AgentSocket(
    {
      requestTicket,
      createSocket: (url) => new FakeSocket(url),
      buildUrl: (ws, t) => buildSocketUrl(ws, t, "http://localhost:3000"),
      random: () => 0, // smallest delay: jitter part is 0
    },
    {
      onStatus: (s) => statuses.push(s),
      onEvent: (e) => events.push(e),
      onAudio: (a) => audio.push(a),
      onSession: () => {},
      onFatal: (code, message) => fatal.push([code, message]),
    },
  );
  return { sock, statuses, events, audio, fatal, requestTicket };
}

const last = () => FakeSocket.instances[FakeSocket.instances.length - 1];

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("buildSocketUrl", () => {
  it("appends the ticket and maps http(s) to ws(s)", () => {
    expect(buildSocketUrl("ws://b.test/api/v1/agent/live", "a b", "http://x")).toBe("ws://b.test/api/v1/agent/live?ticket=a+b");
    expect(buildSocketUrl("https://b.test/live?x=1", "t", "http://x")).toBe("wss://b.test/live?x=1&ticket=t");
    expect(buildSocketUrl("/api/v1/agent/live", "t", "https://app.test")).toBe("wss://app.test/api/v1/agent/live?ticket=t");
  });
});

describe("AgentSocket", () => {
  it("connects with a ticket, uses arraybuffer, dispatches events and audio, pings every 20 s", async () => {
    const { sock, statuses, events, audio } = setup();
    sock.connect();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const ws = last();
    expect(ws.url).toBe("ws://backend.test/api/v1/agent/live?ticket=tk1");
    expect(ws.binaryType).toBe("arraybuffer");
    ws.serverOpen();
    expect(statuses).toEqual(["connecting", "open"]);
    ws.serverJson({ type: "vad", speech: true });
    ws.onmessage?.({ data: "not json" } as MessageEvent);
    ws.serverBinary(new ArrayBuffer(4));
    expect(events).toEqual([{ type: "vad", speech: true }]);
    expect(audio).toHaveLength(1);
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(ws.json()).toEqual([{ type: "ping" }]);
  });

  it("mute stops audio and sends mute/unmute; mute is re-sent after a reconnect", async () => {
    const { sock } = setup();
    sock.connect();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    last().serverOpen();
    sock.sendAudio(new ArrayBuffer(3200));
    sock.setMuted(true);
    sock.sendAudio(new ArrayBuffer(3200));
    expect(last().binary()).toHaveLength(1);
    expect(last().json()).toEqual([{ type: "mute" }]);
    last().serverClose(1006);
    await vi.advanceTimersByTimeAsync(10_000);
    last().serverOpen();
    expect(last().json()).toEqual([{ type: "mute" }]);
    sock.setMuted(false);
    expect(last().json()).toEqual([{ type: "mute" }, { type: "unmute" }]);
  });

  it("drops the oldest frames when the socket is backed up", async () => {
    const { sock } = setup();
    sock.connect();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const ws = last();
    ws.serverOpen();
    ws.bufferedAmount = HIGH_WATER_BYTES;
    const frames = Array.from({ length: BACKLOG_FRAMES + 5 }, (_, i) => new Uint8Array([i]).buffer);
    frames.forEach((f) => sock.sendAudio(f));
    expect(ws.binary()).toHaveLength(0);
    expect(sock.droppedFrames).toBe(5);
    ws.bufferedAmount = 0;
    sock.sendAudio(new Uint8Array([99]).buffer);
    const sent = ws.binary().map((b) => new Uint8Array(b)[0]);
    expect(sent[0]).toBe(6); // frames 0..5 were dropped (one more pushed out by the newest)
    expect(sent[sent.length - 1]).toBe(99);
    expect(sent).toHaveLength(BACKLOG_FRAMES);
  });

  it("reconnects with backoff, a fresh ticket and resume_session_id", async () => {
    const { sock, statuses, requestTicket } = setup();
    sock.connect();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    last().serverOpen();
    last().serverClose(1006);
    expect(statuses.at(-1)).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(249);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(requestTicket).toHaveBeenLastCalledWith("00000000-0000-0000-0000-000000000001");
    expect(last().url).toContain("ticket=tk2");
  });

  it("retries a failing ticket request and gives up after the maximum attempts", async () => {
    const requestTicket = vi.fn(async () => {
      throw new Error("offline");
    });
    const { sock, fatal, statuses } = setup(requestTicket);
    sock.connect();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(requestTicket).toHaveBeenCalledTimes(MAX_RECONNECT_ATTEMPTS + 1);
    expect(fatal).toEqual([["CONNECTION_LOST", expect.any(String)]]);
    expect(statuses.at(-1)).toBe("closed");
  });

  it("stops at once on a fatal ticket error", async () => {
    const requestTicket = vi.fn(async () => {
      throw new FatalSocketError("FORBIDDEN", "nope");
    });
    const { sock, fatal } = setup(requestTicket);
    sock.connect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requestTicket).toHaveBeenCalledTimes(1);
    expect(fatal).toEqual([["FORBIDDEN", "nope"]]);
  });

  it("never reconnects after a fatal server error", async () => {
    const { sock, events } = setup();
    sock.connect();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    last().serverOpen();
    last().serverJson({ type: "error", source: "config", code: "PROVIDER_NOT_CONFIGURED", message: "m", fatal: true });
    last().serverClose(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toHaveLength(1);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(last().closedWith).toBe(1000);
  });

  it("disconnect closes normally and cancels a pending reconnect", async () => {
    const { sock } = setup();
    sock.connect();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    last().serverOpen();
    last().serverClose(1006);
    sock.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
