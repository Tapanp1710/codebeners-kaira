/**
 * Shared Playwright helpers. Credentials come only from E2E_EMAIL / E2E_PASSWORD (never committed);
 * use an owner account on a non-production backend, because the tests create real records.
 */
import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const EMAIL = process.env.E2E_EMAIL ?? "";
export const PASSWORD = process.env.E2E_PASSWORD ?? "";

/** Fails early with a clear message instead of later on the login form. */
export function requireCredentials() {
  if (!EMAIL || !PASSWORD) throw new Error("Set E2E_EMAIL and E2E_PASSWORD (owner on a non-production backend).");
}

/** Logs in through the real UI, so the backend's HttpOnly cookies are set via the proxy, then waits for the target page. */
export async function login(page: Page, next = "/dashboard") {
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
