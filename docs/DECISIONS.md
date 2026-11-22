# Decision log

| # | Decision | Why |
|---|---|---|
| 1 | Backend repo lives at `Desktop/Codebenders/backend` (own git repo). The parent home-folder repo and the stray `Codebenders/app`, `Codebenders/tests` copies are not touched. | Spec 2.3: never modify unrelated parent repositories. |
| 2 | Synchronous SQLAlchemy 2 + psycopg 3, FastAPI sync endpoints (threadpool). | Simple transactions and row locks. The I/O volume of a small business doesn't need async DB code. |
| 3 | Services flush, endpoints commit. | Lets proposal approval run many operations atomically. |
| 4 | Outstanding balances are derived, never stored. | Removes a whole class of reconciliation bugs (spec 6.4). |
| 5 | Invoice lifecycle `issued`/`void`; payment status derived. | Spec: no independently editable balances or status. |
| 6 | Gap-free invoice numbers `INV-0001` per business via a locked counter on `businesses`. | Unique and human-friendly. Concurrency-safe. |
| 7 | HttpOnly cookie access + rotating refresh tokens, CSRF claim delivered in the JSON body. | Separate origins; no localStorage tokens; the frontend can't read API-domain cookies cross-origin. |
| 8 | Overdue invoices without a commitment are expected `today + 30 days` (configurable per business). | Spec 8.2: overdue customers must not be assumed to pay immediately. |
| 9 | Overdue bills are assumed payable today. | Conservative for cash planning. |
| 10 | Rules extractor as the fallback provider. | Typed workflows work without credentials. Deterministic tests. |
| 11 | Evidence-required extraction: unsupported values are removed, not trusted. | Spec 9.3 "never invent". Deterministic enforcement rather than relying on the prompt. |
| 12 | Customer resolution happens locally; no customer data is sent to the LLM. | Spec 14: minimise data sent to providers. |
| 13 | "Remaining amount" commitments supersede earlier pending commitments on that invoice (audited). | Matches the demo semantics and avoids exceeding the outstanding cap. |
| 14 | TTS default `bulbul:v4-flash` (2026-11-22; was `bulbul:v3` + `shubh`) with per-language personas te `kavitha_te_conversation`, hi `aparna_hi_customer`, en `aparna_en_companion`; STT `saaras:v4` (`transcribe` mode keeps the spoken language); LLM `sarvam-105b`. | Sarvam lists v4-flash as its latest TTS model with the same contract as v3, covering Telugu, Hindi and English. Hindi and English voices are the docs' rank-1 customer-care picks; Telugu has no ranking (4 voices). Not auditioned live yet. `bulbul:v3` + v3 speakers remains a valid setting. |
| 15 | Login accepts any `local@domain` string. | Lookup key only. `EmailStr` rejected the spec's `demo@kaira.local`. |
| 16 | No Redis/queues/microservices; in-process rate limiter. | Spec 4: no unjustified infrastructure. |
| 17 | Postgres bound to 127.0.0.1 in compose; API published on 0.0.0.0 for LAN frontend access. | Two-laptop development without exposing the database. |
| 18 | `127.0.0.1` instead of `localhost` in DSNs. | Measured 5 s IPv6 fallback per connection on this Windows host. |
| 19 | An Idempotency-Key is bound to a SHA-256 fingerprint of the canonical request (amount, date as sent, method, reference, notes, target). A different request under the same key is 422 `IDEMPOTENCY_KEY_REUSED`. Legacy rows without a fingerprint are compared column-by-column. | A key used to replay silently when only the amount matched, so the caller believed different details had been recorded. Omitted dates are fingerprinted as null so a next-day retry still replays. |
| 20 | A server-side `payment_attempts` registry (register → execute → succeeded/rejected; cancel only when provably nothing was recorded) is the authority for unresolved payments. See PAYMENT_ATTEMPTS.md. | Cross-device and cleared-storage recovery need the server to own the key and the frozen request. PostgreSQL enforces one pending attempt per invoice or bill. |
