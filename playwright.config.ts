import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

/**
 * Deterministic fake microphone: a fixed 2 s, 440 Hz, 16 kHz mono PCM tone written once per run and fed to
 * Chromium with --use-file-for-fake-audio-capture. Simulated audio only: it proves the browser recording
 * pipeline, not live Sarvam transcription (that needs SARVAM_API_KEY and is reported separately).
 */
function fakeMicrophoneWav(): string {
  const rate = 16_000;
  const samples = rate * 2;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
  const dir = join(tmpdir(), "kaira-e2e");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "fake-mic-440hz.wav");
  writeFileSync(file, buf);
  return file;
}

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
        launchOptions: {
          args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            `--use-file-for-fake-audio-capture=${fakeMicrophoneWav()}`,
          ],
        },
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
