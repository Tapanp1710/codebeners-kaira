# Financial engine

All money uses Python `Decimal` and PostgreSQL `NUMERIC(14,2)`, rounded half-up to paise. Floats
are rejected (`utils.money.q2`). Code: `app/services/ledger.py`, `forecast_service.py`,
`receivables_service.py`, `payment_service.py`, `commitment_service.py`.

## Balances

See DATABASE_SCHEMA.md, "Derived values". Outstanding balances are always computed from
items and payments and are never editable.

## Opening cash

`businesses.opening_cash_balance` is the cash held at the **start** of `opening_cash_as_of`.
Cash movements dated **on or after** that date change current cash. Movements dated **before** it are
historical entries that are already reflected in the opening balance, so they are excluded from current
cash. They still reduce invoice and bill balances. To re-baseline, PATCH both fields in `/business/settings`.

## Payments (atomic)

Customer payment: lock the invoice, apply the idempotency check, reject void/fully paid invoices and
overpayment, then insert the payment, its `cash_transactions` inflow and an `audit_logs` entry in one
transaction. When the invoice reaches 0, its pending commitments become `fulfilled`.
Bill payment: the same, with an outflow. An **unpaid bill never creates a cash outflow.**

## Commitments

A commitment changes *when* part of an existing balance is expected. It never adds to what is owed.
Pending commitments are capped per invoice (≤ invoice outstanding) and per customer (≤ customer
outstanding). A spoken "he'll clear the remaining" commitment supersedes (cancels, with audit) earlier
pending commitments for the same invoice.

## Forecast

`projected(d) = current_cash + Σ expected inflows ≤ d − Σ expected outflows ≤ d`, daily for the horizon (1–365, default 90).

Expected inflows, in this order, each capped by what remains on the invoice:
1. invoice-linked pending commitments, in date order;
2. customer-level commitments, allocated to that customer's remaining balances, oldest due date first;
3. any remainder on the invoice due date. If the invoice is already overdue, it is expected
   `overdue_collection_delay_days` (default 30, configurable per business) after today.
   Overdue customers are never assumed to pay today.
4. A pending commitment whose date has passed is treated the same way (`missed_commitment`).

Expected outflows: the remaining balance of each open bill on its due date. Overdue bills are assumed
due today (the conservative choice).

Outputs: opening cash, current cash, totals of expected in/out within the horizon, balances at 30/60/90 days,
daily (or weekly) points, lowest balance and its date, shortfall periods below `low_cash_threshold`,
the events behind every number (invoice/commitment/bill ids), amounts beyond the horizon, and the assumptions in plain language.

Not double-counted, by construction: allocation subtracts each commitment from the invoice's
remaining amount before the remainder is scheduled. Tests: `tests/api/test_forecast.py`.

## What-if simulation

`POST /cashflow/simulate` shifts every expected **inflow** of the target (customer, invoice, or the
customer with the largest outstanding balance) by `delay_days`, then compares the baseline and simulated
projections: milestone balances and differences, lowest balances, shortfalls, new shortfall dates, and
a plain-language explanation. It runs inside a PostgreSQL `READ ONLY` transaction and never writes. Tests
compare table row counts and invoice data before and after.

## Receivables ageing

Buckets by days overdue: `current` (not yet due), `1_30`, `31_60`, `61_90`, `90_plus`.
