#!/usr/bin/env bash
# First-time KAIRA backend setup. Flags: --skip-venv  --no-seed
source "$(dirname "$0")/common.sh"
SKIP_VENV=0; NO_SEED=0
for a in "$@"; do case "$a" in --skip-venv) SKIP_VENV=1;; --no-seed) NO_SEED=1;; esac; done

step "Checking prerequisites"
command -v docker >/dev/null || fail "Docker is not installed: https://docs.docker.com/get-docker/"
docker info >/dev/null 2>&1 || fail "Docker is installed but not running."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
ok "Docker and Docker Compose available"

step "Preparing .env"
if [ ! -f .env ]; then cp .env.example .env; ok "Created .env from .env.example"; fi
if [ -z "$(env_get JWT_SECRET_KEY)" ]; then env_set JWT_SECRET_KEY "$(new_secret 48)"; ok "Generated JWT_SECRET_KEY"; fi
APP_ENV="$(env_get APP_ENV development)"
GENERATED_PW=""
if [ -z "$(env_get DEMO_OWNER_PASSWORD)" ] && [ "$APP_ENV" = "development" ]; then
  GENERATED_PW="$(new_secret 12)"; env_set DEMO_OWNER_PASSWORD "$GENERATED_PW"; ok "Generated DEMO_OWNER_PASSWORD"
fi
[ -n "$(env_get SARVAM_API_KEY)" ] || warn "SARVAM_API_KEY is empty: voice and Sarvam AI are disabled; typed input still works."

step "Starting PostgreSQL"
run "Database container started" docker compose up -d db
for _ in $(seq 1 45); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' kaira-backend-db-1 2>/dev/null)" = "healthy" ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' kaira-backend-db-1 2>/dev/null)" = "healthy" ] \
  || fail "PostgreSQL did not become healthy (docker compose logs db)"
ok "PostgreSQL is healthy"

step "Building API image"
run "API image built" docker compose build api

step "Validating configuration and applying migrations"
run "Configuration valid" docker compose run --rm --no-deps --entrypoint python api -m app.cli check-config
run "Migrations applied" docker compose run --rm --no-deps --entrypoint python api -m app.cli migrate

if [ "$NO_SEED" -eq 0 ] && [ "$APP_ENV" = "development" ]; then
  step "Loading demo data (idempotent)"
  run "Demo data loaded" docker compose run --rm --no-deps --entrypoint python api -m app.cli seed
fi

if [ "$SKIP_VENV" -eq 0 ]; then
  step "Preparing local Python environment (tests and tooling)"
  if command -v python3.11 >/dev/null || command -v python3 >/dev/null; then
    PY="$(command -v python3.11 || command -v python3)"
    [ -x "$VENV_PY" ] || run "Virtual environment created" "$PY" -m venv .venv
    run "Python dependencies installed" "$VENV_PY" -m pip install -q -r requirements-dev.txt
  else
    warn "Python 3.11+ not found; skipping local environment (Docker setup is complete)."
  fi
fi

echo
printf '\033[32mKAIRA backend setup complete.\033[0m\n'
echo "  Start:       ./scripts/start.sh"
echo "  Demo login:  $(env_get DEMO_OWNER_EMAIL demo@kaira.local)"
[ -n "$GENERATED_PW" ] && echo "  Demo password (also saved in .env): $GENERATED_PW"
exit 0
