#!/usr/bin/env bash
# Start KAIRA frontend in the background. Flags: --dev  --rebuild  --port N
source "$(dirname "$0")/common.sh"
DEV=0; REBUILD=0; PORT=3000
while [ $# -gt 0 ]; do case "$1" in --dev) DEV=1;; --rebuild) REBUILD=1;; --port) PORT="$2"; shift;; esac; shift; done
mkdir -p "$RUN_DIR"
if [ -f "$RUN_DIR/frontend.pid" ] && kill -0 "$(cat "$RUN_DIR/frontend.pid")" 2>/dev/null; then
  fail "Already running (PID $(cat "$RUN_DIR/frontend.pid")). Run ./scripts/stop.sh first."
fi
run "Environment valid" node scripts/check-env.mjs
if [ "$DEV" -eq 0 ] && { [ "$REBUILD" -eq 1 ] || [ ! -f .next/BUILD_ID ]; }; then
  step "Building for production"; run "Production build" npm run -s build
fi
MODE=start; [ "$DEV" -eq 1 ] && MODE=dev
step "Starting KAIRA frontend ($MODE) on port $PORT"
nohup node node_modules/next/dist/bin/next "$MODE" --port "$PORT" > "$RUN_DIR/frontend.log" 2>&1 &
echo $! > "$RUN_DIR/frontend.pid"
wait_http "http://127.0.0.1:$PORT/login" 120 || { tail -20 "$RUN_DIR/frontend.log"; fail "Frontend did not respond on port $PORT"; }
ok "KAIRA running at http://localhost:$PORT (PID $(cat "$RUN_DIR/frontend.pid"))"
node scripts/check-env.mjs --connect || true
