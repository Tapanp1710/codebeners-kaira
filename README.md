# KAIRA Frontend

The web app for KAIRA, a voice-first business operations partner for small businesses. Owners see cash,
receivables and forecasts, and speak or type requests. KAIRA turns them into proposals that are recorded only after
the owner approves them.

Next.js 16 · React 19 · TypeScript · Tailwind CSS 4 · TanStack Query · Recharts · Playwright · Vitest.

## Quick start

```powershell
.\scripts\setup.ps1          # Linux/macOS: ./scripts/setup.sh
# set BACKEND_ORIGIN in .env.local if the backend is not on this machine
.\scripts\start.ps1          # http://localhost:3000
```

Screens: **Dashboard · Customers & Invoices · Receivables · Cash-Flow Forecast · What-If Analysis**, plus Approvals,
Settings (owner) and the KAIRA assistant (orb, bottom right).

## How it talks to the backend

The browser calls only this app (`/api/backend/...`). A server-side proxy forwards to `BACKEND_ORIGIN`, so the
backend's HttpOnly session cookies stay first-party and no backend address or secret reaches the browser.
Types are generated from the backend's OpenAPI contract (`contracts/`).

## Docs

| | |
|---|---|
| [ARCHITECTURE](docs/ARCHITECTURE.md) | structure, auth/CSRF, data layer, voice, design system |
| [INTEGRATION](docs/INTEGRATION.md) | contract import, proxy rules, endpoints used, **two-laptop setup** |
| [ENVIRONMENT_SETUP](docs/ENVIRONMENT_SETUP.md) | variables, scripts, Node version notes |
| [TESTING](docs/TESTING.md) | unit, component, E2E and acceptance suites |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | Docker image, CI, production checklist |
| [STATUS](docs/STATUS.md) | what was verified, what is blocked, known limitations |
