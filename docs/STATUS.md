# Status

## Publication (2026-11-22)

| Item | Value |
|---|---|
| GitHub | https://github.com/Tapanp1710/codebeners-kaira, branch `feat/server-payment-recovery` (the backend lives in the same repository on `feat/payment-integrity`) |
| Backend compatibility | backend `0c37f8d`, API 1.1.0. `contracts/openapi.json` is identical to the backend's `docs/openapi.json` and to the spec its code generates. All 41 endpoint/method calls exist. Live check: `BACKEND_ORIGIN=… npm run contract:check` matched |
| GitHub Actions | run 44998134229 passed: env template, contract, lint, typecheck, unit tests, build, production audit, Docker build. The e2e job is skipped until `E2E_BACKEND_ORIGIN` (variable) and `E2E_EMAIL` / `E2E_PASSWORD` (secrets) point at a **disposable** backend |
| Before pushing | secret scan clean (working tree and history); lint, typecheck, 122 unit tests, build, Docker (non-root, proxied login), and Playwright 18/18 against a disposable backend built from the published backend commit |


## 2026-11-22: server-side payment recovery (branch `feat/server-payment-recovery`)

| Item | Result | How |
|---|---|---|
| Contract | API 1.1.0 from kaira-backend `578cede` (43 paths) | `npm run contract:check` |
| Unit / component tests | 122 / 122 passed | `npm test` |
| ESLint, TypeScript | 0 problems; passes | `npm run lint`, `npm run typecheck` |
| Production build | succeeds | `npm run build` |
| Playwright, full suite | **18 / 18 passed** (incl. `RUN_ACCEPTANCE=1`, cross-device recovery, the voice test) | disposable backend built from `feat/payment-integrity` and PostgreSQL |
| PostgreSQL after E2E | 21 succeeded attempts, each linked to a payment with the same key in the same business; 0 duplicate payment keys; 0 duplicate cash movements; no overpaid invoice or bill | SQL |
| Docker image | builds; container serves /login, proxied login, `/payment-attempts` through the proxy, 400 for a malformed path; runs as non-root `kaira` | `docker build`, `docker run` against the disposable backend |
| Proxy hardening | malformed path: 500 → 400 envelope; double decoding: 200 → 404; browser forwarding headers no longer forwarded | probed on `next start`, plus unit tests |

## 2026-11-21

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
| Docker image | verified 2026-11-21: builds, runs as non-root `kaira`, serves `/login`, proxied login 200 against local backend | `docker build`, `docker run -e BACKEND_ORIGIN=http://host.docker.internal:8000` |

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
