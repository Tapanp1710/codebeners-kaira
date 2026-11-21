#!/usr/bin/env bash
# Stop the frontend started by start.sh. Never touches the backend or its database.
source "$(dirname "$0")/common.sh"
PIDFILE="$RUN_DIR/frontend.pid"
# No PID file means nothing was started by start.sh: exit 0 so stop is idempotent.
[ -f "$PIDFILE" ] || { ok "Frontend is not running"; exit 0; }
PID="$(cat "$PIDFILE")"
# kill -0 only tests that the PID is alive; a plain kill (SIGTERM) then stops it. The PID file is removed either way.
if kill -0 "$PID" 2>/dev/null; then kill "$PID" && ok "Stopped KAIRA frontend (PID $PID)"; else ok "Process $PID was not running"; fi
rm -f "$PIDFILE"
