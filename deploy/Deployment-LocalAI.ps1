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
