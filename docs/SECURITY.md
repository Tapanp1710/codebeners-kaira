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
validated by magic bytes. Rate limits apply per IP and per e-mail on login, and per user on AI/voice
(in-process sliding window: fine for one instance; use a gateway limiter when scaling horizontally).
CORS uses an explicit allow-list with credentials. Requests carry `X-Request-ID`, and logs are structured
JSON without secrets (httpx URL logging is silenced). The server header is disabled.

## Known limitations / follow-ups

* The rate limiter is per process (multi-worker deployments multiply the limits).
* No account self-service (password reset, user invitations). Users are created with `python -m app.cli create-owner` or by the seed.
* Dependency audit runs in CI (`pip-audit`). It was not run locally.
