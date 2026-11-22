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
 *
 * Levels: the 0..1 mic/output levels change ~20x/s while live. useAgentLevels() reads them from a separate context
 * backed by the engine's own levels store, so only the component that animates them (the orb) re-renders. While any
 * mounted component uses useAgentLevels(), the levels are no longer copied into useAgent() (its deprecated
 * micLevel/outputLevel stay 0), so nothing else re-renders on them; with no such component they behave as before.
 *
 * Cross-tab: only one tab may hold the live microphone session; `liveElsewhere` is true in the other tabs.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { AgentEngine, ZERO_LEVELS } from "@/lib/agent/engine";
import type { AgentContextValue, AgentLevels } from "@/lib/agent/protocol";
import { deriveOrb, initialAgentState, type AgentIntent } from "@/lib/agent/reducer";
import { invalidateFinancial } from "@/lib/api/hooks";

const AgentContext = createContext<AgentContextValue | null>(null);
/** The engine itself (a stable value: this context never re-renders its consumers). */
const AgentLevelsContext = createContext<AgentEngine | null>(null);

const getServerSnapshot = () => initialAgentState;
const getServerLevels = () => ZERO_LEVELS;
const noopSubscribe = () => () => {};

export function AgentProvider({ children, engine: injected }: { children: React.ReactNode; engine?: AgentEngine }) {
  // One engine per mounted provider (survives navigation inside the layout; never shared between trees).
  // `engine` is for tests (fake devices); the app never passes it.
  const [engine] = useState(() => injected ?? new AgentEngine());
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
      liveElsewhere: state.liveElsewhere,
    }),
    [engine, state],
  );
  return (
    <AgentLevelsContext.Provider value={engine}>
      <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
    </AgentLevelsContext.Provider>
  );
}

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgent() must be used inside <AgentProvider>.");
  return ctx;
}

/**
 * The orb's 0..1 microphone and playback levels (~20 updates/s while live). Only the calling component re-renders
 * on them. Outside <AgentProvider> (tests, static previews) it returns zeros instead of throwing.
 */
export function useAgentLevels(): AgentLevels {
  const engine = useContext(AgentLevelsContext);
  return useSyncExternalStore(engine ? engine.subscribeLevels : noopSubscribe, engine ? engine.getLevels : getServerLevels, getServerLevels);
}
