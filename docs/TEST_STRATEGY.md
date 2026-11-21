# Test strategy

Tests run against **real PostgreSQL** (`kaira_test`; set `TEST_DATABASE_URL` to override). The schema is
built from the Alembic migrations once per session and every table is truncated before each test. A
safeguard refuses any database whose name does not end in `_test`.

```
python -m pytest -q            # or scripts/verify.(ps1|sh) for every gate
```

| Suite | Covers |
|---|---|
| `tests/unit/test_config.py` | defaults, env overrides, production refusal of weak/missing secrets |
| `tests/unit/test_ai_units.py` | amount/date parsing, invoice refs, name scoring, INR formatting, evidence dropping, LLM output parsing, rules extractor intents |
| `tests/api/test_health.py` | envelope, readiness (db + migrations), request ID, CORS preflight, 413, OpenAPI endpoint coverage |
| `tests/api/test_auth.py` | HttpOnly cookies, CSRF, bearer, refresh rotation + reuse detection, logout, rate limit, roles |
| `tests/api/test_finance_core.py` | customers, invoice item maths and numbering, void rules, partial/full payments, cash + audit rows, overpayment, idempotency, **concurrent payments**, bills, commitments caps, receivables reconciliation, **cross-business isolation** |
| `tests/api/test_forecast.py` | forecast maths, no double counting, overdue assumption, shortfalls, simulation **non-mutation**, dashboard, opening-cash rule |
| `tests/api/test_assistant.py` | demo phrase → proposal, approval execution, **duplicate and concurrent approval**, rejection, edit, ambiguous customer/invoice, overpayment blocking, prompt injection, staff rules, queries, reminders, missing provider config, upload validation, **mocked** Sarvam STT/LLM/TTS/errors/timeouts/hallucination |
| `tests/integration/test_demo_workflow.py` | seed idempotency and the mandatory end-to-end scenario (spec §17.3) through HTTP |
| `tests/api/test_payment_idempotency.py` | request fingerprints: exact replay, a 422 for each changed field, canonicalisation, omitted date, replay after full payment, rollback, legacy rows, **concurrent exact/conflicting/cross-invoice requests** (invoice and bill) |
| `tests/api/test_payment_attempts.py` | payment-attempt registry: registration replay and conflict, linking a recorded key, **another device** (separate client and user), **server restart** (new app instance), crash before commit, replay after full invoice/bill payment, rejection, unauthenticated and cross-business access, CSRF, **concurrent registration, retry and execute-vs-cancel**, safe/refused/reconciling cancellation |
| `tests/api/test_rate_limit_shared.py` | PostgreSQL rate limiter shared by two engines, by **three separate OS processes**, and across two app instances (login); payment write limit |
| `tests/integration/test_seed_reset.py`, `tests/integration/test_cli_users.py` | seed repeatability, the dev-only reset (re-anchors dates; refuses non-demo businesses and production), `create-user` |

Frontend ↔ backend acceptance (2026-11-22): the kaira-frontend Playwright suite ran 18/18 against a disposable backend
built from this branch, including cross-device payment recovery and `RUN_ACCEPTANCE=1`. A SQL check afterwards
confirmed one payment per key and one cash movement per payment (see kaira-frontend docs/STATUS.md).

Mocked provider tests are labelled as mocked. A live Sarvam test needs `SARVAM_API_KEY` and has **not**
been run (see INTEGRATION_STATUS.md).

CI (`.github/workflows/ci.yml`): ruff lint and format, migrations apply, `alembic check`, downgrade/upgrade round trip,
OpenAPI drift check, pytest with a PostgreSQL service, pip-audit, Docker build, and a check that the image
refuses insecure production configuration.
