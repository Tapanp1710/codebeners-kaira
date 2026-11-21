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
* **Payment recovery** for bill payments (`components/cashflow/bills-panel.tsx`) and invoice payments
  (`components/invoices/payment-form.tsx`), both built on one shared store in `lib/api/payment-attempt.ts`:
  * The first submit saves an *attempt* (the key plus the exact request body) to `localStorage`, before the request is
    sent. The storage keys are `kaira:bill-payment-attempt:v1:<businessId>:<billId>` and
    `kaira:invoice-payment-attempt:v1:<businessId>:<invoiceId>`. Each kind has its own lock and channel names.
  * For invoices, the frozen body also includes the reference and notes. While a payment is pending, the invoice page
    shows "Resolve payment" (even if the invoice now reads fully paid) and hides Void.
  * The attempt is removed only when the backend confirms an outcome:
    * success, whether newly recorded or replayed;
    * a processed 4xx rejection, which means nothing was recorded.
  * Network errors, timeouts, 5xx and 401/408/409/429 keep the attempt. The form locks and "Retry payment" resends the
    same key and body.
  * There is no discard action. Closing the dialog keeps the attempt, and the bill row then shows "Resolve payment".
  * Attempts survive reloads, closed tabs and browser restarts, and are never overwritten.
  * **Cross-tab:** submits for a bill run under a per-bill Web Lock and re-read storage inside the lock. Changes are
    broadcast on a `BroadcastChannel`, with `storage` events as a fallback, so other tabs adopt a pending attempt or
    close once it is confirmed. A 24 h completion marker lets them tell "confirmed" apart from "rejected".
  * **Trade-offs:** the entry holds no tokens or credentials, only the key, ids, amount, date and method. It is
    scoped to the business, so users of the same business share a bill's pending attempt; that sharing is what stops a
    second person or tab from paying the bill again. It outlives logout on a shared device until the payment is
    resolved. Attempts do not expire, because backend idempotency keys never expire and an old key can always be
    replayed safely. If `localStorage` is blocked, attempts are kept in memory only, with no reload or cross-tab
    recovery.
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
