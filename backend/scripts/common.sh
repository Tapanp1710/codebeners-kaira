#!/usr/bin/env bash
# Shared helpers for KAIRA backend shell scripts (Linux/macOS).
set -euo pipefail
BACKEND_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BACKEND_ROOT"

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m    OK  %s\033[0m\n' "$1"; }
warn() { printf '\033[33m    !!  %s\033[0m\n' "$1"; }
fail() { printf '\033[31m    FAILED  %s\033[0m\n' "$1"; exit 1; }

# run "description" cmd args...  -> fails the script on non-zero exit
run() { local d="$1"; shift; if "$@"; then ok "$d"; else fail "$d (exit code $?)"; fi; }

env_get() { # env_get KEY [default]
  local v=""
  [ -f .env ] && v="$(grep -E "^$1=" .env | tail -n1 | cut -d= -f2- || true)"
  printf '%s' "${v:-${2:-}}"
}

env_set() { # env_set KEY VALUE
  if grep -qE "^$1=" .env; then
    local tmp; tmp="$(mktemp)"
    awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' .env > "$tmp" && mv "$tmp" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

new_secret() { python3 -c "import secrets,sys; print(secrets.token_urlsafe(int(sys.argv[1])))" "${1:-48}" 2>/dev/null \
  || head -c "${1:-48}" /dev/urandom | base64 | tr -d '\n=+/' ; }

wait_http() { # wait_http URL TIMEOUT
  local end=$((SECONDS + ${2:-90}))
  while [ $SECONDS -lt $end ]; do
    if curl -fsS -o /dev/null "$1"; then return 0; fi
    sleep 2
  done
  return 1
}

VENV_PY="$BACKEND_ROOT/.venv/bin/python"
