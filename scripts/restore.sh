#!/usr/bin/env bash
# Restore a backup. DESTRUCTIVE. Usage: ./scripts/restore.sh backups/kaira-XXXX.dump --confirm
source "$(dirname "$0")/common.sh"
FILE="${1:-}"; CONFIRM="${2:-}"
[ -n "$FILE" ] && [ -f "$FILE" ] || fail "Usage: ./scripts/restore.sh <file.dump> --confirm"
[ "$CONFIRM" = "--confirm" ] || fail "Restoring overwrites the current database. Re-run with --confirm."
USER_="$(env_get POSTGRES_USER kaira)"; DB="$(env_get POSTGRES_DB kaira)"
step "Stopping API to avoid writes during restore"
docker compose stop api >/dev/null || true
run "Backup copied into container" docker compose cp "$FILE" db:/tmp/restore.dump
run "Database restored" docker compose exec -T db pg_restore -U "$USER_" -d "$DB" --clean --if-exists --no-owner /tmp/restore.dump
docker compose exec -T db rm -f /tmp/restore.dump >/dev/null
ok "Restore complete. Start the API with ./scripts/start.sh"
