# System architecture

KAIRA is two independently deployed applications.

```
 kaira-frontend (Next.js)  ──HTTPS/JSON, cookies + CSRF──►  kaira-backend (FastAPI, modular monolith)
                                                              │
                         ┌────────────────────────────────────┼─────────────────────────┐
                         ▼                                    ▼                         ▼
                 Business services                    Financial engine             AI services
         customers / invoices / payments /        ledger (derived balances),   extraction (Sarvam LLM or
         bills / commitments / audit              receivables, forecast,       deterministic rules), evidence
                                                  simulation, insights         check, resolution, proposals,
                         │                                    │                approval executor, queries,
                         └──────────────► PostgreSQL ◄────────┘                reminders, Sarvam STT/TTS
                                          (single source of truth; audit_logs)
```

## Backend layout

| Path | Responsibility |
|---|---|
| `app/main.py` | App factory, middleware (request ID + access log, body-size limit, CORS), lifespan |
| `app/core/` | Settings and validation, security (Argon2, JWT, CSRF), errors and handlers, logging, rate limiter |
| `app/db/` | Declarative base, engine/session, FastAPI dependencies (`Auth`, `OwnerAuth`), Alembic helpers |
| `app/models/` | SQLAlchemy models (see DATABASE_SCHEMA.md) |
| `app/schemas/` | Pydantic request/response models (the OpenAPI contract) |
| `app/services/` | Business logic. Services **flush**; endpoints **commit**, so an approved AI action runs many operations in one transaction |
| `app/services/ai/` | Text parsing, extractors, resolution and confidence, proposed actions, assistant |
| `app/integrations/sarvam/` | Sarvam REST adapter (timeouts, retries, error mapping) |
| `app/api/v1/` | Routers and presenters |
| `app/cli.py`, `app/seed.py` | Operational commands and the idempotent demo seed |

## Request lifecycle

`RequestContextMiddleware` assigns `X-Request-ID`, then the `BodySizeLimitMiddleware` (413), then CORS,
then the router. The `Auth` dependency validates the cookie or bearer JWT, enforces CSRF on unsafe cookie
requests, and loads the user and business. Every service query is filtered by `business_id`.
Errors become the envelope in `app/core/handlers.py`.

## Concurrency model

* `SELECT … FOR UPDATE` on the invoice (payments, commitments), the bill (bill payments), the business row
  (invoice number allocation) and the proposed action (approve/reject/edit).
* Unique constraints back up the logic: `(business_id, idempotency_key)` on payments,
  `(source_type, source_id)` on cash transactions, `(business_id, invoice_number)`.
* Simulation runs inside `SET TRANSACTION READ ONLY`.

## Deployment shape

A single Docker image (`Dockerfile`) running uvicorn workers behind any HTTPS reverse proxy or PaaS,
with managed PostgreSQL. No Redis, queue or microservices: the workload is not big enough to justify them
(see DECISIONS.md).
