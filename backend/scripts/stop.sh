#!/usr/bin/env bash
# Stop containers; database data (docker volume) is preserved.
source "$(dirname "$0")/common.sh"
step "Stopping containers (data is preserved)"
run "Containers stopped" docker compose stop
