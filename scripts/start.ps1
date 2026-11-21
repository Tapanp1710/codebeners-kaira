<#
.SYNOPSIS
  Start KAIRA frontend in the background and confirm it is reachable.
.PARAMETER Dev
  Run the development server instead of the production build.
.PARAMETER Rebuild
  Force a fresh production build.
.PARAMETER Port
  Port to listen on (default 3000).
#>
param([switch]$Dev, [switch]$Rebuild, [int]$Port = 3000)
. "$PSScriptRoot\common.ps1"
Set-Location $script:FrontendRoot
New-Item -ItemType Directory -Force $script:RunDir | Out-Null
$pidFile = Join-Path $script:RunDir 'frontend.pid'
$logFile = Join-Path $script:RunDir 'frontend.log'

if (Test-Path $pidFile) {
    $old = Get-Content $pidFile
    if (Get-Process -Id $old -ErrorAction SilentlyContinue) { Stop-WithError "KAIRA frontend already running (PID $old). Run .\scripts\stop.ps1 first." }
}
Invoke-Checked 'Environment valid' { node scripts/check-env.mjs }

$nextBin = Join-Path $script:FrontendRoot 'node_modules/next/dist/bin/next'
if (-not (Test-Path $nextBin)) { Stop-WithError 'Dependencies missing. Run .\scripts\setup.ps1 first.' }
if (-not $Dev) {
    if ($Rebuild -or -not (Test-Path (Join-Path $script:FrontendRoot '.next/BUILD_ID'))) {
        Write-Step 'Building for production'
        Invoke-Checked 'Production build' { npm run -s build }
    }
    $mode = 'start'
} else {
    $mode = 'dev'
}

Write-Step "Starting KAIRA frontend ($mode) on port $Port"
# Win32_Process.Create starts a detached process that inherits no handles, so this script returns
# promptly even when its own output is captured (CI, other scripts).
$node = (Get-Command node).Source
$commandLine = "cmd.exe /d /c `"`"$node`" `"$nextBin`" $mode --port $Port > `"$logFile`" 2>&1`""
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine; CurrentDirectory = $script:FrontendRoot }
if ($created.ReturnValue -ne 0) { Stop-WithError "Could not start the frontend process (Win32 error $($created.ReturnValue))" }
Set-Content -Path $pidFile -Value $created.ProcessId
if (-not (Wait-HttpOk "http://127.0.0.1:$Port/login" 120)) {
    Get-Content $logFile -Tail 20 -ErrorAction SilentlyContinue
    Stop-WithError "Frontend did not respond on port $Port (log: $logFile)"
}
Write-Ok "KAIRA running at http://localhost:$Port  (PID $($created.ProcessId), log $logFile)"
node scripts/check-env.mjs --connect
