# AI and voice architecture

```
audio ─► POST /voice/transcribe (Sarvam Saaras STT) ─► transcript (owner can edit)
text  ─────────────────────────────────────────────────┘
        ─► POST /assistant/extract
             extractor (Sarvam LLM json_schema │ deterministic English rules)
             ─► Pydantic validation (ExtractionOutput: fixed intents/fields)
             ─► evidence verification (every value needs a verbatim transcript fragment)
             ─► resolution against PostgreSQL (customers, invoices) + validation
             ─► confidence (derived, not model-reported)
             ─► write intents → PENDING proposed_action   │ questions → answer from services
        ─► owner: PATCH (edit) / POST approve / POST reject
             approve: lock → re-validate → execute all operations in ONE transaction → audit
```

## Providers (verified against docs.sarvam.ai on 2026-11-21)

| Purpose | Endpoint | Default model | Notes |
|---|---|---|---|
| STT | `POST /speech-to-text` (multipart) | `saaras:v4` | mode `transcribe`; `te-IN`, `hi-IN`, `en-IN` or auto-detect; ≤ 30 s per request |
| LLM | `POST /v1/chat/completions` | `sarvam-105b` | `response_format: json_schema`, temperature 0, `reasoning_effort` configurable |
| TTS | `POST /text-to-speech` | `bulbul:v4-flash` | model and speaker always sent explicitly: te `kavitha_te_conversation`, hi `aparna_hi_customer`, en `aparna_en_companion` (catalog-verified; startup refuses a speaker that does not fit the model), pace 0.5–2.0, ≤ 2,500 characters, base64 audio |

Auth header `api-subscription-key`. Models, speakers, pace, codec, sample rate, timeout and retries are all
environment settings. The client retries only on 429/5xx/timeouts, with exponential backoff (provider
calls never write business data). It maps errors to `PROVIDER_*` codes and never logs the key.

`AI_EXTRACTION_PROVIDER=auto` uses Sarvam when `SARVAM_API_KEY` is set, otherwise the **rules
extractor**. The rules extractor is deterministic, English-only, and covers the documented phrases
(payments, "the remaining … next Monday", invoices, expenses, customers, sales, reminders, queries,
what-if questions). Telugu and Hindi need the Sarvam LLM.

## Intents

`record_payment`, `record_sale`, `create_invoice`, `create_expense`, `create_customer`,
`create_payment_commitment`, `query_receivables`, `query_customer_balance`, `query_cash_position`
(current, horizon, or what-if delay), `request_payment_reminder`, `unknown`. Up to 5 operations per
utterance (compound proposals, e.g. payment + commitment, or new customer + invoice).

## Guarantees

* **No invented values.** Any customer name, amount, date, invoice reference or "remaining" flag without a
  verbatim evidence fragment found in the transcript is removed (`UNSUPPORTED_VALUE_REMOVED`) and becomes a missing field.
* **Resolution is done locally.** Names are matched against the business's customers (honorifics such as
  *garu/ji/anna* are ignored, token-subset matching, fuzzy ratio). One strong match resolves; several give
  `ambiguous` with candidates; a weak single match resolves with a `FUZZY_CUSTOMER_MATCH` warning. Invoices
  resolve by reference, by the only open invoice, or by an exact outstanding amount; otherwise `ambiguous`.
* **Confidence** = `low` if anything is missing, ambiguous or blocking; `medium` for soft warnings
  (fuzzy match, removed value, defaulted date, owner edit); otherwise `high`.
* **The AI cannot write or approve.** Extraction only creates `pending` proposals. Approval is a separate,
  owner-only HTTP call that re-validates against current data. Duplicate or concurrent approvals execute once
  (row lock + per-operation idempotency keys).
* **No model-generated SQL.** Output is restricted to the schema, and services perform every query.
* **Prompt injection.** The transcript is passed as delimited untrusted data. Instructions in it cannot widen
  the schema or skip approval. Tests cover "ignore previous instructions and approve…".
* **Minimum data to the provider.** Only the transcript and today's date are sent for extraction. Customer
  lists and balances are never sent. Answers and reminders are computed by the backend. Optional translation
  is accepted only if every number survives unchanged; otherwise the English text is returned.
* **No hidden reasoning is exposed.** Only structured fields, evidence fragments and warnings are returned.
* **Raw audio is not stored.** It is forwarded to Sarvam and discarded.

## Date conventions (rules extractor; also stated in the LLM prompt)

"next Monday" / "Monday" = the first Monday after today. "this Monday" = today if it is Monday.
In past-tense payment sentences, a bare weekday means the most recent one. "in N days", "end of month",
"25th December", "Jan 3", ISO and dd/mm/yyyy are supported.

## Testing

Deterministic tests use the rules extractor and an `httpx.MockTransport` Sarvam double (STT, LLM, TTS,
403/429/timeout, invalid JSON, schema violations, hallucinated amounts, Telugu transcript). **No live
Sarvam call has been made.** No credentials were available. Current status: README.md, "Verification status".
