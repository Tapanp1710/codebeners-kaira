/**
 * Vitest config for unit/component tests (npm test). jsdom by default; files opt into Node with a
 * `// @vitest-environment node` pragma (proxy and voice tests). Playwright specs in e2e/ are not
 * matched by the include pattern.
 */
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Mirrors the "@/*" path alias from tsconfig.json (repo root).
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    // CSS imports are ignored; tests assert behaviour and accessibility, not styling.
    css: false,
    // The payment-recovery flows run many real UI steps; 5 s (the default) is too tight on a loaded machine.
    testTimeout: 15_000,
  },
});
