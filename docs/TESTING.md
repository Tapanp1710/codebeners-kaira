# Testing

| Suite | Command | Environment | Covers |
|---|---|---|---|
| Unit & component (Vitest) | `npm test` | jsdom / node, network stubbed | proxy (headers, multipart bytes, binary bodies, multiple Set-Cookie, path rewrite, allow-list, backend down/timeout); API client (envelope, CSRF, refresh+retry, single-flight refresh, session loss, CSRF re-sync, idempotency, timeouts); voice multipart + TTS decoding; exact money/date formatting; redirect safety; voice orb states; proposal presentation / approve / reject / edit / staff; payment and invoice forms; assistant capability and microphone errors; navigation |
| End-to-end (Playwright) | `E2E_EMAIL=… E2E_PASSWORD=… npm run test:e2e` | production build + **real backend** + PostgreSQL | login/logout, protected routes, HttpOnly cookies invisible to JS, silent refresh after access expiry, lost session, CSRF refusal, customer → invoice → partial payment → receivables/dashboard refresh, assistant reject / edit / approve with backend verification (payment, commitment, audit), voice recording with a fake microphone and the real provider response, questions, reminder drafts, forecast, non-mutating what-if, mobile layout |
| Acceptance (opt-in) | `RUN_ACCEPTANCE=1 … npx playwright test e2e/acceptance.spec.ts` | seeded demo business | the full section-23 workflow with Ramesh. **Records a real ₹5,000 payment**; skips itself if Ramesh owes ≤ ₹5,000 |

E2E creates uniquely named customers on each run, so it repeats safely. Do not point it at production data.
Live Sarvam behaviour cannot be tested without the key. With no key, the voice test asserts the honest
"not configured" error, and it accepts a ready or error result when a key is present.
