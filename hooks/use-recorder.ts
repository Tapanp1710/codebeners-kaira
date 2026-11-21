"use client";

/**
 * MediaRecorder wrapper for the voice orb (components/voice/assistant-panel.tsx).
 *
 * Produces one audio Blob per recording and hands it to `onComplete`; the panel then uploads it with
 * transcribe() in lib/api/voice.ts. Browser capability and permission failures are mapped to a small set
 * of RecorderError codes with user-facing messages that always offer typing as a fallback.
 * Microphone access also depends on the Permissions-Policy set in next.config.ts (microphone=(self)).
 */
import { useCallback, useEffect, useRef, useState } from "react";

export const MAX_RECORDING_SECONDS = 30; // Sarvam synchronous STT limit (contracts/API_CONTRACT.md)

export type RecorderStatus = "idle" | "requesting" | "recording" | "error";

export type RecorderError =
  | "unsupported"
  | "permission_denied"
  | "no_microphone"
  | "recording_failed"
  | "empty_recording";

export const RECORDER_MESSAGES: Record<RecorderError, string> = {
  unsupported: "This browser cannot record audio. Type your request instead.",
  permission_denied: "Microphone access was blocked. Allow it in the browser's site settings, or type your request.",
  no_microphone: "No microphone was found. Connect one, or type your request.",
  recording_failed: "Recording failed. Please try again, or type your request.",
  empty_recording: "Nothing was recorded. Hold the orb a little longer while you speak.",
};

// First container the browser can record, in order of preference (Chrome/Firefox: WebM/Opus; Safari: MP4).
// undefined lets MediaRecorder choose its own default. The resulting MIME type also decides the upload
// file extension in transcribe().
function pickMimeType(): string | undefined {
  // Guard for server rendering and browsers without MediaRecorder; isTypeSupported is optional-chained
  // below so an implementation that lacks it falls through to the browser default.
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return undefined;
}

/**
 * Explicit, user-initiated recording only. The microphone stream is released as soon as recording
 * stops; nothing listens in the background.
 *
 * Returns { status, error, seconds, start, stop, reset }. `start` is meant to be wired to a tap on the orb;
 * recording ends on `stop()` or automatically at MAX_RECORDING_SECONDS.
 */
export function useRecorder(onComplete: (audio: Blob) => void) {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [error, setError] = useState<RecorderError | null>(null);
  const [seconds, setSeconds] = useState(0);
  // Refs hold the live recorder/stream/chunks so event handlers never read stale React state.
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Latest onComplete, so recorder.onstop (bound when recording started) calls the current callback.
  const completeRef = useRef(onComplete);
  useEffect(() => {
    completeRef.current = onComplete;
  }, [onComplete]);

  // Stops the elapsed-time timer and every microphone track (turns off the browser's recording indicator).
  const release = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Unmount cleanup: never leave the microphone open if the component goes away mid-recording.
  useEffect(() => release, [release]);

  const fail = useCallback(
    (reason: RecorderError) => {
      release();
      setError(reason);
      setStatus("error");
    },
    [release],
  );

  // Safe to call repeatedly: only an active recorder is stopped; the Blob is assembled in onstop.
  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    // Feature detection: getUserMedia is also missing on insecure (non-HTTPS, non-localhost) origins.
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      fail("unsupported");
      return;
    }
    // "requesting" spans the browser's permission prompt, which waits on the user for as long as it takes.
    setStatus("requesting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      // Map getUserMedia DOMException names to user-facing reasons.
      const name = (err as DOMException)?.name;
      fail(name === "NotAllowedError" || name === "SecurityError" ? "permission_denied" : name === "NotFoundError" ? "no_microphone" : "recording_failed");
      return;
    }
    // The stream is stored before the recorder is built, so every later fail() (constructor throw,
    // onerror, empty recording) reaches it through release() and stops the microphone tracks.
    streamRef.current = stream;
    chunksRef.current = [];
    let recorder: MediaRecorder;
    try {
      const mimeType = pickMimeType();
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      fail("recording_failed");
      return;
    }
    recorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onerror = () => fail("recording_failed");
    recorder.onstop = () => {
      release();
      // recorder.mimeType can be an empty string when MediaRecorder picked its own default; fall back to WebM.
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      // Under ~200 bytes there is effectively no audio (e.g. an immediate second tap); don't upload it.
      if (blob.size < 200) {
        fail("empty_recording");
        return;
      }
      setStatus("idle");
      completeRef.current(blob);
    };
    // 250 ms timeslice: data arrives in small chunks while recording instead of one chunk at stop.
    recorder.start(250);
    setSeconds(0);
    setStatus("recording");
    // Elapsed-seconds counter that also enforces the provider limit. stop() is called from inside the
    // state updater; that is harmless if the updater runs twice because stop() ignores an inactive recorder.
    timerRef.current = setInterval(() => {
      setSeconds((s) => {
        if (s + 1 >= MAX_RECORDING_SECONDS) stop();
        return s + 1;
      });
    }, 1000);
  }, [fail, release, stop]);

  // Clears an error so the orb returns to idle; does not touch the microphone.
  const reset = useCallback(() => {
    setError(null);
    setStatus("idle");
  }, []);

  return { status, error, seconds, start, stop, reset };
}
