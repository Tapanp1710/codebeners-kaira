#!/usr/bin/env bash
# Compressed PostgreSQL backup (pg_dump custom format) into ./backups, verified with pg_restore --list.
source "$(dirname "$0")/common.sh"
USER_="$(env_get POSTGRES_USER kaira)"; DB="$(env_get POSTGRES_DB kaira)"
mkdir -p backups
STAMP="$(date +%Y%m%d-%H%M%S)"; FILE="backups/kaira-$STAMP.dump"; IN="/tmp/kaira-$STAMP.dump"
step "Backing up database '$DB'"
run "pg_dump completed" docker compose exec -T db pg_dump -U "$USER_" -d "$DB" -Fc -f "$IN"
run "Backup verified (pg_restore --list)" docker compose exec -T db sh -c "pg_restore --list $IN > /dev/null"
run "Backup copied to host" docker compose cp "db:$IN" "$FILE"
docker compose exec -T db rm -f "$IN" >/dev/null
[ -s "$FILE" ] || fail "Backup file missing or empty"
ok "Backup written: $BACKEND_ROOT/$FILE ($(wc -c < "$FILE") bytes)"
