param(
    # How many of each kind to keep, newest first, besides the ones state.json and release.json point at.
    [ValidateRange(1, 100)]
    [int]$KeepCount = 10,
    [string]$Releases = 'C:\LocalAI\releases',
    [string]$StateDir = 'C:\LocalAI\.deploy',
    [string]$Live = 'C:\LocalAI\appliance\app',
    [string]$Container = 'local-ai-appliance'
)
# Every deploy leaves three copies behind (Deploy-LocalAI.ps1): the extracted candidate in releases\<sha>, the
# previous live app in .deploy\live-before-<guid>, and /data/backups/before-deploy-<guid>.db in the appliance's volume.
# Nothing removed them, so a busy day of releases left ~10 of each and thousands of files. Run-LocalAI-AutoDeploy.ps1
# calls this after a healthy deploy. It keeps the newest $KeepCount of each kind, and always keeps the current,
# previous and rollback releases, the rollback snapshot and the data backup named in state.json, plus the commit in the
# live release.json. It does nothing while a deploy holds the lock or state.json is not HEALTHY.
# Returns @{ Removed = @{ Releases; Snapshots; DataBackups } (counts); Log = lines }. Idempotent; never throws: a
# failure is a log line.
$ErrorActionPreference = 'Continue'
$removed = [ordered]@{ Releases = 0; Snapshots = 0; DataBackups = 0 }
$log = [System.Collections.Generic.List[string]]::new()
$result = { [pscustomobject]@{ Removed = [pscustomobject]$removed; Log = @($log) } }

try {
    if (Test-Path -LiteralPath (Join-Path $StateDir 'deploy.lock')) { $log.Add('History prune skipped: a deploy holds the lock.'); return (& $result) }
    $statePath = Join-Path $StateDir 'state.json'
    $state = try { Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json } catch { $null }
    if (-not $state -or $state.status -ne 'HEALTHY') { $log.Add("History prune skipped: deploy state is '$($state.status)', not HEALTHY."); return (& $result) }
    $liveCommit = try { [string](Get-Content -LiteralPath (Join-Path $Live 'release.json') -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json).commit } catch { '' }

    # Keeps the newest $KeepCount names plus the protected ones; removes the rest and counts what really went.
    function Remove-Older([object[]]$Dirs, [string[]]$Protected, [string]$Kind) {
        $keep = @(@($Dirs | Sort-Object LastWriteTime -Descending | Select-Object -First $KeepCount | ForEach-Object { $_.Name.ToLowerInvariant() }) + $Protected)
        $count = 0
        foreach ($dir in $Dirs) {
            if ($keep -contains $dir.Name.ToLowerInvariant()) { continue }
            Remove-Item -LiteralPath $dir.FullName -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $dir.FullName) { $log.Add("Kept $Kind $($dir.Name): it could not be removed.") } else { $count++ }
        }
        return $count
    }

    $commits = @($state.currentCommit, $state.previousCommit, $state.rollbackSnapshotCommit, $liveCommit | Where-Object { "$_".Trim() } | ForEach-Object { "$_".Trim().ToLowerInvariant() })
    if (Test-Path -LiteralPath $Releases) {
        $dirs = @(Get-ChildItem -LiteralPath $Releases -Directory -Force | Where-Object { $_.Name -match '^[a-f0-9]{40}$' })
        $removed.Releases = Remove-Older $dirs $commits 'release'
    }
    $snapshot = if ($state.rollbackSnapshot) { @((Split-Path -Leaf "$($state.rollbackSnapshot)").ToLowerInvariant()) } else { @() }
    $dirs = @(Get-ChildItem -LiteralPath $StateDir -Directory -Force -Filter 'live-before-*')
    $removed.Snapshots = Remove-Older $dirs $snapshot 'snapshot'

    # ls -t lists newest first. Names are checked against a strict pattern before they reach rm.
    $listed = @(& docker exec $Container sh -c 'ls -1t /data/backups/ 2>/dev/null' 2>$null)
    if ($LASTEXITCODE -ne 0) {
        $log.Add("Data backup prune skipped: docker exec $Container failed.")
    } else {
        $names = @($listed | ForEach-Object { "$_".Trim() } | Where-Object { $_ -match '^before-deploy-[A-Za-z0-9_.-]+\.db$' })
        $keep = @(@($names | Select-Object -First $KeepCount) + @("$($state.dataBackupName)".Trim() | Where-Object { $_ }))
        $old = @($names | Where-Object { $keep -notcontains $_ })
        for ($i = 0; $i -lt $old.Count; $i += 50) {
            $batch = @($old[$i..([Math]::Min($i + 49, $old.Count - 1))])
            & docker exec $Container sh -c ('cd /data/backups && rm -f -- ' + ($batch -join ' ')) 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { $removed.DataBackups += $batch.Count } else { $log.Add("Kept $($batch.Count) data backups: docker rm failed.") }
        }
    }
    if ($removed.Releases + $removed.Snapshots + $removed.DataBackups) {
        $log.Add("Removed $($removed.Releases) old releases, $($removed.Snapshots) app snapshots and $($removed.DataBackups) pre-deploy data backups (kept the newest $KeepCount of each and the rollback targets).")
    }
} catch {
    $log.Add("History prune failed: $($_.Exception.Message)")
}
return (& $result)
