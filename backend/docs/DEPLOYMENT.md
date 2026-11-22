# Deployment

## Artefacts

* `Dockerfile`: python:3.11-slim, non-root user, uvicorn workers (`WEB_CONCURRENCY`), proxy headers,
  graceful shutdown (20 s), HEALTHCHECK on `/health`.
* `docker/entrypoint.sh`: runs `python -m app.cli check-config` (refuses insecure production settings), then, only
  when `RUN_MIGRATIONS_ON_START=true`, `wait-db --timeout 60` and `migrate`, then starts uvicorn on `PORT`
  (default 8000) with `WEB_CONCURRENCY` workers (default 1) and `FORWARDED_ALLOW_IPS`.
* `docker-compose.prod.yml`: API only, with an external managed PostgreSQL from `.env.production`.
* Repository root `.github/workflows/backend.yml`: quality gates (see README.md, "Tests").
* Repository root `.github/workflows/backend-deploy.yml`: **manual** (`workflow_dispatch`, type `deploy`). It runs
  `backend.yml`, then needs approval through the GitHub `production` environment, calls the host's deploy hook
  (`secrets.DEPLOY_HOOK_URL`) and polls `${PRODUCTION_API_URL}/ready`.

## Free-tier target: Render + Supabase + Vercel

This is the intended low-cost setup. Values in angle brackets are placeholders; never commit real hosts or secrets.

```
Browser ──HTTPS──► Vercel (Next.js, kaira-frontend/) ──server-side proxy, BACKEND_ORIGIN──► Render web service (backend/)
   │                                                                                            │
   └──────────── wss://<your-render-service>.onrender.com/api/v1/agent/live (ticket) ───────────┤
                                                                                                ▼
                                                                  Supabase PostgreSQL (session pooler, port 5432)
```

### Database: Supabase

1. Create a project and copy the **session pooler** connection string (port 5432). The session pooler keeps one
   server connection per client connection, which fits SQLAlchemy's connection pool.
2. Write it with the psycopg driver and TLS:
   `DATABASE_URL=postgresql+psycopg://<user>:<password>@<pooler-host>:5432/postgres?sslmode=require`
3. Keep `DATABASE_POOL_SIZE + DATABASE_MAX_OVERFLOW` per worker, times `WEB_CONCURRENCY`, within the project's
   connection limit.

### Backend: Render web service

1. New web service from the repository, runtime **Docker**, root directory `backend` (the Dockerfile and build
   context are there). Plan: free.
2. The free plan has **no pre-deploy command**, so set `RUN_MIGRATIONS_ON_START=true`; the entrypoint then waits
   for the database and runs `migrate` before uvicorn starts. Render provides `PORT`; the entrypoint uses it.
3. Health check path: `/ready` (returns 503 until the database is reachable and migrations are current) or
   `/health` (process liveness only).
4. Environment (from `.env.production.example`):
   * `APP_ENV=production`, a strong `JWT_SECRET_KEY` (≥ 32 characters), `COOKIE_SECURE=true`, `DATABASE_URL` as above.
   * `FRONTEND_ORIGIN` and `CORS_ORIGINS` = `https://<your-vercel-app>.vercel.app`. The browser opens the live
     WebSocket on the backend directly, and its `Origin` is checked against `CORS_ORIGINS`.
   * `AGENT_PUBLIC_WS_URL=wss://<your-render-service>.onrender.com/api/v1/agent/live`.
   * `SARVAM_API_KEY` for voice and the agent LLM (secret; server-side only).
   * `FORWARDED_ALLOW_IPS`: the addresses of Render's proxy, if client IPs from `X-Forwarded-For` are needed.
   * `WEB_CONCURRENCY`: keep 1 (the default). The WebSocket ticket's single-use check and the one-live-socket-per-user rule
     are kept in process memory, so they hold per worker process.
5. The free plan sleeps when idle. The first request after a sleep waits for the container to start (and run
   migrations), and a sleeping service has no open live sessions.

### Frontend: Vercel

1. Import the repository with root directory `kaira-frontend`.
2. Set `BACKEND_ORIGIN=https://<your-render-service>.onrender.com` as a **server-side** environment variable (never
   `NEXT_PUBLIC_*`). The browser calls `/api/backend/api/v1/...` on the Vercel origin, and the Next.js server
   forwards it, so session cookies are first-party on the Vercel domain. Leave `COOKIE_DOMAIN` unset on the backend;
   `COOKIE_SAMESITE=lax` works because the cookies never cross sites.
3. No database credentials, JWT secret or Sarvam key belong in the frontend; `scripts/check-env.mjs` refuses them.

### First account and checks

1. Create the owner from a shell with the backend environment:
   `python -m app.cli create-owner --business … --email … --name …` (password from `KAIRA_OWNER_PASSWORD` or
   prompted).
2. `GET https://<your-render-service>.onrender.com/ready` shows `database: ok`, `migrations: current` and
   `voice_provider: configured` when the Sarvam key is set.
3. Sign in through the Vercel URL and turn on the live session; the browser must reach the `wss://` URL.

## Hosts with a pre-deploy command

On a host that supports a pre-deploy/release command, keep `RUN_MIGRATIONS_ON_START=false` and run
`python -m app.cli migrate` (in `backend/`) there, so a failed migration stops the release before traffic moves.
`backend-deploy.yml` assumes this.

General procedure:

1. Provision managed PostgreSQL (14+) and copy its connection string (with `sslmode=require`).
2. Fill in `.env.production.example` as host environment variables.
3. Configure the host to build `backend/Dockerfile`, health check path `/ready`, pre-deploy command
   `python -m app.cli migrate`.
4. Back up the database before any release that contains a new migration (`pg_dump -Fc`, or the provider's
   snapshots).
5. Create the first account (above).
6. GitHub: create the `production` environment with required reviewers, secret `DEPLOY_HOOK_URL` and variable
   `PRODUCTION_API_URL`.
7. Run *backend-deploy*. Verify `GET /ready` shows `database: ok, migrations: current`.

## Cookies and domains

The Vercel setup above proxies `/api/v1` through the Next.js app, so cookies stay first-party. Without the proxy,
serve the frontend and API on the same registrable domain (e.g. `app.example.com`, `api.example.com`) with
`COOKIE_SAMESITE=lax` and optionally `COOKIE_DOMAIN=.example.com`. Different sites need `COOKIE_SAMESITE=none` +
HTTPS, and some browsers' third-party-cookie restrictions may still block them, so avoid that setup. The live
WebSocket uses a ticket, not cookies, in every setup.

## Operations

* Stale pending payment attempts: `python -m app.cli reconcile-payment-attempts [--dry-run]` (see
  PAYMENT_ATTEMPTS.md). It is safe to run from several workers at once.

## Scaling notes

The HTTP API is stateless: scale horizontally. Rate-limit counters live in PostgreSQL (`RATE_LIMIT_BACKEND=postgres`),
so limits stay shared across workers and instances. The PostgreSQL pool size per worker is
`DATABASE_POOL_SIZE + DATABASE_MAX_OVERFLOW`. Live voice sessions are held in the worker that accepted the socket.
