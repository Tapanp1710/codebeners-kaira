<#
.SYNOPSIS
  Start the KAIRA backend (PostgreSQL + API containers) and confirm it is reachable.
#>
. "$PSScriptRoot\common.ps1"
Set-Location $script:BackendRoot

if (-not (Test-Path (Join-Path $script:BackendRoot '.env'))) { Stop-WithError '.env not found. Run .\scripts\setup.ps1 first.' }
$values = Read-DotEnv (Join-Path $script:BackendRoot '.env')
$port = if ($values['API_HOST_PORT']) { $values['API_HOST_PORT'] } else { '8000' }

Write-Step 'Starting containers'
Invoke-Checked 'Containers started' { docker compose up -d --build }

Write-Step 'Waiting for the API to become ready'
if (-not (Wait-HttpOk "http://127.0.0.1:$port/ready" 120)) {
    docker compose logs --tail 40 api
    Stop-WithError "API did not become ready on port $port"
}
Write-Ok "API ready at http://127.0.0.1:$port"
Write-Host ''
Write-Host "  API docs:    http://127.0.0.1:$port/docs"
Write-Host "  Frontend:    set NEXT_PUBLIC_API_BASE_URL=http://<this-machine>:$port/api/v1 in kaira-frontend/.env.local"
Write-Host '  Stop:        .\scripts\stop.ps1'
