<#
.SYNOPSIS
  Stop the KAIRA frontend started by start.ps1. Does not touch the backend or its database.
#>
. "$PSScriptRoot\common.ps1"
$pidFile = Join-Path $script:RunDir 'frontend.pid'
if (-not (Test-Path $pidFile)) { Write-Ok 'Frontend is not running (no PID file).'; exit 0 }
$procId = Get-Content $pidFile
if (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
    taskkill /PID $procId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithError "Could not stop PID $procId" }
    Write-Ok "Stopped KAIRA frontend (PID $procId)"
} else {
    Write-Ok "Process $procId was not running"
}
Remove-Item $pidFile -Force
