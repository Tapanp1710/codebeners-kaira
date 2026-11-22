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

KAIRA captures business events the way the owner already speaks, and keeps the owner in control. There are two
paths into the same validated services:

- **Live agent:** speech or typed turn → agent tool call → evidence check, resolution, autonomy decision →
  executed, read back for a "yes", or sent to the owner for approval → one transaction → audit trail
- **Extract and approve (REST):** transcript → extraction → resolution → pending proposal → owner approval → one
  transaction → audit trail

| Area | Capabilities |
|---|---|
| Records | Customers, invoices (line items, gap-free numbering, void), partial and full payments, bills and bill payments, payment promises (commitments) |
| Money views | Dashboard, receivables with overdue ageing, current cash, 30/60/90-day cash-flow forecast with lowest balance and shortfalls, read-only what-if simulation ("what if my biggest customer pays 15 days late?"), insights |
| Live agent | Streaming voice over a WebSocket (Sarvam realtime STT, `sarvam-105b` tool calling over 28 business tools, streaming TTS) or typed turns; English, Hindi and Telugu; barge-in; read-backs and owner approval where the policy requires them |
| Assistant (REST) | Transcribe, extract payments, promises, invoices, expenses, customers and questions into a proposal; customer and invoice matching; evidence and confidence; edit, approve or reject; reminder drafts; spoken replies |
| Integrity | Server-side autonomy policy, owner-only approval of staff and read-back proposals, exactly-once payments (idempotency keys with request fingerprints), cross-device payment recovery, an audit row for every write |

Out of scope: GST/statutory compliance, sending reminders automatically, always-on listening.

## 3. Architecture

```
 Browser ──same origin──► Next.js frontend ──server-side proxy (/api/backend → /api/v1)──► FastAPI backend
                          (HttpOnly cookies stay first-party; no backend secret in the browser)      │
                 ┌─────────────────────────────────────────┬──────────────────────────────────────────┤
                 ▼                                         ▼                                          ▼
         Business services                         Financial engine                       AI and agent services
   customers, invoices, payments, bills,    derived balances, receivables, forecast,   live agent (WS + tools), Sarvam
   commitments, payment attempts, audit     simulation (READ ONLY), insights           STT/LLM/TTS adapters, extractors,
                 │                                         │                           evidence check, proposals, approval
                 └──────────────────────► PostgreSQL ◄─────┘
                               (single source of truth, audit_logs)
```

The live voice WebSocket is the one exception to the proxy: the browser opens `WS /api/v1/agent/live` on the backend
directly with a 60-second single-use ticket, because Next.js route handlers cannot proxy WebSockets.

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
| AI and voice | Sarvam AI: Saaras v4 (realtime and REST speech-to-text), `sarvam-105b` (agent tool calling and structured extraction), Bulbul v4 Flash (streaming and REST text-to-speech) |
| Frontend | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, TanStack Query, Recharts, openapi-typescript |
| Testing | pytest on real PostgreSQL, Ruff, Vitest, Playwright |
| Delivery | Docker (non-root images), Docker Compose, GitHub Actions |

## 5. Repository structure

Backend (`backend/`):

| Path | Responsibility |
|---|---|
| `app/main.py` | App factory and middleware: request ID and access log, body-size limit, CORS |
| `app/core/` | Settings and validation, security (Argon2, JWT, CSRF), error envelope, logging, rate limiter |
| `app/db/` | Engine and session, auth dependencies (`Auth`, `OwnerAuth`), Alembic helpers |
| `app/models/`, `app/schemas/` | SQLAlchemy models; Pydantic request/response models (the OpenAPI contract) |
| `app/services/` | Business logic and the financial engine. `app/services/ai/`: parsing, extractors, resolution, proposals, assistant. `app/services/agent/`: orchestrator, tool registry, live session, date and number resolution |
| `app/integrations/sarvam/` | Sarvam adapters: REST client (timeouts, retries, error mapping) and realtime STT/TTS WebSockets |
| `app/api/v1/` | Routers and presenters |
| `app/cli.py`, `app/seed.py` | Operational commands and the demo seed |
| `alembic/` | Migrations |
| `tests/` | `unit/`, `api/`, `agent/`, `integration/` |
| `scripts/` | `setup`, `start`, `stop`, `verify`, `backup`, `restore` (PowerShell and bash) |
| `docs/` | Design references, [API_CONTRACT](docs/API_CONTRACT.md), [openapi.json](docs/openapi.json), [SECURITY](docs/SECURITY.md), [DEPLOYMENT](docs/DEPLOYMENT.md) |

Frontend (`../kaira-frontend/`): `app/` (routes: login, agent, dashboard, customers, invoices, receivables,
cashflow, scenarios, actions (Approvals), settings, and the `api/backend` proxy), `components/` (design system, agent
orb and dock, proposal review), `lib/` (typed API client, server proxy, live agent engine, exact money formatting,
payment recovery), `contracts/` (the imported backend contract), `tests/` (Vitest) and `e2e/` (Playwright).

## 6. Voice processing workflow

There are two paths. Both end in the same validated services, row locks, idempotency keys and audit rows.

### 6.1 Live voice agent (primary)

Contract: [docs/VOICE_AGENT.md](docs/VOICE_AGENT.md). Code: `app/api/v1/endpoints/agent.py`, `app/services/agent/`,
`app/integrations/sarvam/realtime.py`.

1. **Session.** The owner switches the live session on. `POST /agent/session` returns a single-use WebSocket ticket
   (`AGENT_TICKET_TTL_SECONDS`, default 60) and `ws_url` (`AGENT_PUBLIC_WS_URL`).
2. **Stream.** The browser sends 16 kHz Int16 PCM over `WS /api/v1/agent/live`. The backend forwards it to Sarvam
   realtime STT (`saaras:v4`, `AGENT_STT_LANGUAGE=auto`, server VAD, customer names as key terms). Partial
   transcripts are captions only; a final transcript starts a turn.
3. **Turn.** `sarvam-105b` runs a tool-calling loop (at most `AGENT_MAX_TOOL_STEPS`, bounded by
   `AGENT_TURN_TIMEOUT_SECONDS`) over the typed tool registry in `app/services/agent/tools.py`: reads (balances,
   invoices, forecast, what-if) and writes (payments, promises, invoices, expenses, customers, corrections).
   Identity, business and role come from the database, never from the model.
4. **Decide.** Every write goes through the proposal pipeline (evidence check against the user's own words,
   customer/invoice resolution, caps). The server then decides, and the model cannot override it:
   - owner, every value evidenced, amount parses to exactly the stated amount, customer and invoice resolved:
     executed at once when `AGENT_AUTONOMY=auto` (the default);
   - anything the policy cannot verify (fuzzy match, unparsed amount, possible duplicate, or
     `AGENT_AUTONOMY=confirm`): `needs_confirmation`. KAIRA reads it back, and `confirm_pending_action` runs it only
     on a "yes" in a later turn, if the proposal is unchanged;
   - missing or ambiguous details: `needs_clarification`, nothing stored;
   - staff user: `needs_owner_approval`; the owner approves on the Approvals screen (`POST /actions/{id}/approve`).
5. **Reply.** Figures and dates in the reply must appear in tool results or the user's words, otherwise the reply
   is replaced by the tools' own summaries. The reply is spoken with Sarvam streaming TTS (`bulbul:v4-flash`) as
   PCM frames; speaking over KAIRA stops playback (barge-in).

`POST /agent/turn` runs one typed turn through the same orchestrator. Without `SARVAM_API_KEY` the live socket
closes with `PROVIDER_NOT_CONFIGURED` after connecting.

### 6.2 Extract and approve (REST)

1. **Transcribe.** `POST /voice/transcribe` sends recorded audio (up to Sarvam's 30-second limit) to Saaras v4 in
   `transcribe` mode (Telugu, Hindi, English, or auto-detect). Raw audio is not stored.
2. **Extract.** `POST /assistant/extract` sends only the transcript and today's date to `sarvam-105b` with a JSON
   schema. Without a key, a deterministic English rules extractor is used (`AI_EXTRACTION_PROVIDER=auto`).
3. **Validate.** Output is checked against a fixed schema. Any value without a verbatim evidence fragment in the
   transcript is removed. Customers and invoices are matched locally; customer data is never sent to the model.
4. **Propose.** Write intents become a `pending` proposal with evidence, warnings and a derived confidence level.
   Questions are answered from backend data.
5. **Approve.** `POST /actions/{id}/approve` is owner-only (see section 7).
6. **Speak.** `POST /voice/speak` reads answers aloud with Bulbul v4 Flash. The model and voice are always sent
   explicitly (en `aparna_en_companion`, hi `aparna_hi_customer`, te `kavitha_te_conversation`), and startup refuses a
   voice that does not belong to the configured model.

The REST client retries only on 429/5xx and timeouts, with exponential backoff, and never retries 400/402/403/422 or
an exhausted spend budget. Without `SARVAM_API_KEY`, the voice endpoints return `503 PROVIDER_NOT_CONFIGURED` and
typed input keeps working.

## 7. Financial integrity and approval model

- **The server decides, not the model.** The agent's write tools and REST extraction both produce proposals. Whether a
  proposal executes now, is read back, waits for clarification or waits for the owner is decided by server code
  (`autonomy_decision` in `app/services/agent/tools.py`). The model never approves, never sets identity or role,
  and has no SQL access. REST extraction only creates `pending` proposals.
- **Deterministic code calculates.** Money is `Decimal` / `NUMERIC(14,2)`. Outstanding balances, remaining amounts and
  forecasts are derived from the ledger and never stored or taken from the model. Spoken amounts and date words are
  parsed server-side; when they disagree with what the model passed, KAIRA asks or reads back instead of writing.
- **The owner authorises.** Staff writes and REST proposals need an owner approval, a separate owner-only request. It
  locks the proposal, re-validates against current data and executes every operation in one transaction. Rejection
  writes nothing. Owner instructions executed by the agent use the same approve path in the same transaction.
- **Exactly once.** Payments carry an `Idempotency-Key` bound to a SHA-256 fingerprint of the request. An exact retry
  replays; the same key with different details is `422 IDEMPOTENCY_KEY_REUSED`. A duplicate or concurrent approval
  executes once. Agent tool calls have their own execution records, so a repeated turn or tool call replays the
  stored result. The server-side `payment_attempts` registry lets any device resolve a payment whose response was
  lost.
- **Audited.** Every payment, commitment, proposal transition, login and attempt transition writes an `audit_logs`
  row, linked to the approved action where there is one.
- **No overpayment.** Payments and promises are capped at what is actually outstanding. A promise for "the
  remaining amount" supersedes earlier pending promises on that invoice. A payment correction records only an
  increase as the difference; a decrease is refused.

## 8. Security considerations

HttpOnly cookie sessions with rotating refresh tokens and reuse detection; CSRF token on every unsafe request; Argon2id
passwords; per-business isolation on every lookup; rate limits shared across workers through PostgreSQL (login, AI,
payments); request size limits and audio magic-byte checks; one error envelope with no stack traces or SQL; prompt
injection handled by schema-restricted output, evidence checks against the user's own words and the server-side
autonomy policy. Staging and production refuse to start with weak or missing secrets or insecure cookies. The Sarvam
key stays on the server and is never logged. The frontend proxy forwards only `/api/v1` paths. The live voice
WebSocket is the exception: the browser connects to the backend directly with a single-use ticket, and its `Origin`
must be in `CORS_ORIGINS`. Full details and the 2026-11-22 review:
[docs/SECURITY.md](docs/SECURITY.md).

## 9. Setup

Prerequisites: Docker (the only hard requirement); Python 3.11+ for local tests; Node 20.9+ (22 LTS recommended) for the frontend.

```powershell
# backend (cd backend)
.\scripts\setup.ps1      # Linux/macOS: ./scripts/setup.sh
                         # creates .env with a generated JWT secret and demo password, starts PostgreSQL, builds the
                         # API image, checks config, migrates, seeds the demo business, creates .venv
.\scripts\start.ps1      # starts db + api and waits for /ready  ->  http://127.0.0.1:8000/docs

# frontend (cd ..\kaira-frontend)
.\scripts\setup.ps1      # npm ci, .env.local, checks; set BACKEND_ORIGIN=http://127.0.0.1:8000 if needed
.\scripts\start.ps1      # http://localhost:3000
```

Sign in as `DEMO_OWNER_EMAIL` / `DEMO_OWNER_PASSWORD` from the backend `.env`. Other scripts: `stop`, `verify` (all
quality gates), `backup`, `restore -Confirm`.

## 10. Environment variables

Templates: [.env.example](.env.example) (development) and [.env.production.example](.env.production.example). Never
commit `.env`.

All application settings are declared in `app/core/config.py`; the table lists every one. The last four rows are
read by the container entrypoint, Docker Compose or pytest, not by `config.py`.

| Variable | Default | Purpose |
|---|---|---|
| `APP_NAME`, `APP_ENV`, `DEBUG` | KAIRA, development, false | `staging`/`production` enforce secure settings |
| `LOG_LEVEL`, `LOG_FORMAT`, `API_V1_PREFIX` | INFO, json, /api/v1 | Logging and API prefix |
| `RUN_MIGRATIONS_ON_START` | false | When `true`, the container entrypoint waits for the database and runs `migrate` before starting uvicorn |
| `DATABASE_URL` | dev: local `kaira` database | PostgreSQL DSN (`postgresql+psycopg://…`). Required in staging/production. Use `127.0.0.1`, not `localhost`, on Windows (avoids a 5 s IPv6 fallback) |
| `DATABASE_POOL_SIZE` / `_MAX_OVERFLOW` / `_POOL_TIMEOUT` | 5 / 10 / 30 | Connection pool (per worker process) |
| `DEFAULT_CURRENCY`, `DEFAULT_TIMEZONE`, `DEFAULT_OVERDUE_COLLECTION_DELAY_DAYS` | INR, Asia/Kolkata, 30 | Defaults for new businesses |
| `JWT_SECRET_KEY` | generated by setup | Session and WebSocket-ticket signing; ≥ 32 characters in staging/production |
| `ACCESS_TOKEN_EXPIRE_MINUTES`, `REFRESH_TOKEN_EXPIRE_DAYS` | 15, 7 | Session lifetime |
| `COOKIE_SECURE`, `COOKIE_SAMESITE`, `COOKIE_DOMAIN` | false, lax, unset | Cookie flags; `COOKIE_SECURE=true` required in staging/production |
| `FRONTEND_ORIGIN`, `CORS_ORIGINS` | http://localhost:3000 | Allowed browser origins (comma-separated). The live WebSocket's `Origin` is checked against `CORS_ORIGINS` |
| `MAX_REQUEST_BYTES`, `MAX_AUDIO_UPLOAD_BYTES` | 1 MB, 5 MB | Request limits |
| `RATE_LIMIT_LOGIN_PER_MINUTE`, `_AI_`, `_PAYMENT_` | 10, 30, 60 | Throttling (agent turns use the AI limit) |
| `RATE_LIMIT_BACKEND` | postgres | `postgres` is shared by all workers; `memory` is single-process only |
| `SARVAM_API_KEY` | unset | Enables live voice, the agent LLM and LLM extraction. Server-side only |
| `SARVAM_BASE_URL` | https://api.sarvam.ai | REST base; the realtime WebSocket base is derived from it |
| `SARVAM_STT_MODEL`, `SARVAM_STT_MODE` | saaras:v4, transcribe | Speech-to-text |
| `SARVAM_LLM_MODEL`, `SARVAM_LLM_REASONING_EFFORT`, `SARVAM_LLM_MAX_TOKENS` | sarvam-105b, low, 4096 | Agent and extraction LLM |
| `SARVAM_TTS_MODEL`, `SARVAM_TTS_SPEAKER_TE/HI/EN` | bulbul:v4-flash; kavitha_te_conversation / aparna_hi_customer / aparna_en_companion | Speech output; voices must belong to the model |
| `SARVAM_TTS_PACE`, `_SAMPLE_RATE`, `_CODEC` | 1.0, 22050, wav | REST speech output format |
| `SARVAM_TIMEOUT_SECONDS`, `SARVAM_MAX_RETRIES` | 60, 2 | REST provider calls |
| `AI_EXTRACTION_PROVIDER` | auto | `auto` (Sarvam with a key, otherwise rules), `sarvam` or `rules` |
| `AGENT_STT_LANGUAGE`, `AGENT_STT_STREAM_TYPE` | auto, fast | Realtime STT language (`auto`, or `te-IN`/`hi-IN`/`en-IN` to pin one) and stream type |
| `AGENT_VAD_THRESHOLD`, `_SILENCE_MS`, `_PREFIX_PADDING_MS`, `_MIN_SPEECH_MS` | 0.3, 900, 300, 250 | Sarvam server VAD |
| `AGENT_TTS_SAMPLE_RATE` | 22050 | PCM sample rate sent to the browser |
| `AGENT_MAX_TOOL_STEPS`, `AGENT_TURN_TIMEOUT_SECONDS`, `AGENT_HISTORY_MESSAGES` | 6, 60, 16 | Bounds of one agent turn |
| `AGENT_TICKET_TTL_SECONDS`, `AGENT_MAX_SESSION_MINUTES` | 60, 120 | WebSocket ticket lifetime; maximum live session length |
| `AGENT_AUTONOMY` | auto | `auto`: clear, evidenced owner instructions execute; `confirm`: every write waits for a "yes". Staff writes always wait for the owner |
| `AGENT_PUBLIC_WS_URL` | ws://127.0.0.1:8000/api/v1/agent/live | Where browsers open the live WebSocket (`wss://…` in production) |
| `DEMO_OWNER_EMAIL`, `DEMO_OWNER_PASSWORD` | demo@kaira.local, generated by setup | Development seed |
| `WEB_CONCURRENCY`, `PORT`, `FORWARDED_ALLOW_IPS` | 1, 8000, 127.0.0.1 | Container entrypoint: uvicorn workers, port, trusted proxy IPs |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_HOST_PORT`, `API_HOST_PORT` | kaira, kaira_dev_password, kaira, 5432, 8000 | `docker-compose.yml` only |
| `TEST_DATABASE_URL` | `DATABASE_URL` with database `kaira_test` | pytest (database name must end in `_test`) |
| `KAIRA_OWNER_PASSWORD`, `KAIRA_USER_PASSWORD` | unset (prompted) | Passwords for `create-owner` / `create-user` in non-interactive use |

Frontend (`.env.local`): `BACKEND_ORIGIN` (server-only, required), `BACKEND_TIMEOUT_MS`, `TRUSTED_CLIENT_IP_HEADER`,
`NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_APP_ENV`. The frontend never holds database credentials, JWT secrets or Sarvam
keys, and its env check refuses them.

## 11. Database setup and migrations

All schema changes go through Alembic (`alembic/versions`, head `b3f1c7a9e2d4`).

```
python -m app.cli migrate          # apply migrations (setup and start do this)
python -m app.cli seed             # idempotent demo business
python -m app.cli seed --reset     # development/test only: restore the demo data with dates relative to today
python -m app.cli check-config | wait-db | export-openapi [path]
python -m app.cli create-owner --business "Name" --email you@example.com --name "You"
python -m app.cli create-user --owner-email … --email … [--role staff]
python -m app.cli reconcile-payment-attempts [--dry-run]   # resolve stale pending payment attempts from proof
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

Suites: `tests/unit` (config, parsing, date and number resolution, agent tools, Sarvam REST and realtime adapters,
live-session rules), `tests/api` (auth, finance core with concurrency and cross-business isolation, forecast and
non-mutating simulation, assistant and approvals, payment idempotency, payment attempts and reconciliation, shared
rate limiting), `tests/agent` (orchestrator, autonomy policy, read tools, `/agent/*` HTTP and WebSocket endpoints,
acceptance scenarios), `tests/integration` (demo workflow, seed reset, CLI users). Every Sarvam call in pytest is
mocked (`tests/agent/conftest.py` uses a scripted fake LLM and in-process STT/TTS fakes); live runs are listed in
section 15.

Frontend (`../kaira-frontend`): `npm run lint`, `npm run typecheck`, `npm test` (Vitest), `npm run build`, and
Playwright end-to-end tests against a real backend (`E2E_EMAIL=… E2E_PASSWORD=… npm run test:e2e`; use a disposable
database).

CI lives at the repository root in `.github/workflows/`:

| Workflow | Trigger | Runs |
|---|---|---|
| `backend.yml` | push to `main` (always), push to `feat/**` and PRs when `backend/` changed, manual, called by others | Ruff lint and format, migrations, `alembic check`, downgrade/upgrade round trip, OpenAPI drift check, pytest on a PostgreSQL service, pip-audit, Docker build, and a check that the image refuses insecure production configuration |
| `frontend.yml` | same pattern for `kaira-frontend/` | env template, contract and generated types, lint, typecheck, Vitest, build, `npm audit --omit=dev`, Docker build; a staging Playwright job only when `vars.E2E_BACKEND_ORIGIN` is set |
| `e2e.yml` | same pattern for either folder | PostgreSQL service, migrated and seeded backend, staff user, production frontend build, Playwright. No secrets; credentials are generated per run. Specs that need the live agent LLM skip themselves |
| `full-suite.yml` | manual | the three workflows above, without path filters |
| `backend-deploy.yml` | manual, typed confirmation, `production` environment approval | `backend.yml`, then the host's deploy hook and a `/ready` poll |

After any API change, run `python -m app.cli export-openapi` and commit `docs/openapi.json` (CI fails on drift). The
frontend imports that file into `contracts/` and regenerates its types with `npm run contract:generate`.

## 13. Docker and deployment

- `docker-compose.yml` (development): PostgreSQL bound to `127.0.0.1`, and the API on port 8000 with
  `RUN_MIGRATIONS_ON_START=true`.
- `Dockerfile`: python:3.11-slim, non-root user, uvicorn workers (`WEB_CONCURRENCY`), health check on `/health`. The
  entrypoint (`docker/entrypoint.sh`) validates configuration, refuses insecure production settings, runs
  `wait-db` and `migrate` when `RUN_MIGRATIONS_ON_START=true`, then starts uvicorn on `PORT`.
- `docker-compose.prod.yml`: the API only, with managed PostgreSQL from `.env.production`.
- Frontend `Dockerfile`: Next.js standalone, Node 22 Alpine, non-root; `BACKEND_ORIGIN` is read at runtime.

The free-tier target is a Render web service (Docker, root directory `backend`) with Supabase PostgreSQL through the
session pooler, and the frontend on Vercel with `BACKEND_ORIGIN` set server-side. The Render free plan has no
pre-deploy command and sleeps when idle, so migrations run on start (`RUN_MIGRATIONS_ON_START=true`) and the first
request after idle is slow. Step-by-step procedure, variables and the manual deploy workflow:
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

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

With `SARVAM_API_KEY` set, the same statement spoken or typed to the KAIRA agent (the orb on `/agent`, or
`POST /agent/turn`) is executed directly for the owner: one payment and one promise for the remainder, with the
same balances, and no separate approval step.

## 15. Verification status

This section matches the status in the root `README.md`.

| Check | Result |
|---|---|
| Backend tests | 507 tests collected at commit `a05050b` (`pytest --collect-only`); pass/fail is reported by the `backend-ci` workflow, which also runs Ruff, the migration round trip, `alembic check` and the OpenAPI drift check. OpenAPI: API 1.2.0, 47 paths (`docs/openapi.json`) |
| Frontend | lint, typecheck, Vitest and production build run in `frontend-ci` |
| End to end | `e2e.yml` runs Playwright against a freshly migrated and seeded backend in CI; specs that need the live agent LLM are skipped there |
| Live `sarvam-105b` agent (typed turns, disposable database) | Exercised: balance question, clarification when the amount is missing, payment, invoice creation, correction recorded as the difference after a later "yes", ambient chatter ignored, "mark INV-0001 paid" refused, Telugu and Hindi payment + promise. Details in the root README |
| Live WebSocket pipeline (Sarvam STT → agent → Sarvam TTS) | Exercised with Sarvam-synthesized speech streamed in real time as a loopback: English question, Telugu payment statement, barge-in, billed STT seconds recorded |
| Not yet verified | A human speaking into a browser microphone; the configured voices have not been auditioned by a person |

## 16. Known limitations

- Live voice has been exercised only with synthesized loopback speech, not a human microphone.
- Without `SARVAM_API_KEY`, the live agent is unavailable and REST extraction uses the English rules engine, which
  covers the documented phrasings but is not a general language model. Telugu and Hindi need the key.
- The configured voices are from Sarvam's catalog but have not been auditioned by a person.
- Relative dates follow fixed rules in the business timezone: "next Monday" is the first Monday after today, so said
  on a Sunday it means the next day. Hindi "कल" / "परसों" without a clear tense are asked, not guessed.
- The live WebSocket ticket's single-use check and the one-live-socket-per-user rule are kept in process memory, so
  they hold per worker process.
- The browser listens only while the page is open and the live session is on; background listening would need a
  native app.
- There is no e-mail service, so there's no password reset or invitations. The CLI creates accounts.
- Access tokens remain valid for up to 15 minutes after logout (refresh tokens are revoked immediately).
- Behind the frontend proxy, the per-IP login limit is shared; the per-e-mail limit still applies.
- Reminders are drafted, never sent.

## 17. Hackathon submission

- Repository: https://github.com/Tapanp1710/codebeners-kaira (public). Backend in `backend/`, frontend in
  `kaira-frontend/`.
- The presentation and demo video are submitted separately and are not stored in this repository.
