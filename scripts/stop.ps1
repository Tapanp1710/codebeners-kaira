<#
.SYNOPSIS
  Stop the KAIRA backend containers. Database data (docker volume) is preserved.
#>
. "$PSScriptRoot\common.ps1"
Set-Location $script:BackendRoot
Write-Step 'Stopping containers (data is preserved)'
Invoke-Checked 'Containers stopped' { docker compose stop }
