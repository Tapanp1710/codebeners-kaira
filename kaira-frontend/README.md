# KAIRA frontend

The web app for KAIRA, an AI-powered business operations partner for small businesses. Owners see cash, receivables
and forecasts, and talk to KAIRA (live voice or typed). The backend's agent executes clear owner instructions, reads
back anything it cannot verify and waits for a "yes", and sends staff requests to the owner on the Approvals page.

**The full project documentation** (problem, architecture, voice workflow, financial integrity model, security, backend
setup, environment, demo) is in `../backend/README.md` and the root `README.md` of this monorepo. This README covers
the frontend. Deeper frontend design notes are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · TanStack Query · openapi-fetch · Recharts ·
Vitest · Playwright.

Screens: **Dashboard · Customers & Invoices · Receivables · Cash-Flow Forecast · What-If Analysis**, plus Approvals,
Settings (owner only). The KAIRA agent home (`/agent`, the landing screen) and a persistent agent dock on every page are
the primary interface.

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
  (app)/agent|dashboard|customers|invoices|receivables|cashflow|scenarios|actions|settings
                             (actions = the Approvals page)
  api/backend/[...path]/     same-origin proxy to the backend
proxy.ts                     optimistic cookie check -> /login
components/                  ui (design system), layout, agent (orb, dock, conversation), dashboard, customers,
                             invoices, cashflow, charts, payments, actions (ProposalCard), auth
lib/agent/                   live voice engine: mic worklet capture, socket, player, reducer, tab lock, VAD
lib/api/                     generated schema types, typed client (CSRF, refresh), query hooks
lib/server/                  env validation, proxy core, server session
lib/payments/                server-side payment-attempt recovery
lib/format/                  exact money (BigInt) and date helpers
hooks/                       debounce
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

For HTTP the browser never calls the backend directly, so its HttpOnly session cookies are first-party wherever the
backend runs. The one exception is the live voice WebSocket: Next.js route handlers cannot proxy WebSockets, so the
browser opens the `ws_url` returned by `POST /agent/session` on the backend directly, authenticated by a single-use
ticket (no cookies). The backend checks the socket's `Origin` against its `CORS_ORIGINS`, so the frontend's origin
must be listed there, and `AGENT_PUBLIC_WS_URL` must be reachable from the browser.

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
| Unit and component (Vitest) | `npm test` | Proxy (headers, multipart, cookies, path rules, timeouts); API client (envelope, CSRF, refresh, idempotency); agent engine (socket and reconnects, tab lock, reducer, buffers, PCM, provider); money and date formatting; ProposalCard review, approve, reject and edit; screens and forms; payment recovery (lost responses, reload, another device, two tabs, pending visibility, logout privacy); the contract script |
| End to end (Playwright) | `E2E_EMAIL=… E2E_PASSWORD=… npm run test:e2e` | Production build against a **real backend** and PostgreSQL: auth and protected routes, refresh, CSRF refusal, invoice → payment → receivables, proposal reject/edit/approve on Approvals with backend checks, the live-session toggle and status, forecast, non-mutating what-if, mobile layout |
| Live agent (opt-in) | `E2E_LIVE_AGENT=1 …` | Typed requests to KAIRA (payment and promise, questions, reminder drafts). Needs a backend with `SARVAM_API_KEY`; skipped otherwise |
| Payment recovery (opt-in) | `E2E_DISPOSABLE_BACKEND=1 E2E_STAFF_EMAIL=… E2E_STAFF_PASSWORD=… npx playwright test e2e/payment-recovery.spec.ts` | Lost response then reload, browser restart, two tabs, cross-device, for invoices and bills |
| Acceptance (opt-in) | `RUN_ACCEPTANCE=1 E2E_LIVE_AGENT=1 … npx playwright test e2e/acceptance.spec.ts` | The full Ramesh demo through the agent. **Records a real ₹5,000 payment**; skips itself if Ramesh owes ₹5,000 or less |

E2E creates uniquely named customers, so it can be repeated, but point it only at a disposable backend. No E2E test
speaks into a microphone: live speech recognition is not covered by Playwright.

## Docker and deployment

- `next.config.ts`: standalone output, security headers (`X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`,
  `Permissions-Policy: microphone=(self)`).
- `Dockerfile`: multi-stage, Node 22 Alpine, non-root user, health check on `/login`. `BACKEND_ORIGIN` is read at
  runtime, so one image works everywhere:
  `docker build -t kaira-frontend . && docker run -p 3000:3000 -e BACKEND_ORIGIN=http://<backend>:8000 kaira-frontend`.
- CI is at the repository root: `.github/workflows/frontend.yml` (env template check, contract check, lint,
  typecheck, unit tests, build, `npm audit --omit=dev`, Docker build; a staging Playwright job only when
  `vars.E2E_BACKEND_ORIGIN` is set) and `.github/workflows/e2e.yml` (Playwright against a backend and PostgreSQL
  started inside the job, no secrets). `full-suite.yml` runs both plus the backend checks on demand.
- Production: serve the frontend and backend over HTTPS, with backend `COOKIE_SECURE=true`. Set `BACKEND_ORIGIN` as a
  server variable, and check with `node scripts/check-env.mjs --connect`.

The free-tier target is Vercel (root directory `kaira-frontend`, `BACKEND_ORIGIN=https://<your-render-service>.onrender.com`
as a server-side variable) in front of the backend on Render. The backend must list the Vercel origin in
`CORS_ORIGINS` and set `AGENT_PUBLIC_WS_URL` to its public `wss://` address for live voice. Details:
[`../backend/docs/DEPLOYMENT.md`](../backend/docs/DEPLOYMENT.md).

## Verification status

The project-wide status is in the root `README.md`. For the frontend:

| Check | Result |
|---|---|
| Lint, typecheck, unit and component tests, production build | run by `frontend-ci` on every relevant push and PR |
| Contract | `contracts/openapi.json` is identical to the backend's `docs/openapi.json` (API 1.2.0, 47 paths; `contracts/CONTRACT_VERSION`) |
| Playwright | run by `e2e.yml` against a seeded backend; tests that need the live agent LLM are skipped there |
| Live voice in a browser | Not yet verified with a human speaking into a microphone. The backend pipeline was exercised with Sarvam-synthesized loopback speech |

## Known limitations

- Live voice, the agent LLM, and Telugu/Hindi understanding need `SARVAM_API_KEY` on the backend. Without it the
  live session reports that voice is not configured.
- The browser listens only while the page is open, the live session is on and microphone permission is granted. Only
  one tab per browser profile holds the live session (Web Locks); other tabs keep typed input.
- Behind the proxy, every login comes from the frontend server's IP, so the backend's per-IP login limit is shared.
  The per-e-mail limit still applies.
- Browsers without the Web Locks API could race two refreshes, which triggers the backend's reuse protection and
  signs the user out.
- Voiding an invoice uses the browser's confirm dialog.
