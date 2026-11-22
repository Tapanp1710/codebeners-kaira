#!/usr/bin/env bash
# All backend quality gates. Exits non-zero on the first failure.
source "$(dirname "$0")/common.sh"
[ -x "$VENV_PY" ] || fail "Local .venv missing. Run ./scripts/setup.sh (without --skip-venv)."

step "Ensuring PostgreSQL is running"
run "Database container running" docker compose up -d db
sleep 2

step "Lint and format"
run "ruff check" "$VENV_PY" -m ruff check .
run "ruff format --check" "$VENV_PY" -m ruff format --check .

step "Migrations"
run "Database at head" "$VENV_PY" -m app.cli migrate
run "Models match migrations (alembic check)" "$VENV_PY" -m alembic check

step "API contract"
TMP="$(mktemp)"
run "OpenAPI generated" "$VENV_PY" -m app.cli export-openapi "$TMP"
diff -q <(tr -d '\r' < docs/openapi.json) <(tr -d '\r' < "$TMP") >/dev/null \
  || fail "docs/openapi.json is out of date. Run: python -m app.cli export-openapi"
ok "docs/openapi.json is current"

step "Tests (PostgreSQL)"
run "pytest" "$VENV_PY" -m pytest -q -p no:warnings

step "Live API (if running)"
PORT="$(env_get API_HOST_PORT 8000)"
if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/ready"; then ok "Running API ready"; else warn "API not running - skipped live check"; fi
printf '\033[32mAll backend checks passed.\033[0m\n'
