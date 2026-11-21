"use client";

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

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return undefined;
}

/**
 * Explicit, user-initiated recording only. The microphone stream is released as soon as recording
 * stops; nothing listens in the background.
 */
export function useRecorder(onComplete: (audio: Blob) => void) {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [error, setError] = useState<RecorderError | null>(null);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const completeRef = useRef(onComplete);
  useEffect(() => {
    completeRef.current = onComplete;
  }, [onComplete]);

  const release = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => release, [release]);

  const fail = useCallback(
    (reason: RecorderError) => {
      release();
      setError(reason);
      setStatus("error");
    },
    [release],
  );

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      fail("unsupported");
      return;
    }
    setStatus("requesting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = (err as DOMException)?.name;
      fail(name === "NotAllowedError" || name === "SecurityError" ? "permission_denied" : name === "NotFoundError" ? "no_microphone" : "recording_failed");
      return;
    }
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
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      if (blob.size < 200) {
        fail("empty_recording");
        return;
      }
      setStatus("idle");
      completeRef.current(blob);
    };
    recorder.start(250);
    setSeconds(0);
    setStatus("recording");
    timerRef.current = setInterval(() => {
      setSeconds((s) => {
        if (s + 1 >= MAX_RECORDING_SECONDS) stop();
        return s + 1;
      });
    }, 1000);
  }, [fail, release, stop]);

  const reset = useCallback(() => {
    setError(null);
    setStatus("idle");
  }, []);

  return { status, error, seconds, start, stop, reset };
}
