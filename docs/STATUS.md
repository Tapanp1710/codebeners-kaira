# Status (2026-11-21)

## Verification

| Item | Result | How |
|---|---|---|
| Contract | Matches backend 357bc56 **and** the live backend | `node scripts/contract.mjs check` with `BACKEND_ORIGIN` |
| ESLint | 0 errors, 0 warnings | `npm run lint` |
| TypeScript | passes | `npm run typecheck` |
| Unit / component tests | 59 / 59 passed | `npm test` |
| Production build | succeeds (15 routes) | `npm run build` |
| E2E against real backend | 9 / 9 passed | Playwright, production build, backend at `http://127.0.0.1:8000` |
| Acceptance (section 23) | passed once on the seeded demo business | `RUN_ACCEPTANCE=1` (recorded ₹5,000 for Ramesh Kumar) |
| Cookie + CSRF proxy | verified with curl and in Chromium | two Set-Cookie headers, refresh path rewrite, CSRF rejection, refresh via proxy |
| Scripts (PowerShell) | setup, start, stop, verify run successfully, including failure paths | Windows 11 |
| Scripts (bash) | syntax-checked only | not executed on Linux/macOS |
| Docker image | see final report | `docker build` |

## Not verified / blockers

* **Cross-laptop connectivity:** not tested. Frontend and backend ran on the **same** machine, so `BACKEND_ORIGIN`
  was `127.0.0.1`. The steps are in INTEGRATION.md.
* **Live Sarvam (STT, TTS, Telugu/Hindi):** the backend has no `SARVAM_API_KEY`. The voice path was exercised for real
  up to the backend (fake microphone → multipart upload → backend `503 PROVIDER_NOT_CONFIGURED` shown to the user).
  The transcript, extraction and TTS UI with real provider output is unit-tested with stubbed responses only.
* **GitHub Actions:** written, not run (no remote).
* **Deployment:** none.

## Known limitations

* Login rate limiting is per client IP on the backend. Behind the proxy all logins share the frontend server's IP. The
  backend also limits per e-mail. A per-IP limit at the frontend edge or a trusted `X-Forwarded-For` on the backend would
  restore per-user IP limits.
* Two tabs refreshing at the same moment are serialised with the Web Locks API. Browsers without it (very old ones) could
  race and trigger the backend's refresh-reuse protection, which logs the user out.
* Reminders and answers are English unless the backend has the Sarvam key. The UI says so.
* Voiding an invoice uses the browser's confirm dialog.
