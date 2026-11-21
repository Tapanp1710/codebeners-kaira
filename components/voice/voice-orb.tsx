"use client";

import { Mic, Square } from "lucide-react";

import { cn } from "@/components/ui/primitives";

export type OrbState = "idle" | "listening" | "processing" | "ready" | "speaking" | "error";

export const ORB_LABEL: Record<OrbState, string> = {
  idle: "Tap to speak",
  listening: "Listening… tap to stop",
  processing: "Working on it…",
  ready: "Ready",
  speaking: "Speaking…",
  error: "Something went wrong",
};

/** Layered luminous orb. Purely visual state + one explicit button; never records on its own. */
export function VoiceOrb({
  state,
  onPress,
  disabled,
  size = "lg",
  seconds,
  ariaLabel,
  testId = "voice-orb",
}: {
  state: OrbState;
  onPress: () => void;
  disabled?: boolean;
  size?: "sm" | "lg";
  seconds?: number;
  ariaLabel?: string;
  testId?: string;
}) {
  const listening = state === "listening";
  return (
    <div className="flex flex-col items-center gap-3">
      <button
        type="button"
        onClick={onPress}
        disabled={disabled}
        aria-pressed={ariaLabel ? undefined : listening}
        aria-label={ariaLabel ?? (listening ? "Stop recording" : "Start recording")}
        data-testid={testId}
        data-state={state}
        className={cn(
          "orb grid place-items-center text-cream disabled:cursor-not-allowed disabled:opacity-60",
          size === "lg" ? "size-32" : "size-11",
        )}
      >
        {listening ? (
          <Square className={size === "lg" ? "size-8" : "size-4"} aria-hidden="true" />
        ) : (
          <Mic className={size === "lg" ? "size-9" : "size-5"} aria-hidden="true" />
        )}
      </button>
      {size === "lg" && (
        <p role="status" aria-live="polite" className="text-sm font-medium text-muted" data-testid="orb-status">
          {ORB_LABEL[state]}
          {listening && seconds !== undefined ? ` · ${seconds}s / 30s` : ""}
        </p>
      )}
    </div>
  );
}
