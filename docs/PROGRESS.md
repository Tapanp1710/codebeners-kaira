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
