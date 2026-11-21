"use client";

/**
 * Presentational voice orb used in two places: the large record/stop control inside AssistantPanel,
 * and the small "Ask KAIRA" launcher in the app shell. It holds no state and never touches the
 * microphone; the parent passes the state and decides what a press does. The animated look comes from
 * the `.orb` CSS class in app/globals.css, keyed off the `data-state` attribute.
 */
import { Mic, Square } from "lucide-react";

import { cn } from "@/components/ui/primitives";

/** Visual states; AssistantPanel derives them from recorder status plus its own transcribe/extract/speak workflow. */
export type OrbState = "idle" | "listening" | "processing" | "ready" | "speaking" | "error";

/** Status text announced through the polite live region under the large orb. */
export const ORB_LABEL: Record<OrbState, string> = {
  idle: "Tap to speak",
  listening: "Listening… tap to stop",
  processing: "Working on it…",
  ready: "Ready",
  speaking: "Speaking…",
  error: "Something went wrong",
};

/**
 * Layered luminous orb. Purely visual state + one explicit button; never records on its own.
 * `seconds` is the elapsed recording time from the recorder; `testId` lets the two usages be told apart in tests.
 */
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
  // Accessibility: without a custom `ariaLabel` the button acts as a record toggle (aria-pressed plus a
  // Start/Stop label). With one (the launcher) it is a plain button and aria-pressed is omitted.
  // The status line and the seconds counter render only for the large size; "30s" mirrors
  // MAX_RECORDING_SECONDS in hooks/use-recorder.ts, which stops recording at that limit.
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
