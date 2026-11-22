# KAIRA frontend

The web app for KAIRA, an AI-powered business operations partner for small businesses. Owners see cash, receivables
and forecasts, and speak or type what happened. KAIRA turns it into proposals that are recorded only after the owner
approves them.

**The full project documentation** (problem, architecture, voice workflow, financial integrity model, security, backend
setup, environment, demo) is in the backend README on the repository's default branch, `feat/payment-integrity`. This
README covers the frontend. Deeper frontend design notes are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · TanStack Query · openapi-fetch · Recharts ·
Vitest · Playwright.

Screens: **Dashboard · Customers & Invoices · Receivables · Cash-Flow Forecast · What-If Analysis**, plus Approvals,
Settings (owner only). The KAIRA agent home (/agent, the landing screen) and a persistent agent dock on every page are the primary interface.

## Quick start

Prerequisites: Node.js 20.9+ (22 LTS recommended) and a running KAIRA backend.

```powershell
.\scripts\setup.ps1          # Linux/macOS: ./scripts/setup.sh
# edit .env.local -> BACKEND_ORIGIN if the backend is not at http://127.0.0.1:8000
.\scripts\start.ps1          # http://localhost:3000, then sign in with the backend's owner account
```

| PowerShell | bash | Does |
|---|---|---|
| `.\scripts\setup.ps1 [-SkipChecks]` | `./scripts/setup.sh [--skip-checks]` | Node check, `npm ci`, `.env.local`, env validation, contract check, lint, typecheck, tests, backend connectivity report |
| `.\scripts\start.ps1 [-Dev] [-Rebuild] [-Port 3000]` | `./scripts/start.sh [--dev] [--rebuild] [--port N]` | Builds if needed, starts in the background (PID and log in `.run/`), waits for the app |
| `.\scripts\stop.ps1` | `./scripts/stop.sh` | Stops that process. Never touches the backend |
| `.\scripts\verify.ps1 [-E2E]` | `./scripts/verify.sh [--e2e]` | Contract (including the live backend), lint, typecheck, unit tests, production build [+ Playwright] |

npm scripts: `dev`, `build`, `start`, `lint`, `typecheck`, `test`, `test:e2e`, `contract:generate`, `contract:check`, `verify`.

The repository was verified on Node 20.15.1, which needs two pins: Tailwind CSS 4.3.3 and older test tooling (Vitest 3,
jsdom 26, ESLint 9). On that version React prints a harmless warning about `ArrayBuffer.prototype.detached`.

## Structure

```
app/
  login/                     sign-in and silent session resume
  (app)/layout.tsx           server-side session check (GET /auth/me), providers, app shell
  (app)/dashboard|customers|invoices|receivables|cashflow|scenarios|actions|settings
  api/backend/[...path]/     same-origin proxy to the backend
proxy.ts                     optimistic cookie check -> /login
components/                  design system, layout, dashboard, customers, invoices, cashflow, charts, voice, actions
lib/api/                     generated schema types, typed client (CSRF, refresh), query hooks, voice
lib/server/                  env validation, proxy core, server session
lib/payments/                server-side payment-attempt recovery
lib/format/                  exact money (BigInt) and date helpers
hooks/                       recorder (MediaRecorder), debounce
contracts/                   imported backend contract: openapi.json, CONTRACT_VERSION, API_CONTRACT.md
tests/                       Vitest unit and component tests
e2e/                         Playwright tests against a real backend
```

## How the browser reaches the backend

```
Browser ──same origin──> /api/backend/api/v1/...  (app/api/backend/[...path]/route.ts, lib/server/proxy.ts)
                                  │ server-side, BACKEND_ORIGIN (never sent to the browser)
                                  ▼
                         KAIRA backend /api/v1/...
```

The browser never calls the backend directly, so its HttpOnly session cookies are first-party wherever the backend runs,
and CORS is not involved.

- Only `api/v1/...` paths are forwarded. `/docs` and `/openapi.json` are not reachable through the proxy. Malformed
  encodings get `400 BAD_REQUEST_PATH`, and paths are never decoded twice.
- Forwarded request headers: `accept`, `content-type`, `cookie`, `x-csrf-token`, `idempotency-key`, `x-request-id` and
  `user-agent`. Others (including `authorization`, `host` and any browser-supplied forwarding headers) are dropped. The
  client IP is forwarded only from the header named by `TRUSTED_CLIENT_IP_HEADER`.
- Bodies are forwarded as raw bytes, which preserves multipart audio. Each `Set-Cookie` is forwarded separately, with
  `Path=/api/v1/...` rewritten to `/api/backend/api/v1/...` and `Domain` removed.
- If the backend is down the proxy returns `502 BACKEND_UNAVAILABLE`; if it's too slow, `504 BACKEND_TIMEOUT` (30 s,
  90 s for voice). The internal URL is never echoed.

Every write sends the in-memory CSRF token as `X-CSRF-Token`. A `401 SESSION_EXPIRED` triggers a single refresh,
serialised across tabs with Web Locks, and the request is retried. Payments register a server-side attempt first, so a
lost response can be resolved from any device without paying twice. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Environment (`.env.local`; template `.env.example`)

| Variable | Scope | Required | Purpose |
|---|---|---|---|
| `BACKEND_ORIGIN` | server only | yes | Backend origin, e.g. `http://127.0.0.1:8000` (no `/api/v1`) |
| `BACKEND_TIMEOUT_MS` | server only | no | Upstream timeout (default 30000; voice uses at least 90 s) |
| `TRUSTED_CLIENT_IP_HEADER` | server only | no | Header **your** reverse proxy sets to the browser IP. Unset: no client IP is forwarded |
| `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_APP_ENV` | public | no | Page title; informational |
| `E2E_EMAIL`, `E2E_PASSWORD`, `E2E_PORT`, `RUN_ACCEPTANCE` | test runner | for E2E | Owner account on a **non-production** backend; port (3100); opt-in acceptance test |

Never put database credentials, JWT secrets or Sarvam keys here; `scripts/check-env.mjs` refuses them. If
`BACKEND_ORIGIN` is missing, the proxy returns `500 FRONTEND_MISCONFIGURED`. Nothing falls back to mock data.

### Backend on another machine

Set `BACKEND_ORIGIN=http://<backend-private-IP>:8000` and run `node scripts/check-env.mjs --connect`; it must report
`Backend reachable`. On the backend machine, allow port 8000 only from the frontend machine. For example, on Windows
(admin PowerShell):
`New-NetFirewallRule -DisplayName "KAIRA API" -Direction Inbound -Protocol TCP -LocalPort 8000 -RemoteAddress <frontend-IP> -Action Allow -Profile Private`.
Never expose port 8000 or PostgreSQL to the internet.

## API contract

The backend owns the contract. `contracts/openapi.json` is a copy of the backend's `docs/openapi.json`, and
`contracts/CONTRACT_VERSION` records its version, source commit and hash. `lib/api/schema.d.ts` is generated from it and
must never be edited by hand.

`npm run contract:check` (also run by setup, verify and CI) fails if the spec changed without being re-recorded, if the
generated types are stale, or, when `BACKEND_ORIGIN` is set, if the running backend serves a different contract.

To update: copy the backend's `docs/openapi.json` and `docs/API_CONTRACT.md` into `contracts/`, then run
`BACKEND_COMMIT=<sha> IMPORT_DATE=<YYYY-MM-DD> npm run contract:generate` and `npm run verify`. Type errors show
every place the UI must change.

## Testing

| Suite | Command | Covers |
|---|---|---|
| Unit and component (Vitest) | `npm test` | Proxy (headers, multipart, cookies, path rules, timeouts); API client (envelope, CSRF, refresh, idempotency); voice upload and audio decoding; money and date formatting; proposal review, approve, reject and edit; forms; payment recovery (lost responses, reload, another device, two tabs, pending visibility, logout privacy); the contract script |
| End to end (Playwright) | `E2E_EMAIL=… E2E_PASSWORD=… npm run test:e2e` | Production build against a **real backend** and PostgreSQL: auth and protected routes, HttpOnly cookies, refresh, CSRF refusal, invoice → payment → receivables, assistant reject/edit/approve with backend checks, voice recording with a fake microphone, forecast, non-mutating what-if, mobile layout |
| Payment recovery (opt-in) | `E2E_DISPOSABLE_BACKEND=1 E2E_STAFF_EMAIL=… E2E_STAFF_PASSWORD=… npx playwright test e2e/payment-recovery.spec.ts` | Lost response then reload, browser restart, two tabs, cross-device, for invoices and bills |
| Acceptance (opt-in) | `RUN_ACCEPTANCE=1 … npx playwright test e2e/acceptance.spec.ts` | The full Ramesh demo. **Records a real ₹5,000 payment**; skips itself if Ramesh owes ₹5,000 or less |

E2E creates uniquely named customers, so it can be repeated, but point it only at a disposable backend. The voice test
uses a fixed 440 Hz tone as a fake microphone. That is simulated audio: it proves the recording pipeline, not live
Sarvam transcription.

## Docker and deployment

- `next.config.ts`: standalone output, security headers (`X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`,
  `Permissions-Policy: microphone=(self)`).
- `Dockerfile`: multi-stage, Node 22 Alpine, non-root user, health check on `/login`. `BACKEND_ORIGIN` is read at
  runtime, so one image works everywhere:
  `docker build -t kaira-frontend . && docker run -p 3000:3000 -e BACKEND_ORIGIN=http://<backend>:8000 kaira-frontend`.
- `.github/workflows/ci.yml`: env template check, contract check, lint, typecheck, unit tests, build,
  `npm audit --omit=dev`, Docker build. The Playwright job runs only when `vars.E2E_BACKEND_ORIGIN` and the
  `E2E_EMAIL`/`E2E_PASSWORD` secrets point at a disposable backend.
- Production: serve the frontend and backend over HTTPS, with backend `COOKIE_SECURE=true`. Set `BACKEND_ORIGIN` as a
  server variable, and check with `node scripts/check-env.mjs --connect`.

No hosting provider has been chosen. **Nothing has been deployed.**

## Verification status (22 Nov 2026)

| Check | Result |
|---|---|
| Lint, typecheck | 0 problems |
| Unit and component tests | 122 passed |
| Production build | succeeds |
| Contract | identical to the backend's `docs/openapi.json` (API 1.1.0, 43 paths); every endpoint the UI calls exists |
| Playwright | 18/18 against a disposable backend, including acceptance and cross-device recovery |
| Docker | image builds and runs as non-root; proxied login, CSRF refusal and path hardening checked live |
| GitHub Actions | passes (the e2e job is skipped without a configured disposable backend) |
| Live Sarvam voice | **not tested** (no key). Without a key the UI shows "Voice is not available on this server yet" and typed English input works |

## Known limitations

- Live speech-to-text, Telugu/Hindi understanding and spoken answers need `SARVAM_API_KEY` on the backend.
- Behind the proxy, every login comes from the frontend server's IP, so the backend's per-IP login limit is shared.
  The per-e-mail limit still applies.
- Browsers without the Web Locks API could race two refreshes, which triggers the backend's reuse protection and
  signs the user out.
- Voiding an invoice uses the browser's confirm dialog.
