"use client";

/**
 * The one place the KAIRA orb reads its 0..1 audio levels from (microphone while listening/hearing, KAIRA's voice
 * while speaking). Only <LiveKairaOrb> calls it. The levels come from the voice engine's dedicated levels store
 * (useAgentLevels), which updates ~20 times a second without re-rendering the rest of the page.
 */
import { useAgentLevels } from "@/components/agent/agent-provider";

export type OrbLevels = { micLevel: number; outputLevel: number };

export function useOrbLevels(): OrbLevels {
  const { mic, output } = useAgentLevels();
  return { micLevel: mic, outputLevel: output };
}
