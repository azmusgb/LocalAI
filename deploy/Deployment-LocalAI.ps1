# Shared deployment contracts. Dot sourcing defines functions and performs no promotion.
function Read-LocalAI-DeployState([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{} }
    try {
        $raw = Get-Content -LiteralPath $Path -Raw
        if (-not $raw.TrimStart().StartsWith('{')) { throw 'Expected a JSON object' }
        $state = $raw | ConvertFrom-Json
        if ($null -eq $state -or $state -isnot [pscustomobject]) { throw 'Expected a JSON object' }
        return $state
    }
    catch { throw "Cannot read deployment state at ${Path}: $($_.Exception.Message)" }
}

function Write-LocalAI-DeployState([string]$Path, [object]$State) {
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    $replaced = $temporary + '.previous'
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes(($State | ConvertTo-Json -Depth 10))
        $stream = [System.IO.File]::Open($temporary, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
        finally { $stream.Dispose() }
        if (Test-Path -LiteralPath $Path) { [System.IO.File]::Replace($temporary, $Path, $replaced) }
        else { [System.IO.File]::Move($temporary, $Path) }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        if (Test-Path -LiteralPath $replaced) { Remove-Item -LiteralPath $replaced -Force }
    }
}

# A lock whose writer is gone (killed by a reboot, the task time limit or a hung command, so its
# finally block never ran) would otherwise block every later deploy.
function Test-LocalAI-DeployLockStale([string]$LockPath) {
    try { $content = [System.IO.File]::ReadAllText($LockPath).Trim() } catch { return $false }
    $parts = $content -split ' ', 2
    $ownerPid = 0
    if ($parts.Count -lt 2 -or -not [int]::TryParse($parts[0], [ref]$ownerPid)) { return $true }
    $taken = [DateTime]::MinValue
    if (-not [DateTime]::TryParse($parts[1], [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind, [ref]$taken)) { return $true }
    $owner = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    if (-not $owner) { return $true }
    # The PID was reused by a process started after the lock was taken.
    try { return $owner.StartTime.ToUniversalTime() -gt $taken.ToUniversalTime().AddSeconds(1) } catch { return $false }
}

function Enter-LocalAI-DeployLock([string]$StateDir) {
    [System.IO.Directory]::CreateDirectory($StateDir) | Out-Null
    $lockPath = Join-Path $StateDir 'deploy.lock'
    if ((Test-Path -LiteralPath $lockPath) -and (Test-LocalAI-DeployLockStale $lockPath)) {
        Write-Warning "Removing stale deploy lock: $([System.IO.File]::ReadAllText($lockPath).Trim())"
        Remove-Item -LiteralPath $lockPath -Force
    }
    $stream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes("$PID $(Get-Date -Format o)")
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
    return $lockPath
}

# What release.json records about a release: its commit, a version (major.minor from package.json at that commit,
# then the number of commits on main, e.g. 2.0.431), when it went live, and the merged PR titles since the previous
# live release. Only the commit is required; if git can't answer, the rest is left out rather than failing a deploy.
function New-LocalAI-ReleaseInfo([string]$Repo, [string]$Sha, [string]$Previous) {
    $info = [ordered]@{ commit = $Sha; deployedAt = (Get-Date).ToUniversalTime().ToString('o') }
    $encoding = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        $package = (git -C $Repo show "${Sha}:package.json" 2>$null) -join "`n"
        $count = [string](git -C $Repo rev-list --count $Sha 2>$null)
        if ($package -and $count -match '^\d+$') {
            $parts = ([string]($package | ConvertFrom-Json).version).Split('.')
            if ($parts.Count -ge 2 -and $parts[0] -match '^\d+$' -and $parts[1] -match '^\d+$') { $info.version = "$($parts[0]).$($parts[1]).$($count.Trim())" }
        }
        $range = $Sha
        if ($Previous -and $Previous -ne $Sha) {
            git -C $Repo merge-base --is-ancestor $Previous $Sha 2>$null
            if ($LASTEXITCODE -eq 0) { $range = "$Previous..$Sha" }
        }
        # One record per commit on main: subject, unit separator, body, record separator.
        $log = (git -C $Repo log --first-parent "--format=%s%x1f%b%x1e" -n $(if ($range -eq $Sha) { 1 } else { 50 }) $range 2>$null) -join "`n"
        $notes = foreach ($record in ($log -split [char]0x1e)) {
            $subject, $body = $record.Trim("`n", "`r", ' ') -split [char]0x1f, 2
            if (-not $subject) { continue }
            if ($subject -match '^Merge pull request #(\d+) from ') {
                # A merge commit's subject names the branch; the PR title is the first line of its body.
                $title = (([string]$body) -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
                [ordered]@{ title = $(if ($title) { $title.Trim() } else { $subject }); pr = [int]$Matches[1] }
            }
            elseif ($subject -match '^(.*?)\s*\(#(\d+)\)\s*$') { [ordered]@{ title = $Matches[1]; pr = [int]$Matches[2] } }  # squash merge
            else { [ordered]@{ title = [string]$subject } }
        }
        if ($notes) { $info.notes = @($notes) }
    } catch {
        # A release without notes is still a release.
    } finally {
        [Console]::OutputEncoding = $encoding
        $global:LASTEXITCODE = 0
    }
    return $info
}

function Read-LocalAI-ReleaseCommit([string]$AppRoot) {
    $file = Join-Path $AppRoot 'release.json'
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    $release = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    if ([string]$release.commit -notmatch '^[a-f0-9]{40}$') { throw "Invalid release identity in $file" }
    return [string]$release.commit
}

function Get-LocalAI-RollbackCommit([string]$Snapshot, [object]$State) {
    $commit = Read-LocalAI-ReleaseCommit $Snapshot
    if ($commit) { return $commit }
    if ($State.rollbackSnapshot -and [System.IO.Path]::GetFullPath($State.rollbackSnapshot) -eq [System.IO.Path]::GetFullPath($Snapshot)) {
        if ($State.PSObject.Properties.Name -contains 'rollbackSnapshotCommit') { return $State.rollbackSnapshotCommit }
        return $State.previousCommit
    }
    return $null # A custom legacy snapshot has no proven SHA.
}

function Test-LocalAI-HealthPayload {
    param([object]$Health, [string]$ExpectedCommit, [switch]$RequireSqlite)
    if ($null -eq $Health -or $Health.status -ne 'ok') { return $false }
    if ($RequireSqlite -and ($Health.storage.engine -ne 'sqlite' -or [int]$Health.storage.schemaVersion -lt 1)) { return $false }
    if ($ExpectedCommit -and $Health.releaseCommit -ne $ExpectedCommit) { return $false }
    return $true
}

function Wait-LocalAI-Health {
    param([string]$HealthUrl, [string]$ExpectedCommit, [switch]$RequireSqlite, [int]$Attempts = 12, [int]$DelaySeconds = 2)
    for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
        try {
            $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5
            if (Test-LocalAI-HealthPayload -Health $health -ExpectedCommit $ExpectedCommit -RequireSqlite:$RequireSqlite) { return $true }
        } catch { }
        if ($attempt + 1 -lt $Attempts -and $DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }
    }
    return $false
}

# docs/ and host/ go into the candidate's app/repo-context, so they ship, back up and roll back with the app tree.
function Copy-LocalAI-RepoContext([string]$Candidate) {
    $context = Join-Path $Candidate 'app/repo-context'
    if (Test-Path -LiteralPath $context) { Remove-Item -LiteralPath $context -Recurse -Force }
    foreach ($part in @('docs','host')) {
        $source = Join-Path $Candidate $part
        if (-not (Test-Path -LiteralPath $source)) { continue }
        [System.IO.Directory]::CreateDirectory($context) | Out-Null
        Copy-Item -LiteralPath $source -Destination (Join-Path $context $part) -Recurse -Force
    }
}
# The PowerShell host runs its own copy of its script (installed by Enable-LocalAI-PowerShellHost.ps1), so a release
# brings that copy up to date. Only where the host is installed; a failure warns and never fails the deploy.
function Update-LocalAI-PowerShellHost([string]$Candidate, [string]$HostRoot) {
    $installed = Join-Path $HostRoot 'Run-LocalAI-PowerShellHost.ps1'
    $source = Join-Path $Candidate 'host/powershell-bridge/Run-LocalAI-PowerShellHost.ps1'
    if (-not (Test-Path -LiteralPath $installed) -or -not (Test-Path -LiteralPath $source)) { return }
    try {
        if ((Get-FileHash -LiteralPath $installed).Hash -eq (Get-FileHash -LiteralPath $source).Hash) { return }
        # Copy beside it, then swap, so the host's next run never reads a half-written script.
        $next = "$installed.next"
        Copy-Item -LiteralPath $source -Destination $next -Force
        Move-Item -LiteralPath $next -Destination $installed -Force
        Write-Host 'PowerShell host script updated to this release.'
    } catch { Write-Warning "PowerShell host script not updated: $($_.Exception.Message)" }
}
function Copy-LocalAI-AppTree([string]$From, [string]$To, [switch]$Replace) {
    if (-not (Test-Path -LiteralPath (Join-Path $From 'server.js'))) { throw "Application source missing: $From" }
    if (Test-Path -LiteralPath $To) {
        if (-not $Replace) { throw "Snapshot already exists: $To" }
        Remove-Item -LiteralPath $To -Recurse -Force
    }
    [System.IO.Directory]::CreateDirectory($To) | Out-Null
    robocopy $From $To /MIR /XD node_modules .git data reports logs backups /XF .env '*.log' '*.tmp' '*.bak' | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "Application copy failed: robocopy exit $LASTEXITCODE" }
}
