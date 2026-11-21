<#
.SYNOPSIS
  First-time KAIRA backend setup: prerequisites, .env, PostgreSQL, migrations, demo data.
.PARAMETER SkipVenv
  Do not create the local Python virtual environment (only needed for running tests).
.PARAMETER NoSeed
  Do not load demo data.
#>
param([switch]$SkipVenv, [switch]$NoSeed)
. "$PSScriptRoot\common.ps1"
Set-Location $script:BackendRoot

Write-Step 'Checking prerequisites'
if (-not (Test-CommandExists 'docker')) { Stop-WithError 'Docker is not installed. Install Docker Desktop: https://docs.docker.com/desktop/' }
docker info *> $null
if ($LASTEXITCODE -ne 0) { Stop-WithError 'Docker is installed but not running. Start Docker Desktop and retry.' }
docker compose version *> $null
if ($LASTEXITCODE -ne 0) { Stop-WithError 'Docker Compose v2 is required (included with Docker Desktop).' }
Write-Ok 'Docker and Docker Compose available'

Write-Step 'Preparing .env'
$envPath = Join-Path $script:BackendRoot '.env'
if (-not (Test-Path $envPath)) {
    Copy-Item (Join-Path $script:BackendRoot '.env.example') $envPath
    Write-Ok 'Created .env from .env.example'
}
$values = Read-DotEnv $envPath
if (-not $values['JWT_SECRET_KEY']) {
    Set-DotEnvValue $envPath 'JWT_SECRET_KEY' (New-Secret 48)
    Write-Ok 'Generated JWT_SECRET_KEY'
}
$generatedPassword = $null
if (-not $values['DEMO_OWNER_PASSWORD'] -and ($values['APP_ENV'] -eq 'development' -or -not $values['APP_ENV'])) {
    $generatedPassword = New-Secret 12
    Set-DotEnvValue $envPath 'DEMO_OWNER_PASSWORD' $generatedPassword
    Write-Ok 'Generated DEMO_OWNER_PASSWORD'
}
$values = Read-DotEnv $envPath
if (-not $values['SARVAM_API_KEY']) { Write-Warn2 'SARVAM_API_KEY is empty: voice and Sarvam AI are disabled; typed input still works.' }

Write-Step 'Starting PostgreSQL'
Invoke-Checked 'Database container started' { docker compose up -d db }
$healthy = $false
for ($i = 0; $i -lt 45; $i++) {
    $status = docker inspect -f '{{.State.Health.Status}}' kaira-backend-db-1 2>$null
    if ($status -eq 'healthy') { $healthy = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $healthy) { Stop-WithError 'PostgreSQL did not become healthy. Check: docker compose logs db' }
Write-Ok 'PostgreSQL is healthy'

Write-Step 'Building API image'
Invoke-Checked 'API image built' { docker compose build api }

Write-Step 'Validating configuration and applying migrations'
Invoke-Checked 'Configuration valid' { docker compose run --rm --no-deps --entrypoint python api -m app.cli check-config }
Invoke-Checked 'Migrations applied' { docker compose run --rm --no-deps --entrypoint python api -m app.cli migrate }

if (-not $NoSeed -and ($values['APP_ENV'] -eq 'development' -or -not $values['APP_ENV'])) {
    Write-Step 'Loading demo data (idempotent)'
    Invoke-Checked 'Demo data loaded' { docker compose run --rm --no-deps --entrypoint python api -m app.cli seed }
}

if (-not $SkipVenv) {
    Write-Step 'Preparing local Python environment (for tests and tooling)'
    $python = $null
    foreach ($candidate in @('py -3.11', 'python')) {
        $exe, $arg = $candidate.Split(' ')
        if (Test-CommandExists $exe) { $python = $candidate; break }
    }
    if (-not $python) {
        Write-Warn2 'Python 3.11+ not found; skipping local environment (Docker setup is complete).'
    } else {
        if (-not (Test-Path (Get-VenvPython))) {
            $exe, $arg = $python.Split(' ')
            if ($arg) { & $exe $arg -m venv .venv } else { & $exe -m venv .venv }
            if ($LASTEXITCODE -ne 0) { Stop-WithError 'Could not create .venv' }
        }
        Invoke-Checked 'Python dependencies installed' { & (Get-VenvPython) -m pip install -q -r requirements-dev.txt }
    }
}

Write-Host ''
Write-Host 'KAIRA backend setup complete.' -ForegroundColor Green
Write-Host "  Start:  .\scripts\start.ps1"
Write-Host "  Demo login: $($values['DEMO_OWNER_EMAIL'])"
if ($generatedPassword) { Write-Host "  Demo password (also saved in .env): $generatedPassword" }
