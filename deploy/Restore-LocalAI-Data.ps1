param(
    [Parameter(Mandatory = $true)][string]$Backup,
    [string]$Container = 'local-ai-appliance',
    [string]$HealthUrl = 'http://127.0.0.1:3080/healthz',
    [switch]$Force
)
# Replaces the appliance database with a backup made by Backup-LocalAI-Data.ps1.
# The current database is snapshotted first, so a restore can itself be undone.
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Backup)) { throw "Backup not found: $Backup" }
if (-not $Force) { throw "This replaces all appliance data with $Backup. Re-run with -Force to proceed." }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
function Run([scriptblock]$c, [string]$what) { $ErrorActionPreference = 'Continue'; $o = & $c 2>&1 | ForEach-Object { "$_" }; if ($LASTEXITCODE -ne 0) { throw "$what failed: $($o -join ' ')" } }

Run { docker exec $Container node /app/storage-cli.js backup --data-dir /data --output "/data/backups/pre-restore-$stamp.db" } 'Safety snapshot'
Run { docker cp $Backup "${Container}:/data/backups/restore-$stamp.db" } 'Copy backup in'
Run { docker stop $Container } 'Stop appliance'
# The data volume is reachable only through a container; use the stopped appliance's volume via a helper.
$image = (docker inspect $Container --format '{{.Config.Image}}')
# {{json}} rather than a template with "/data" in it: Windows PowerShell 5.1 strips quotes from native arguments.
# Assigned first: in 5.1 ConvertFrom-Json emits the whole array as one pipeline item; a variable enumerates it.
$mounts = (docker inspect $Container --format '{{json .Mounts}}') | ConvertFrom-Json
$volume = ($mounts | Where-Object { $_.Destination -eq '/data' } | Select-Object -First 1).Name
# As the appliance's own user, so the restored database stays writable by it (no User: it runs as root, and so does this).
$user = (docker inspect $Container --format '{{.Config.User}}')
$asUser = if ($user) { @('--user', $user) } else { @() }
Run { docker run --rm @asUser -v "${volume}:/data" --entrypoint sh $image -c "cd /data && rm -f localai.db-wal localai.db-shm && cp backups/restore-$stamp.db localai.db" } 'Swap database'
Run { docker start $Container } 'Start appliance'
for ($i = 0; $i -lt 60; $i++) { Start-Sleep 2; try { if ((Invoke-RestMethod $HealthUrl -TimeoutSec 3).status -eq 'ok') { Write-Host "Restored $Backup. Previous data kept as /data/backups/pre-restore-$stamp.db"; exit 0 } } catch { } }
throw "Appliance did not become healthy after restore. Previous data: /data/backups/pre-restore-$stamp.db"
