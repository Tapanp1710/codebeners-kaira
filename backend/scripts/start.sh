#!/usr/bin/env bash
# Start PostgreSQL + API containers and confirm the API is reachable.
source "$(dirname "$0")/common.sh"
[ -f .env ] || fail ".env not found. Run ./scripts/setup.sh first."
PORT="$(env_get API_HOST_PORT 8000)"
step "Starting containers"
run "Containers started" docker compose up -d --build
step "Waiting for the API to become ready"
if ! wait_http "http://127.0.0.1:$PORT/ready" 120; then
  docker compose logs --tail 40 api
  fail "API did not become ready on port $PORT"
fi
ok "API ready at http://127.0.0.1:$PORT"
echo "  API docs:  http://127.0.0.1:$PORT/docs"
echo "  Frontend:  NEXT_PUBLIC_API_BASE_URL=http://<this-machine>:$PORT/api/v1"
