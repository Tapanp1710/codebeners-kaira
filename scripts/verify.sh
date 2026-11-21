#!/usr/bin/env bash
# All frontend quality gates. Flag --e2e also runs Playwright (needs E2E_EMAIL/E2E_PASSWORD).
source "$(dirname "$0")/common.sh"
# Same gates as CI's checks job except npm audit, in fail-fast order: run() aborts on the first failing step.
assert_node
run "Environment valid" node scripts/check-env.mjs
run "Contract / types / live backend contract" node scripts/contract.mjs check
run "ESLint (0 warnings)" npm run -s lint
run "TypeScript" npm run -s typecheck
run "Unit and component tests" npm run -s test
run "Production build" npm run -s build
# E2E is opt-in: it needs a live backend and owner credentials, which are checked before Playwright starts.
if [ "${1:-}" = "--e2e" ]; then
  [ -n "${E2E_EMAIL:-}" ] && [ -n "${E2E_PASSWORD:-}" ] || fail "Set E2E_EMAIL and E2E_PASSWORD (non-production owner)."
  run "End-to-end tests (real backend)" npx playwright test
fi
printf '\033[32mAll frontend checks passed.\033[0m\n'
