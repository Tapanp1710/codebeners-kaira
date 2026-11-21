import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the REAL backend (BACKEND_ORIGIN) through the production build.
 * Required env: E2E_EMAIL, E2E_PASSWORD (an owner account on a NON-production backend).
 * The suite creates its own uniquely named customers so it can run repeatedly.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        permissions: ["microphone"],
        launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
      },
    },
  ],
  webServer: {
    command: `npx next start --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { BACKEND_ORIGIN: process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:8000" },
  },
});
