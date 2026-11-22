"use client";

/**
 * The one place the KAIRA orb reads its 0..1 audio levels from (microphone while listening/hearing, KAIRA's voice
 * while speaking). Only <LiveKairaOrb> calls it, so the levels source can be switched in a single line, e.g. to a
 * dedicated levels hook from the voice engine that updates without re-rendering the rest of the page. Until then
 * the levels come from the shared agent context.
 */
import { useAgent } from "@/components/agent/agent-provider";

export type OrbLevels = { micLevel: number; outputLevel: number };

export function useOrbLevels(): OrbLevels {
  const { micLevel, outputLevel } = useAgent();
  return { micLevel, outputLevel };
}
