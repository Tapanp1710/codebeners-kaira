"use client";

/**
 * Persistent agent dock, shown at the bottom of every (app) page except the agent home. It is a second view of
 * the same live session (useAgent()), so talking to KAIRA never requires leaving the page: mini orb (links to the
 * agent home), state text, live caption or last reply, live switch, mute, stop speaking and a compact text input.
 * On phones it collapses to orb + state + live switch; "More" expands the rest.
 * Accessibility: the state line is a polite status region and KAIRA's last reply is announced once through a
 * visually hidden polite live region (the visible caption also shows the word-by-word partial, which is not
 * announced). The dock sits on navy, so its focus outline uses the light "dark surface" colour (globals.css).
 */
import { ChevronDown, ChevronUp, Maximize2 } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";

import { AgentTextForm, InterruptButton, LiveToggle, MuteToggle, useLiveSession } from "@/components/agent/agent-controls";
import { LiveKairaOrb, ORB_STATUS } from "@/components/agent/kaira-orb";
import { cn } from "@/components/ui/primitives";

export function AgentDock() {
  const { agent, toggle, starting, error, orb } = useLiveSession();
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const status = ORB_STATUS[orb];
  const caption = agent.partial ? { who: "You", text: agent.partial } : agent.lastReply ? { who: "KAIRA", text: agent.lastReply } : null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-3 pb-3 lg:left-[17rem]">
      <section
        aria-label="KAIRA voice dock"
        data-testid="agent-dock"
        data-expanded={expanded}
        data-surface="dark"
        className="pointer-events-auto mx-auto max-w-4xl rounded-3xl bg-navy/95 p-2.5 text-cream shadow-[0_18px_50px_-20px_rgb(13_27_42/0.8)] ring-1 ring-white/10 backdrop-blur sm:p-3"
      >
        <div className="flex items-center gap-2.5 sm:gap-3">
          <Link href="/agent" aria-label="Open KAIRA" className="shrink-0 rounded-full">
            <LiveKairaOrb state={orb} size="dock" />
          </Link>
          <div className="min-w-0 flex-1">
            <p role="status" aria-live="polite" className="truncate text-sm font-semibold" data-testid="dock-status">
              {status.label}
              {agent.live && !agent.muted && <span className="ml-2 text-xs font-normal text-sage">· mic on</span>}
            </p>
            <p className="sr-only" aria-live="polite" aria-atomic="true" data-testid="dock-reply-announcer">
              {agent.lastReply ? `KAIRA: ${agent.lastReply}` : ""}
            </p>
            <p className={cn("truncate text-xs text-cream/70", !expanded && "hidden sm:block")} data-testid="dock-caption">
              {caption ? (
                <>
                  <span className="font-semibold text-champagne">{caption.who}:</span>{" "}
                  {caption.text}
                </>
              ) : (
                status.hint
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <LiveToggle live={agent.live} starting={starting} onToggle={toggle} resume={agent.resumeAvailable} compact testId="dock-live-toggle" />
            <span className={cn("items-center gap-1.5", expanded ? "flex" : "hidden sm:flex")}>
              <MuteToggle live={agent.live} muted={agent.muted} onChange={agent.setMuted} compact testId="dock-mute" />
              <InterruptButton speaking={orb === "speaking"} onInterrupt={agent.interrupt} compact testId="dock-interrupt" />
            </span>
            <Link href="/agent" className="hidden rounded-full p-2 text-cream/80 hover:bg-white/10 hover:text-cream sm:inline-flex" aria-label="Open the full KAIRA view">
              <Maximize2 className="size-4" aria-hidden="true" />
            </Link>
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              aria-expanded={expanded}
              aria-controls={panelId}
              aria-label={expanded ? "Show less" : "Show more"}
              className="rounded-full p-2 text-cream/80 hover:bg-white/10 hover:text-cream sm:hidden"
            >
              {expanded ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronUp className="size-4" aria-hidden="true" />}
            </button>
          </div>
        </div>
        <div id={panelId} className={cn("mt-2 flex-col gap-1.5 [&_input]:bg-white/90", expanded ? "flex" : "hidden sm:flex")}>
          {error && (
            <p role="alert" className="text-xs text-champagne" data-testid="dock-error">
              Live voice unavailable: {error}{" "}
              <span className="text-cream/70">Typing still works.</span>
            </p>
          )}
          <AgentTextForm compact testIdPrefix="dock" />
        </div>
      </section>
    </div>
  );
}
