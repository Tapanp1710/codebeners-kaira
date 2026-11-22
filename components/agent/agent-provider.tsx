"use client";

/**
 * KAIRA live voice agent provider: exposes the voice engine (lib/agent/engine.ts) through useAgent() using the
 * contract in lib/agent/protocol.ts (AgentContextValue).
 *
 * Mount it once inside the authenticated (app) layout, below the TanStack QueryClientProvider (it invalidates
 * queries after agent writes) so the live session survives client-side navigation. Nothing touches the
 * microphone until enable() is called from a user gesture; after a full reload `resumeAvailable` is true instead.
 * Errors (microphone blocked, no device, insecure context, fatal server errors, failed typed turns) are reported in
 * `error`; enable() and sendText() never reject.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { AgentEngine } from "@/lib/agent/engine";
import type { AgentContextValue } from "@/lib/agent/protocol";
import { deriveOrb, initialAgentState, type AgentIntent } from "@/lib/agent/reducer";
import { invalidateFinancial } from "@/lib/api/hooks";

const AgentContext = createContext<AgentContextValue | null>(null);

const getServerSnapshot = () => initialAgentState;

export function AgentProvider({ children }: { children: React.ReactNode }) {
  // One engine per mounted provider (survives navigation inside the layout; never shared between trees).
  const [engine] = useState(() => new AgentEngine());
  const state = useSyncExternalStore(engine.subscribe, engine.getSnapshot, getServerSnapshot);
  const queryClient = useQueryClient();
  const router = useRouter();

  useEffect(() => {
    engine.setIntentHandler((intent: AgentIntent) => {
      if (intent.kind === "navigate") router.push(intent.path);
      else if (intent.scope === "financial") void invalidateFinancial(queryClient);
      else {
        void queryClient.invalidateQueries({ queryKey: ["customers"] });
        void queryClient.invalidateQueries({ queryKey: ["customer"] });
      }
    });
    return () => engine.setIntentHandler(null);
  }, [engine, queryClient, router]);

  useEffect(() => {
    engine.attach();
    return () => engine.detach();
  }, [engine]);

  const value = useMemo<AgentContextValue>(
    () => ({
      live: state.live,
      enable: engine.enable,
      disable: engine.disable,
      muted: state.muted,
      setMuted: engine.setMuted,
      interrupt: engine.interrupt,
      sendText: engine.sendText,
      orb: deriveOrb(state),
      micLevel: state.micLevel,
      outputLevel: state.outputLevel,
      partial: state.partial,
      transcript: state.transcript,
      activity: state.activity,
      lastReply: state.lastReply,
      metrics: state.metrics,
      error: state.error,
      voiceConfigured: state.voiceConfigured,
      resumeAvailable: state.resumeAvailable,
    }),
    [engine, state],
  );
  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgent() must be used inside <AgentProvider>.");
  return ctx;
}
