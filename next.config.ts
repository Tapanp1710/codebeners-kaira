/**
 * Next.js build/runtime configuration: security headers on every route, a self-contained
 * "standalone" server build (used by the Dockerfile), and pinned workspace/tracing roots.
 * Backend location is NOT configured here; it is read at request time from BACKEND_ORIGIN (lib/server/env.ts).
 */
import type { NextConfig } from "next";

// Applied to every response, including the /api/backend proxy. X-Frame-Options: DENY blocks framing (clickjacking).
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Microphone is used only after an explicit tap on the voice orb.
  { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Emits .next/standalone with a minimal server.js and only the traced node_modules files.
  output: "standalone",
  // Pin the workspace root: a stray package-lock.json in a parent folder must not be picked up.
  turbopack: { root: process.cwd() },
  outputFileTracingRoot: process.cwd(),
  // Dev server only: allow opening the app via 127.0.0.1 as well as localhost.
  allowedDevOrigins: ["127.0.0.1"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
