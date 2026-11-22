/**
 * "Try KAIRA Demo" on the sign-in page: the shown credentials are the configured evaluator account, Copy puts
 * each value on the clipboard, and "Login as Demo" fills the form and goes through the normal POST /auth/login.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LoginForm } from "@/components/auth/login-form";
import { setTransport } from "@/lib/api/client";
import { DEMO_ACCOUNT } from "@/lib/demo-account";

import { ownerSession } from "./fixtures";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Try KAIRA Demo", () => {
  const assign = vi.fn();
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.stubGlobal("location", { ...window.location, assign, replace: vi.fn() });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    assign.mockReset();
    writeText.mockClear();
  });

  it("is configured with a real account, not a placeholder", () => {
    expect(DEMO_ACCOUNT).not.toBeNull();
    expect(DEMO_ACCOUNT!.email).toMatch(/^[^@\s]+@[^@\s]+$/);
    expect(DEMO_ACCOUNT!.password.length).toBeGreaterThanOrEqual(10);
    expect(DEMO_ACCOUNT!.password.toLowerCase()).not.toMatch(/placeholder|changeme|xxx|password/);
  });

  it("shows the credentials with the evaluation note and copies each one", async () => {
    render(<LoginForm />);
    expect(screen.getByRole("heading", { name: "Try KAIRA Demo" })).toBeInTheDocument();
    expect(screen.getByText(/Demo account provided for hackathon evaluation/)).toBeInTheDocument();
    expect(screen.getByTestId("demo-email")).toHaveTextContent(DEMO_ACCOUNT!.email);
    expect(screen.getByTestId("demo-password")).toHaveTextContent(DEMO_ACCOUNT!.password);

    fireEvent.click(screen.getByRole("button", { name: "Copy demo username" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(DEMO_ACCOUNT!.email));
    fireEvent.click(screen.getByRole("button", { name: "Copy demo password" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(DEMO_ACCOUNT!.password));
    expect(await screen.findByRole("status")).toHaveTextContent("Password copied");
  });

  it("Login as Demo fills the form and signs in through POST /auth/login", async () => {
    const bodies: unknown[] = [];
    setTransport(async (req) => {
      if (req.url.endsWith("/auth/login")) {
        bodies.push(await req.json());
        return json(200, { success: true, data: ownerSession, error: null });
      }
      return json(404, { success: false, data: null, error: { code: "NOT_FOUND", message: "not mocked" } });
    });
    render(<LoginForm />);
    fireEvent.click(screen.getByRole("button", { name: "Login as Demo" }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/agent"));
    expect(bodies).toEqual([{ email: DEMO_ACCOUNT!.email, password: DEMO_ACCOUNT!.password }]);
    expect(screen.getByLabelText("Email")).toHaveValue(DEMO_ACCOUNT!.email);
    expect(screen.getByLabelText("Password")).toHaveValue(DEMO_ACCOUNT!.password);
  });

  it("shows the backend's error if the demo sign-in is refused", async () => {
    setTransport(async () =>
      json(401, { success: false, data: null, error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." } }),
    );
    render(<LoginForm />);
    fireEvent.click(screen.getByRole("button", { name: "Login as Demo" }));
    expect(await screen.findByText(/Invalid email or password/)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });
});
