#!/usr/bin/env bash
# Shared helpers for KAIRA frontend shell scripts (Linux/macOS).
# Sourced (not executed) by setup/start/stop/verify, so this strict mode applies to the caller too:
# -e exit on an unchecked failure, -u error on unset variables, pipefail fails a pipeline if any stage fails.
set -euo pipefail
# Resolve the repo root from this file's own location and cd there, so callers work from any directory.
FRONTEND_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# .run/ holds runtime state shared by start.sh and stop.sh (frontend.pid, frontend.log).
RUN_DIR="$FRONTEND_ROOT/.run"
cd "$FRONTEND_ROOT"

# Coloured log helpers (ANSI escapes). fail() exits the whole script with code 1.
step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m    OK  %s\033[0m\n' "$1"; }
warn() { printf '\033[33m    !!  %s\033[0m\n' "$1"; }
fail() { printf '\033[31m    FAILED  %s\033[0m\n' "$1"; exit 1; }
# run DESC CMD...: execute CMD; print OK on success, otherwise abort via fail() reporting the command's exit code.
run()  { local d="$1"; shift; if "$@"; then ok "$d"; else fail "$d (exit code $?)"; fi; }

# Next.js 16 needs Node >= 20.9; the comparison runs inside Node to avoid fragile shell version parsing.
assert_node() {
  command -v node >/dev/null || fail "Node.js is not installed (need 20.9+): https://nodejs.org"
  local v; v="$(node -p 'process.versions.node')"
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=9)?0:1)' \
    || fail "Node.js $v is too old; Next.js 16 needs 20.9 or newer."
  command -v npm >/dev/null || fail "npm is not available."
  ok "Node.js $v, npm $(npm --version)"
}

# wait_http URL [SECONDS=90]: poll every 2 s with curl -f (HTTP >= 400 counts as not ready); returns 1 on timeout.
wait_http() {
  local end=$((SECONDS + ${2:-90}))
  while [ $SECONDS -lt $end ]; do curl -fsS -o /dev/null "$1" && return 0; sleep 2; done
  return 1
}
