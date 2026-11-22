#!/bin/sh
# Container entrypoint: validate configuration, optionally migrate, then serve.
set -e

python -m app.cli check-config

if [ "${RUN_MIGRATIONS_ON_START:-false}" = "true" ]; then
  python -m app.cli wait-db --timeout 60
  python -m app.cli migrate
fi

# One worker by default: live-agent WebSocket tickets are single-use, and that is enforced per process
# (app/api/v1/endpoints/agent.py _used_tickets), so with N workers a ticket could be replayed up to N times within
# its 60 s lifetime. The free-tier target is a single 512 MB instance anyway. Raise WEB_CONCURRENCY only together
# with a shared (database-backed) ticket store.
exec uvicorn app.main:app \
  --host 0.0.0.0 \
  --port "${PORT:-8000}" \
  --workers "${WEB_CONCURRENCY:-1}" \
  --proxy-headers \
  --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-127.0.0.1}" \
  --timeout-graceful-shutdown 20 \
  --no-server-header
