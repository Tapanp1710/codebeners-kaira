<#
.SYNOPSIS
  Run every backend quality gate: lint, format, migrations check, OpenAPI drift, tests,
  and (if running) the live health endpoints. Exits non-zero on the first failure.
#>
. "$PSScriptRoot\common.ps1"
Set-Location $script:BackendRoot
$py = Get-VenvPython
if (-not (Test-Path $py)) { Stop-WithError 'Local .venv missing. Run .\scripts\setup.ps1 (without -SkipVenv).' }

Write-Step 'Ensuring PostgreSQL is running (tests use the kaira_test database)'
Invoke-Checked 'Database container running' { docker compose up -d db }
Start-Sleep -Seconds 2

Write-Step 'Lint and format'
Invoke-Checked 'ruff check' { & $py -m ruff check . }
Invoke-Checked 'ruff format --check' { & $py -m ruff format --check . }

Write-Step 'Migrations'
Invoke-Checked 'Database at head' { & $py -m app.cli migrate }
Invoke-Checked 'Models match migrations (alembic check)' { & $py -m alembic check }

Write-Step 'API contract'
$tmp = Join-Path $env:TEMP 'kaira-openapi-check.json'
Invoke-Checked 'OpenAPI generated' { & $py -m app.cli export-openapi $tmp }
$current = (Get-Content (Join-Path $script:BackendRoot 'docs\openapi.json') -Raw) -replace "`r", ''
$fresh = (Get-Content $tmp -Raw) -replace "`r", ''
if ($current -ne $fresh) { Stop-WithError 'docs/openapi.json is out of date. Run: python -m app.cli export-openapi' }
Write-Ok 'docs/openapi.json is current'

Write-Step 'Tests (PostgreSQL)'
Invoke-Checked 'pytest' { & $py -m pytest -q -p no:warnings }

$values = Read-DotEnv (Join-Path $script:BackendRoot '.env')
$port = if ($values['API_HOST_PORT']) { $values['API_HOST_PORT'] } else { '8000' }
Write-Step 'Live API (if running)'
try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/ready" -UseBasicParsing -TimeoutSec 5
    Write-Ok "Running API ready (HTTP $($r.StatusCode))"
} catch {
    Write-Warn2 'API container not running - skipped live check (start with .\scripts\start.ps1)'
}
Write-Host ''
Write-Host 'All backend checks passed.' -ForegroundColor Green
