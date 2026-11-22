# Shared helpers for KAIRA backend PowerShell scripts (Windows PowerShell 5.1+).
# Native tools (docker) write progress to stderr; failures are detected via $LASTEXITCODE,
# so stderr must not be treated as a terminating error (Windows PowerShell 5.1 behaviour).
$ErrorActionPreference = 'Continue'
$script:BackendRoot = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "    OK  $Message" -ForegroundColor Green }
function Write-Warn2([string]$Message) { Write-Host "    !!  $Message" -ForegroundColor Yellow }
function Stop-WithError([string]$Message) {
    Write-Host "    FAILED  $Message" -ForegroundColor Red
    exit 1
}

# Runs a native command and fails the script if it returns a non-zero exit code.
function Invoke-Checked([string]$Description, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { Stop-WithError "$Description (exit code $LASTEXITCODE)" }
    Write-Ok $Description
}

function Test-CommandExists([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Read-DotEnv([string]$Path) {
    $values = @{}
    if (-not (Test-Path $Path)) { return $values }
    foreach ($line in Get-Content $Path) {
        if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
        $idx = $line.IndexOf('=')
        $values[$line.Substring(0, $idx).Trim()] = $line.Substring($idx + 1).Trim()
    }
    return $values
}

function Set-DotEnvValue([string]$Path, [string]$Key, [string]$Value) {
    $lines = Get-Content $Path
    $found = $false
    $out = foreach ($line in $lines) {
        if ($line -match "^\s*$([regex]::Escape($Key))=") { $found = $true; "$Key=$Value" } else { $line }
    }
    if (-not $found) { $out += "$Key=$Value" }
    [System.IO.File]::WriteAllLines($Path, [string[]]$out, (New-Object System.Text.UTF8Encoding($false)))
}

function New-Secret([int]$Bytes = 48) {
    $buffer = New-Object byte[] $Bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
    return ([Convert]::ToBase64String($buffer)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Wait-HttpOk([string]$Url, [int]$TimeoutSeconds = 90) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
            if ($r.StatusCode -eq 200) { return $true }
        } catch { Start-Sleep -Seconds 2 }
    }
    return $false
}

function Get-VenvPython {
    return (Join-Path $script:BackendRoot '.venv\Scripts\python.exe')
}
