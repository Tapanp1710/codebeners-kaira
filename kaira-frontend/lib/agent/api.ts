/**
 * REST calls of the live agent (contracts/VOICE_AGENT.md), through the typed client in lib/api/client.ts
 * (same-origin proxy, cookie session, X-CSRF-Token, refresh-and-retry) plus validation of the loosely typed parts
 * of the responses (event lists, conversation rows).
 */
import { api, unwrap } from "@/lib/api/client";

import type { AgentSessionTicket, AgentTurnResponse, ConversationMessage, ServerEvent } from "./protocol";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Minimal structural check for a server event: an object with a string `type`. Field-level shapes follow the
 * contract; the reducer ignores event types it does not know.
 */
export function asServerEvent(value: unknown): ServerEvent | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  return value as unknown as ServerEvent;
}

/** Parses one JSON WebSocket text frame. Returns null for anything that is not a server event. */
export function parseServerFrame(data: string): ServerEvent | null {
  try {
    return asServerEvent(JSON.parse(data));
  } catch {
    return null;
  }
}

/** POST /agent/session -> WebSocket ticket. */
export function startAgentSession(resumeSessionId: string | null): Promise<AgentSessionTicket> {
  return unwrap(api.POST("/api/v1/agent/session", { body: { resume_session_id: resumeSessionId } }));
}

/** POST /agent/turn: one typed turn over REST (used when the live socket is not open). */
export async function postAgentTurn(text: string, turnId: string, language?: string | null): Promise<AgentTurnResponse> {
  const out = await unwrap(api.POST("/api/v1/agent/turn", { body: { text, turn_id: turnId, language: language ?? null } }));
  const events = (Array.isArray(out.events) ? out.events : []).map(asServerEvent).filter((e): e is ServerEvent => e !== null);
  return { ...out, events };
}

/** GET /agent/conversation: stored history, oldest first. Rows that do not match the contract are skipped. */
export async function getAgentConversation(): Promise<ConversationMessage[]> {
  const rows: unknown = await unwrap(api.GET("/api/v1/agent/conversation"));
  if (!Array.isArray(rows)) return [];
  const out: ConversationMessage[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const { turn_id, role, text, language, at, facts } = row;
    if (typeof turn_id !== "string" || (role !== "user" && role !== "assistant") || typeof text !== "string") continue;
    out.push({
      turn_id,
      role,
      text,
      language: typeof language === "string" ? language : null,
      at: typeof at === "string" ? at : new Date(0).toISOString(),
      facts: Array.isArray(facts) ? facts.filter(isRecord) : null,
    });
  }
  return out;
}

/** GET /ready -> checks.voice_provider ("configured" | "not_configured"); null when unknown. Public endpoint. */
export async function readVoiceProviderReady(): Promise<boolean | null> {
  try {
    const res = await fetch("/api/backend/api/v1/ready", { cache: "no-store" });
    const body: unknown = await res.json().catch(() => null);
    const payload = isRecord(body) ? (isRecord(body.data) ? body.data : isRecord(body.error) && isRecord(body.error.details) ? body.error.details : null) : null;
    const checks = payload && isRecord(payload.checks) ? payload.checks : null;
    const value = checks?.voice_provider;
    return value === "configured" ? true : value === "not_configured" ? false : null;
  } catch {
    return null;
  }
}

/** Client turn id: 32 hex chars (crypto.randomUUID without dashes), matching [A-Za-z0-9_.:-]{1,64}. */
export function newTurnId(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID().replace(/-/g, "");
  if (c && typeof c.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`.slice(0, 64);
}

/** Builds the WebSocket URL: ws_url (absolute, or relative to this origin; http(s) mapped to ws(s)) + ?ticket=. */
export function buildSocketUrl(wsUrl: string, ticket: string, origin: string): string {
  const url = new URL(wsUrl, origin);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}
