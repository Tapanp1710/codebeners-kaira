# Source Annotation Report

Branch: `docs/frontend-source-annotations` (based on `feat/kaira-frontend` at `6cbd4e3`).
Date: 2026-11-22.

This was a documentation-only pass. It added explanatory comments to the frontend source and changed no executable code, configuration, styling, dependencies or Docker behaviour.

## Summary

| | |
|---|---|
| Tracked files inspected | 102 (every tracked file in the repository) |
| Files annotated | 78 |
| Comments added | 776 comment blocks: 1,569 comment lines, including 115 inline JSX comments |
| Files excluded | 24 (listed below, with reasons) |
| Code lines changed | 0 (checked mechanically; see "Verification") |

**How comments are counted:** a run of consecutive comment lines, or one `/** ... */` block, counts as one comment. A few files had an existing one-line JSDoc extended, so the original line shows as replaced. Those are counted with the added comments.

**What the comments cover:** where it genuinely applied, each file was given four kinds of comment:
- **A. Architecture and purpose:** what the module is responsible for, its dependencies and who uses it.
- **B. Implementation:** behaviour, parameters, state, data transformations and decisions that aren't obvious.
- **C. Integration:** backend endpoints, cookies, CSRF, the shape of requests and responses, cache invalidation and how errors propagate.
- **D. Reliability:** validation, edge cases, security boundaries, performance, failure handling and assumptions.

Small files got fewer comments. No comment adds a TODO or describes behaviour the code does not have.

## Comments per file

The line counts are for the file before and after annotation.

| File | Lines before | Lines after | Comments |
|---|---|---|---|
| `.github/workflows/ci.yml` | 62 | 76 | 14 |
| `Dockerfile` | 25 | 37 | 9 |
| `app/(app)/actions/page.tsx` | 52 | 69 | 5 |
| `app/(app)/cashflow/page.tsx` | 149 | 177 | 18 |
| `app/(app)/customers/[id]/page.tsx` | 162 | 188 | 15 |
| `app/(app)/customers/page.tsx` | 128 | 147 | 14 |
| `app/(app)/dashboard/page.tsx` | 9 | 14 | 1 |
| `app/(app)/invoices/[id]/page.tsx` | 123 | 149 | 14 |
| `app/(app)/invoices/new/page.tsx` | 18 | 28 | 2 |
| `app/(app)/invoices/page.tsx` | 110 | 128 | 13 |
| `app/(app)/layout.tsx` | 32 | 53 | 7 |
| `app/(app)/receivables/page.tsx` | 210 | 237 | 18 |
| `app/(app)/scenarios/page.tsx` | 188 | 219 | 19 |
| `app/(app)/settings/page.tsx` | 89 | 119 | 13 |
| `app/api/backend/[...path]/route.ts` | 26 | 41 | 6 |
| `app/layout.tsx` | 23 | 35 | 5 |
| `app/login/page.tsx` | 37 | 52 | 3 |
| `app/page.tsx` | 5 | 10 | 1 |
| `components/actions/labels.ts` | 47 | 65 | 6 |
| `components/actions/proposal-card.tsx` | 398 | 483 | 27 |
| `components/auth/login-form.tsx` | 92 | 123 | 11 |
| `components/cashflow/bills-panel.tsx` | 177 | 215 | 15 |
| `components/charts/forecast-chart.tsx` | 137 | 175 | 15 |
| `components/customers/customer-form.tsx` | 103 | 137 | 14 |
| `components/customers/reminder-dialog.tsx` | 96 | 121 | 11 |
| `components/customers/section-tabs.tsx` | 32 | 38 | 2 |
| `components/dashboard/dashboard-view.tsx` | 192 | 221 | 18 |
| `components/invoices/invoice-form.tsx` | 152 | 193 | 18 |
| `components/invoices/payment-form.tsx` | 112 | 148 | 15 |
| `components/layout/app-shell.tsx` | 282 | 334 | 16 |
| `components/providers.tsx` | 83 | 113 | 12 |
| `components/ui/dialog.tsx` | 68 | 82 | 4 |
| `components/ui/finance.tsx` | 66 | 86 | 7 |
| `components/ui/form.tsx` | 48 | 60 | 5 |
| `components/ui/pager.tsx` | 15 | 19 | 1 |
| `components/ui/primitives.tsx` | 191 | 225 | 18 |
| `components/voice/assistant-panel.tsx` | 211 | 265 | 22 |
| `components/voice/voice-orb.tsx` | 66 | 81 | 5 |
| `e2e/acceptance.spec.ts` | 125 | 139 | 14 |
| `e2e/helpers.ts` | 40 | 48 | 5 |
| `e2e/workflows.spec.ts` | 250 | 275 | 20 |
| `hooks/use-debounced.ts` | 12 | 17 | 1 |
| `hooks/use-recorder.ts` | 129 | 161 | 17 |
| `lib/api/client.ts` | 205 | 262 | 25 |
| `lib/api/errors.ts` | 44 | 62 | 8 |
| `lib/api/hooks.ts` | 289 | 338 | 21 |
| `lib/api/types.ts` | 32 | 37 | 4 |
| `lib/api/voice.ts` | 39 | 55 | 7 |
| `lib/format/dates.ts` | 57 | 71 | 9 |
| `lib/format/money.ts` | 94 | 119 | 15 |
| `lib/server/env.ts` | 28 | 39 | 4 |
| `lib/server/proxy.ts` | 129 | 189 | 17 |
| `lib/server/session.ts` | 46 | 62 | 6 |
| `next.config.ts` | 25 | 32 | 3 |
| `playwright.config.ts` | 40 | 47 | 7 |
| `proxy.ts` | 33 | 41 | 2 |
| `scripts/check-env.mjs` | 75 | 98 | 16 |
| `scripts/common.ps1` | 39 | 46 | 6 |
| `scripts/common.sh` | 27 | 35 | 7 |
| `scripts/contract.mjs` | 104 | 127 | 16 |
| `scripts/setup.ps1` | 41 | 45 | 4 |
| `scripts/setup.sh` | 18 | 21 | 3 |
| `scripts/start.ps1` | 49 | 56 | 6 |
| `scripts/start.sh` | 20 | 26 | 6 |
| `scripts/stop.ps1` | 16 | 19 | 3 |
| `scripts/stop.sh` | 8 | 10 | 2 |
| `scripts/verify.ps1` | 22 | 24 | 2 |
| `scripts/verify.sh` | 15 | 17 | 2 |
| `tests/api-client.test.ts` | 166 | 191 | 17 |
| `tests/components.test.tsx` | 160 | 182 | 16 |
| `tests/fixtures.ts` | 79 | 89 | 7 |
| `tests/format.test.ts` | 67 | 78 | 8 |
| `tests/proxy.test.ts` | 157 | 181 | 18 |
| `tests/render.tsx` | 27 | 35 | 4 |
| `tests/screens.test.tsx` | 167 | 188 | 17 |
| `tests/setup.ts` | 16 | 23 | 3 |
| `tests/voice-api.test.ts` | 52 | 61 | 6 |
| `vitest.config.mts` | 15 | 22 | 3 |

## Files excluded

| File | Reason |
|---|---|
| `lib/api/schema.d.ts` | Generated by `openapi-typescript` (`npm run contract:generate`). `contract:check` requires it to match regenerated output exactly, so editing it would break the contract gate. |
| `package-lock.json`, `package.json`, `tsconfig.json`, `contracts/openapi.json`, `contracts/CONTRACT_VERSION` | JSON or plain data with no comment syntax. `CONTRACT_VERSION` is a hash the contract check compares against. |
| `app/globals.css` | Out of scope: the task ruled out any change to CSS or visual appearance. |
| `eslint.config.mjs`, `postcss.config.mjs` | Under 20 lines of standard tool configuration with nothing that isn't obvious. Application configuration was out of scope. |
| `.env.example`, `.dockerignore`, `.gitignore`, `.gitattributes` | Already self-describing. `.env.example` is copied into CI as `.env.local`, so its contents were left untouched. |
| `AGENTS.md`, `README.md`, `docs/*.md`, `contracts/*.md` | Already documentation. `AGENTS.md` is regenerated by `next dev`. |

There is no top-level `types/` directory. The shared types live in `lib/api/types.ts`, which is annotated.

## Major architectural relationships

- **Request path:** the browser never contacts the backend directly. React Query hooks (`lib/api/hooks.ts`) call the typed client (`lib/api/client.ts`). The client sends requests to `/api/backend/api/v1/*`, which reaches the catch-all route `app/api/backend/[...path]/route.ts`. That route calls `proxyToBackend()` in `lib/server/proxy.ts`, which forwards to `BACKEND_ORIGIN` (read by `lib/server/env.ts`).
- **Two-layer auth guard:**
  - The root `proxy.ts` (Next 16's renamed middleware) only checks that the `kaira_access` cookie exists. If it is missing, it redirects to `/login?next=…&resume=1`; otherwise it records the requested path in `x-kaira-path`.
  - The real check is the server layout `app/(app)/layout.tsx`. It calls `getServerSession()` (`lib/server/session.ts`), which sends `GET /auth/me` directly to the backend with a 10 s timeout and is deduplicated per request with React `cache()`.
  - The layout tells "unauthenticated" apart from "backend unavailable", so an outage shows its own page instead of logging the user out.
- **Session on the client:** the layout passes the session to `components/providers.tsx`. That file seeds the in-memory CSRF token, exposes `isOwner` and creates the React Query client:
  - queries: 15 s `staleTime`, refetch on focus, no retry on 4xx;
  - mutations: no retry.
- **Screens:** pages under `app/(app)/*` stay thin. The workflow logic lives in components: `ProposalCard` for approvals, `AssistantPanel` and `VoiceOrb` for voice, `InvoiceForm` and `PaymentDialog` for invoices and payments, `BillsPanel`, `DashboardView` and the forecast charts.
- **Money and dates:** amounts stay as exact decimal strings and any arithmetic uses BigInt (`lib/format/money.ts`). Only chart plotting converts amounts to floats. Calendar dates are formatted as text, so they never shift by a timezone (`lib/format/dates.ts`).

## Integration observations

- **Proxy security boundary:**
  - Only `api/v1/...` paths are forwarded, and `.`/`..` segments are rejected.
  - The request is always built on the configured origin.
  - Request and response headers are passed through allow-lists.
  - Each `Set-Cookie` is passed back separately, with its Domain removed and `/api` paths given the `/api/backend` prefix. As a result `kaira_refresh` is scoped to `/api/backend/api/v1/auth`.
  - Every response is marked `cache-control: no-store`.
  - Proxy failures come back in the backend's own envelope: 502 `BACKEND_UNAVAILABLE` and 504 `BACKEND_TIMEOUT`, without exposing the internal host.
- **CSRF:** the token is held only in memory and sent only on POST, PUT, PATCH and DELETE. A 403 `CSRF_FAILED` triggers one `/auth/me` re-sync and one replay of the request.
- **Session refresh:** a 401 (`SESSION_EXPIRED` or `UNAUTHENTICATED`) triggers one refresh and one replay.
  - Within a tab, a shared promise means only one refresh runs at a time; across tabs, a Web Lock (`kaira-session-refresh`) runs them one after another. This matters because refresh tokens are single-use.
  - If the refresh fails, the session is cleared and the page reloads to `/login?expired=1`.
- **Timeouts:** the browser waits 30 s by default and 95 s for `/voice/`. The proxy waits 30 s by default (`BACKEND_TIMEOUT_MS`) and at least 90 s for voice, so for voice calls the proxy's 504 normally arrives first.
- **Error mapping:** a call succeeds only on a 2xx status with `success: true` and data. Anything else becomes an `ApiError` that carries the backend's `X-Request-ID`. Network failures and timeouts become status 0.
- **Approvals:** proposals run only after an owner approves them on the server (`POST /actions/{id}/approve`). The UI mirrors `can_approve` and hides Approve and Reject from staff, while the backend enforces roles with 403. Approving invalidates both the actions queries and every financial query.
- **Voice:**
  - Recording starts only when the user taps, and is capped at 30 s.
  - The transcript fills an editable text box and is never sent for extraction automatically.
  - Read-aloud uses `/voice/speak`.
  - `GET /ready` controls the "voice not configured" notices.
- **Simulations:** what-if runs are a mutation with nothing to invalidate. "Back to baseline" just resets the mutation on the client.

## Issues noticed during annotation (not fixed)

These were found while reading the code. The task was documentation-only, so the code is unchanged; each one is described neutrally in the comment beside it.

1. **Bill payments may get a new idempotency key on network failure.** `components/cashflow/bills-panel.tsx` replaces the key when `err.status < 500`, and network failures and timeouts have status 0. If a payment reached the server but the response was lost, retrying could record it twice. Invoice payments (`payment-form.tsx`) correctly replace the key only on 4xx. *Checked against the source.*
2. **Some invoice validation errors are shown nowhere.** `invoice-form.tsx` maps server validation errors onto inputs only for `customer_id`, `invoice_date`, `due_date` and `notes`, and hides the summary banner when field errors exist. A server error that names only line-item fields is therefore not displayed.
3. **Malformed path encoding.** `lib/server/proxy.ts` calls `decodeURIComponent` on the path without catching errors, so a bad `%` sequence probably returns a 500 instead of the 404 envelope. *Not tested.*
4. **Client IP can be spoofed.** The proxy route forwards the first hop of an incoming `x-forwarded-for` unchanged. A client can fake it unless something in front of the app strips the header.
5. **Small UI inconsistencies:**
   - Changing the sort on receivables and customers keeps the current page, while other filters reset to page 1.
   - Several pickers stop at 200 rows with no paging.
   - Some detail sections (customer and invoice payments) have no loading or error state.
   - Read-aloud revokes its object URL only in `onended`.
6. **Wrong path in an error message.** `scripts/contract.mjs` tells the user to "Re-import docs/openapi.json", but the file it checks is `contracts/openapi.json`.

## Verification

**Checks run on every commit**
- A comments-only checker, a Node script in the session scratchpad, compares each changed file with `feat/kaira-frontend`:
  1. Every added or removed line must be a comment, blank, or a lone `{/* */}` line.
  2. The TypeScript AST, printed without comments, must be identical.
  3. The output transpiled with comments removed must be identical.
  4. For `.tsx` files, the output compiled with the real React JSX transform must be byte-identical. This proves the JSX comments change nothing in what renders, including whitespace between text.

  The checker was tested against deliberate bad edits, including a JSX comment that splits text, and caught them.
- Lint, typecheck and unit tests were run after each annotation batch.
- The production build was run after the first full set and again after the final components batch.
- Shell syntax: `bash -n` passes on every `.sh` file.
- PowerShell: the PowerShell parser reports 0 errors for every `.ps1` file, and `Get-Help` still reads the existing help blocks.
- YAML: `ci.yml` parses with PyYAML.

**Final results** (run after the last commit)
- `npm run contract:check`: exit 0; the contract hash and generated types match, and the live check was skipped because `BACKEND_ORIGIN` is not set
- `npm run lint`: exit 0, no warnings
- `npm run typecheck` (`next typegen && tsc --noEmit`): exit 0
- `npm test` (Vitest): exit 0; 6 files, 59 tests passed
- `npm run build`: exit 0, from a clean `.next` (compiled successfully)
- Comments-only checker: `RESULT: OK (78 changed)`; `bash -n` OK; 0 PowerShell parse errors; `ci.yml` parses

**Problems found and fixed during verification:** in the first pass, a whitespace-normalised check missed two dropped spaces after `=` (`components/ui/finance.tsx` and `components/voice/voice-orb.tsx`). Commit `41c1e8e` restored them, and the checker was made strict line-by-line so it would catch this in future.

**Not run**
- The Playwright E2E suites: they need a running backend, and `acceptance.spec.ts` permanently changes the seeded data.
- A Docker rebuild: the Dockerfile changes are whole-line `#` comments only, and the image was verified on 2026-11-21 (`docs/STATUS.md`).
