# Integration handoff: kaira-backend → kaira-frontend

The frontend is developed on a different laptop in a separate repository. Everything it needs is
in this repository's `docs/` folder. The backend owns the contract.

## What to copy into kaira-frontend

| File | Destination in kaira-frontend | Purpose |
|---|---|---|
| `docs/openapi.json` | `contract/openapi.json` | Source for generated TypeScript types |
| `docs/API_CONTRACT.md` | `contract/API_CONTRACT.md` | Auth/CSRF/envelope/money conventions |
| `docs/DATABASE_SCHEMA.md` | `contract/DATABASE_SCHEMA.md` | Reference only (frontend never connects to PostgreSQL) |
| this file | `contract/INTEGRATION_HANDOFF.md` | Version record |

Record the source in `kaira-frontend/contract/CONTRACT_VERSION`:

```
api_version=1.0.0
backend_branch=feat/kaira-backend
backend_commit=<git rev-parse HEAD of kaira-backend when copied>
openapi_sha256_prefix=<sha256sum docs/openapi.json | cut -c1-16>
```

Current contract: **version 1.0.0, 39 paths, 109 schemas.** The commit and hash are recorded in
`docs/INTEGRATION_STATUS.md` with each contract change.

## Generating types (frontend)

```
npx openapi-typescript contract/openapi.json -o src/lib/api/schema.d.ts
```

Contract compatibility test idea for the frontend CI: regenerate into a temp file and `diff`
against the committed `schema.d.ts`; fail if different.

## Connecting to the backend

| Scenario | NEXT_PUBLIC_API_BASE_URL | Backend `.env` |
|---|---|---|
| Same machine | `http://localhost:8000/api/v1` | `CORS_ORIGINS=http://localhost:3000` (default) |
| Backend on another laptop (LAN) | `http://<backend-laptop-LAN-IP>:8000/api/v1` | add the frontend's origin, e.g. `CORS_ORIGINS=http://localhost:3000,http://<frontend-laptop-IP>:3000` |
| Staging / production | `https://api.<domain>/api/v1` | `CORS_ORIGINS=https://app.<domain>`, `COOKIE_SECURE=true` |

Notes:
* The LAN IP is configuration only. Never hardcode it in source.
* **Cookies across laptops.** When the browser on the frontend laptop calls the backend on another IP,
  the page origin (`http://<frontend-ip>:3000`) and the API (`http://<backend-ip>:8000`) are different
  sites. Browsers then refuse `SameSite=Lax` cookies on `fetch`, and `SameSite=None` requires HTTPS.
  The two supported options:
  1. **Recommended:** a same-origin proxy in Next.js. Add a rewrite (`/api/v1/:path*` → `http://<backend-ip>:8000/api/v1/:path*`)
     and set `NEXT_PUBLIC_API_BASE_URL=/api/v1`. The browser sees one origin, and the cookies work over plain HTTP on the LAN.
  2. Open the app via `http://localhost:3000` on the backend laptop itself, which is same-site with `localhost:8000`.
* On Windows, allow inbound TCP 8000 in the firewall on the backend laptop for LAN access.
* Docker Compose publishes the API on `0.0.0.0:8000`. PostgreSQL is bound to `127.0.0.1` only.

## Contract change procedure (backend side)

1. Change the code and tests.
2. Run `python -m app.cli export-openapi` (writes `docs/openapi.json`).
3. Run `scripts/verify` (CI also fails on drift).
4. Commit, then note the change in `docs/INTEGRATION_STATUS.md` (breaking or additive).
5. Copy the files to the frontend, regenerate the types, and run the frontend contract test.
