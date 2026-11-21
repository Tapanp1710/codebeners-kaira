# Shared helpers for KAIRA frontend PowerShell scripts (Windows PowerShell 5.1+).
# Native tools write progress to stderr; failures are detected via $LASTEXITCODE.
# 'Continue' (not 'Stop') so stderr from npm/node is not turned into a terminating error; Invoke-Checked checks exit codes instead.
$ErrorActionPreference = 'Continue'
# Repo root = parent of the scripts folder; RunDir (.run) holds frontend.pid and frontend.log for start/stop.
$script:FrontendRoot = Split-Path -Parent $PSScriptRoot
$script:RunDir = Join-Path $script:FrontendRoot '.run'

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "    OK  $Message" -ForegroundColor Green }
function Write-Warn2([string]$Message) { Write-Host "    !!  $Message" -ForegroundColor Yellow }
# Exits the whole script, including scripts that dot-sourced this file, with code 1.
function Stop-WithError([string]$Message) {
    Write-Host "    FAILED  $Message" -ForegroundColor Red
    exit 1
}
# Runs a scriptblock that calls a native tool and fails the script if that tool's exit code is non-zero.
function Invoke-Checked([string]$Description, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { Stop-WithError "$Description (exit code $LASTEXITCODE)" }
    Write-Ok $Description
}
function Test-CommandExists([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

# Same Node >= 20.9 requirement as common.sh; the version is compared numerically, part by part.
function Assert-Node {
    if (-not (Test-CommandExists 'node')) { Stop-WithError 'Node.js is not installed. Install Node.js 20.9+ (LTS 22 recommended): https://nodejs.org' }
    $v = (node -p "process.versions.node").Trim()
    $parts = $v.Split('.') | ForEach-Object { [int]$_ }
    if ($parts[0] -lt 20 -or ($parts[0] -eq 20 -and $parts[1] -lt 9)) { Stop-WithError "Node.js $v is too old; Next.js 16 needs 20.9 or newer." }
    if (-not (Test-CommandExists 'npm')) { Stop-WithError 'npm is not available.' }
    Write-Ok "Node.js $v, npm $((npm --version).Trim())"
}

# Polls a URL until it returns a 2xx/3xx status or the deadline passes. Redirects are not followed and each
# attempt times out after 5 s; any exception (connection refused, timeout, error status) waits 2 s and retries.
function Wait-HttpOk([string]$Url, [int]$TimeoutSeconds = 90) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5 -MaximumRedirection 0
            if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400) { return $true }
        } catch { Start-Sleep -Seconds 2 }
    }
    return $false
}
