# Security

## Sessions (separate frontend and backend origins)

* Passwords: Argon2id (`argon2-cffi`). A dummy hash equalises timing for unknown e-mails. The same error is
  returned for a wrong e-mail and a wrong password.
* Access token: HS256 JWT (15 min, `aud=kaira-api`, `typ=access`, embedded `csrf` claim) in an **HttpOnly**
  cookie `kaira_access`.
* Refresh token: random 64-byte token in an HttpOnly cookie scoped to `/api/v1/auth`. Only its SHA-256 is
  stored. It is rotated on every refresh; re-use of a revoked token revokes all of that user's sessions.
  Logout revokes it.
* CSRF: unsafe cookie-authenticated requests need `X-CSRF-Token` equal to the access token's `csrf` claim
  (constant-time compare). The value is delivered in JSON bodies (login/refresh/me), so it works cross-origin,
  and the frontend keeps it in memory only. Bearer-token requests are not CSRF-prone.
* Cookie flags come from `COOKIE_SECURE`, `COOKIE_SAMESITE`, `COOKIE_DOMAIN`. In staging/production
  `COOKIE_SECURE=true` is enforced, and `SameSite=None` without `Secure` is refused at startup.
  Preferred deployment: same-site (`app.example.com` + `api.example.com`, `SameSite=Lax`) or a Next.js same-origin proxy.
* No tokens in localStorage. Nothing secret goes in `NEXT_PUBLIC_*` variables.

## Authorization and isolation

Roles: `owner` (all) and `staff` (no approve/reject, no business settings). Every service query filters by the
authenticated `business_id`. Another business's record IDs return `404`. Tests:
`test_cross_business_access_is_blocked`, `test_staff_cannot_change_settings_or_approve`,
`test_staff_can_propose_but_not_approve`.

## Financial integrity

Decimal end to end; row locks; idempotency keys; unique `(source_type, source_id)` on cash movements;
overpayment checks under lock; audit log for every state change (with before/after snapshots, password
hashes excluded); simulation in a read-only transaction.

## AI safety

See AI_ARCHITECTURE.md, "Guarantees".

## Configuration

Startup validation (`app/core/config.py`): in staging/production, `DATABASE_URL`, a `JWT_SECRET_KEY` of ≥ 32
characters and secure cookies are required, and the development DB password is rejected. Development
generates an ephemeral secret if none is set (the setup scripts write a persistent one). There is no
built-in default secret.

## Request hardening

Body limit 1 MB (5 MB for audio upload), checked on Content-Length **and** on streamed bodies. Audio is
validated by magic bytes.

Rate limits, all per minute:
- **Login:** per IP and per e-mail (`RATE_LIMIT_LOGIN_PER_MINUTE`).
- **AI and voice** (STT, LLM extraction, TTS): per user (`RATE_LIMIT_AI_PER_MINUTE`).
- **Payment-attempt register/execute/cancel and action approval:** per user (`RATE_LIMIT_PAYMENT_PER_MINUTE`).

The counters are kept in **PostgreSQL** (`rate_limit_buckets`, `RATE_LIMIT_BACKEND=postgres`, the default). Every
uvicorn worker and every API container therefore shares one budget per key. The image runs 2 workers, so a
per-process limiter would have allowed twice the configured login attempts. This is verified across separate OS
processes in `tests/api/test_rate_limit_shared.py`.

The algorithm is a sliding window approximated from two fixed windows, using the database clock. Each check commits
independently of the request, so a failed request still counts. `RATE_LIMIT_BACKEND=memory` keeps the old
in-process limiter and is correct only for a single worker.

Token refresh is deliberately not rate limited. Refresh tokens are single-use, rotating and high-entropy, and a
per-IP key would throttle every user behind a shared proxy (see "Client IP" below).

## Client IP

The login per-IP key uses the address uvicorn reports. Uvicorn trusts `X-Forwarded-For` only from
`FORWARDED_ALLOW_IPS` (default `127.0.0.1`). List the frontend server there **only if** its proxy does not
pass through a browser-supplied `X-Forwarded-For`. Otherwise a client could choose its own rate-limit key. That is a
requirement on the frontend proxy (`lib/server/proxy.ts` in kaira-frontend).

When `FORWARDED_ALLOW_IPS` doesn't list the frontend server, every request appears to come from the frontend server,
so the per-IP login budget is shared and the per-e-mail limit still applies.
CORS uses an explicit allow-list with credentials. Requests carry `X-Request-ID`, and logs are structured
JSON without secrets (httpx URL logging is silenced). The server header is disabled.

## Known limitations / follow-ups

* No account self-service (password reset, user invitations). Users are created with `python -m app.cli create-owner` or by the seed.
* Dependency audit runs in CI (`pip-audit`). It was not run locally.
