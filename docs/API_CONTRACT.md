# KAIRA API Contract (v1.0.0)

The backend owns this contract. The machine-readable source of truth is
[`docs/openapi.json`](openapi.json) (regenerate with `python -m app.cli export-openapi`;
CI fails if it drifts from the code). This document explains the conventions the OpenAPI
file cannot express. The frontend must not invent endpoints or fields.

## Base URL

`{NEXT_PUBLIC_API_BASE_URL}` = `http(s)://<host>:<port>/api/v1` (e.g. `http://localhost:8000/api/v1`).
Operational endpoints `/health` and `/ready` also exist without the prefix.

## Envelope

Every response, success or failure:

```json
{ "success": true,  "data": { ... }, "error": null }
{ "success": false, "data": null, "error": { "code": "VALIDATION_ERROR", "message": "…", "details": {} } }
```

`message` is safe to show to the owner. `details` is structured (validation errors are in
`details.errors[] = {loc, msg, type}`).

## Data conventions

| Kind | Format | Example |
|---|---|---|
| Money | decimal **string**, 2 places, INR | `"5000.00"` |
| Money input | string or number, > 0, ≤ 2 decimals | `"5000"`, `"5000.50"` |
| Date | ISO 8601 date | `"2026-11-23"` |
| Timestamp | ISO 8601 UTC | `"2026-11-21T10:30:00Z"` |
| IDs | UUID strings | |

Never do financial arithmetic on money strings in the browser. Every total, balance,
status and projection comes from the API.

## Pagination and filtering

List endpoints accept `page` (≥1, default 1) and `page_size` (default 50, max 200; actions max 100)
and return `data = { items: [...], total, page, page_size }`. Filters are query parameters documented
per endpoint in OpenAPI (`status`, `customer_id`, `search`, date ranges, `sort` with `-` prefix for descending).

## Authentication (browser)

* `POST /auth/login {email, password}` → sets **HttpOnly** cookies `kaira_access` (15 min) and
  `kaira_refresh` (7 days, path `/api/v1/auth`) and returns `data.csrf_token`.
* All requests must be sent **with credentials** (`fetch(url, { credentials: "include" })`).
* For `POST/PATCH/PUT/DELETE` send header `X-CSRF-Token: <csrf_token>`. Keep the token **in memory**
  (not localStorage). After a reload, call `GET /auth/me` to obtain it again.
* When a request returns `401` with `error.code` `SESSION_EXPIRED` or `UNAUTHENTICATED`, call
  `POST /auth/refresh` once (no CSRF needed). It rotates cookies and returns a **new** `csrf_token`.
  Then retry. If refresh fails → redirect to login.
* `POST /auth/logout` revokes the refresh token and clears cookies.
* Non-browser clients may use `Authorization: Bearer <access token>`; CSRF does not apply.
* Roles: `owner` (everything) and `staff` (cannot approve/reject actions or change business settings → `403 FORBIDDEN`).

## Idempotency

`POST /invoices/{id}/payments` and `POST /bills/{id}/payments` accept an optional
`Idempotency-Key` header. Retrying with the same key returns the original payment with
`replayed: true` and never records a second payment. Generate one key per user submission
(e.g. `crypto.randomUUID()`), reuse it on retry.

## Endpoints

| Method & path | Purpose |
|---|---|
| `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me` | Session |
| `GET/PATCH /business/settings` | Business profile, opening cash, overdue assumption, shortfall threshold (PATCH: owner) |
| `GET /dashboard` | Cash, receivables, overdue, upcoming bills (14 days), recent payments, forecast summary, alerts, recent activity, pending action count |
| `GET/POST /customers`, `GET/PATCH /customers/{id}` | Customers with balances (`outstanding`, `overdue`, `pending_commitments`…); detail includes commitments |
| `GET /customers/{id}/invoices`, `GET /customers/{id}/payments` | History |
| `GET/POST /invoices`, `GET/PATCH /invoices/{id}` | Invoices with items; totals derived. PATCH: dates/notes, items (only without payments), `lifecycle_status: "void"` (only without payments) |
| `GET /invoices/{id}/payments`, `POST /invoices/{id}/payments` | Partial/full payments; rejects overpayment (`OVERPAYMENT`) |
| `GET /payments` | All payments (filters) |
| `GET /receivables`, `GET /receivables/summary` | Open invoices with ageing (`current`,`1_30`,`31_60`,`61_90`,`90_plus`) and commitments; totals |
| `GET/POST /bills`, `GET/PATCH /bills/{id}`, `POST /bills/{id}/payments` | Payables |
| `GET/POST /payment-commitments`, `PATCH /payment-commitments/{id}` | Promised payments (statuses `pending`,`fulfilled`,`cancelled`,`broken`) |
| `GET /cashflow/position` | Actual current cash |
| `GET /cashflow/forecast?horizon_days=90&granularity=daily\|weekly` | Projection (`value_type: "projected"`) |
| `POST /cashflow/simulate` | What-if delay (`value_type: "simulated"`, `is_simulation: true`). Body: exactly one of `customer_id`, `invoice_id`, `largest_customer: true` + `delay_days` (+ `horizon_days`) |
| `POST /voice/transcribe` | multipart `file` (+ `language_code` `te-IN`/`hi-IN`/`en-IN`/`unknown`) → transcript. ≤ 30 s audio (Sarvam limit), ≤ 5 MB |
| `POST /voice/speak` | `{text, language_code, speaker?, pace?}` → `{audio_base64, mime_type, …}` |
| `POST /assistant/extract` | `{transcript, language?, input_mode}` → `kind`: `proposal` \| `answer` \| `reminder` \| `unknown` |
| `POST /assistant/query` | Read-only question → answer computed by backend |
| `POST /assistant/reminder` | `{customer_id, invoice_id?, language, tone}` → editable draft (never sent) |
| `GET /actions`, `GET/PATCH /actions/{id}` | Proposed actions; PATCH replaces `operations` (re-validated) |
| `POST /actions/{id}/approve` | Owner only. Executes transactionally; repeat returns `replayed: true` |
| `POST /actions/{id}/reject` | Owner only. `{reason?}`; no financial change |
| `GET /insights` | Data-driven alerts (`severity`: critical/warning/info) |
| `GET /audit-logs` | Filter by `entity_type`, `entity_id`, `source_action_id` |
| `GET /health`, `GET /ready` | Liveness; readiness (database, migrations, provider configuration) |

## Voice → proposal → approval flow (frontend)

1. Record with explicit mic interaction → `POST /voice/transcribe` (or let the user type).
2. Show the transcript, allow editing.
3. `POST /assistant/extract {transcript, language, input_mode}`.
4. `kind == "proposal"` → render `proposal.operations[]`:
   `type`, `fields` (amount, dates, method…), `customer` / `invoice` resolution
   (`status`: `resolved`/`ambiguous`/`not_found`/`new`/`not_applicable`, `candidates[]`),
   `missing_fields`, `computed` (e.g. `remaining_amount`, `invoice_outstanding_after`),
   plus `evidence[]`, `warnings[]` (`blocking: true` prevents approval), `confidence_level`, `can_approve`.
5. Edit → `PATCH /actions/{id} {operations: [...]}` (send `customer_id` / `invoice_id` chosen from candidates).
6. Approve → `POST /actions/{id}/approve`; show success **only** after `200` with `action.status == "executed"`,
   then refetch dashboard, receivables, forecast.
7. Optionally speak `answer.answer` with `POST /voice/speak`.

## Error codes

| HTTP | Codes |
|---|---|
| 401 | `UNAUTHENTICATED`, `SESSION_EXPIRED`, `INVALID_CREDENTIALS`, `ACCOUNT_INACTIVE` |
| 403 | `FORBIDDEN`, `CSRF_FAILED` |
| 404 | `NOT_FOUND` (also for records of another business) |
| 405 | `METHOD_NOT_ALLOWED` |
| 409 | `CONFLICT`, `ACTION_NOT_PENDING` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 422 | `VALIDATION_ERROR`, `OVERPAYMENT`, `INVOICE_ALREADY_PAID`, `BILL_ALREADY_PAID`, `INVOICE_VOID`, `INVOICE_HAS_PAYMENTS`, `INVOICE_CUSTOMER_MISMATCH`, `IDEMPOTENCY_KEY_REUSED`, `AMOUNT_BELOW_PAID`, `COMMITMENT_EXCEEDS_OUTSTANDING`, `INVALID_AMOUNT`, `INVALID_STATUS`, `INVALID_HORIZON`, `INVALID_DELAY`, `TARGET_REQUIRED`, `NO_RECEIVABLES`, `NOTHING_TO_DELAY`, `NOTHING_OUTSTANDING`, `NOTHING_REMAINING`, `ACTION_NOT_EXECUTABLE` |
| 429 | `RATE_LIMITED` (`Retry-After` header) |
| 500 | `INTERNAL_SERVER_ERROR` |
| 502 | `PROVIDER_ERROR` (AI/voice provider rejected the request or returned invalid output) |
| 503 | `PROVIDER_NOT_CONFIGURED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_RATE_LIMITED`, `PROVIDER_TIMEOUT`, `DATABASE_UNAVAILABLE`, `NOT_READY` |

Proposal warning codes: `AMBIGUOUS_CUSTOMER`, `AMBIGUOUS_INVOICE`, `CUSTOMER_NOT_FOUND`, `NO_OPEN_INVOICE`,
`FUZZY_CUSTOMER_MATCH`, `POSSIBLE_DUPLICATE_CUSTOMER`, `OVERPAYMENT`, `DATE_DEFAULTED`, `DATE_IN_PAST`,
`NOTHING_REMAINING`, `UNSUPPORTED_VALUE_REMOVED`, `NOT_UNDERSTOOD`, `EDITED_BY_OWNER`.

Every response carries `X-Request-ID` (echoed if the client sends a safe one); include it in bug reports.
