# Deployment

## Artefacts

* `next.config.ts`: `output: "standalone"`, security headers, pinned workspace root.
* `Dockerfile`: multi-stage, Node 22 Alpine, non-root user, `node server.js`, healthcheck on `/login`.
  `BACKEND_ORIGIN` is read at **runtime**, so one image works for every environment.
* `.github/workflows/ci.yml`: `npm ci`, env template check, contract/types check, lint, typecheck, unit tests,
  production build, `npm audit --omit=dev`, Docker build. Playwright E2E runs only when a staging backend is configured
  (`vars.E2E_BACKEND_ORIGIN` + secrets `E2E_EMAIL`, `E2E_PASSWORD`).

## Production checklist

1. Run the backend behind HTTPS with `COOKIE_SECURE=true`. Through the proxy, the browser only ever talks to the
   frontend's origin, so cookies are first-party and `COOKIE_SAMESITE=lax` is fine.
2. Serve the frontend over HTTPS (a platform or reverse proxy terminating TLS).
3. Set `BACKEND_ORIGIN=https://api.<your-domain>` (or the backend's private network address) as a **server** env var.
4. `docker build -t kaira-frontend . && docker run -p 3000:3000 -e BACKEND_ORIGIN=... kaira-frontend`,
   or on a Node host: `npm ci && npm run build && npm run start`.
5. Verify: `node scripts/check-env.mjs --connect`, sign in, and open each of the five screens.

No hosting provider has been chosen or provisioned. Nothing has been deployed publicly.
