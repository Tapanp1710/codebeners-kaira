# Integration status

## Current contract

| Item | Value |
|---|---|
| API version | 1.0.0 |
| OpenAPI | `docs/openapi.json`: 39 paths, 109 schemas, sha256 prefix `d5e1169a42676b83` |
| Backend commit | `git log -1 --format=%H -- docs/openapi.json` (the commit that last changed the contract) |
| Frontend synchronised | **No.** The frontend repository is on another laptop and is not accessible from this workspace |

## Verification matrix (as of 2026-11-21)

| Integration | State | Evidence |
|---|---|---|
| Backend ↔ PostgreSQL 17 (Docker) | Verified | full pytest suite; containerised API `/ready` = database ok, migrations current |
| Migrations (apply, `alembic check`, downgrade→upgrade) | Verified locally | commands run 2026-11-21 |
| Auth cookies + CSRF over real HTTP | Verified (curl against the container) | login, dashboard, CSRF rejection, extract with CSRF |
| CORS for `http://localhost:3000` | Verified (preflight test) | `test_cors_allows_frontend_origin_with_credentials` |
| Frontend ↔ backend | **Not verified** | no frontend in this workspace |
| Sarvam STT / LLM / TTS | **Not live-verified**. Request/response handling is tested with a mocked transport only | `SARVAM_API_KEY` not provided |
| Setup / start / backup / restore / verify (PowerShell) | Verified on Windows 11 | run 2026-11-21, exit codes checked, including a forced-failure check |
| Shell scripts (Linux/macOS) | Syntax-checked only (`bash -n`) | not executed on Linux/macOS |
| GitHub Actions workflows | Written, **not executed** | no GitHub remote configured for this repository |

## Change log

* 1.0.0: initial complete contract.
