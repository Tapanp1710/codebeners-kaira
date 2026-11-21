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
| 14 | TTS default `bulbul:v3` with speaker `shubh`; STT `saaras:v4`; LLM `sarvam-105b`. | Current docs: v3 is the API default with a documented 37-speaker list; v4-flash uses different speaker IDs. All configurable. |
| 15 | Login accepts any `local@domain` string. | Lookup key only. `EmailStr` rejected the spec's `demo@kaira.local`. |
| 16 | No Redis/queues/microservices; in-process rate limiter. | Spec 4: no unjustified infrastructure. |
| 17 | Postgres bound to 127.0.0.1 in compose; API published on 0.0.0.0 for LAN frontend access. | Two-laptop development without exposing the database. |
| 18 | `127.0.0.1` instead of `localhost` in DSNs. | Measured 5 s IPv6 fallback per connection on this Windows host. |
