/**
 * KAIRA agent home: the default screen after sign-in and for `/`. A thin Server Component that only sets the
 * page title; the screen is the client AgentHome, which drives the one live session from the (app) layout's
 * <AgentProvider> through useAgent(). Auth is already enforced by the (app) layout.
 */
import type { Metadata } from "next";

import { AgentHome } from "@/components/agent/agent-home";

export const metadata: Metadata = { title: "KAIRA" };

export default function AgentPage() {
  return <AgentHome />;
}
