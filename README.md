# KAIRA: a voice-first business operating system for small businesses

KAIRA is an AI business operations partner. The owner opens KAIRA, turns on the live session and talks:

> "How much does Ramesh owe me?" · "Ramesh paid me five thousand rupees today." · "Create an invoice for Ramesh for
> twenty thousand." · "రమేష్ ఈరోజు ఐదు వేల రూపాయలు ఇచ్చాడు, మిగిలినది వచ్చే సోమవారం ఇస్తాడు." · "Which bills are due this week?"

KAIRA transcribes the speech live (Sarvam Saaras v4), understands it with the business's real records
(sarvam-105b tool calling over typed backend tools), executes authorised operations through the same validated
services the app uses, verifies the result, refreshes the screens and answers out loud (Sarvam Bulbul v4 Flash), in
English, Hindi or Telugu. The orb on the KAIRA screen is the primary interface; every manual page (customers,
invoices, receivables, cash-flow forecast, what-if, approvals, settings) still works and shows the same data.

| Folder | Application |
|---|---|
| [`backend/`](backend/README.md) | FastAPI, SQLAlchemy 2, PostgreSQL, Alembic; the agent, tools, ledger and Sarvam adapters |
| [`kaira-frontend/`](kaira-frontend/README.md) | Next.js 16, React 19, TypeScript, Tailwind 4; the orb home, agent dock and manual pages |

Contracts: [`backend/docs/VOICE_AGENT.md`](backend/docs/VOICE_AGENT.md) (live voice protocol, autonomy policy),
[`backend/docs/API_CONTRACT.md`](backend/docs/API_CONTRACT.md), [`backend/docs/openapi.json`](backend/docs/openapi.json)
(API 1.2.0), [`backend/docs/SECURITY.md`](backend/docs/SECURITY.md).

## How it works

```
mic (browser, explicit live session) -> AudioWorklet 16 kHz PCM -> WS /api/v1/agent/live (60 s single-use ticket)
  -> Sarvam realtime STT (saaras:v4, auto language, server VAD, customer-name keyterms)
  -> final transcript -> agent turn: sarvam-105b tool calling over 28 business tools (reads + writes)
       writes -> existing proposal pipeline: evidence check against the user's own words, customer/invoice
                 resolution, caps, row locks, idempotency keys, audit rows -> executed or read back
  -> reply (figures verified against tool results) -> Sarvam streaming TTS (bulbul:v4-flash) -> PCM to the browser
  barge-in: speaking over KAIRA stops playback (server VAD + client VAD)
```

**Autonomy with financial safety.** A clear owner instruction ("Ramesh paid me five thousand today") executes at
once when every value is in the owner's own words and the spoken amount parses to exactly that amount. Missing or
ambiguous details are asked; unverifiable ones are read back and run only after a "yes" in a later turn; staff
requests wait for the owner on Approvals. The AI never sets identity, business or permissions, never gets SQL access,
never marks an invoice paid without payments, and corrections never edit or duplicate a payment (an increase records
only the difference; a decrease is refused). Exactly-once payment guarantees from the existing ledger are unchanged.

## Run it locally

Prerequisites: Docker, Python 3.11, Node 20.9+ (22 LTS recommended).

```powershell
cd backend;        .\scripts\setup.ps1; .\scripts\start.ps1      # API on http://127.0.0.1:8000, demo data seeded
cd kaira-frontend; .\scripts\setup.ps1; .\scripts\start.ps1      # app on http://localhost:3000
```

Sign in as `demo@kaira.local` with `DEMO_OWNER_PASSWORD` from `backend/.env`. For live voice put
`SARVAM_API_KEY=...` in `backend/.env` (server-side only, never in the frontend, never committed) and run
`backend/scripts/start.ps1` again; `/api/v1/ready` then reports `voice_provider: configured`. Without a key, typed
input on the same agent still works. Live listening needs the page open, the live session switched on and
microphone permission; listening in the background with the browser closed would need a native app.

## Tests

* Backend: `cd backend && python -m pytest -q` (PostgreSQL), `ruff check .`, migrations and OpenAPI drift
  (`scripts/verify`). Frontend: `cd kaira-frontend && npm run lint && npm run typecheck && npm test && npm run build`,
  Playwright end-to-end against a disposable backend.
* CI: `.github/workflows/backend.yml` and `frontend.yml` run every check for the folder that changed (always on
  `main`); `e2e.yml` runs Playwright against a seeded backend started inside the job, with no secrets;
  `full-suite.yml` runs all three on demand; `backend-deploy.yml` is manual-only.
* Deployment target (free tier): backend on a Render Docker web service with Supabase PostgreSQL (session pooler),
  frontend on Vercel. See [`backend/docs/DEPLOYMENT.md`](backend/docs/DEPLOYMENT.md).

## Verified on 22 Nov 2026

| Check | Result |
|---|---|
| Backend tests | 220 passed on 22 Nov (196 existing + 24 agent safety unit tests); ruff clean; migration round trip clean. The suite has since grown to 507 collected tests at `a05050b` (including the extended agent acceptance suite); current results are reported by `backend-ci` |
| Frontend | lint 0 warnings, typecheck, 228 unit/component tests, production build |
| Live sarvam-105b agent (typed turns, disposable DB) | balance question; "Ramesh paid me." -> clarification, nothing written; follow-up "He paid…" -> one payment; invoice creation (INV-0006); correction 5,000 -> 6,000 records only ₹1,000 after a later-turn "yes"; ambient chatter ignored; "mark INV-0001 paid" refused; monthly collections; Telugu and Hindi payment + promise (balance ₹7,000, promise for the remainder) |
| Live WebSocket pipeline (Sarvam STT -> agent -> Sarvam TTS) | English question, Telugu payment statement and barge-in; first partial 36-76 ms after speech start; reply text 1.9-3.7 s and first audio 2.2-4.2 s after the end of speech; tts.stop ~20 ms after speech start; billed STT seconds recorded. Input was Sarvam-synthesized speech streamed in real time (a pipeline loopback), not a human microphone |
| Not yet verified | a human speaking into a browser microphone; Playwright e2e of the agent UI against a backend with a live Sarvam key (CI runs e2e without a key, and the specs that need the LLM skip themselves) |

## Repository history

The backend and frontend were developed as separate repositories (published branches `feat/payment-integrity` and
`feat/server-payment-recovery`, kept unchanged). This `main` imports both with full history via `git subtree`.
