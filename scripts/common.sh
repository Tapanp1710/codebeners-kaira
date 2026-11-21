#!/usr/bin/env bash
# Shared helpers for KAIRA frontend shell scripts (Linux/macOS).
set -euo pipefail
FRONTEND_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$FRONTEND_ROOT/.run"
cd "$FRONTEND_ROOT"

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m    OK  %s\033[0m\n' "$1"; }
warn() { printf '\033[33m    !!  %s\033[0m\n' "$1"; }
fail() { printf '\033[31m    FAILED  %s\033[0m\n' "$1"; exit 1; }
run()  { local d="$1"; shift; if "$@"; then ok "$d"; else fail "$d (exit code $?)"; fi; }

assert_node() {
  command -v node >/dev/null || fail "Node.js is not installed (need 20.9+): https://nodejs.org"
  local v; v="$(node -p 'process.versions.node')"
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=9)?0:1)' \
    || fail "Node.js $v is too old; Next.js 16 needs 20.9 or newer."
  command -v npm >/dev/null || fail "npm is not available."
  ok "Node.js $v, npm $(npm --version)"
}

wait_http() {
  local end=$((SECONDS + ${2:-90}))
  while [ $SECONDS -lt $end ]; do curl -fsS -o /dev/null "$1" && return 0; sleep 2; done
  return 1
}
