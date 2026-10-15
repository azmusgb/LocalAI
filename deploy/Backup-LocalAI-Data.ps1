param(
    [string]$Container = 'local-ai-appliance',
    [string]$BackupRoot = 'C:\LocalAI\backups\data',
    # A second copy off this disk. OneDrive syncs it to the cloud; pass '' to skip.
    [string]$OffsiteRoot = "$env:USERPROFILE\OneDrive\LocalAI-Backups",
    [int]$KeepDaily = 7,
    [int]$KeepWeekly = 4
)
# Nightly backup of the appliance database: a consistent SQLite snapshot (VACUUM INTO, includes WAL writes),
# verified by opening it read-only with the app's own storage code before it is kept, then pruned to
# 7 daily + 4 weekly copies locally and off-box. Writes C:\LocalAI\backups\last-backup.json for monitoring.
$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$name = "localai-$stamp.db"
$statusFile = Join-Path (Split-Path $BackupRoot -Parent) 'last-backup.json'
New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null

function Invoke-Native([scriptblock]$Command, [string]$What) {
    $ErrorActionPreference = 'Continue'
    $out = & $Command 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -ne 0) { throw "$What failed: $($out -join ' ')" }
    return ($out | Where-Object { $_ -notmatch 'ExperimentalWarning|trace-warnings' }) -join "`n"
}
function Select-Keep([System.IO.FileInfo[]]$Files) {
    $sorted = $Files | Sort-Object Name -Descending
    $keep = @($sorted | Select-Object -First $KeepDaily)
    # Weekly copies come from the weeks before the daily window, so 7 daily + 4 weekly reaches back about five weeks.
    $dailyWeeks = @{}
    foreach ($f in $keep) { $d = [datetime]::ParseExact($f.BaseName.Substring(8, 8), 'yyyyMMdd', $null); $dailyWeeks['{0}-{1}' -f $d.Year, [Globalization.CultureInfo]::InvariantCulture.Calendar.GetWeekOfYear($d, 'FirstFourDayWeek', 'Monday')] = $true }
    $weeks = @{}
    foreach ($f in ($sorted | Select-Object -Skip $KeepDaily)) {
        $d = [datetime]::ParseExact($f.BaseName.Substring(8, 8), 'yyyyMMdd', $null)
        $week = '{0}-{1}' -f $d.Year, [Globalization.CultureInfo]::InvariantCulture.Calendar.GetWeekOfYear($d, 'FirstFourDayWeek', 'Monday')
        if (-not $dailyWeeks.ContainsKey($week) -and -not $weeks.ContainsKey($week) -and $weeks.Count -lt $KeepWeekly) { $weeks[$week] = $f }
    }
    return @($keep + $weeks.Values | Select-Object -Unique)
}

$result = [ordered]@{ at = (Get-Date).ToString('o'); ok = $false; file = $null; sizeBytes = 0; counts = $null; offsite = $null; error = $null }
try {
    # 1. Snapshot inside the container, then copy it out.
    Invoke-Native { docker exec $Container node /app/storage-cli.js backup --data-dir /data --output "/data/backups/nightly/$name" } 'Snapshot' | Out-Null
    $local = Join-Path $BackupRoot $name
    Invoke-Native { docker cp "${Container}:/data/backups/nightly/$name" $local } 'Copy out' | Out-Null
    Invoke-Native { docker exec $Container rm -f "/data/backups/nightly/$name" } 'Cleanup' | Out-Null

    # 2. Restore test: open the copy read-only with the app's storage code in a scratch folder.
    $probe = "/tmp/restore-test-$stamp"
    Invoke-Native { docker exec $Container mkdir -p $probe } 'Restore test setup' | Out-Null
    Invoke-Native { docker cp $local "${Container}:$probe/localai.db" } 'Restore test copy' | Out-Null
    $report = Invoke-Native { docker exec $Container node /app/storage-cli.js status --data-dir $probe } 'Restore test'
    Invoke-Native { docker exec $Container rm -rf $probe } 'Restore test cleanup' | Out-Null
    $status = $report | ConvertFrom-Json
    if (-not $status.ok) { throw "Restore test reported a problem: $report" }
    $result.counts = $status.counts
    $result.file = $local
    $result.sizeBytes = (Get-Item $local).Length

    # 3. Off-box copy and retention.
    if ($OffsiteRoot) {
        New-Item -ItemType Directory -Force -Path $OffsiteRoot | Out-Null
        Copy-Item $local (Join-Path $OffsiteRoot $name)
        $result.offsite = Join-Path $OffsiteRoot $name
    }
    foreach ($root in @($BackupRoot, $OffsiteRoot) | Where-Object { $_ }) {
        $files = @(Get-ChildItem $root -File -Filter 'localai-*.db')
        $keep = Select-Keep $files
        $files | Where-Object { $keep.FullName -notcontains $_.FullName } | Remove-Item -Force
    }
    $result.ok = $true
} catch {
    $result.error = "$_"
}
$result | ConvertTo-Json -Depth 4 | Set-Content -Path $statusFile -Encoding UTF8
if ($result.ok) { Write-Host "Backup OK: $($result.file) ($([math]::Round($result.sizeBytes/1MB,1)) MB), verified, offsite: $($result.offsite)" }
else { throw "Backup FAILED: $($result.error)" }
