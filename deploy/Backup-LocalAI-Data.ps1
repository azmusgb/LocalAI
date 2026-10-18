param(
    [string]$Container = 'local-ai-appliance',
    [string]$BackupRoot = 'C:\LocalAI\backups\data',
    # A second copy off this disk. OneDrive syncs it to the cloud; pass '' to skip.
    [string]$OffsiteRoot = "$env:USERPROFILE\OneDrive\LocalAI-Backups",
    [int]$KeepDaily = 7,
    [int]$KeepWeekly = 4,
    # Docker volumes with state that isn't in the database: n8n's workflows and credentials, Caddy's root certificate
    # (every device trusts it), the Responses proxy's data. Pass @() to skip.
    [string[]]$Volumes = @('n8n_data', 'localai-caddy-data', 'local-ai-ollama-responses-proxy-data'),
    [string]$VolumeRoot = 'C:\LocalAI\backups\volumes',
    # A second copy on another LOCAL disk, off by default (this PC has only C:; its G: is Google Drive). Never a
    # cloud-synced folder: these hold the HTTPS root key and n8n's credentials with their key, so one is refused.
    [string]$VolumeCopyRoot = '',
    # The stack's secrets (n8n's encryption key among them): a rebuild needs them. Kept beside the volume archives.
    [string]$StackEnv = 'C:\LocalAI\stack\stack.env'
)
# Nightly backup of the appliance database: a consistent SQLite snapshot (VACUUM INTO, includes WAL writes),
# verified by opening it read-only with the app's own storage code before it is kept, then pruned to
# 7 daily + 4 weekly copies locally and off-box. Then archives the Docker volumes listed in -Volumes (each container
# using one is paused for the seconds the archive takes, so n8n's SQLite files are consistent), checks each archive
# can be read, and keeps the same 7 + 4 locally and on a second drive.
# Writes C:\LocalAI\backups\last-backup.json for monitoring.
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
# True for a folder a cloud client syncs: OneDrive, Dropbox, iCloud, or a drive labelled Google Drive (G:\My Drive).
# Labels maps drive letters to volume labels (Win32_LogicalDisk's), so tests can pass their own.
function Test-CloudPath([string]$Path, [hashtable]$Labels = $null) {
    if ($Path -match '(?i)\\(OneDrive( - [^\\]+)?|Dropbox|iCloudDrive|iCloud Drive|Google Drive|My Drive)(\\|$)') { return $true }
    $letter = ([IO.Path]::GetPathRoot($Path) -replace '[:\\]', '').ToUpper()
    if (-not $letter) { return $false }
    # Win32_LogicalDisk, not Get-Volume: Google Drive's virtual drive only shows up here (label "Google Drive").
    if ($null -eq $Labels) { $Labels = @{}; Get-CimInstance Win32_LogicalDisk -ErrorAction SilentlyContinue | ForEach-Object { $Labels["$($_.DeviceID)".TrimEnd(':')] = $_.VolumeName } }
    return "$($Labels[$letter])" -match '(?i)Google Drive|OneDrive|Dropbox|iCloud'
}
function Select-Keep([System.IO.FileInfo[]]$Files) {
    # Every backup name carries its time as yyyyMMdd-HHmmss (localai-…db, volume-<name>-….tgz).
    $dateOf = { param($f) [datetime]::ParseExact([regex]::Match($f.Name, '(\d{8})-\d{6}').Groups[1].Value, 'yyyyMMdd', $null) }
    $sorted = $Files | Sort-Object { [regex]::Match($_.Name, '\d{8}-\d{6}').Value } -Descending
    $keep = @($sorted | Select-Object -First $KeepDaily)
    # Weekly copies come from the weeks before the daily window, so 7 daily + 4 weekly reaches back about five weeks.
    $dailyWeeks = @{}
    foreach ($f in $keep) { $d = & $dateOf $f; $dailyWeeks['{0}-{1}' -f $d.Year, [Globalization.CultureInfo]::InvariantCulture.Calendar.GetWeekOfYear($d, 'FirstFourDayWeek', 'Monday')] = $true }
    $weeks = @{}
    foreach ($f in ($sorted | Select-Object -Skip $KeepDaily)) {
        $d = & $dateOf $f
        $week = '{0}-{1}' -f $d.Year, [Globalization.CultureInfo]::InvariantCulture.Calendar.GetWeekOfYear($d, 'FirstFourDayWeek', 'Monday')
        if (-not $dailyWeeks.ContainsKey($week) -and -not $weeks.ContainsKey($week) -and $weeks.Count -lt $KeepWeekly) { $weeks[$week] = $f }
    }
    return @($keep + $weeks.Values | Select-Object -Unique)
}

$result = [ordered]@{ at = (Get-Date).ToString('o'); ok = $false; file = $null; sizeBytes = 0; counts = $null; offsite = $null; volumes = @(); stackEnv = $null; error = $null }
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

    # 4. Docker volumes: a tar.gz each, made by a throwaway container that mounts the volume read-only.
    if ($Volumes.Count) {
        New-Item -ItemType Directory -Force -Path $VolumeRoot | Out-Null
        if ($VolumeCopyRoot -and (Test-CloudPath $VolumeCopyRoot)) { throw "Refusing to copy volume archives to $VolumeCopyRoot`: it is a cloud-synced folder, and they hold secrets" }
        $copyRoot = if ($VolumeCopyRoot -and (Test-Path (Split-Path -Qualifier $VolumeCopyRoot))) { $VolumeCopyRoot } else { $null }
        if ($copyRoot) { New-Item -ItemType Directory -Force -Path $copyRoot | Out-Null }
        $image = Invoke-Native { docker inspect --format '{{.Config.Image}}' $Container } 'Find a helper image'
        foreach ($volume in $Volumes) {
            $archive = "volume-$volume-$stamp.tgz"
            $users = @((Invoke-Native { docker ps -q --filter "volume=$volume" } "Find containers using $volume") -split "`n" | Where-Object { $_ })
            if ($users.Count) { Invoke-Native { docker pause @users } "Pause $volume users" | Out-Null }
            try {
                Invoke-Native { docker run --rm --network none -v "${volume}:/v:ro" -v "${VolumeRoot}:/out" $image tar czf "/out/$archive" -C /v . } "Archive $volume" | Out-Null
            } finally {
                if ($users.Count) { Invoke-Native { docker unpause @users } "Unpause $volume users" | Out-Null }
            }
            # Readable and not empty, or it isn't a backup.
            $entries = Invoke-Native { docker run --rm --network none -v "${VolumeRoot}:/out:ro" $image tar tzf "/out/$archive" } "Check $archive"
            if (@($entries -split "`n" | Where-Object { $_ -and $_ -ne './' }).Count -eq 0) { throw "Archive $archive is empty" }
            $file = Join-Path $VolumeRoot $archive
            if ($copyRoot) { Copy-Item $file (Join-Path $copyRoot $archive) }
            $result.volumes += [ordered]@{ volume = $volume; file = $file; sizeBytes = (Get-Item $file).Length; copy = if ($copyRoot) { Join-Path $copyRoot $archive } else { $null } }
            foreach ($root in @($VolumeRoot, $copyRoot) | Where-Object { $_ }) {
                $files = @(Get-ChildItem $root -File -Filter "volume-$volume-*.tgz")
                $keep = Select-Keep $files
                $files | Where-Object { $keep.FullName -notcontains $_.FullName } | Remove-Item -Force
            }
        }
        if ($StackEnv -and (Test-Path $StackEnv)) {
            $envCopy = "stack-env-$stamp.env"
            foreach ($root in @($VolumeRoot, $copyRoot) | Where-Object { $_ }) {
                Copy-Item $StackEnv (Join-Path $root $envCopy)
                $files = @(Get-ChildItem $root -File -Filter 'stack-env-*.env')
                $keep = Select-Keep $files
                $files | Where-Object { $keep.FullName -notcontains $_.FullName } | Remove-Item -Force
            }
            $result.stackEnv = Join-Path $VolumeRoot $envCopy
        }
    }
    $result.ok = $true
} catch {
    $result.error = "$_"
}
$result | ConvertTo-Json -Depth 4 | Set-Content -Path $statusFile -Encoding UTF8
if ($result.ok) {
    Write-Host "Backup OK: $($result.file) ($([math]::Round($result.sizeBytes/1MB,1)) MB), verified, offsite: $($result.offsite)"
    foreach ($v in $result.volumes) { Write-Host "Volume $($v.volume): $($v.file) ($([math]::Round($v.sizeBytes/1MB,1)) MB), copy: $($v.copy)" }
}
else {
    # Tell the Inbox (and, through it, the owner's phone). UTF-8 bytes: Windows PowerShell sends strings as ISO-8859-1.
    try {
        $note = @{ kind = 'backup'; title = 'Nightly backup failed'; detail = "$($result.error)"; meta = @{ outcome = 'failed' } } | ConvertTo-Json -Compress
        Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3080/api/notifications/system' -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($note)) -TimeoutSec 10 | Out-Null
    } catch { }
    throw "Backup FAILED: $($result.error)"
}
