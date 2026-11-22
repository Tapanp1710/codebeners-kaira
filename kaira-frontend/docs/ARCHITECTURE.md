# Frontend architecture

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript 5.9 · Tailwind CSS 4 · TanStack Query 5 ·
openapi-fetch + openapi-typescript · React Hook Form + Zod · Recharts 3 · lucide-react · Vitest · Playwright.

```
app/
  layout.tsx                 fonts (next/font: Manrope, Fraunces), global CSS
  login/                     sign-in + silent session resume
  (app)/layout.tsx           SERVER session check (GET /auth/me), providers, app shell
  (app)/agent|dashboard|customers|invoices|receivables|cashflow|scenarios|actions|settings
                             (/agent is the landing screen; /actions is the Approvals page)
  api/backend/[...path]/     same-origin proxy to the backend
proxy.ts                     Next 16 "proxy" (formerly middleware): optimistic cookie check -> /login
components/                  ui (design system), layout, agent (provider, home, orb, dock, conversation, activity),
                             dashboard, customers, invoices, cashflow, charts, payments, actions (ProposalCard), auth
lib/agent/                   live voice engine: engine, socket, mic + worklet, player, reducer, protocol, tab lock,
                             VAD, ring buffers
lib/api/                     schema.d.ts (generated), types, client (CSRF/refresh), hooks (queries/mutations)
lib/payments/                server-side payment-attempt recovery
lib/server/                  env validation, proxy core, server session
lib/format/                  exact money (BigInt) and date helpers
hooks/                       debounce
contracts/                   imported backend contract + version record
```

## Authentication and security

* **Cookies stay HttpOnly.** The browser never sees tokens. The backend sets `kaira_access` (15 min, `Path=/`) and
  `kaira_refresh` (7 days, path rewritten to the proxy's auth path).
* **Server-side check.** Every protected page renders through `app/(app)/layout.tsx`, which calls the backend's
  `/auth/me` with the access cookie. A cookie's presence alone is never trusted. `proxy.ts` only redirects
  requests with no cookie at all, as an optimisation.
* **CSRF.** The token comes in the `/auth/me` / login / refresh JSON and is kept **in memory** (`lib/api/client.ts`).
  It is sent as `X-CSRF-Token` on POST/PATCH/PUT/DELETE. On `403 CSRF_FAILED` the client re-syncs once (`GET /auth/me`).
* **Expiry.** On `401 SESSION_EXPIRED` the client refreshes once and retries. Refreshes are single-flight in a tab and
  serialised across tabs with the Web Locks API, because the backend revokes every session when a rotated refresh token is
  reused. If refresh fails, the user goes to `/login?expired=1`. When the access cookie is gone, the login page first tries
  a silent refresh (`resume=1`).
* **Redirect safety.** `next` must be a same-origin relative path (`safeNext`).
* **Roles.** Approve/reject and business settings are hidden for staff. The backend still enforces them (`403 FORBIDDEN`).
* **Headers.** `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy: microphone=(self)`;
  `poweredByHeader` off.
* **Configuration.** Server variables are `BACKEND_ORIGIN` (required), `BACKEND_TIMEOUT_MS` and
  `TRUSTED_CLIENT_IP_HEADER`. No backend secrets live in the frontend, and `scripts/check-env.mjs` fails if a
  `NEXT_PUBLIC_*` variable looks like a secret.
* **Live WebSocket.** The one connection that bypasses the proxy: the browser opens the backend's `ws_url` directly
  with a single-use ticket from `POST /agent/session` (no cookies). The backend checks its `Origin` against
  `CORS_ORIGINS`.

## Data layer

* Types come from the contract. Hooks call `openapi-fetch` with typed paths. `unwrap()` returns `data` only when the
  HTTP status is 2xx **and** the envelope says `success: true`; anything else throws `ApiError {code, message,
  status, details, requestId}`.
* TanStack Query caches reads (15 s stale time, refetch on focus). Mutations are **never retried automatically**.
* After any financial write (payment, invoice, bill, approval, settings) `invalidateFinancial()` refreshes every
  ledger-derived view (dashboard, insights, customers, invoices, receivables, forecast, bills, commitments, audit).
  Customer edits only refresh customer data.
* Payments send an `Idempotency-Key` created once per submission and reused on retry.
* **Payment recovery: the server is the authority** (`/payment-attempts`, added in backend API 1.1.0):
  * **Shared code.** Bill and invoice payments share `lib/payments/server-attempts.ts` (register, then execute, with
    one outcome classification) and the `usePaymentAttempt` hook.
  * **Register before paying.** A payment first registers an *attempt*; the backend freezes the key and the exact
    request. The attempt is then executed, and executing it again is always safe: the backend records the payment
    once or replays it.
  * **Finding unconfirmed payments.** Any device lists them with `GET /payment-attempts?status=pending`. They
    appear on the dashboard, the invoice list, receivables, the invoice page and the bills panel, on every page of
    each list.
  * **No discard, no new key.** An unconfirmed payment is never discarded and never gets a new key. Its fields are
    frozen and "Retry payment" resends the same attempt. Closing the dialog keeps it.
  * **Browser storage is only a recovery aid.** `lib/api/payment-attempt.ts` keeps `localStorage` records
    (`kaira:{bill,invoice}-payment-attempt:v1:<businessId>:<id>`):
    * They cover the moment between choosing a key and the server confirming the registration.
    * Records written by builds before the registry (`v: 1`) are registered with their original key, so a payment
      already recorded under it is linked rather than repeated.
    * At logout, `v2` records are cleared (the server holds the attempt, or nothing happened), and `v1` records
      are cleared only once registered. Server attempts are never cancelled by logout.
  * **Concurrency.** Fresh submits re-check local storage and the server under a per-target Web Lock. Without Web
    Locks, PostgreSQL's "one pending attempt per invoice or bill" rule decides: the second tab or device gets a 409
    and adopts the first one's attempt. A BroadcastChannel (with `storage` events as a fallback) keeps open tabs in
    step.
  * **Limits.** Recovery works across devices, but only for users of the same business. The backend's per-user
    write limit applies.
* Money stays a decimal string. Display uses exact BigInt formatting with Indian digit grouping. The invoice form's
  running estimate uses exact arithmetic and is labelled as an estimate. Charts convert to numbers only for plotting,
  and their labels show the exact strings.

## Voice and approvals

The live voice agent (contract: `contracts/VOICE_AGENT.md`, types: `lib/agent/protocol.ts`) is the primary
interface. `components/agent/agent-provider.tsx` mounts one `AgentEngine` (`lib/agent/engine.ts`) in the `(app)`
layout, so a live session survives navigation:

* The microphone opens only when the user enables the live session (explicit click). An AudioWorklet
  (`public/worklets/kaira-mic-worklet.js`) downmixes and resamples to 16 kHz Int16 PCM in ~100 ms frames, streamed
  over a WebSocket (`lib/agent/socket.ts`) to the backend, which bridges to Sarvam realtime STT. Audio captured while
  the socket is connecting or reconnecting goes to a 1.5 s pre-roll buffer and is flushed in order when it opens. A
  client energy VAD drives the orb and early local barge-in; recognition is Sarvam's.
* **One live tab.** `lib/agent/tab-lock.ts` holds an exclusive Web Locks lock (`kaira.agent.live-mic`) while a tab
  streams the microphone; a BroadcastChannel tells other tabs, which show "live voice is active in another tab" and
  keep typed input. The browser releases the lock when the holding tab closes or crashes. The backend separately
  ends an older socket of the same user (`SESSION_REPLACED`).
* **Ticket and reconnects.** The WebSocket is authenticated with a single-use ticket from `POST /agent/session`
  (Next.js route handlers cannot proxy WebSockets). Every reconnect requests a fresh ticket with
  `resume_session_id`, with exponential backoff.
* **Dead sockets and offline.** Every ping (20 s) arms a watchdog: if nothing arrives from the server within 10 s
  (`PONG_TIMEOUT_MS`) the socket is treated as lost and reconnected. A typed turn sent over the socket triggers an
  immediate probe. The browser `offline` event drops the socket and pauses reconnect attempts; `online` reconnects at
  once. Typed turns that were sent over a socket that dropped are resent over `POST /agent/turn` with the same
  `turn_id`, so the backend replays rather than repeats them.
* **Levels.** Mic and output levels (~20 Hz) live in a separate small store on the engine
  (`subscribeLevels`/`getLevels`, read through `useAgentLevels()`), so level updates re-render only the orb, not the
  page.
* Replies arrive as PCM frames and are scheduled gaplessly (`lib/agent/player.ts`); `tts.stop` (server barge-in)
  or local speech stops playback instantly.
* `reduceAgentEvent` (`lib/agent/reducer.ts`) turns server events into the orb state, transcript, activity feed and
  side effects (refresh ledger queries after writes, `navigate` to internal paths only).
* Typed input (`sendText`) uses the same conversation over the socket, or `POST /agent/turn` without it.

UI: `/agent` (`components/agent/agent-home.tsx`, `kaira-orb.tsx`, `activity-feed.tsx`, `conversation.tsx`) and the
`AgentDock` on every other page.

**Approvals** (`app/(app)/actions/page.tsx`) lists proposed actions from `GET /actions` with status tabs (awaiting
approval, approved, rejected, all). Proposals reach it from the agent (read-backs waiting for a "yes" and staff
requests waiting for the owner; owner instructions the agent executed appear as approved) and from the REST
`POST /assistant/extract` path, which the current UI does not call. Each proposal is a `ProposalCard`
(`components/actions/proposal-card.tsx`): transcript, intent, customer/invoice resolution with candidates, amounts,
computed values (remaining balance, balance after), evidence with "found in transcript", warnings (blocking ones
highlighted) and confidence. Edit sends the full operation list to `PATCH /actions/{id}`. Approve and reject are
owner-only, wait for the backend and are disabled while in flight. Success is shown only when the returned status is
`executed`. When the backend reports `voice_provider: not_configured`, the UI says so and keeps typed input working.

## Design system

The palette is defined as Tailwind v4 `@theme` tokens in `app/globals.css`: navy `#0D1B2A`, abyss `#1B263B`, steel `#415A77`,
sage `#778D7A`, champagne `#D4C4A8`, cream `#F4F1DE`. Accessible extras are muted danger (terracotta), warn (amber) and a
distinct "simulated" colour, so hypothetical values never look like actual or projected ones. Fraunces for figures and
headings, Manrope for UI, tabular numerals for money. `prefers-reduced-motion` disables animation. Tables scroll inside
their cards on phones, and every chart has a table alternative or a comparison table.
