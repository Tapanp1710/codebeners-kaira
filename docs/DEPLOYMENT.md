# Deployment

## Artefacts

* `Dockerfile`: python:3.11-slim, non-root user, uvicorn workers (`WEB_CONCURRENCY`), proxy headers,
  graceful shutdown (20 s), HEALTHCHECK on `/health`. The entrypoint validates configuration first and refuses
  to start with insecure production settings.
* `docker-compose.prod.yml`: API only, with an external managed PostgreSQL from `.env.production`.
* `.github/workflows/ci.yml`: quality gates (see TEST_STRATEGY.md).
* `.github/workflows/deploy.yml`: **manual** (`workflow_dispatch`, type `deploy`). It re-runs CI, then needs
  approval through the GitHub `production` environment, calls the host's deploy hook, and polls `/ready`.

## Production procedure

1. Provision managed PostgreSQL (14+) and copy its connection string (with `sslmode=require`).
2. Fill in `.env.production.example` (strong `JWT_SECRET_KEY`, `COOKIE_SECURE=true`, CORS origin of the frontend,
   Sarvam key) as host environment variables.
3. Configure the host to build the Dockerfile, health check path `/ready`, and **pre-deploy/release command**
   `python -m app.cli migrate`.
4. Back up the database before any release that contains a new migration (`pg_dump -Fc`, or the provider's snapshots).
5. Create the first account: `python -m app.cli create-owner --business … --email … --name …`
   (password from `KAIRA_OWNER_PASSWORD` or prompted).
6. GitHub: create the `production` environment with required reviewers, secret `DEPLOY_HOOK_URL` and variable `PRODUCTION_API_URL`.
7. Run *backend-deploy*. Verify `GET /ready` shows `database: ok, migrations: current`.

## Cookies and domains

Serve the frontend and API on the same registrable domain (e.g. `app.example.com`, `api.example.com`) with
`COOKIE_SAMESITE=lax` and optionally `COOKIE_DOMAIN=.example.com`, or proxy `/api/v1` through the Next.js app.
Different sites need `COOKIE_SAMESITE=none` + HTTPS, and some browsers' third-party-cookie restrictions may
still block them, so avoid that setup.

## Hosting provider

**Not yet evaluated.** No provider's current documentation, pricing, free tier or card requirements have been
verified, so none is recommended here. Any platform that runs a Dockerfile with a pre-deploy command and offers
managed PostgreSQL fits this design (for example Render, Railway, Fly.io, Google Cloud Run + Cloud SQL, or AWS
App Runner + RDS). Check each candidate's current official docs before choosing. Nothing has been purchased,
provisioned or deployed.

## Scaling notes

Stateless API: scale horizontally. Then move rate limiting to the gateway/proxy (the in-process limiter is
per instance). The PostgreSQL pool size per worker is `DATABASE_POOL_SIZE + DATABASE_MAX_OVERFLOW`.
