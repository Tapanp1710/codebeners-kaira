# KAIRA

**An AI-powered business operations partner for small businesses.** The owner says or types what happened, for
example *"Ramesh paid me 5,000 rupees today. He will clear the remaining amount next Monday."* KAIRA turns it into
business records. Clear, complete instructions from the owner execute autonomously through the backend's
validated services; anything missing, ambiguous or unverifiable is asked back or read back for confirmation.

This is the backend of the KAIRA monorepo (`backend/`); the web app is in `kaira-frontend/` and the overview is the
root `README.md`. The live voice agent contract is [docs/VOICE_AGENT.md](docs/VOICE_AGENT.md).

---

## 1. Problem

Small businesses that sell on credit run on memory. Who paid, how much, against which invoice, and who promised to
pay the rest "next Monday" ends up in notebooks, chat messages and the owner's head. Accounting software expects
accountant-style data entry, so records are entered late or never. Generic chatbots can talk, but they cannot be trusted
to write financial records on their own.

## 2. Solution and core features

KAIRA captures business events the way the owner already speaks, and keeps the owner in control:

**conversation → transcription → extraction → resolution → proposed action → owner approval → one transaction → audit trail**

| Area | Capabilities |
|---|---|
| Records | Customers, invoices (line items, gap-free numbering, void), partial and full payments, bills and bill payments, payment promises (commitments) |
| Money views | Dashboard, receivables with overdue ageing, current cash, 30/60/90-day cash-flow forecast with lowest balance and shortfalls, read-only what-if simulation ("what if my biggest customer pays 15 days late?"), insights |
| Assistant | Voice (Sarvam speech-to-text) or typed input; extraction of payments, promises, invoices, expenses, customers and questions; customer and invoice matching; evidence and confidence; edit, approve or reject; English reminder drafts; spoken replies (Sarvam text-to-speech) |
| Integrity | Owner-only approval, exactly-once payments (idempotency keys with request fingerprints), cross-device payment recovery, an audit row for every write |

Out of scope: GST/statutory compliance, sending reminders automatically, always-on listening.

## 3. Architecture

```
 Browser ──same origin──► Next.js frontend ──server-side proxy (/api/backend → /api/v1)──► FastAPI backend
                          (HttpOnly cookies stay first-party; no backend secret in the browser)      │
                 ┌─────────────────────────────────────────┬──────────────────────────────────────────┤
                 ▼                                         ▼                                          ▼
         Business services                         Financial engine                           AI services
   customers, invoices, payments, bills,    derived balances, receivables, forecast,   Sarvam STT/LLM/TTS adapter,
   commitments, payment attempts, audit     simulation (READ ONLY), insights           rules extractor, evidence check,
                 │                                         │                           resolution, proposals, approval
                 └──────────────────────► PostgreSQL ◄─────┘
                               (single source of truth, audit_logs)
```

A modular monolith in one Docker image, with no Redis, queues or microservices. Services *flush* and endpoints
*commit*, so an approved proposal executes all its operations in one transaction. Row locks (`SELECT … FOR UPDATE`) on
the invoice, bill, business counter and proposal, backed by unique constraints, make concurrent writes safe. Every query
is scoped by `business_id`.

Design references in `docs/`: [FINANCIAL_ENGINE](docs/FINANCIAL_ENGINE.md) (balances, forecast, simulation),
[AI_ARCHITECTURE](docs/AI_ARCHITECTURE.md) (extraction pipeline and guarantees),
[DATABASE_SCHEMA](docs/DATABASE_SCHEMA.md), [PAYMENT_ATTEMPTS](docs/PAYMENT_ATTEMPTS.md) (recovery state machine),
[DECISIONS](docs/DECISIONS.md) (decision log).

## 4. Technology stack

| Layer | Technology |
|---|---|
| Backend | Python 3.11, FastAPI, Pydantic v2, SQLAlchemy 2 (sync) + psycopg 3, Alembic, Argon2id, JWT |
| Database | PostgreSQL 17 (14+ supported) |
| AI and voice | Sarvam AI: Saaras v4 (speech-to-text), `sarvam-105b` (structured extraction), Bulbul v4 Flash (text-to-speech) |
| Frontend | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, TanStack Query, Recharts, openapi-typescript |
| Testing | pytest on real PostgreSQL, Ruff, Vitest, Playwright |
| Delivery | Docker (non-root images), Docker Compose, GitHub Actions |

## 5. Repository structure

Backend (this branch):

| Path | Responsibility |
|---|---|
| `app/main.py` | App factory and middleware: request ID and access log, body-size limit, CORS |
| `app/core/` | Settings and validation, security (Argon2, JWT, CSRF), error envelope, logging, rate limiter |
| `app/db/` | Engine and session, auth dependencies (`Auth`, `OwnerAuth`), Alembic helpers |
| `app/models/`, `app/schemas/` | SQLAlchemy models; Pydantic request/response models (the OpenAPI contract) |
| `app/services/` | Business logic and the financial engine. `app/services/ai/`: parsing, extractors, resolution, proposals, assistant |
| `app/integrations/sarvam/` | Sarvam REST adapter: timeouts, retries, error mapping |
| `app/api/v1/` | Routers and presenters |
| `app/cli.py`, `app/seed.py` | Operational commands and the demo seed |
| `alembic/` | Migrations |
| `tests/` | `unit/`, `api/`, `integration/` |
| `scripts/` | `setup`, `start`, `stop`, `verify`, `backup`, `restore` (PowerShell and bash) |
| `docs/` | Design references, [API_CONTRACT](docs/API_CONTRACT.md), [openapi.json](docs/openapi.json), [SECURITY](docs/SECURITY.md), [DEPLOYMENT](docs/DEPLOYMENT.md) |

Frontend (`feat/server-payment-recovery`): `app/` (routes: login, dashboard, customers, invoices, receivables,
cashflow, scenarios, actions, settings, and the `api/backend` proxy), `components/` (design system, voice orb, assistant,
proposal review), `lib/` (typed API client, server proxy, exact money formatting, payment recovery), `contracts/`
(the imported backend contract), `tests/` (Vitest) and `e2e/` (Playwright).

## 6. Voice processing workflow

1. **Capture.** The owner taps the orb (recording stops on a second tap or at Sarvam's 30-second limit) or types.
2. **Transcribe.** `POST /voice/transcribe` sends the audio to Saaras v4 in `transcribe` mode (Telugu, Hindi, English,
   or auto-detect). The owner can edit the transcript. Raw audio is not stored.
3. **Extract.** `POST /assistant/extract` sends only the transcript and today's date to `sarvam-105b` with a JSON
   schema. Without a key, a deterministic English rules extractor is used (`AI_EXTRACTION_PROVIDER=auto`).
4. **Validate.** Output is checked against a fixed schema. Any value without a verbatim evidence fragment in the
   transcript is removed. Customers and invoices are matched locally; customer data is never sent to the model.
5. **Propose.** Write intents become a `pending` proposal with evidence, warnings and a derived confidence level.
   Questions are answered from backend data.
6. **Speak.** `POST /voice/speak` reads answers aloud with Bulbul v4 Flash. The model and voice are always sent
   explicitly (en `aparna_en_companion`, hi `aparna_hi_customer`, te `kavitha_te_conversation`), and startup refuses a
   voice that does not belong to the configured model.

The client retries only on 429/5xx and timeouts, with exponential backoff, and never retries 400/402/403/422 or an
exhausted spend budget. Without `SARVAM_API_KEY`, the voice endpoints return `503 PROVIDER_NOT_CONFIGURED` and typed
input keeps working.

## 7. Financial integrity and approval model

- **AI extracts and proposes.** Extraction only ever creates `pending` proposals. It cannot write records or approve.
- **Deterministic code calculates.** Money is `Decimal` / `NUMERIC(14,2)`. Outstanding balances, remaining amounts and
  forecasts are derived from the ledger and never stored or taken from the model.
- **The owner authorises.** Approval is a separate, owner-only request. It locks the proposal, re-validates against
  current data and executes every operation in one transaction. Rejection writes nothing.
- **Exactly once.** Payments carry an `Idempotency-Key` bound to a SHA-256 fingerprint of the request. An exact retry
  replays; the same key with different details is `422 IDEMPOTENCY_KEY_REUSED`. A duplicate or concurrent approval
  executes once. The server-side `payment_attempts` registry lets any device resolve a payment whose response was lost.
- **Audited.** Every payment, commitment, proposal transition, login and attempt transition writes an `audit_logs`
  row, linked to the approved action where there is one.
- **No overpayment.** Payments and promises are capped at what is actually outstanding. A promise for "the
  remaining amount" supersedes earlier pending promises on that invoice.

## 8. Security considerations

HttpOnly cookie sessions with rotating refresh tokens and reuse detection; CSRF token on every unsafe request; Argon2id
passwords; per-business isolation on every lookup; rate limits shared across workers through PostgreSQL (login, AI,
payments); request size limits and audio magic-byte checks; one error envelope with no stack traces or SQL; prompt
injection handled by schema-restricted output and approval. Staging and production refuse to start with weak or
missing secrets or insecure cookies. The Sarvam key stays on the server and is never logged. The frontend proxy forwards
only `/api/v1` paths and never exposes the backend address. Full details and the 2026-11-22 review:
[docs/SECURITY.md](docs/SECURITY.md).

## 9. Setup

Prerequisites: Docker (the only hard requirement); Python 3.11+ for local tests; Node 20.9+ (22 LTS recommended) for the frontend.

```powershell
# backend (this branch)
.\scripts\setup.ps1      # Linux/macOS: ./scripts/setup.sh
                         # creates .env with a generated JWT secret and demo password, starts PostgreSQL, builds the
                         # API image, checks config, migrates, seeds the demo business, creates .venv
.\scripts\start.ps1      # starts db + api and waits for /ready  ->  http://127.0.0.1:8000/docs

# frontend (branch feat/server-payment-recovery, separate checkout)
.\scripts\setup.ps1      # npm ci, .env.local, checks; set BACKEND_ORIGIN=http://127.0.0.1:8000 if needed
.\scripts\start.ps1      # http://localhost:3000
```

Sign in as `DEMO_OWNER_EMAIL` / `DEMO_OWNER_PASSWORD` from the backend `.env`. Other scripts: `stop`, `verify` (all
quality gates), `backup`, `restore -Confirm`.

## 10. Environment variables

Templates: [.env.example](.env.example) (development) and [.env.production.example](.env.production.example). Never
commit `.env`.

| Variable | Default | Purpose |
|---|---|---|
| `APP_ENV` | development | `staging`/`production` enforce secure settings |
| `DATABASE_URL` | dev: local `kaira` database | PostgreSQL DSN. Required in production. Use `127.0.0.1`, not `localhost`, on Windows (avoids a 5 s IPv6 fallback) |
| `DATABASE_POOL_SIZE` / `_MAX_OVERFLOW` / `_POOL_TIMEOUT` | 5 / 10 / 30 | Connection pool |
| `TEST_DATABASE_URL` | the `kaira_test` database | pytest (must end in `_test`) |
| `JWT_SECRET_KEY` | generated by setup | Session signing; ≥ 32 characters in production |
| `ACCESS_TOKEN_EXPIRE_MINUTES`, `REFRESH_TOKEN_EXPIRE_DAYS` | 15, 7 | Session lifetime |
| `COOKIE_SECURE`, `COOKIE_SAMESITE`, `COOKIE_DOMAIN` | false, lax, unset | Cookie flags; `COOKIE_SECURE=true` required in production |
| `FRONTEND_ORIGIN`, `CORS_ORIGINS` | http://localhost:3000 | Allowed browser origins (comma-separated) |
| `MAX_REQUEST_BYTES`, `MAX_AUDIO_UPLOAD_BYTES` | 1 MB, 5 MB | Request limits |
| `RATE_LIMIT_LOGIN_PER_MINUTE`, `_AI_`, `_PAYMENT_` | 10, 30, 60 | Throttling |
| `RATE_LIMIT_BACKEND` | postgres | `postgres` is shared by all workers; `memory` is single-process only |
| `DEFAULT_CURRENCY`, `DEFAULT_TIMEZONE`, `DEFAULT_OVERDUE_COLLECTION_DELAY_DAYS` | INR, Asia/Kolkata, 30 | Defaults for new businesses |
| `SARVAM_API_KEY` | unset | Enables voice and LLM extraction. Server-side only |
| `SARVAM_STT_MODEL`, `SARVAM_STT_MODE` | saaras:v4, transcribe | Speech-to-text |
| `SARVAM_LLM_MODEL`, `SARVAM_LLM_REASONING_EFFORT`, `SARVAM_LLM_MAX_TOKENS` | sarvam-105b, low, 4096 | Extraction |
| `SARVAM_TTS_MODEL`, `SARVAM_TTS_SPEAKER_TE/HI/EN` | bulbul:v4-flash; kavitha_te_conversation / aparna_hi_customer / aparna_en_companion | Speech output; voices must belong to the model |
| `SARVAM_TTS_PACE`, `_SAMPLE_RATE`, `_CODEC` | 1.0, 22050, wav | Speech output format |
| `SARVAM_TIMEOUT_SECONDS`, `SARVAM_MAX_RETRIES` | 60, 2 | Provider calls |
| `AI_EXTRACTION_PROVIDER` | auto | `auto` (Sarvam with a key, otherwise rules), `sarvam` or `rules` |
| `DEMO_OWNER_EMAIL`, `DEMO_OWNER_PASSWORD` | demo@kaira.local, generated | Development seed |
| `LOG_LEVEL`, `LOG_FORMAT`, `RUN_MIGRATIONS_ON_START` | INFO, json, false | Operations |
| `WEB_CONCURRENCY`, `PORT`, `FORWARDED_ALLOW_IPS` | 2, 8000, 127.0.0.1 | Container runtime |

Frontend (`.env.local`): `BACKEND_ORIGIN` (server-only, required), `BACKEND_TIMEOUT_MS`, `TRUSTED_CLIENT_IP_HEADER`,
`NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_APP_ENV`. The frontend never holds database credentials, JWT secrets or Sarvam
keys, and its env check refuses them.

## 11. Database setup and migrations

All schema changes go through Alembic (`alembic/versions`, head `6462ead8dd6e`).

```
python -m app.cli migrate          # apply migrations (setup and start do this)
python -m app.cli seed             # idempotent demo business
python -m app.cli seed --reset     # development/test only: restore the demo data with dates relative to today
python -m app.cli check-config | wait-db | export-openapi [path]
python -m app.cli create-owner --business "Name" --email you@example.com --name "You"
python -m app.cli create-user --owner-email … --email … [--role staff]
```

`seed --reset` touches only the business named "KAIRA Demo Traders" owned by `DEMO_OWNER_EMAIL`, and refuses in staging
and production. Backups: `scripts/backup` (`pg_dump -Fc`, verified) and `scripts/restore <file> -Confirm`.

## 12. Tests

```
docker compose up -d db
.venv\Scripts\python.exe -m pytest -q                       # real PostgreSQL (kaira_test)
.venv\Scripts\python.exe -m ruff check . ; .venv\Scripts\python.exe -m ruff format --check .
.\scripts\verify.ps1                                         # every gate: ruff, migrations + alembic check, OpenAPI drift, pytest, live /ready
```

Suites: `tests/unit` (config, parsing, Sarvam client retry policy and request shape), `tests/api` (auth, finance core
with concurrency and cross-business isolation, forecast and non-mutating simulation, assistant and approvals, payment
idempotency, payment attempts, shared rate limiting), `tests/integration` (demo workflow, seed reset, CLI users).
Sarvam is tested with a mocked transport only, and those tests are labelled as mocked.

Frontend (its branch): `npm run lint`, `npm run typecheck`, `npm test` (Vitest), `npm run build`, and Playwright
end-to-end tests against a real backend (`E2E_EMAIL=… E2E_PASSWORD=… npm run test:e2e`; use a disposable database).

CI (`.github/workflows/ci.yml`): Ruff, migrations, `alembic check`, downgrade/upgrade round trip, OpenAPI drift check,
pytest on a PostgreSQL service, pip-audit, Docker build, and a check that the image refuses insecure production
configuration.

After any API change, run `python -m app.cli export-openapi` and commit `docs/openapi.json` (CI fails on drift). The
frontend imports that file into `contracts/` and regenerates its types with `npm run contract:generate`.

## 13. Docker

- `docker-compose.yml` (development): PostgreSQL bound to `127.0.0.1`, and the API on port 8000.
- `Dockerfile`: python:3.11-slim, non-root user, uvicorn workers, health check. The entrypoint validates configuration
  and refuses insecure production settings.
- `docker-compose.prod.yml`: the API only, with managed PostgreSQL from `.env.production`.
- Frontend `Dockerfile`: Next.js standalone, Node 22 Alpine, non-root; `BACKEND_ORIGIN` is read at runtime.

Production procedure and the manual, approval-gated deploy workflow: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
**Nothing has been deployed.**

## 14. Demo workflow

1. `seed --reset` the demo database (approval records a real payment), then sign in.
2. Dashboard: cash, receivables, cash outlook and alerts.
3. Customers & Invoices → **Ramesh Kumar**: ₹12,000.00 outstanding on INV-0001.
4. **Ask KAIRA** → language English → type *"Ramesh paid me 5,000 rupees today. He will clear the remaining amount next
   Monday."* → **Understand**.
5. The proposal shows two operations, "Record customer payment" ₹5,000.00 and "Record payment promise" ₹7,000.00, each
   with evidence and the backend's before/after balance.
6. **Approve.** Ramesh's balance becomes ₹7,000.00, with one payment "via assistant" and a pending ₹7,000.00 promise.
   Cash rises and receivables fall by exactly ₹5,000.00, and the dashboard's Recent activity shows the audit trail.

API equivalent: `POST /auth/login`, `POST /assistant/extract`, `POST /actions/{id}/approve` (header `X-CSRF-Token`
from the login response).

## 15. Verification status (22 Nov 2026)

| Check | Result |
|---|---|
| Backend tests (pytest, PostgreSQL) | 196 passed; Ruff clean; migrations round trip and `alembic check` clean; OpenAPI current (API 1.1.0, 43 paths) |
| Frontend | lint and typecheck clean; 122 unit tests passed; production build succeeds |
| End to end | Playwright 18/18 against a disposable backend, including cross-device payment recovery and the demo acceptance test |
| Demo scenario on a disposable database | Passed: exactly one payment, correct balances, separate promise, audit trail; re-approval records nothing new; a rejected proposal writes nothing |
| GitHub Actions | Backend and frontend CI pass. The frontend e2e job is skipped until a disposable backend is configured |
| Live Sarvam (STT, LLM, TTS) | **Not tested**: no `SARVAM_API_KEY`. Request formats were checked against Sarvam's documentation and covered by mocked tests |

## 16. Known limitations

- Live Sarvam voice and LLM extraction have not been exercised. Without a key, extraction uses the English rules
  engine, which covers the documented phrasings but is not a general language model. Telugu and Hindi need the key.
- The configured voices are from Sarvam's catalog but have not been listened to.
- Relative dates follow fixed rules: "next Monday" is the first Monday after today, so said on a Sunday it means the
  next day.
- There is no e-mail service, so there's no password reset or invitations. The CLI creates accounts.
- Access tokens remain valid for up to 15 minutes after logout (refresh tokens are revoked immediately).
- Behind the frontend proxy, the per-IP login limit is shared; the per-e-mail limit still applies.
- Reminders and answers are in English unless the Sarvam key is configured. Reminders are drafted, never sent.

## 17. Hackathon submission

- Repository: https://github.com/Tapanp1710/codebeners-kaira (public). Backend `feat/payment-integrity`, frontend
  `feat/server-payment-recovery`.
- The demo uses typed English input on a local, disposable database. The voice pipeline is integrated and tested
  against mocks, and live testing is pending the API key.
- The presentation and demo video are submitted separately and are not stored in this repository.
- No deployment, hosted environment or paid infrastructure is part of this submission.
