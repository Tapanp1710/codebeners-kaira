<#
.SYNOPSIS
  All frontend quality gates: contract, lint, types, unit tests, production build, and optionally E2E.
.PARAMETER E2E
  Also run Playwright against the real backend (needs E2E_EMAIL and E2E_PASSWORD env vars).
#>
param([switch]$E2E)
. "$PSScriptRoot\common.ps1"
Set-Location $script:FrontendRoot
# Same gates as CI's checks job except npm audit, fail-fast: Invoke-Checked exits on the first non-zero exit code.
Assert-Node
Invoke-Checked 'Environment valid' { node scripts/check-env.mjs }
Invoke-Checked 'Contract / types / live backend contract' { node scripts/contract.mjs check }
Invoke-Checked 'ESLint (0 warnings)' { npm run -s lint }
Invoke-Checked 'TypeScript' { npm run -s typecheck }
Invoke-Checked 'Unit and component tests' { npm run -s test }
Invoke-Checked 'Production build' { npm run -s build }
# -E2E is opt-in: it needs a live backend and owner credentials, which are checked before Playwright starts.
if ($E2E) {
    if (-not $env:E2E_EMAIL -or -not $env:E2E_PASSWORD) { Stop-WithError 'Set E2E_EMAIL and E2E_PASSWORD for an owner account on a NON-production backend.' }
    Invoke-Checked 'End-to-end tests (real backend)' { npx playwright test }
}
Write-Host ''
Write-Host 'All frontend checks passed.' -ForegroundColor Green
