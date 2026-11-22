/**
 * Root layout: the single <html>/<body> shell shared by every page (the public /login route and the
 * authenticated (app) route group alike). It is a Server Component and deliberately stays thin: fonts, global
 * CSS and document metadata only. Session handling, React Query and toasts are NOT mounted here; they live in
 * app/(app)/layout.tsx so that only signed-in pages pay for them.
 */
import type { Metadata, Viewport } from "next";
import { Fraunces, Manrope } from "next/font/google";

import "./globals.css";

// next/font self-hosts both families at build time (no runtime request to Google). Each exposes a CSS variable
// that app/globals.css maps to --font-sans (Manrope, UI text) and --font-display (Fraunces, figures/headings).
const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope", display: "swap" });
const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces", display: "swap", axes: ["opsz"] });

// Child pages set only a short `title` (e.g. "Sign in"); the template turns it into "Sign in · KAIRA".
// NEXT_PUBLIC_APP_NAME is inlined at build time. robots noindex/nofollow: this is a private business tool.
export const metadata: Metadata = {
  title: { default: process.env.NEXT_PUBLIC_APP_NAME ?? "KAIRA", template: "%s · KAIRA" },
  description: "Voice-first business operations partner for small businesses.",
  robots: { index: false, follow: false },
};

// Viewport settings are a separate export from `metadata` in this Next.js version; themeColor is the brand navy.
export const viewport: Viewport = { themeColor: "#0d1b2a", width: "device-width", initialScale: 1 };

/** lang="en-IN" matches the Indian locale used for money and date formatting (lib/format). */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" className={`${manrope.variable} ${fraunces.variable}`}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
