"use client";

/**
 * Controls shared by the agent home (/agent) and the agent dock on every other page. All of them talk to the one
 * live session in <AgentProvider> through useAgent(); none keeps its own copy of the conversation.
 *
 *  - useLiveSession(): explicit start/stop of the live session. A failed enable() (microphone blocked, no device,
 *    voice engine unavailable) is kept as `startError` and shown; the orb then shows "error" instead of pretending
 *    to listen.
 *  - LiveToggle / MuteToggle / InterruptButton: the three voice controls. Mute and "Stop speaking" are disabled
 *    (not hidden) when they cannot apply, so the layout does not jump.
 *  - AgentTextForm: the typed path into the same conversation (sendText()).
 * The buttons are memoised (their props are primitives and the engine's stable callbacks), so the frequent agent
 * context updates while live (audio levels) do not re-render them.
 */
import { Mic, MicOff, Power, Send, VolumeX } from "lucide-react";
import { memo, useCallback, useId, useState, type FormEvent } from "react";

import { useAgent } from "@/components/agent/agent-provider";
import { Button, cn } from "@/components/ui/primitives";
import type { AgentContextValue, OrbState } from "@/lib/agent/protocol";

/** Maps an enable()/sendText() failure to a sentence the user can act on. */
export function describeAgentError(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was blocked. Allow the microphone for this site in your browser settings, or type instead.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found on this device. You can type instead.";
  if (name === "NotReadableError") return "The microphone is in use by another application. Close it and try again, or type instead.";
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong.";
}

/** The orb state to show: a failed start is an error even though the engine itself is still "off". */
export function displayOrb(agent: Pick<AgentContextValue, "orb" | "live">, startError: string | null): OrbState {
  if (startError && !agent.live && agent.orb === "off") return "error";
  return agent.orb;
}

/** Start/stop of the live session with the start error kept for display. */
export function useLiveSession() {
  const agent = useAgent();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const { live, enable, disable } = agent;

  const toggle = useCallback(async () => {
    if (live) {
      disable();
      return;
    }
    setStartError(null);
    setStarting(true);
    try {
      await enable();
    } catch (err) {
      setStartError(describeAgentError(err));
    } finally {
      setStarting(false);
    }
  }, [live, enable, disable]);

  const engineError = agent.error ? agent.error.message : null;
  return {
    agent,
    toggle,
    starting,
    startError,
    /** Engine error (from the session) first, then a failed start. */
    error: engineError ?? startError,
    fatal: agent.error?.fatal ?? Boolean(startError),
    orb: displayOrb(agent, startError),
  };
}

/** Start / end (or, after a reload, resume) the live session. `resume` comes from useAgent().resumeAvailable. */
export const LiveToggle = memo(function LiveToggle({
  live,
  starting,
  onToggle,
  compact,
  resume,
  testId = "agent-live-toggle",
}: {
  live: boolean;
  starting: boolean;
  onToggle: () => void;
  compact?: boolean;
  resume?: boolean;
  testId?: string;
}) {
  const verb = live ? "End" : resume ? "Resume" : "Start";
  const label = `${verb} live session`;
  return (
    <Button
      type="button"
      variant={live ? "good" : "primary"}
      size={compact ? "sm" : "lg"}
      onClick={onToggle}
      loading={starting}
      aria-pressed={live}
      aria-label={compact ? `${label}${live ? " (microphone is on)" : ""}` : undefined}
      data-testid={testId}
      className={cn(compact && "px-2.5 sm:px-3")}
    >
      {live ? <Power className="size-4" aria-hidden="true" /> : <Mic className="size-4" aria-hidden="true" />}
      <span className={cn(compact && "hidden sm:inline")}>{compact ? `${verb} live` : label}</span>
    </Button>
  );
});

export const MuteToggle = memo(function MuteToggle({
  live,
  muted,
  onChange,
  compact,
  testId = "agent-mute",
}: {
  live: boolean;
  muted: boolean;
  onChange: (muted: boolean) => void;
  compact?: boolean;
  testId?: string;
}) {
  return (
    <Button
      type="button"
      variant="secondary"
      size={compact ? "sm" : "lg"}
      onClick={() => onChange(!muted)}
      disabled={!live}
      aria-pressed={muted}
      aria-label={muted ? "Unmute microphone" : "Mute microphone"}
      title={live ? undefined : "Available while the live session is on"}
      data-testid={testId}
      className={cn(compact && "px-2.5")}
    >
      {muted ? <MicOff className="size-4" aria-hidden="true" /> : <Mic className="size-4" aria-hidden="true" />}
      {!compact && <span>{muted ? "Unmute" : "Mute"}</span>}
    </Button>
  );
});

export const InterruptButton = memo(function InterruptButton({
  speaking,
  onInterrupt,
  compact,
  testId = "agent-interrupt",
}: {
  speaking: boolean;
  onInterrupt: () => void;
  compact?: boolean;
  testId?: string;
}) {
  return (
    <Button
      type="button"
      variant="secondary"
      size={compact ? "sm" : "lg"}
      onClick={onInterrupt}
      disabled={!speaking}
      aria-label="Stop speaking"
      title={speaking ? undefined : "Available while KAIRA is speaking"}
      data-testid={testId}
      className={cn(compact && "px-2.5")}
    >
      <VolumeX className="size-4" aria-hidden="true" />
      {!compact && <span>Stop speaking</span>}
    </Button>
  );
});

/**
 * Typed message into the same conversation. Keeps the text if sending fails so nothing is lost.
 * `compact` renders the one-line dock variant with a visually hidden label.
 */
export function AgentTextForm({ compact, testIdPrefix = "agent" }: { compact?: boolean; testIdPrefix?: string }) {
  const { sendText } = useAgent();
  const id = useId();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendText(value);
      setText("");
    } catch (err) {
      setError(`Not sent: ${describeAgentError(err)}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className={cn("min-w-0", compact ? "flex-1" : "space-y-2")} aria-label="Type to KAIRA">
      <label htmlFor={id} className={compact ? "sr-only" : "block text-xs font-semibold uppercase tracking-wide text-muted"}>
        {compact ? "Type to KAIRA" : "Or type to KAIRA"}
      </label>
      <div className="flex min-w-0 gap-2">
        <input
          id={id}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={compact ? "Type to KAIRA…" : "e.g. How much do my customers owe me?"}
          autoComplete="off"
          data-testid={`${testIdPrefix}-text-input`}
          className={cn(
            "min-w-0 flex-1 rounded-full bg-white/80 px-4 text-sm text-ink ring-1 ring-line placeholder:text-muted/70 focus:bg-white focus:outline-none focus:ring-2 focus:ring-steel",
            compact ? "h-8" : "h-10",
          )}
        />
        <Button
          type="submit"
          variant="dark"
          size={compact ? "sm" : "md"}
          loading={sending}
          disabled={!text.trim()}
          aria-label="Send to KAIRA"
          data-testid={`${testIdPrefix}-text-submit`}
        >
          <Send className="size-4" aria-hidden="true" />
          {!compact && <span>Send</span>}
        </Button>
      </div>
      {error && (
        <p role="alert" className={compact ? "mt-1 text-xs text-champagne" : "text-sm text-danger"} data-testid={`${testIdPrefix}-text-error`}>
          {error}
        </p>
      )}
    </form>
  );
}
