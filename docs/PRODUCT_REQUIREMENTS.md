# Product requirements: KAIRA

KAIRA is an AI-powered, voice-first business operations partner for small Indian businesses. Owners speak
or type in Telugu, Hindi or English, for example *"Ramesh paid me 5,000 rupees today. He will clear the remaining
amount next Monday."* KAIRA turns this into verifiable, owner-approved, audited operations.

**Core workflow:** conversation → transcription → understanding → data resolution → proposed action → owner approval
→ transactional operation → audit trail. The AI never writes financial records on its own.

## Capability checklist (backend status)

| Capability | Status |
|---|---|
| Business settings, authentication, owner/staff roles | Implemented, tested |
| Customers (CRUD, search, balances, history, commitments) | Implemented, tested |
| Invoices (items, numbering, totals, due dates, void, filters) | Implemented, tested |
| Partial / full payments, history, overpayment prevention | Implemented, tested (incl. concurrency) |
| Receivables, overdue tracking, ageing | Implemented, tested |
| Bills, expenses, partial bill payments | Implemented, tested |
| Payment commitments | Implemented, tested |
| Cash position, 30/60/90 forecast, lowest balance, shortfalls | Implemented, tested |
| What-if delay simulation | Implemented, tested (non-mutation proven) |
| Voice input (Sarvam STT) Telugu/Hindi/English | Implemented; mocked tests only (no live key) |
| Typed-transcript fallback | Implemented, tested |
| AI extraction, customer/invoice resolution, evidence, confidence | Implemented; rules provider tested; Sarvam LLM path mocked |
| Proposed actions: edit / approve / reject, idempotent, compound | Implemented, tested |
| Audit history | Implemented, tested |
| Conversational queries | Implemented, tested |
| Payment reminder drafts | Implemented, tested (English template; translation only with Sarvam) |
| Business insights | Implemented, tested |
| Text-to-speech (Sarvam Bulbul) | Implemented; mocked tests only |

Out of scope by specification: GST/statutory tax compliance, automatic sending of reminders, always-on listening.
The frontend is a separate repository (`kaira-frontend`).
