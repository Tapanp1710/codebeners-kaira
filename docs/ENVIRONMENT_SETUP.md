# Environment setup

## Prerequisites

* Node.js **20.9+** (Next.js 16 minimum). Node **22 LTS** is recommended. This repository was built and verified on
  Node 20.15.1, which needed two pins: Tailwind CSS 4.3.3 (4.3.4+ needs Node 20.19+) and older test tooling
  (Vitest 3, jsdom 26, ESLint 9). On Node 20.15 React prints a harmless warning about `ArrayBuffer.prototype.detached`.
* A running KAIRA backend you can reach (see INTEGRATION.md).

## Variables (`.env.local`; template `.env.example`)

| Variable | Scope | Required | Example | Purpose |
|---|---|---|---|---|
| `BACKEND_ORIGIN` | **server only** | yes | `http://127.0.0.1:8000` | Where the Next.js server reaches the backend. Origin only, no `/api/v1`. Never sent to the browser |
| `BACKEND_TIMEOUT_MS` | server only | no | `30000` | Upstream timeout for proxied calls (voice uses at least 90 s) |
| `TRUSTED_CLIENT_IP_HEADER` | server only | no | unset | Header that **your** reverse proxy sets to the browser's IP (e.g. `x-real-ip`; for `x-forwarded-for` the rightmost hop is used). Unset: no client IP is forwarded, and a browser-supplied `X-Forwarded-For`/`X-Real-IP`/`Forwarded` is never passed on. Set the backend's `FORWARDED_ALLOW_IPS` to this server's address only when this is set |
| `NEXT_PUBLIC_APP_NAME` | public | no | `KAIRA` | Page title |
| `NEXT_PUBLIC_APP_ENV` | public | no | `development` | Informational |
| `E2E_EMAIL`, `E2E_PASSWORD` | test runner only | for E2E | | Owner account on a **non-production** backend |
| `E2E_PORT` | test runner only | no | `3100` | Port for the E2E production server |
| `RUN_ACCEPTANCE` | test runner only | no | `1` | Enables the acceptance test that records a real payment for the seeded "Ramesh Kumar" |

Never put database credentials, JWT secrets or Sarvam keys here. `scripts/check-env.mjs` refuses them.
If `BACKEND_ORIGIN` is missing, the proxy returns `500 FRONTEND_MISCONFIGURED` and protected pages show "KAIRA can't reach its server".
Nothing falls back to mock data.

## Scripts

| PowerShell | bash | Does |
|---|---|---|
| `.\scripts\setup.ps1 [-SkipChecks]` | `./scripts/setup.sh [--skip-checks]` | Node check, `npm ci` (lockfile), `.env.local`, env validation, contract/types check, lint, typecheck, tests, backend connectivity report |
| `.\scripts\start.ps1 [-Dev] [-Rebuild] [-Port 3000]` | `./scripts/start.sh [--dev] [--rebuild] [--port N]` | Builds if needed, starts in the background (PID and log in `.run/`), waits for the app, reports backend reachability |
| `.\scripts\stop.ps1` | `./scripts/stop.sh` | Stops that process. Never touches the backend |
| `.\scripts\verify.ps1 [-E2E]` | `./scripts/verify.sh [--e2e]` | Contract (incl. live backend), lint (0 warnings), typecheck, unit tests, production build [+ Playwright] |

npm scripts: `dev`, `build`, `start`, `lint`, `typecheck`, `test`, `test:e2e`, `contract:generate`, `contract:check`, `verify`.

## First run

```powershell
.\scripts\setup.ps1
# edit .env.local -> BACKEND_ORIGIN if the backend is not on this machine
.\scripts\start.ps1
# open http://localhost:3000 and sign in with the backend's owner account
```
