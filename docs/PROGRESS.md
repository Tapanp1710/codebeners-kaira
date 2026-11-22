# Progress

## Done (backend, branch `feat/kaira-backend`)

| Phase | Status |
|---|---|
| 0 Workspace discovery | Done. Backend repo identified. Python 3.11.0, Node 20.15.1, Docker 24.0.5 / Compose 2.20.2 available; no host PostgreSQL (Docker is used) |
| 1 Architecture & docs | Done (this folder) |
| 2 Backend foundation | Done: config validation, logging + request IDs, error envelope, health/readiness, limits |
| 3 Database | Done: 14 tables, Alembic migration, constraints, indexes |
| 4 Core operations | Done: auth, customers, invoices, payments, bills, bill payments, commitments, cash transactions, audit |
| 5 Financial modules | Done: dashboard, receivables, cash position, forecast, shortfalls, simulation, insights |
| 6 AI and voice | Done in code: Sarvam STT/TTS/LLM adapters (mock-tested), rules extractor, evidence, resolution, proposals, edit/approve/reject, queries, reminders |
| 9 Production readiness (backend) | Dockerfile, compose (dev/prod), scripts (ps1 + sh), CI and deploy workflows, OpenAPI export, backup/restore |

## Not done / blocked

* **Phase 7 frontend and phase 8 integration** belong to the `kaira-frontend` repository on the other laptop.
  The handoff package is ready (INTEGRATION_HANDOFF.md).
* Live Sarvam verification needs `SARVAM_API_KEY`.
* Hosting provider evaluation and any deployment need the owner's choice and approval.
* GitHub Actions has not run: the repository has no remote yet.

## Resume checklist

`git status`, read this file and INTEGRATION_STATUS.md, `docker compose up -d db`, `scripts/verify`.

## Payment integrity and recovery (branch `feat/payment-integrity`, 2026-11-22)

Based on `docs/backend-comment-annotations` (`b40315e`), which preserves comment-only edits found uncommitted on
`feat/kaira-backend` (verified code-identical to `357bc56` by AST comparison).

| Step | Status | Evidence |
|---|---|---|
| Baseline | 120 tests pass on PostgreSQL, ruff check/format clean | local run |
| B1 Request fingerprints | Done: SHA-256 of canonical request on `payments` and `bill_payments` (migration `6b1d2e8f4a10`); exact retry replays, any changed field is 422 `IDEMPOTENCY_KEY_REUSED`; legacy rows compared column-by-column; unique-key races resolved through a savepoint | `tests/api/test_payment_idempotency.py` (26 tests, real PostgreSQL, incl. concurrency) |
| B2 Payment-attempt registry | Done: `payment_attempts` table (migration `d50345d81159`), `/api/v1/payment-attempts` register/list/get/execute/cancel, state machine in docs/PAYMENT_ATTEMPTS.md | — |
| B3 Recovery tests | Done: 22 PostgreSQL tests (other device, server restart, crash before commit, full payment replay, isolation, concurrency, cancellation races). Suite 168 passed; `alembic check` clean | `tests/api/test_payment_attempts.py` |
| B4 Seed reproducibility | Done: seed stays idempotent; `seed --reset` (development/test only, demo business matched by owner email **and** name) re-anchors scenario dates to today | `tests/integration/test_seed_reset.py` (5 tests) + CLI run on a scratch DB: seed ×2 identical counts, reset → same counts, production refused |
| B5 Rate limiting | Done: limiter counters moved to PostgreSQL (`rate_limit_buckets`, migration `6462ead8dd6e`, sliding window on the DB clock). The 2-worker image previously doubled every limit. Added a per-user limit on payment-attempt writes and action approval | `tests/api/test_rate_limit_shared.py`: two engines, **3 separate OS processes** (36 attempts against a budget of 15 → exactly 15 accepted), login across two app instances. Suite 178 passed |
| B6 Security review | Done: no new high-severity issues beyond B1 and B5 (both fixed); findings table in docs/SECURITY.md; CSRF regression test for payment-attempt writes | `test_csrf_is_required_for_attempt_writes` |
| B7 Account management | Assessed: no e-mail service, so no fake reset or invite flow. Added `cli create-user` (staff/owner in an existing owner's business, audited, password from env or prompt) | `tests/integration/test_cli_users.py`; suite 181 passed |
| Phase 4 Handoff | Done: API 1.1.0 (43 paths, 117 schemas); `docs/openapi.json` regenerated and checked; API_CONTRACT, DATABASE_SCHEMA and INTEGRATION_HANDOFF updated | export-openapi diff clean; suite 181 passed |
| Phases 5–8 (frontend, kaira-frontend `feat/server-payment-recovery`) | Done: contract 1.1.0 imported; server-side recovery; pending visibility; proxy hardening; contract script; line-item errors; pagination; logout privacy; voice test fixed | 122 unit tests; Playwright 18/18 against a disposable backend built from this branch (incl. cross-device and `RUN_ACCEPTANCE=1`) |
| Phase 9 final verification | 181 passed; ruff check/format clean; OpenAPI current; migrations base→head→base→head and `alembic check` clean; Docker image builds | local run, 2026-11-22 |

### Remaining (external or owner decisions)

* **Live Sarvam:** STT, LLM extraction and TTS in Telugu, Hindi and English are not verified, because `SARVAM_API_KEY` is
  absent. Mocked provider tests and the typed fallback pass.
* **GitHub Actions:** never run (nothing was pushed). The workflow YAML parses, and the same steps pass locally.
* **E-mail:** there is no provider, so there's no password reset or invitations. `cli create-user` covers account
  creation.
* **Deployment:** not deployed. Hosting, TLS, `FORWARDED_ALLOW_IPS` and the frontend's `TRUSTED_CLIENT_IP_HEADER`
  are decisions for the owner.

### Resume

```bash
git checkout feat/payment-integrity        # backend; base docs/backend-comment-annotations
docker compose up -d db
.venv/Scripts/python -m pytest -q          # expects 181 passed
```

## Publication (2026-11-22)

| Item | Value |
|---|---|
| GitHub repository | https://github.com/Tapanp1710/codebeners-kaira (holds the backend and the frontend as **separate branches**; histories are unrelated and not merged) |
| Backend branch | `feat/payment-integrity` (the repository's default branch, because it was pushed first to the empty repository) |
| Frontend branch | `feat/server-payment-recovery` |
| API contract | 1.1.0 (43 paths). The frontend's `contracts/openapi.json` is byte-for-byte identical to `docs/openapi.json`, which matches the spec the app generates. All 41 endpoint/method pairs the frontend calls exist |
| GitHub Actions, backend | run `44998117015` on `8b856ea` **failed**: two config tests read CI's job-level env (pre-existing). Fixed in `0c37f8d`; run `44998826389` **passed** (ruff, migrations, `alembic check`, round trip, OpenAPI, pytest on PostgreSQL, pip-audit, Docker build and insecure-config refusal) |
| GitHub Actions, frontend | run `44998134229` on `4df2b11` **passed** (env template, contract, lint, typecheck, tests, build, audit, Docker build). The e2e job is skipped: the `E2E_BACKEND_ORIGIN` variable is not set |
| Secret scan before pushing | no secrets in the working tree or in any commit of either repository; only `.env.example` templates are tracked |

Repository settings the owner may add (none are needed for CI to pass):
- `DEPLOY_HOOK_URL` (secret, backend `deploy.yml`): the hosting provider's deploy hook. Deploy runs only manually, with a typed confirmation, and nothing has been deployed.
- `E2E_BACKEND_ORIGIN` (variable), plus `E2E_EMAIL` and `E2E_PASSWORD` (secrets), for the frontend `e2e` job. They must point at a **disposable** backend, never production.
- `SARVAM_API_KEY` stays out of CI. Live provider checks are a manual step.
