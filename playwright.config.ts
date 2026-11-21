import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the REAL backend (BACKEND_ORIGIN) through the production build.
 * Required env: E2E_EMAIL, E2E_PASSWORD (an owner account on a NON-production backend).
 * The suite creates its own uniquely named customers so it can run repeatedly.
 */
// Port 3100 by default so the suite never collides with a dev server on 3000.
const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Tests share one backend and owner account and write real data, so they run one at a time and failures are not retried.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // Traces and screenshots are kept only for failing tests.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Microphone permission plus Chromium's fake media stream: recording works headless, with no permission prompt.
        permissions: ["microphone"],
        launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
      },
    },
  ],
  // Playwright starts the production server itself (requires a prior `npm run build`) and waits for /login.
  webServer: {
    command: `npx next start --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/login`,
    // Always a fresh server, never an already-running (possibly dev or stale) one.
    reuseExistingServer: false,
    timeout: 120_000,
    // Server-side only; the browser still talks to /api/backend on this app.
    env: { BACKEND_ORIGIN: process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:8000" },
  },
});
