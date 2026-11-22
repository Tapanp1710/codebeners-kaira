#!/usr/bin/env bash
# First-time KAIRA frontend setup. Flags: --skip-checks
source "$(dirname "$0")/common.sh"
# Order: Node check -> npm ci (exact lockfile) -> .env.local from template -> env + contract checks -> optional quality checks.
SKIP=0; [ "${1:-}" = "--skip-checks" ] && SKIP=1
step "Checking prerequisites"; assert_node
step "Installing locked dependencies (npm ci)"; run "Dependencies installed" npm ci --no-audit --no-fund
step "Preparing .env.local"
# An existing .env.local is never overwritten.
if [ ! -f .env.local ]; then cp .env.example .env.local; ok "Created .env.local - set BACKEND_ORIGIN"; else ok ".env.local exists (unchanged)"; fi
run "Environment valid" node scripts/check-env.mjs
step "Backend contract and generated types"; run "Contract and types consistent" node scripts/contract.mjs check
if [ "$SKIP" -eq 0 ]; then
  step "Quality checks"
  run "ESLint" npm run -s lint
  run "TypeScript" npm run -s typecheck
  run "Unit and component tests" npm run -s test
fi
# Connectivity is informational only (|| true): setup succeeds even if the backend is not running yet.
step "Backend connectivity"; node scripts/check-env.mjs --connect || true
printf '\033[32mKAIRA frontend setup complete.\033[0m  Start: ./scripts/start.sh  (or ./scripts/start.sh --dev)\n'
