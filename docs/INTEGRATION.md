# Backend integration

## Contract source

| Item | Value |
|---|---|
| Backend repository / branch | `Desktop/Codebenders/backend`, `feat/kaira-backend` |
| Backend commit | `357bc565225c80cbd6f4d08240236a8a5844bbf7` (last change to `docs/openapi.json`) |
| Imported | 2026-11-21: `contracts/openapi.json`, `API_CONTRACT.md`, `DATABASE_SCHEMA.md`, `INTEGRATION_HANDOFF.md` |
| API version | 1.0.0, 39 paths, 109 schemas |
| Integrity | `contracts/CONTRACT_VERSION` (sha256 of the spec with LF line endings) |
| Generated types | `lib/api/schema.d.ts` via openapi-typescript 7.13.0. Never edit by hand |

`npm run contract:check` (also run by `scripts/setup` and `scripts/verify`) fails if:
1. `contracts/openapi.json` changed without re-recording,
2. `lib/api/schema.d.ts` is stale, or
3. `BACKEND_ORIGIN` is set and the **running backend** serves a different contract (title ignored).

### Updating the contract

```
copy <backend>/docs/openapi.json, API_CONTRACT.md, DATABASE_SCHEMA.md, INTEGRATION_HANDOFF.md -> contracts/
BACKEND_COMMIT=<backend git sha> IMPORT_DATE=<YYYY-MM-DD> npm run contract:generate
npm run verify          # type errors show every place the UI must change
```

## How the browser reaches the backend

```
Browser ──(same origin)──> /api/backend/api/v1/...  [Next.js route handler: app/api/backend/[...path]/route.ts]
                                   │  server-side, BACKEND_ORIGIN (never exposed to the browser)
                                   ▼
                          KAIRA backend /api/v1/...
```

The backend handoff suggested `NEXT_PUBLIC_API_BASE_URL`. This frontend deliberately does **not** call the backend
from the browser: it uses a same-origin proxy (`lib/server/proxy.ts`), so the backend's HttpOnly cookies are
first-party regardless of where the backend runs. CORS is not involved, because the browser never makes cross-origin calls.

Proxy rules:
* Only paths matching `api/v1/...` are forwarded (`/docs` and `/openapi.json` are not reachable through it).
* Request headers forwarded: `accept`, `content-type`, `cookie`, `x-csrf-token`, `idempotency-key`, `x-request-id`,
  `user-agent`, plus `x-forwarded-for`. Others (e.g. `authorization`, `host`) are dropped.
* Bodies are forwarded as raw bytes, which preserves JSON and multipart audio with its boundary.
* Every `Set-Cookie` is forwarded as its own header. `Path=/api/v1/...` is rewritten to `Path=/api/backend/api/v1/...`
  (so the refresh cookie still reaches `/auth/refresh`) and `Domain` is removed. HttpOnly/Secure/SameSite/Max-Age are unchanged.
* Backend down → `502 BACKEND_UNAVAILABLE`. Too slow → `504 BACKEND_TIMEOUT` (30 s, 90 s for voice). The internal URL is never echoed.

## Endpoints used by the UI

| Area | Endpoints |
|---|---|
| Session | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me` (also server-side) |
| Settings | `GET/PATCH /business/settings` |
| Dashboard | `GET /dashboard`, `GET /insights`, `GET /cashflow/forecast` (weekly) |
| Customers | `GET/POST /customers`, `GET/PATCH /customers/{id}`, `GET /customers/{id}/invoices`, `GET /customers/{id}/payments`, `GET /audit-logs` |
| Invoices & payments | `GET/POST /invoices`, `GET/PATCH /invoices/{id}`, `GET/POST /invoices/{id}/payments` (with `Idempotency-Key`) |
| Receivables | `GET /receivables`, `GET /receivables/summary` |
| Cash flow & bills | `GET /cashflow/forecast`, `GET/POST /bills`, `POST /bills/{id}/payments` (with `Idempotency-Key`) |
| What-if | `POST /cashflow/simulate` |
| Assistant | `POST /voice/transcribe` (multipart), `POST /voice/speak`, `POST /assistant/extract`, `POST /assistant/reminder`, `GET /ready` |
| Approvals | `GET /actions`, `PATCH /actions/{id}`, `POST /actions/{id}/approve`, `POST /actions/{id}/reject` |

Not used by the UI (available in the contract): `GET /payments`, `GET /payment-commitments` (commitments come
embedded in customer and receivable responses), `POST/PATCH /payment-commitments` (promises are created through the
assistant), `GET/PATCH /bills/{id}`, `GET /cashflow/position` (cash comes from the dashboard and forecast),
`POST /assistant/query` (the assistant uses `/assistant/extract`, which also answers questions), `GET /actions/{id}`.

## Two-laptop setup (backend on laptop A, frontend on laptop B)

`127.0.0.1` on laptop B is laptop B. Never point `BACKEND_ORIGIN` at it unless the backend runs there.

1. **Laptop A (backend):** the backend's `docker-compose.yml` already publishes the API on all interfaces (port 8000)
   and keeps PostgreSQL on `127.0.0.1` only. Allow port 8000 **only from laptop B** (Windows, admin PowerShell):
   ```powershell
   New-NetFirewallRule -DisplayName "KAIRA API from frontend laptop" -Direction Inbound -Protocol TCP `
     -LocalPort 8000 -RemoteAddress <laptop-B-private-IP> -Action Allow -Profile Private
   ```
   Find laptop A's private IP with `ipconfig` (Wi-Fi/Ethernet IPv4).
2. **Laptop B (frontend):** set `BACKEND_ORIGIN=http://<laptop-A-private-IP>:8000` in `.env.local`, then run
   `node scripts/check-env.mjs --connect`. It must report `Backend reachable`.
3. Open the app on laptop B at `http://localhost:3000`. Cookies are set by laptop B's own origin via the proxy,
   so `COOKIE_SECURE=false` / `SameSite=lax` on the backend work over the private LAN.
4. Never expose port 8000 or PostgreSQL to the internet. For anything beyond a trusted LAN, use a VPN/private
   tunnel or an HTTPS staging backend.

Note: the backend rate-limits logins per client IP. Behind the proxy every login comes from the frontend server's
IP, which makes that limit shared. The per-e-mail limit still applies (see the limitations in STATUS.md).
