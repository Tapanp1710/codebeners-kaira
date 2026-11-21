#!/bin/sh
# Container entrypoint: validate configuration, optionally migrate, then serve.
set -e

python -m app.cli check-config

if [ "${RUN_MIGRATIONS_ON_START:-false}" = "true" ]; then
  python -m app.cli wait-db --timeout 60
  python -m app.cli migrate
fi

exec uvicorn app.main:app \
  --host 0.0.0.0 \
  --port "${PORT:-8000}" \
  --workers "${WEB_CONCURRENCY:-2}" \
  --proxy-headers \
  --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-127.0.0.1}" \
  --timeout-graceful-shutdown 20 \
  --no-server-header
