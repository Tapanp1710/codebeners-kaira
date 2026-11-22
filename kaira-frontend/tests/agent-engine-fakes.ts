/**
 * Test doubles for the voice engine tests: a scriptable WebSocket, a minimal AudioContext (enough for PcmPlayer)
 * and a microphone stub. Not a test file itself (no .test suffix).
 */
import type { AgentSessionTicket } from "@/lib/agent/protocol";
import type { SocketLike } from "@/lib/agent/socket";

export class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  binaryType: BinaryType = "blob";
  readyState = 0;
  bufferedAmount = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  sent: Array<string | ArrayBufferLike | ArrayBufferView> = [];
  closedWith: number | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string | ArrayBufferLike | ArrayBufferView) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closedWith = code ?? 1005;
    this.readyState = 3;
  }
  // ---- server side
  serverOpen() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  serverJson(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }
  serverBinary(buffer: ArrayBuffer) {
    this.onmessage?.({ data: buffer } as MessageEvent);
  }
  serverClose(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
  json(): Array<Record<string, unknown>> {
    return this.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d));
  }
  binary(): ArrayBuffer[] {
    return this.sent.filter((d): d is ArrayBuffer => d instanceof ArrayBuffer);
  }
}

export function ticket(n = 1, voice = true): AgentSessionTicket {
  return {
    session_id: `00000000-0000-0000-0000-00000000000${n}`,
    ticket: `tk${n}`,
    ws_url: "ws://backend.test/api/v1/agent/live",
    expires_in: 60,
    voice_configured: voice,
    stt_model: "saaras:v4",
    tts_model: "bulbul:v4-flash",
  };
}

type Node = { connect: (n?: unknown) => void; disconnect: () => void };
const node = (): Node => ({ connect: () => {}, disconnect: () => {} });

export class FakeSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped = false;
  connect() {}
  disconnect() {}
  start(when: number) {
    this.startedAt = when;
  }
  stop() {
    this.stopped = true;
  }
}

export class FakeAudioContext {
  currentTime = 0;
  state: AudioContextState = "running";
  destination = node();
  sources: FakeSource[] = [];
  closed = false;
  createGain() {
    return { ...node(), gain: { value: 1, cancelScheduledValues: () => {}, setTargetAtTime: () => {} } };
  }
  createAnalyser() {
    return { ...node(), fftSize: 1024, getFloatTimeDomainData: (b: Float32Array) => b.fill(0) };
  }
  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate, copyToChannel: () => {} };
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    this.state = "closed";
    return Promise.resolve();
  }
}

export class FakeMic {
  started = false;
  stopped = false;
  enabled = true;
  onFrame: ((f: { pcm: ArrayBuffer; rms: number }) => void) | null = null;
  onEnded: (() => void) | null = null;
  failWith: Error | null = null;
  async start(_ctx: unknown, onFrame: (f: { pcm: ArrayBuffer; rms: number }) => void, onEnded: () => void) {
    if (this.failWith) throw this.failWith;
    this.started = true;
    this.onFrame = onFrame;
    this.onEnded = onEnded;
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }
  stop() {
    this.stopped = true;
  }
  /** Emits one 100 ms frame (1600 samples) of constant value. */
  frame(value: number, rms: number) {
    this.onFrame?.({ pcm: new Int16Array(1600).fill(value).buffer, rms });
  }
}
