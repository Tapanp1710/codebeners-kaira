/**
 * Microphone capture: getUserMedia (echo cancellation, noise suppression, AGC, mono) -> MediaStreamSource ->
 * AudioWorklet (public/worklets/kaira-mic-worklet.js: mono, 16 kHz, Int16 LE, ~100 ms frames + RMS).
 *
 * Opened only by an explicit enable() and torn down completely by stop(): every track is stopped and every node
 * disconnected, so the browser's microphone indicator turns off. The AudioContext belongs to the caller (shared
 * with playback so one user gesture unlocks both).
 */
import { MIC_SAMPLE_RATE } from "./protocol";
import type { AgentError } from "./reducer";

export const MIC_WORKLET_URL = "/worklets/kaira-mic-worklet.js";
export const MIC_FRAME_SAMPLES = 1600; // 100 ms at 16 kHz

export type MicFrame = { pcm: ArrayBuffer; rms: number };

/** Error with a stable code and a user-facing message. */
export class MicError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MicError";
  }
  toAgentError(): AgentError {
    return { code: this.code, message: this.message, fatal: true };
  }
}

/** Checks that live capture can work here at all (secure context, getUserMedia, AudioWorklet). */
export function micSupportError(): MicError | null {
  if (typeof window === "undefined") return new MicError("mic_unsupported", "Live voice is only available in the browser.");
  if (!window.isSecureContext) {
    return new MicError("insecure_context", "Live voice needs a secure connection (HTTPS or localhost). Typed input still works.");
  }
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
    return new MicError("mic_unsupported", "This browser cannot capture the microphone. Typed input still works.");
  }
  if (typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") {
    return new MicError("audio_unsupported", "This browser does not support the audio features live voice needs.");
  }
  return null;
}

/** Maps getUserMedia / AudioWorklet failures to a MicError with a clear message. */
export function toMicError(error: unknown): MicError {
  if (error instanceof MicError) return error;
  const name = error instanceof Error || (typeof DOMException !== "undefined" && error instanceof DOMException) ? (error as Error).name : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return new MicError(
        "mic_permission_denied",
        "Microphone access is blocked. Allow the microphone for this site in your browser settings, then turn live voice on again.",
      );
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return new MicError("mic_not_found", "No microphone was found. Connect one and turn live voice on again.");
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return new MicError("mic_busy", "The microphone is in use by another app or could not be started.");
    default:
      return new MicError("mic_failed", "The microphone could not be started.");
  }
}

export class MicCapture {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private stopped = false;
  /** Audio contexts whose worklet module is already loaded. */
  private static loaded = new WeakSet<BaseAudioContext>();

  /**
   * Opens the microphone and starts emitting frames. `onEnded` fires if the device goes away (unplugged, revoked).
   * Throws MicError.
   */
  async start(ctx: AudioContext, onFrame: (frame: MicFrame) => void, onEnded: () => void): Promise<void> {
    const unsupported = micSupportError();
    if (unsupported) throw unsupported;
    this.stopped = false;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      });
    } catch (error) {
      throw toMicError(error);
    }
    // stop() may have been called while the permission prompt was open.
    if (this.stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    try {
      if (!MicCapture.loaded.has(ctx)) {
        await ctx.audioWorklet.addModule(MIC_WORKLET_URL);
        MicCapture.loaded.add(ctx);
      }
      if (this.stopped) return this.stop();
      this.source = ctx.createMediaStreamSource(stream);
      this.node = new AudioWorkletNode(ctx, "kaira-mic", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
        processorOptions: { targetRate: MIC_SAMPLE_RATE, frameSamples: MIC_FRAME_SAMPLES },
      });
      this.node.port.onmessage = (event: MessageEvent<{ type?: string; pcm?: unknown; rms?: unknown }>) => {
        const data = event.data;
        if (data?.type === "frame" && data.pcm instanceof ArrayBuffer && typeof data.rms === "number") {
          onFrame({ pcm: data.pcm, rms: data.rms });
        }
      };
      // A silent sink keeps the worklet in the rendered graph in every browser without making the mic audible.
      this.sink = ctx.createGain();
      this.sink.gain.value = 0;
      this.source.connect(this.node);
      this.node.connect(this.sink);
      this.sink.connect(ctx.destination);
      for (const track of stream.getAudioTracks()) track.addEventListener("ended", onEnded, { once: true });
    } catch (error) {
      this.stop();
      throw error instanceof MicError ? error : new MicError("audio_unsupported", "The audio processor for live voice could not be started.");
    }
  }

  /** Mute at the source too (the browser keeps the device open; frames become silence). */
  setEnabled(enabled: boolean): void {
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = enabled));
  }

  stop(): void {
    this.stopped = true;
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.port.close();
      this.node.disconnect();
    }
    this.source?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node = null;
    this.source = null;
    this.sink = null;
    this.stream = null;
  }
}
