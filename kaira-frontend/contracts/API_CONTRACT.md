# KAIRA API Contract (v1.2.0)

The backend owns this contract. The machine-readable source of truth is
[`docs/openapi.json`](openapi.json) (regenerate with `python -m app.cli export-openapi`;
CI fails if it drifts from the code). This document explains the conventions the OpenAPI
file cannot express. The frontend must not invent endpoints or fields.

## Base URL

Backend: `http(s)://<host>:<port>/api/v1` (e.g. `http://127.0.0.1:8000/api/v1`). Operational endpoints `/health`
and `/ready` also exist without the prefix.

The KAIRA web app never calls the backend from the browser for HTTP: it calls its own same-origin proxy
`/api/backend/api/v1/...`, and the Next.js server forwards to `BACKEND_ORIGIN`. The live voice WebSocket is the one
exception: the browser connects to `ws_url` from `POST /agent/session` directly (see "Live voice agent").

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
  A staff user's agent writes are stored as proposals that wait for the owner (`needs_owner_approval`).

## Idempotency

`POST /invoices/{id}/payments` and `POST /bills/{id}/payments` accept an optional `Idempotency-Key` header. One key
stands for **exactly one request**:

- **The same key with an identical request** returns the original payment with `replayed: true`, even when that
  payment already cleared the balance, and never records a second payment.
- **The same key with any difference** in amount, payment date, method, reference or notes (or a different
  invoice or bill) returns **422 `IDEMPOTENCY_KEY_REUSED`** and records nothing. *(v1.1.0: earlier versions compared
  only the target and the amount.)*
- **How requests are compared:**
  - `"400"` equals `"400.00"`.
  - `null`, `""` and whitespace-only reference or notes are the same; any other text is compared exactly.
  - An omitted `payment_date` is not the same as an explicit one, but an omitted date still matches an omitted date
    on a later day.

Generate one key per user submission and resend the **identical** body on retry. For recovery across devices and
browsers, use payment attempts (below), which keep the key and body on the server.

## Payment attempts (v1.1.0): cross-device payment recovery

See PAYMENT_ATTEMPTS.md for the full state machine. Client flow:

1. `POST /payment-attempts` with `{resource_type: "invoice"|"bill", resource_id, amount, payment_date?,
   payment_method, reference?, notes? (invoices only), idempotency_key? (optional, at least 8 characters)}`.
   - **201**: a new `pending` attempt.
   - **200**: the existing attempt. This happens for the same request with no key (a lost registration response, or
     another device), or for the same key with the same request.
   - **409 `PAYMENT_ATTEMPT_PENDING`** (`details.attempt_id`): another request is already pending for that invoice or
     bill. Resolve that one instead.
   - **422 `IDEMPOTENCY_KEY_REUSED`**: the key is already bound to a different request.
   - A client key that is already on a **recorded** payment with the same request gives a `succeeded` attempt linked
     to that payment. Use this to migrate attempts that a browser saved locally.
2. `POST /payment-attempts/{id}/execute`
   - **200**: `status: "succeeded"`, with `result.invoice_payment` or `result.bill_payment` (the same shapes as the
     direct payment endpoints) and `result.replayed`.
   - **422**: refused, nothing recorded; the attempt is now `rejected` (`failure_code`).
   - **409 `PAYMENT_ATTEMPT_CANCELLED`**: the attempt was cancelled.
   - **A network error or 5xx** means the outcome is unknown. Execute again or GET the attempt; both are always safe.
3. `GET /payment-attempts?status=pending` (with `resource_type`, `resource_id`, `page` and `page_size` ≤ 200
   available): any authorised device can find unresolved payments. Each item has `resource_label` (the invoice number
   or vendor) and the frozen `request`.
4. `GET /payment-attempts/{id}` returns the attempt, plus `result` once it has `succeeded`.
5. `POST /payment-attempts/{id}/cancel`
   - **200**: cancelled. Only possible while `pending` and when no payment exists under the key.
   - **409 `PAYMENT_ATTEMPT_NOT_PENDING`**: already succeeded or rejected.
   - **409 `PAYMENT_ALREADY_RECORDED`**: a payment exists under the key, so the attempt becomes `succeeded`.

The idempotency key is never returned. Clients act on the attempt `id`. Writes need the `X-CSRF-Token` header and
are rate limited per user (`RATE_LIMIT_PAYMENT_PER_MINUTE`). Pending attempts never expire on their own; an operator
resolves stale ones with `python -m app.cli reconcile-payment-attempts`, which acts only on proof found under row
locks.

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
| `GET/POST /payment-attempts`, `GET /payment-attempts/{id}`, `POST /payment-attempts/{id}/execute`, `POST /payment-attempts/{id}/cancel` | Server-side payment attempts for cross-device recovery (see above) |
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
| `POST /agent/session` | `{resume_session_id?}` → `{session_id, ticket, ws_url, expires_in, voice_configured, stt_model, tts_model}`: a single-use WebSocket ticket |
| `WS /agent/live?ticket=…` | Live voice: PCM audio in, transcripts, agent events and PCM speech out. Ticket auth, `Origin` checked against `CORS_ORIGINS`. Not in OpenAPI |
| `POST /agent/turn` | `{text, turn_id?, language?}` → `{turn_id, reply, language, ignored, replayed, duration_ms, events[]}`: one typed turn through the agent |
| `GET /agent/conversation` | This user's conversation history (oldest first, ≤ 50, last 30 days) |
| `GET /agent/sessions/{id}` | Usage of one live session (billed STT seconds, sent seconds, TTS characters, LLM calls, provider errors) |
| `GET /health`, `GET /ready` | Liveness; readiness (database, migrations, provider configuration) |

## Live voice agent

The primary interface. Full protocol, event list and autonomy policy: `VOICE_AGENT.md`.

1. `POST /agent/session` (cookie session + CSRF) → ticket and `ws_url`.
2. Open `{ws_url}?ticket=<ticket>` from the browser; ask for a new ticket for every reconnect.
3. Stream 16 kHz Int16 PCM; the server sends transcripts, `tool.*` events (with `refresh` hints), `reply` and PCM
   speech.
4. Write tools return `completed`, `needs_confirmation` (read back; runs only after a "yes" in a later turn),
   `needs_clarification` or `needs_owner_approval` (listed under `GET /actions`, decided with
   `POST /actions/{id}/approve|reject`). The server decides which, not the model.
5. Without a socket, `POST /agent/turn` runs the same agent for typed input. Resending the same `turn_id` replays
   the stored reply.

## Extract → proposal → approval flow (REST)

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
| 409 | `CONFLICT`, `ACTION_NOT_PENDING`, `PAYMENT_ATTEMPT_PENDING`, `PAYMENT_ATTEMPT_CANCELLED`, `PAYMENT_ATTEMPT_NOT_PENDING`, `PAYMENT_ALREADY_RECORDED` |
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
