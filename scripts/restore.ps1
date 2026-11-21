<#
.SYNOPSIS
  Restore a backup created by backup.ps1. DESTRUCTIVE: replaces the current database contents.
.PARAMETER File
  Path to a .dump file.
.PARAMETER Confirm
  Required. Confirms you intend to overwrite the current database.
#>
param([Parameter(Mandatory = $true)][string]$File, [switch]$Confirm)
. "$PSScriptRoot\common.ps1"
Set-Location $script:BackendRoot
if (-not $Confirm) { Stop-WithError 'Restoring overwrites the current database. Re-run with -Confirm to proceed.' }
if (-not (Test-Path $File)) { Stop-WithError "Backup file not found: $File" }
$values = Read-DotEnv (Join-Path $script:BackendRoot '.env')
$user = if ($values['POSTGRES_USER']) { $values['POSTGRES_USER'] } else { 'kaira' }
$dbName = if ($values['POSTGRES_DB']) { $values['POSTGRES_DB'] } else { 'kaira' }

Write-Step 'Stopping API to avoid writes during restore'
docker compose stop api | Out-Null
Invoke-Checked 'Backup copied into container' { docker compose cp $File 'db:/tmp/restore.dump' }
Invoke-Checked 'Database restored' { docker compose exec -T db pg_restore -U $user -d $dbName --clean --if-exists --no-owner /tmp/restore.dump }
docker compose exec -T db rm -f /tmp/restore.dump | Out-Null
Write-Ok 'Restore complete. Start the API with .\scripts\start.ps1'
