<#
.SYNOPSIS
  Create a compressed PostgreSQL backup (pg_dump custom format) in .\backups and verify it.
#>
. "$PSScriptRoot\common.ps1"
Set-Location $script:BackendRoot
$values = Read-DotEnv (Join-Path $script:BackendRoot '.env')
$user = if ($values['POSTGRES_USER']) { $values['POSTGRES_USER'] } else { 'kaira' }
$dbName = if ($values['POSTGRES_DB']) { $values['POSTGRES_DB'] } else { 'kaira' }

$dir = Join-Path $script:BackendRoot 'backups'
New-Item -ItemType Directory -Force $dir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$file = Join-Path $dir "kaira-$stamp.dump"
$inContainer = "/tmp/kaira-$stamp.dump"

Write-Step "Backing up database '$dbName'"
Invoke-Checked 'pg_dump completed' { docker compose exec -T db pg_dump -U $user -d $dbName -Fc -f $inContainer }
Invoke-Checked 'Backup verified (pg_restore --list)' { docker compose exec -T db sh -c "pg_restore --list $inContainer > /dev/null" }
Invoke-Checked 'Backup copied to host' { docker compose cp "db:$inContainer" $file }
docker compose exec -T db rm -f $inContainer | Out-Null
if (-not (Test-Path $file) -or (Get-Item $file).Length -eq 0) { Stop-WithError 'Backup file missing or empty' }
Write-Ok ("Backup written: {0} ({1:N0} bytes)" -f $file, (Get-Item $file).Length)
