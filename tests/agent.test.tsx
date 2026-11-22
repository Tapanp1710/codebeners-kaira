/**
 * Voice-first agent UI: the KAIRA orb (state -> accessible label/status), the agent home, the agent dock, the
 * activity feed and the app shell's single agent interface. useAgent() is mocked (vi.mock of the provider module),
 * so these tests pin the UI's behaviour against the contract in lib/agent/protocol.ts, not a voice engine.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { ActivityFeed } from "@/components/agent/activity-feed";
import { AgentDock } from "@/components/agent/agent-dock";
import { AgentHome } from "@/components/agent/agent-home";
import { KairaOrb, ORB_STATUS } from "@/components/agent/kaira-orb";
import { AppShell } from "@/components/layout/app-shell";
import type { ActivityItem, AgentContextValue, OrbState } from "@/lib/agent/protocol";

import { envelope } from "./fixtures";
import { pathOf, renderApp } from "./render";

const mocks = vi.hoisted(() => ({ agent: null as AgentContextValue | null, pathname: "/agent" }));

vi.mock("@/components/agent/agent-provider", () => ({
  AgentProvider: ({ children }: { children: React.ReactNode }) => children,
  useAgent: () => {
    if (!mocks.agent) throw new Error("agent not set");
    return mocks.agent;
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function makeAgent(overrides: Partial<AgentContextValue> = {}): AgentContextValue {
  return {
    live: false,
    enable: vi.fn(async () => {}),
    disable: vi.fn(),
    muted: false,
    setMuted: vi.fn(),
    interrupt: vi.fn(),
    sendText: vi.fn(async () => {}),
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
    ...overrides,
  };
}

const dashboard = {
  as_of: "2026-11-22",
  cash: { current_cash: "123456.50", opening_cash_as_of: "2026-09-22" },
  receivables: { total_outstanding: "229500.00", total_overdue: "40000.00", open_invoice_count: 4, overdue_invoice_count: 1 },
};

const handler = (req: Request) => {
  const p = pathOf(req);
  if (p === "GET /dashboard") return envelope(dashboard);
  if (p === "GET /actions") return envelope({ items: [], total: 0, page: 1, page_size: 1 });
  if (p === "GET /insights") return envelope([]);
  return envelope({});
};

const ALL_STATES: OrbState[] = ["off", "connecting", "listening", "hearing", "thinking", "retrieving", "executing", "speaking", "muted", "reconnecting", "error"];

// jsdom has no canvas; the orb skips drawing when getContext() returns null.
let getContext: MockInstance<(...args: unknown[]) => unknown>;
beforeEach(() => {
  getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null) as unknown as MockInstance<(...args: unknown[]) => unknown>;
  mocks.agent = makeAgent();
  mocks.pathname = "/agent";
});
afterEach(() => {
  getContext.mockRestore();
  vi.unstubAllGlobals();
});

describe("KairaOrb", () => {
  it.each(ALL_STATES)("exposes the %s state as an image label and data-state", (state) => {
    render(<KairaOrb state={state} micLevel={0.4} outputLevel={0.2} size="hero" />);
    const orb = screen.getByRole("img");
    expect(orb).toHaveAccessibleName(`KAIRA: ${ORB_STATUS[state].label}`);
    expect(orb).toHaveAttribute("data-state", state);
    expect(orb).toHaveAttribute("data-size", "hero");
  });

  it("has a distinct visible label and hint for every state", () => {
    expect(new Set(ALL_STATES.map((s) => ORB_STATUS[s].label)).size).toBe(ALL_STATES.length);
    for (const s of ALL_STATES) expect(ORB_STATUS[s].hint.length).toBeGreaterThan(0);
  });

  function fakeContext() {
    const noop = () => {};
    return new Proxy({} as CanvasRenderingContext2D, { get: (_t, key) => (key === "clearRect" ? clearRect : noop), set: () => true });
  }
  const clearRect = vi.fn();

  it("animates with requestAnimationFrame when motion is allowed", () => {
    getContext.mockReturnValue(fakeContext());
    const raf = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    render(<KairaOrb state="speaking" micLevel={0} outputLevel={0.7} size="dock" />);
    expect(raf).toHaveBeenCalled();
  });

  it("draws one still frame and no animation loop when reduced motion is preferred", () => {
    clearRect.mockClear();
    getContext.mockReturnValue(fakeContext());
    const raf = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    render(<KairaOrb state="hearing" micLevel={0.9} outputLevel={0} size="hero" />);
    expect(raf).not.toHaveBeenCalled();
    expect(clearRect).toHaveBeenCalledTimes(1);
  });
});

describe("ActivityFeed", () => {
  const base = { turn_id: "t1", started_at: 1_000, kind: "read" as const, tool: "get_receivables", label: "Checking receivables" };
  const item = (o: Partial<ActivityItem>): ActivityItem => ({ ...base, id: `t1:${o.state}:${o.kind}`, state: "running", ...o });

  it.each<[Partial<ActivityItem>, string]>([
    [{ state: "running", kind: "read" }, "Retrieving"],
    [{ state: "running", kind: "write", tool: "record_payment", label: "Recording payment" }, "Executing"],
    [{ state: "completed", finished_at: 1_850, summary: "Customers owe ₹2,29,500.00" }, "Completed"],
    [{ state: "needs_clarification", summary: "Which Ramesh did you mean?" }, "Needs clarification"],
    [{ state: "needs_confirmation", kind: "write", summary: "Record ₹5,000 from Ramesh Kumar?" }, "Needs confirmation"],
    [{ state: "failed", summary: "Invoice not found" }, "Failed"],
  ])("shows %o as %s with its summary", (o, label) => {
    const it = item(o);
    render(<ActivityFeed activity={[it]} orb="listening" />);
    const row = screen.getByTestId("activity-item");
    expect(row).toHaveAttribute("data-state", it.state);
    expect(within(row).getByText(label)).toBeInTheDocument();
    expect(within(row).getByText(it.label)).toBeInTheDocument();
    if (it.summary) expect(within(row).getByTestId("activity-summary")).toHaveTextContent(it.summary);
    if (o.state === "needs_confirmation") expect(within(row).getByRole("link", { name: "Approvals" })).toHaveAttribute("href", "/actions");
  });

  it("shows Understanding while the orb is thinking, newest tool run first, and real result fields", () => {
    render(
      <ActivityFeed
        orb="thinking"
        activity={[
          item({ id: "a", state: "completed", label: "First", result: { total_outstanding: "229500.00", invoices: [1, 2] } }),
          item({ id: "b", state: "completed", label: "Second" }),
        ]}
      />,
    );
    const rows = screen.getAllByTestId("activity-item");
    expect(rows[0]).toHaveAttribute("data-phase", "understanding");
    expect(rows[0]).toHaveTextContent("Understanding");
    expect(rows[1]).toHaveTextContent("Second");
    expect(rows[2]).toHaveTextContent("First");
    expect(within(rows[2]).getByText("229500.00")).toBeInTheDocument();
    expect(within(rows[2]).getByText("2 items")).toBeInTheDocument();
  });

  it("says plainly when nothing has happened yet", () => {
    render(<ActivityFeed activity={[]} orb="off" />);
    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
  });
});

describe("AgentHome", () => {
  it("starts with the microphone off and only voice controls that apply enabled", async () => {
    renderApp(<AgentHome />, { handler });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Talk to KAIRA, Demo");
    expect(screen.getByTestId("agent-status")).toHaveTextContent("Live session off");
    expect(screen.getByRole("img", { name: "KAIRA: Live session off" })).toBeInTheDocument();
    expect(screen.getByTestId("agent-live-toggle")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("agent-live-toggle")).toHaveTextContent("Start live session");
    expect(screen.getByTestId("agent-mute")).toBeDisabled();
    expect(screen.getByTestId("agent-interrupt")).toBeDisabled();
    expect(screen.getByTestId("agent-mic-notice")).toHaveTextContent("The microphone is off");
    expect(screen.getByTestId("status-mic")).toHaveTextContent("Off");
    expect(screen.getByTestId("status-connection")).toHaveTextContent("Not connected");
    // Real figures from GET /dashboard, nothing else.
    const figures = await screen.findByTestId("agent-figures");
    expect(figures).toHaveTextContent("₹1,23,456.50");
    expect(figures).toHaveTextContent("₹2,29,500.00");
    expect(figures).toHaveTextContent("₹40,000.00");
  });

  it("shows a failed start as an error instead of pretending to listen", async () => {
    const enable = vi.fn(async () => {
      throw new Error("Live voice engine not installed in this build.");
    });
    mocks.agent = makeAgent({ enable });
    renderApp(<AgentHome />, { handler });
    await userEvent.click(screen.getByTestId("agent-live-toggle"));
    expect(enable).toHaveBeenCalledOnce();
    expect(await screen.findByTestId("agent-error")).toHaveTextContent("Live voice engine not installed in this build.");
    expect(screen.getByTestId("agent-status")).toHaveTextContent("Voice unavailable");
    expect(screen.getByRole("img", { name: "KAIRA: Voice unavailable" })).toHaveAttribute("data-state", "error");
    expect(screen.getByTestId("agent-live-toggle")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("status-mic")).toHaveTextContent("Off");
  });

  it("explains a blocked microphone", async () => {
    mocks.agent = makeAgent({
      enable: vi.fn(async () => {
        throw new DOMException("denied", "NotAllowedError");
      }),
    });
    renderApp(<AgentHome />, { handler });
    await userEvent.click(screen.getByTestId("agent-live-toggle"));
    expect(await screen.findByTestId("agent-error")).toHaveTextContent(/Microphone access was blocked/);
  });

  it("labels a live session clearly and wires mute, stop speaking and end", async () => {
    const agent = makeAgent({
      live: true,
      orb: "speaking",
      voiceConfigured: true,
      partial: "how much does ramesh",
      lastReply: "Ramesh owes you ₹18,000.00.",
      metrics: { response_ms: 1200 },
      transcript: [
        { id: "t1", role: "user", text: "How much does Ramesh owe?", language: "en-IN", at: "2026-11-22T10:00:00Z", mode: "voice" },
        { id: "t1", role: "assistant", text: "Ramesh owes you ₹18,000.00.", language: "en-IN", at: "2026-11-22T10:00:02Z" },
      ],
    });
    mocks.agent = agent;
    renderApp(<AgentHome />, { handler });
    expect(screen.getByTestId("agent-status")).toHaveTextContent("Speaking");
    expect(screen.getByTestId("agent-live-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("agent-live-toggle")).toHaveTextContent("End live session");
    expect(screen.getByTestId("agent-mic-notice")).toHaveTextContent("Microphone is on");
    expect(screen.getByTestId("status-mic")).toHaveTextContent("On");
    expect(screen.getByTestId("status-connection")).toHaveTextContent("Connected");
    expect(screen.getByTestId("status-voice")).toHaveTextContent("Ready");
    expect(screen.getByTestId("agent-partial")).toHaveTextContent("how much does ramesh");
    expect(screen.getByTestId("agent-last-reply")).toHaveTextContent("Ramesh owes you ₹18,000.00.");
    expect(screen.getByText("Last response in 1.2 s")).toBeInTheDocument();
    const entries = screen.getAllByTestId("transcript-entry");
    expect(entries.map((e) => e.getAttribute("data-role"))).toEqual(["user", "assistant"]);

    await userEvent.click(screen.getByTestId("agent-interrupt"));
    expect(agent.interrupt).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByTestId("agent-mute"));
    expect(agent.setMuted).toHaveBeenCalledWith(true);
    await userEvent.click(screen.getByTestId("agent-live-toggle"));
    expect(agent.disable).toHaveBeenCalledOnce();
    expect(agent.enable).not.toHaveBeenCalled();
  });

  it("shows engine errors and a muted microphone", () => {
    mocks.agent = makeAgent({ live: true, muted: true, orb: "muted", error: { code: "stt_unavailable", message: "Speech recognition is unavailable.", fatal: false } });
    renderApp(<AgentHome />, { handler });
    expect(screen.getByTestId("agent-error")).toHaveTextContent("Speech recognition is unavailable.");
    expect(screen.getByTestId("status-mic")).toHaveTextContent("Muted");
    expect(screen.getByTestId("agent-mute")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("agent-mic-notice")).toHaveTextContent("microphone muted");
  });

  it("sends typed text through sendText() and keeps it if sending fails", async () => {
    const sendText = vi.fn(async () => {});
    mocks.agent = makeAgent({ sendText });
    renderApp(<AgentHome />, { handler });
    const input = screen.getByTestId("agent-text-input");
    expect(screen.getByTestId("agent-text-submit")).toBeDisabled();
    await userEvent.type(input, "How much do my customers owe me?");
    await userEvent.click(screen.getByTestId("agent-text-submit"));
    expect(sendText).toHaveBeenCalledWith("How much do my customers owe me?");
    expect(input).toHaveValue("");

    sendText.mockRejectedValueOnce(new Error("Live voice engine not installed in this build."));
    await userEvent.type(input, "Ramesh paid 5000");
    await userEvent.click(screen.getByTestId("agent-text-submit"));
    expect(await screen.findByTestId("agent-text-error")).toHaveTextContent("Not sent: Live voice engine not installed in this build.");
    expect(input).toHaveValue("Ramesh paid 5000");
  });
});

describe("AgentDock", () => {
  it("offers the same session compactly: state, caption, live switch and typed input", async () => {
    const agent = makeAgent({ live: true, orb: "listening", lastReply: "Done. I recorded ₹5,000.00 from Ramesh Kumar." });
    mocks.agent = agent;
    renderApp(<AgentDock />, { handler });
    const dock = screen.getByTestId("agent-dock");
    expect(within(dock).getByRole("img", { name: "KAIRA: Listening" })).toHaveAttribute("data-size", "dock");
    expect(screen.getByTestId("dock-status")).toHaveTextContent("Listening");
    expect(screen.getByTestId("dock-caption")).toHaveTextContent("KAIRA: Done. I recorded ₹5,000.00 from Ramesh Kumar.");
    expect(screen.getByTestId("dock-live-toggle")).toHaveAccessibleName("End live session (microphone is on)");
    expect(within(dock).getByRole("link", { name: "Open KAIRA" })).toHaveAttribute("href", "/agent");

    await userEvent.type(screen.getByTestId("dock-text-input"), "Show overdue invoices");
    await userEvent.click(screen.getByTestId("dock-text-submit"));
    expect(agent.sendText).toHaveBeenCalledWith("Show overdue invoices");

    const more = screen.getByRole("button", { name: "Show more" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(more);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  });

  it("prefers the live caption and reports a failed start", async () => {
    mocks.agent = makeAgent({
      partial: "ramesh paid",
      enable: vi.fn(async () => {
        throw new Error("Live voice engine not installed in this build.");
      }),
    });
    renderApp(<AgentDock />, { handler });
    expect(screen.getByTestId("dock-caption")).toHaveTextContent("You: ramesh paid");
    await userEvent.click(screen.getByTestId("dock-live-toggle"));
    expect(await screen.findByTestId("dock-error")).toHaveTextContent("Live voice engine not installed in this build.");
    expect(screen.getByTestId("dock-status")).toHaveTextContent("Voice unavailable");
  });
});

describe("AppShell", () => {
  it("shows the dock on module pages and no other assistant launcher", async () => {
    mocks.pathname = "/customers";
    renderApp(<AppShell><h1>Customers</h1></AppShell>, { handler });
    expect(screen.getByTestId("agent-dock")).toBeInTheDocument();
    expect(screen.queryByTestId("assistant-launcher")).not.toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const links = within(nav).getAllByRole("link");
    expect(links[0]).toHaveTextContent("KAIRA");
    expect(links[0]).toHaveAttribute("href", "/agent");
    expect(within(nav).getByRole("link", { name: "Customers & Invoices" })).toHaveAttribute("aria-current", "page");
  });

  it("hides the dock on the agent home, which is the full agent interface", () => {
    mocks.pathname = "/agent";
    renderApp(<AppShell><h1>KAIRA</h1></AppShell>, { handler });
    expect(screen.queryByTestId("agent-dock")).not.toBeInTheDocument();
  });
});
