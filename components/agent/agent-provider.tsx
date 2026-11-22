"use client";

/**
 * PLACEHOLDER provider (interface only). The voice-engine workstream replaces this file with the real
 * implementation (microphone, WebSocket, playback). It exists so the app shell can be built against the
 * contract in lib/agent/protocol.ts. It never pretends to listen: enable() reports an error.
 */
import { createContext, useContext, useMemo } from "react";

import type { AgentContextValue } from "@/lib/agent/protocol";

const AgentContext = createContext<AgentContextValue | null>(null);

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const value = useMemo<AgentContextValue>(
    () => ({
      live: false,
      enable: async () => {
        throw new Error("Live voice engine not installed in this build.");
      },
      disable: () => {},
      muted: false,
      setMuted: () => {},
      interrupt: () => {},
      sendText: async () => {
        throw new Error("Live voice engine not installed in this build.");
      },
      orb: "off",
      micLevel: 0,
      outputLevel: 0,
      partial: "",
      transcript: [],
      activity: [],
      lastReply: null,
      metrics: {},
      error: null,
      voiceConfigured: null,
    }),
    [],
  );
  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgent() must be used inside <AgentProvider>.");
  return ctx;
}
