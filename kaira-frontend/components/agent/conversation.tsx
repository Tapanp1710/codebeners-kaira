"use client";

/**
 * Recent conversation from useAgent().transcript (persisted on the server, oldest first). Shown newest at the
 * bottom like a chat, capped to the last `limit` entries. Memoised on the transcript array (the engine keeps it
 * referentially stable between turns), so audio-level updates of the live session do not re-render it. It is not
 * a live region: KAIRA's reply is announced once by the agent home / dock, and the user knows what they said.
 */
import { Keyboard, Mic } from "lucide-react";
import { memo } from "react";

import { cn } from "@/components/ui/primitives";
import type { TranscriptEntry } from "@/lib/agent/protocol";
import { formatDateTime } from "@/lib/format/dates";

export const Conversation = memo(function Conversation({ transcript, limit = 30 }: { transcript: TranscriptEntry[]; limit?: number }) {
  const entries = transcript.slice(-limit);
  if (entries.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted" data-testid="agent-transcript">
        No conversation yet. Start the live session and speak, or type a question below.
      </p>
    );
  }
  return (
    <ol className="space-y-3" data-testid="agent-transcript" aria-label="Conversation, oldest first">
      {entries.map((e) => {
        const user = e.role === "user";
        return (
          <li key={`${e.role}:${e.id}`} className={cn("flex", user ? "justify-end" : "justify-start")} data-testid="transcript-entry" data-role={e.role}>
            <div
              className={cn(
                "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                user ? "rounded-br-md bg-steel text-cream" : "rounded-bl-md bg-white/70 text-ink ring-1 ring-line",
                e.ignored && "opacity-70",
              )}
            >
              <p className={cn("mb-0.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide", user ? "text-cream/70" : "text-muted")}>
                {user ? "You" : "KAIRA"}
                {e.mode === "voice" && <Mic className="size-3" aria-label="spoken" />}
                {e.mode === "text" && <Keyboard className="size-3" aria-label="typed" />}
                <time dateTime={e.at} className="font-normal normal-case tracking-normal">
                  {formatDateTime(e.at)}
                </time>
              </p>
              <p className="whitespace-pre-wrap break-words">{e.text}</p>
              {e.ignored && <p className="mt-1 text-xs italic">Not addressed to KAIRA, so nothing was done.</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
});
