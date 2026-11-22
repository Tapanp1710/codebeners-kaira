/**
 * components/agent/agent-provider.tsx with a real AgentEngine on fake devices (mic, AudioContext, WebSocket, tab lock,
 * network): useAgentLevels() re-renders only its own consumer ~20x/s while useAgent() consumers stay still,
 * liveElsewhere reaches useAgent(), and unmount releases the microphone, socket and tab lock.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentProvider, useAgent, useAgentLevels } from "@/components/agent/agent-provider";
import { AgentEngine, type EngineDeps } from "@/lib/agent/engine";
import type { MicCapture } from "@/lib/agent/mic";

import { FakeAudioContext, FakeMic, FakeNetwork, FakeSocket, FakeTabLock, ticket } from "./agent-engine-fakes";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/agent",
  useSearchParams: () => new URLSearchParams(),
}));

let mic: FakeMic;
let lock: FakeTabLock;
let network: FakeNetwork;

function makeEngine() {
  mic = new FakeMic();
  lock = new FakeTabLock();
  network = new FakeNetwork();
  const deps: EngineDeps = {
    startSession: vi.fn(async () => ticket()),
    postTurn: vi.fn(),
    getConversation: vi.fn(async () => []),
    readVoiceReady: vi.fn(async () => true),
    createSocket: (url) => new FakeSocket(url),
    createAudioContext: () => new FakeAudioContext() as unknown as AudioContext,
    createMic: () => mic as unknown as MicCapture,
    storage: () => window.sessionStorage,
    origin: () => "http://localhost:3000",
    createTabLock: () => lock,
    network,
  };
  return new AgentEngine(deps);
}

const renders = { agent: 0, levels: 0 };

function AgentConsumer() {
  const agent = useAgent();
  return (
    <p data-testid="agent">
      {agent.orb}|{agent.liveElsewhere ? "elsewhere" : "here"}
    </p>
  );
}

function LevelsConsumer() {
  const levels = useAgentLevels();
  return <p data-testid="levels">{levels.mic > 0 ? "moving" : "still"}</p>;
}

function mount(engine: AgentEngine) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <AgentProvider engine={engine}>
        <Profiler id="agent" onRender={() => renders.agent++}>
          <AgentConsumer />
        </Profiler>
        <Profiler id="levels" onRender={() => renders.levels++}>
          <LevelsConsumer />
        </Profiler>
      </AgentProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  FakeSocket.instances = [];
  renders.agent = 0;
  renders.levels = 0;
  window.sessionStorage.clear();
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", class {});
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: vi.fn() }, configurable: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("AgentProvider", () => {
  it("levels re-render only the useAgentLevels() consumer; unmount releases everything", async () => {
    const engine = makeEngine();
    const view = mount(engine);
    await act(async () => {
      await engine.enable();
    });
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    act(() => FakeSocket.instances[0].serverOpen());
    expect(screen.getByTestId("agent").textContent).toBe("listening|here");
    // Quiet speech-free signal (below the client VAD threshold) so only the levels change.
    for (let i = 0; i < 4; i++) act(() => mic.frame(500, 0.01));
    const agentBefore = renders.agent;
    const levelsBefore = renders.levels;
    for (let i = 0; i < 8; i++) {
      act(() => mic.frame(500, 0.01));
      await act(() => new Promise((r) => setTimeout(r, 60)));
    }
    expect(screen.getByTestId("levels").textContent).toBe("moving");
    expect(renders.levels - levelsBefore).toBeGreaterThanOrEqual(1);
    expect(renders.agent - agentBefore).toBe(0);
    // The deprecated fields are held at 0 while a levels consumer exists.
    expect(engine.getSnapshot().micLevel).toBe(0);

    view.unmount();
    expect(mic.stopped).toBe(true);
    expect(FakeSocket.instances[0].closedWith).toBe(1000);
    expect(lock.held).toBe(false);
    expect(lock.disposed).toBe(true);
    expect(network.subscribers).toBe(0);
  });

  it("shows liveElsewhere when another tab holds the live session", async () => {
    const engine = makeEngine();
    lock.available = false;
    mount(engine);
    expect(screen.getByTestId("agent").textContent).toBe("off|elsewhere");
    act(() => lock.setElsewhere(false));
    expect(screen.getByTestId("agent").textContent).toBe("off|here");
  });

  it("useAgentLevels() outside the provider returns zeros", () => {
    render(<LevelsConsumer />);
    expect(screen.getByTestId("levels").textContent).toBe("still");
  });
});
