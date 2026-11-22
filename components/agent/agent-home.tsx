"use client";

/**
 * KAIRA agent home (/agent), the default screen after sign-in. The orb is the primary interface:
 *   - stage: the hero orb, its status (role="status"), the live caption and KAIRA's last reply, the explicit live
 *     session switch (with a clear "microphone is on" line), mute, stop speaking, and microphone / connection /
 *     voice-service status;
 *   - typed input (secondary path when the microphone is unavailable);
 *   - recent conversation, the activity panel (tool runs with their real summaries/results) and supporting
 *     business figures from GET /dashboard.
 * Everything comes from useAgent() (the one live session in the (app) layout) and existing queries.
 */
import { Mic, MicOff, Radio, Server } from "lucide-react";
import type { ReactNode } from "react";

import { ActivityFeed } from "@/components/agent/activity-feed";
import { AgentTextForm, InterruptButton, LiveToggle, MuteToggle, useLiveSession } from "@/components/agent/agent-controls";
import { BusinessFigures } from "@/components/agent/business-figures";
import { Conversation } from "@/components/agent/conversation";
import { KairaOrb, ORB_STATUS } from "@/components/agent/kaira-orb";
import { useSession } from "@/components/providers";
import { Card, CardHeader, cn } from "@/components/ui/primitives";
import type { AgentContextValue, OrbState } from "@/lib/agent/protocol";

type PillTone = "on" | "off" | "warn" | "bad";

function StatusPill({ icon, label, value, tone, testId }: { icon: ReactNode; label: string; value: string; tone: PillTone; testId: string }) {
  return (
    <li
      className={cn(
        "flex items-center gap-2 rounded-full px-3 py-1.5 text-xs ring-1",
        tone === "on" && "bg-sage/20 text-cream ring-sage/50",
        tone === "off" && "bg-white/5 text-cream/70 ring-white/10",
        tone === "warn" && "bg-champagne/15 text-champagne ring-champagne/40",
        tone === "bad" && "bg-danger/25 text-cream ring-danger/60",
      )}
      data-testid={testId}
      data-tone={tone}
    >
      {icon}
      <span className="text-cream/60">{label}</span>
      <span className="font-semibold">{value}</span>
    </li>
  );
}

/** Microphone, connection and voice-service status in words (never inferred beyond what the engine reports). */
export function agentStatus(agent: Pick<AgentContextValue, "live" | "muted" | "voiceConfigured">, orb: OrbState, error: string | null) {
  const mic: [string, PillTone] =
    orb === "error" && !agent.live ? ["Off", error ? "bad" : "off"] : agent.live ? (agent.muted ? ["Muted", "warn"] : ["On", "on"]) : ["Off", "off"];
  const connection: [string, PillTone] =
    orb === "connecting"
      ? ["Connecting…", "warn"]
      : orb === "reconnecting"
        ? ["Reconnecting…", "warn"]
        : orb === "error"
          ? ["Error", "bad"]
          : agent.live
            ? ["Connected", "on"]
            : ["Not connected", "off"];
  const voice: [string, PillTone] =
    agent.voiceConfigured === true ? ["Ready", "on"] : agent.voiceConfigured === false ? ["Not configured", "bad"] : ["Checked on connect", "off"];
  return { mic, connection, voice };
}

export function AgentHome() {
  const { session } = useSession();
  const { agent, toggle, starting, error, fatal, orb } = useLiveSession();
  const status = ORB_STATUS[orb];
  const { mic, connection, voice } = agentStatus(agent, orb, error);
  const firstName = session?.user.name.split(" ")[0];

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(20rem,1fr)]">
      <div className="min-w-0 space-y-6">
        {/* Stage */}
        <section
          aria-labelledby="agent-title"
          className="relative overflow-hidden rounded-[1.75rem] bg-navy px-5 pt-6 pb-8 text-cream shadow-[0_30px_80px_-40px_rgb(13_27_42/0.8)] sm:px-10"
          data-testid="agent-stage"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_38%,rgb(65_90_119/0.55),transparent_55%),radial-gradient(circle_at_85%_100%,rgb(119_141_122/0.18),transparent_45%)]"
          />
          <div className="relative flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 id="agent-title" className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
                {firstName ? `Talk to KAIRA, ${firstName}` : "Talk to KAIRA"}
              </h1>
              <p className="mt-1 text-sm text-cream/70">Ask about your money, or tell KAIRA what happened. It works on your real books.</p>
            </div>
            <ul className="flex flex-wrap gap-2" aria-label="Voice status">
              <StatusPill testId="status-mic" icon={agent.live && !agent.muted ? <Mic className="size-3.5" aria-hidden="true" /> : <MicOff className="size-3.5" aria-hidden="true" />} label="Microphone" value={mic[0]} tone={mic[1]} />
              <StatusPill testId="status-connection" icon={<Radio className="size-3.5" aria-hidden="true" />} label="Connection" value={connection[0]} tone={connection[1]} />
              <StatusPill testId="status-voice" icon={<Server className="size-3.5" aria-hidden="true" />} label="Voice service" value={voice[0]} tone={voice[1]} />
            </ul>
          </div>

          <div className="relative mt-6 flex flex-col items-center text-center">
            <KairaOrb state={orb} micLevel={agent.micLevel} outputLevel={agent.outputLevel} size="hero" />
            <div role="status" aria-live="polite" className="mt-4" data-testid="agent-status">
              <p className="font-display text-2xl font-semibold" data-testid="agent-status-label">{status.label}</p>
              <p className="mt-1 text-sm text-cream/70">{status.hint}</p>
            </div>

            {/* Caption: the live partial transcript (never acted on) and the last reply. */}
            <div className="mt-5 w-full max-w-2xl space-y-3 text-left">
              {agent.partial && (
                <p className="rounded-2xl bg-white/5 px-4 py-3 text-base italic text-cream/90 ring-1 ring-white/10" data-testid="agent-partial">
                  <span className="mr-2 text-xs font-semibold not-italic uppercase tracking-wide text-cream/50">You</span>{" "}
                  {agent.partial}
                </p>
              )}
              {agent.lastReply && (
                <p className="rounded-2xl bg-cream/10 px-4 py-3 text-base leading-relaxed ring-1 ring-champagne/25" aria-live="polite" data-testid="agent-last-reply">
                  <span className="mr-2 text-xs font-semibold uppercase tracking-wide text-champagne">KAIRA</span>{" "}
                  {agent.lastReply}
                </p>
              )}
            </div>

            {error && (
              <div role="alert" className="mt-5 w-full max-w-2xl rounded-2xl bg-danger/25 px-4 py-3 text-left text-sm ring-1 ring-danger/60" data-testid="agent-error">
                <p className="font-semibold">{fatal ? "Live voice is unavailable" : "Voice problem"}</p>
                <p className="mt-0.5 text-cream/85">{error}</p>
                <p className="mt-1 text-cream/70">You can keep working by typing to KAIRA below.</p>
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <LiveToggle live={agent.live} starting={starting} onToggle={toggle} />
              <MuteToggle live={agent.live} muted={agent.muted} onChange={agent.setMuted} />
              <InterruptButton speaking={orb === "speaking"} onInterrupt={agent.interrupt} />
            </div>
            <p className="mt-3 text-xs text-cream/70" data-testid="agent-mic-notice">
              {agent.live
                ? agent.muted
                  ? "Live session on, microphone muted. KAIRA cannot hear you until you unmute."
                  : "Microphone is on. KAIRA listens on every page until you end the live session."
                : "The microphone is off. KAIRA only listens after you start the live session."}
            </p>
            {agent.metrics.response_ms !== undefined && (
              <p className="mt-1 text-[11px] text-cream/50">Last response in {(agent.metrics.response_ms / 1000).toFixed(1)} s</p>
            )}
          </div>
        </section>

        {/* Typed path (secondary) */}
        <Card aria-label="Type to KAIRA">
          <AgentTextForm />
          <p className="mt-2 text-xs text-muted">For when the microphone is unavailable. Typed messages join the same conversation.</p>
        </Card>

        <Card aria-labelledby="conversation-title">
          <CardHeader id="conversation-title" title="Recent conversation" />
          <Conversation transcript={agent.transcript} />
        </Card>
      </div>

      <aside className="min-w-0 space-y-6" aria-label="Activity and business figures">
        <Card aria-labelledby="activity-title">
          <CardHeader id="activity-title" title="Activity" subtitle="Each step KAIRA takes, with its result" />
          <ActivityFeed activity={agent.activity} orb={orb} />
        </Card>
        <Card aria-labelledby="figures-title">
          <CardHeader id="figures-title" title="Your business now" />
          <BusinessFigures />
        </Card>
      </aside>
    </div>
  );
}
