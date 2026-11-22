/**
 * Shared Playwright helpers. Credentials come only from E2E_EMAIL / E2E_PASSWORD (never committed);
 * use an owner account on a non-production backend, because the tests create real records.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

export const EMAIL = process.env.E2E_EMAIL ?? "";
export const PASSWORD = process.env.E2E_PASSWORD ?? "";

/**
 * Tests that need KAIRA's live LLM (the typed agent path, POST /agent/turn backed by Sarvam) run only when
 * E2E_LIVE_AGENT=1: CI has no SARVAM_API_KEY, and without it the agent cannot plan tool calls. Call inside a test
 * (or at file / describe level) to skip with an explicit reason instead of failing.
 */
export const LIVE_AGENT = process.env.E2E_LIVE_AGENT === "1";
export function requireLiveAgent() {
  test.skip(!LIVE_AGENT, "Needs the live agent LLM (backend with SARVAM_API_KEY); set E2E_LIVE_AGENT=1.");
}

/** Fails early with a clear message instead of later on the login form. */
export function requireCredentials() {
  if (!EMAIL || !PASSWORD) throw new Error("Set E2E_EMAIL and E2E_PASSWORD (owner on a non-production backend).");
}

/**
 * Logs in through the real UI, so the backend's HttpOnly cookies are set via the proxy, then waits for the target
 * page. The default target is the KAIRA agent home, the app's landing page after sign-in.
 */
export async function login(page: Page, next = "/agent") {
  requireCredentials();
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Compare the pathname only; 60 s allows for a cold production server and backend.
  await page.waitForURL((u) => u.pathname === next.split("?")[0], { timeout: 60_000 });
  await expect(page.locator("main h1").first()).toBeVisible();
}

/** Random letters only: names must be unique so the rules extractor resolves exactly one customer. */
export function uniqueName(): string {
  const word = (n: number) =>
    Array.from({ length: n }, (_, i) => String.fromCharCode((i === 0 ? 65 : 97) + Math.floor(Math.random() * 26))).join("");
  return `${word(7)} ${word(6)}`;
}

/** Calls the API through the same proxy and cookies the browser uses (read-only helpers). */
export async function apiGet<T>(request: APIRequestContext, path: string): Promise<T> {
  const res = await request.get(`/api/backend/api/v1${path}`);
  expect(res.ok(), `GET ${path} -> ${res.status()}`).toBeTruthy();
  const body = await res.json();
  // The envelope must report success; only the data payload is returned.
  expect(body.success).toBe(true);
  return body.data as T;
}

/** Fill a labelled input inside the open dialog / form. */
export async function fillLabel(page: Page, label: string, value: string, nth = 0) {
  const field = page.getByLabel(label, { exact: true }).nth(nth);
  await field.fill(value);
}

/** The CSRF token of the browser's current session (GET /auth/me), for the few direct API writes tests make. */
export async function csrfToken(request: APIRequestContext): Promise<string> {
  const me = await apiGet<{ csrf_token: string }>(request, "/auth/me");
  return me.csrf_token;
}

/**
 * Sends a typed message to KAIRA (the typed path of the voice agent) and waits until the turn has settled: the
 * message appears in the conversation, the last entry is KAIRA's reply, and no tool run is still in progress.
 * `via: "home"` uses the agent home (/agent, navigating there through the primary nav when needed, so the live
 * session is not reloaded); `via: "dock"` uses the agent dock on the current page. Returns KAIRA's reply text.
 */
export async function askKaira(page: Page, text: string, via: "home" | "dock" = "home"): Promise<string> {
  if (via === "home" && new URL(page.url()).pathname !== "/agent") {
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "KAIRA", exact: true }).first().click();
    await page.waitForURL((u) => u.pathname === "/agent");
  }
  if (via === "dock") {
    const lastReply = page.getByTestId("dock-caption");
    const before = (await lastReply.textContent()) ?? "";
    await page.getByTestId("dock-text-input").fill(text);
    await page.getByTestId("dock-text-submit").click();
    await expect(page.getByTestId("dock-text-input")).toHaveValue("", { timeout: 60_000 });
    await expect(lastReply).not.toHaveText(before, { timeout: 90_000 });
    await expect(lastReply).toContainText("KAIRA:", { timeout: 90_000 });
    return ((await lastReply.textContent()) ?? "").replace(/^KAIRA:\s*/, "");
  }
  const mine = page.getByTestId("transcript-entry").and(page.locator('[data-role="user"]')).filter({ hasText: text });
  const before = await mine.count();
  await page.getByTestId("agent-text-input").fill(text);
  await page.getByTestId("agent-text-submit").click();
  // The input clears once sendText() resolves; a failure keeps the text and shows agent-text-error instead.
  await expect(page.getByTestId("agent-text-input")).toHaveValue("", { timeout: 90_000 });
  await expect(mine).toHaveCount(before + 1, { timeout: 60_000 });
  const last = page.getByTestId("transcript-entry").last();
  await expect(last).toHaveAttribute("data-role", "assistant", { timeout: 90_000 });
  await expect(page.locator('[data-testid="activity-item"][data-state="running"]')).toHaveCount(0, { timeout: 60_000 });
  return (await last.textContent()) ?? "";
}

/**
 * Settles the write tool runs of KAIRA's latest turn (on the agent home). The server's autonomy policy decides:
 * an owner's fully evidenced request is executed at once ("completed"); otherwise it is stored as a proposal
 * ("needs_confirmation"), which this helper approves in the app through the Approvals page's proposal card
 * (`proposalText` picks the card). Returns which path was taken. Fails on clarification or failure states.
 */
export async function settleLatestWrite(page: Page, proposalText: string): Promise<"executed" | "approved"> {
  const newest = page.getByTestId("activity-item").first();
  const turn = await newest.getAttribute("data-turn");
  expect(turn, "KAIRA ran no tool for this request").toBeTruthy();
  const writes = page.locator(`[data-testid="activity-item"][data-kind="write"][data-turn="${turn}"]`);
  expect(await writes.count(), "KAIRA made no change for this request").toBeGreaterThan(0);
  const states = await writes.evaluateAll((els) => els.map((e) => e.getAttribute("data-state")));
  expect(states.every((s) => s === "completed" || s === "needs_confirmation"), `write states: ${states.join(", ")}`).toBe(true);
  if (!states.includes("needs_confirmation")) return "executed";

  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: /Approvals/ }).first().click();
  await page.waitForURL((u) => u.pathname === "/actions");
  const card = page.getByTestId("proposal-card").filter({ hasText: proposalText }).first();
  await expect(card).toHaveAttribute("data-status", "pending");
  const result = await decideProposal(page, card, "approve");
  expect(result.status, "approved proposal did not execute").toBe("executed");
  return "approved";
}

/**
 * Clicks Approve or Reject on a pending proposal card on /actions and verifies the outcome in the UI.
 *
 * The decision is read from the backend's own response (POST /actions/{id}/approve|reject), not from the card on
 * the "Awaiting approval" tab: on success the page refetches the pending list (the mutation awaits that
 * invalidation before the card applies the response), so the decided proposal leaves that tab and its card
 * unmounts before it can show the executed / rejected state. The final state is therefore checked on the
 * "Approved" / "Rejected" tab, where the card is rendered from a fresh GET /actions. Returns the action id and
 * the status the backend reported.
 */
export async function decideProposal(page: Page, card: Locator, decision: "approve" | "reject"): Promise<{ id: string; status: string }> {
  const transcript = ((await card.getByTestId("proposal-transcript").textContent()) ?? "").trim();
  const responded = page.waitForResponse(
    (r) => r.request().method() === "POST" && new RegExp(`/api/v1/actions/[0-9a-f-]{36}/${decision}$`).test(r.url()),
  );
  await card.getByRole("button", { name: decision === "approve" ? /approve/i : /reject/i }).click();
  const res = await responded;
  expect(res.ok(), `POST /actions/{id}/${decision} -> ${res.status()}`).toBeTruthy();
  const body = await res.json();
  const id = body.data.action.id as string;
  const status = body.data.action.status as string;
  // The decided proposal is no longer pending, so it must leave the "Awaiting approval" list.
  await expect(page.getByTestId("proposal-card").filter({ hasText: transcript })).toHaveCount(0);
  await page.getByRole("tab", { name: decision === "approve" ? "Approved" : "Rejected" }).click();
  const decided = page.getByTestId("proposal-card").filter({ hasText: transcript }).first();
  if (decision === "reject") {
    await expect(decided).toHaveAttribute("data-status", "rejected");
    await expect(decided.getByTestId("proposal-rejected")).toContainText("No records were changed");
  } else if (status === "executed") {
    await expect(decided).toHaveAttribute("data-status", "executed");
  }
  return { id, status };
}
