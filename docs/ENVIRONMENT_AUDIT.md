# Environment audit

## Milestone 0 (initial)

- Project root: `C:/Users/Tarun Pendyala/Desktop/Codebenders/backend`, its own git repository. The parent folder
  `C:/Users/Tarun Pendyala` is a separate repository and is not used.
- Branch: `feat/kaira-backend`. Python 3.11.0, git 2.46.0, Docker 24.0.5.
- At that time, PostgreSQL on localhost:5432 was not reachable and no compose database existed.

## Update 2026-11-21

- PostgreSQL 17 runs via `docker compose up -d db` (127.0.0.1:5432, databases `kaira` and `kaira_test`).
- Docker Compose v2.20.2, Node 20.15.1 / npm 10.7.0 present (used only by the frontend repository).
- `localhost` resolution adds about 5 s per connection on this machine (IPv6 attempt first), so DSNs use `127.0.0.1`.
- No `psql` or `gh` CLI on the host. Database tooling runs inside the container.
