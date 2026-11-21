# Frontend architecture

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript 5.9 · Tailwind CSS 4 · TanStack Query 5 ·
openapi-fetch + openapi-typescript · React Hook Form + Zod · Recharts 3 · lucide-react · Vitest · Playwright.

```
app/
  layout.tsx                 fonts (next/font: Manrope, Fraunces), global CSS
  login/                     sign-in + silent session resume
  (app)/layout.tsx           SERVER session check (GET /auth/me), providers, app shell
  (app)/dashboard|customers|invoices|receivables|cashflow|scenarios|actions|settings
  api/backend/[...path]/     same-origin proxy to the backend
proxy.ts                     Next 16 "proxy" (formerly middleware): optimistic cookie check -> /login
components/                  ui (design system), layout, dashboard, customers, invoices, cashflow, charts,
                             voice (orb, assistant), actions (proposal review), auth
lib/api/                     schema.d.ts (generated), types, client (CSRF/refresh), hooks (queries/mutations), voice
lib/server/                  env validation, proxy core, server session
lib/format/                  exact money (BigInt) and date helpers
hooks/                       recorder (MediaRecorder), debounce
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
* **Configuration.** The only server variable is `BACKEND_ORIGIN`. No backend secrets live in the frontend, and
  `scripts/check-env.mjs` fails if a `NEXT_PUBLIC_*` variable looks like a secret.

## Data layer

* Types come from the contract. Hooks call `openapi-fetch` with typed paths. `unwrap()` returns `data` only when the
  HTTP status is 2xx **and** the envelope says `success: true`; anything else throws `ApiError {code, message,
  status, details, requestId}`.
* TanStack Query caches reads (15 s stale time, refetch on focus). Mutations are **never retried automatically**.
* After any financial write (payment, invoice, bill, approval, settings) `invalidateFinancial()` refreshes every
  ledger-derived view (dashboard, insights, customers, invoices, receivables, forecast, bills, commitments, audit).
  Customer edits only refresh customer data.
* Payments send an `Idempotency-Key` created once per submission and reused on retry.
* **Payment recovery: the server is the authority** (backend API 1.1.0, `/payment-attempts`):
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

The orb (`components/voice/voice-orb.tsx`) shows idle / listening / processing / ready / speaking / error.
Recording starts only on a tap, stops on a second tap or at Sarvam's 30 s limit, and releases the microphone
immediately. Audio goes to `POST /voice/transcribe` as multipart `file` + `language_code`. The transcript is editable, then
`POST /assistant/extract`. Proposals (`ProposalCard`) show the transcript, intent, customer/invoice resolution with
candidates, amounts, computed values (remaining balance, balance after), evidence with "found in transcript", warnings
(blocking ones highlighted), and confidence. Edit sends the full operation list to `PATCH /actions/{id}`.
Approve and reject wait for the backend and are disabled while in flight. Success is shown only when the
returned status is `executed`. Answers can be read aloud through `POST /voice/speak` (base64 audio).
When the backend reports `voice_provider: not_configured`, the UI says so and keeps typed English input working.

## Design system

The palette is defined as Tailwind v4 `@theme` tokens in `app/globals.css`: navy `#0D1B2A`, abyss `#1B263B`, steel `#415A77`,
sage `#778D7A`, champagne `#D4C4A8`, cream `#F4F1DE`. Accessible extras are muted danger (terracotta), warn (amber) and a
distinct "simulated" colour, so hypothetical values never look like actual or projected ones. Fraunces for figures and
headings, Manrope for UI, tabular numerals for money. `prefers-reduced-motion` disables animation. Tables scroll inside
their cards on phones, and every chart has a table alternative or a comparison table.
