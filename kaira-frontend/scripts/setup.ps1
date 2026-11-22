<#
.SYNOPSIS
  First-time KAIRA frontend setup: Node check, locked install, .env.local, contract + types, checks,
  backend connectivity report. Never touches the backend.
.PARAMETER SkipChecks
  Skip lint/typecheck/unit tests (faster first run).
#>
param([switch]$SkipChecks)
# Dot-source the shared helpers so their functions and $script: variables live in this script's scope.
. "$PSScriptRoot\common.ps1"
Set-Location $script:FrontendRoot

Write-Step 'Checking prerequisites'
Assert-Node

Write-Step 'Installing locked dependencies (npm ci)'
# npm ci installs exactly what package-lock.json pins and fails if it is out of sync with package.json.
Invoke-Checked 'Dependencies installed from package-lock.json' { npm ci --no-audit --no-fund }

Write-Step 'Preparing .env.local'
$envFile = Join-Path $script:FrontendRoot '.env.local'
# An existing .env.local is never overwritten.
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $script:FrontendRoot '.env.example') $envFile
    Write-Ok 'Created .env.local from .env.example - set BACKEND_ORIGIN to your backend address'
} else { Write-Ok '.env.local exists (left unchanged)' }
Invoke-Checked 'Environment valid' { node scripts/check-env.mjs }

Write-Step 'Backend contract and generated types'
Invoke-Checked 'Contract and TypeScript types are consistent' { node scripts/contract.mjs check }

if (-not $SkipChecks) {
    Write-Step 'Quality checks'
    Invoke-Checked 'ESLint' { npm run -s lint }
    Invoke-Checked 'TypeScript' { npm run -s typecheck }
    Invoke-Checked 'Unit and component tests' { npm run -s test }
}

# Informational only: the connectivity probe's exit code is not checked, so setup completes with the backend down.
Write-Step 'Backend connectivity'
node scripts/check-env.mjs --connect

Write-Host ''
Write-Host 'KAIRA frontend setup complete.' -ForegroundColor Green
Write-Host '  Start:  .\scripts\start.ps1      (production build)   or   .\scripts\start.ps1 -Dev'
