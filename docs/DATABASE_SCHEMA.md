# Database schema

PostgreSQL 17 (works on 14+). All changes go through Alembic (`alembic/versions`; head `6462ead8dd6e`). Conventions:
UUID primary keys; `business_id` on every business-owned table; money is `NUMERIC(14,2)`;
timestamps are `timestamptz` stored in UTC; calendar dates are `date` in the business timezone
(default Asia/Kolkata); named constraints (`ck_`, `uq_`, `fk_`, `ix_`).

| Table | Key columns | Constraints / notes |
|---|---|---|
| `businesses` | name, business_type, currency, timezone, opening_cash_balance, opening_cash_as_of, overdue_collection_delay_days, low_cash_threshold, next_invoice_seq | delay ≥ 0, seq ≥ 1 |
| `users` | business_id, name, email (unique), password_hash (Argon2id), role, is_active | role ∈ owner, staff |
| `refresh_tokens` | user_id, token_hash (SHA-256, unique), expires_at, revoked_at | supports rotation, revocation and reuse detection |
| `customers` | business_id, name, phone, email, address, notes | index (business_id, lower(name)) |
| `invoices` | business_id, customer_id, invoice_number, invoice_date, due_date, lifecycle_status, notes | unique (business_id, invoice_number); lifecycle ∈ issued, void; due ≥ invoice date |
| `invoice_items` | invoice_id, position, description, quantity NUMERIC(12,3), unit_price, line_total | quantity > 0, prices ≥ 0 |
| `payments` | business_id, invoice_id, amount, payment_date, payment_method, reference, notes, idempotency_key, request_fingerprint, source_action_id | amount > 0; unique (business_id, idempotency_key); `request_fingerprint` = SHA-256 of the canonical request (NULL for rows recorded before migration `6b1d2e8f4a10`) |
| `bills` | business_id, vendor_name, description, category, amount, bill_date, due_date, notes | amount > 0; due ≥ bill date |
| `bill_payments` | business_id, bill_id, amount, payment_date, payment_method, reference, idempotency_key, request_fingerprint | amount > 0; unique (business_id, idempotency_key); fingerprint as for payments |
| `payment_attempts` | business_id, resource_type, resource_id, idempotency_key, request_fingerprint, request_payload JSONB, status, payment_id, failure_code, failure_message, created_by, completed_at | resource_type ∈ invoice, bill; status ∈ pending, succeeded, rejected, cancelled; payment_id set ⇔ succeeded; unique (business_id, idempotency_key); **unique (business_id, resource_type, resource_id) WHERE status = 'pending'** (see PAYMENT_ATTEMPTS.md) |
| `payment_commitments` | business_id, customer_id, invoice_id (nullable), amount, expected_payment_date, notes, status | status ∈ pending, fulfilled, cancelled, broken |
| `cash_transactions` | business_id, transaction_type, direction, amount, transaction_date, source_type, source_id, description | direction ∈ inflow, outflow; **unique (source_type, source_id)**, so each payment has exactly one cash movement |
| `conversations` | business_id, user_id, transcript, language, input_mode, provider, processing_status | raw audio is never stored |
| `proposed_actions` | business_id, conversation_id, action_type, extracted_data JSONB, evidence JSONB, source_transcript, confidence_level, warnings JSONB, result JSONB, status, approved_by/at, rejected_at, executed_at, idempotency_key | status ∈ pending, executed, rejected, failed |
| `rate_limit_buckets` | key, window_start, hits | primary key (key, window_start); shared rate-limit counters, pruned after 1 h; no business data |
| `audit_logs` | business_id, user_id, action_type, entity_type, entity_id, before_data, after_data, source_action_id, created_at | append-only; index (entity_type, entity_id) |

## Derived values (never stored)

* invoice total = Σ `invoice_items.line_total`
* invoice outstanding = total − Σ payments (0 for void invoices)
* invoice payment status = `paid` / `partially_paid` / `unpaid` / `void`; overdue = outstanding > 0 and due_date < today
* bill outstanding = amount − Σ bill_payments
* current cash = opening_cash_balance + Σ inflows − Σ outflows where transaction_date ≥ opening_cash_as_of

Columns not in the original specification: `businesses.overdue_collection_delay_days`, `low_cash_threshold`,
`next_invoice_seq` (forecast assumptions and gap-free numbering); `refresh_tokens` (secure sessions);
`invoice_items.position`; `payments.idempotency_key`/`source_action_id`; `bill_payments.idempotency_key`;
`conversations.input_mode`; `proposed_actions.result`.

## Operations

* Apply: `python -m app.cli migrate` (scripts do this automatically).
* Backup / restore: `scripts/backup.(ps1|sh)` and `scripts/restore.(ps1|sh) <file> -Confirm/--confirm`
  (pg_dump custom format, verified with `pg_restore --list`).
* Production: take a backup before deploying a release that contains a new migration. Startup never runs
  destructive operations, and `RUN_MIGRATIONS_ON_START` is false in production.
