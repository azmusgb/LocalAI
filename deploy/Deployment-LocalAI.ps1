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

# The host's long-running parts (deploy/host-parts.json, #450). A deploy replaces the app's files, but these keep
# running what they started with: the container keeps the environment and mounts it was created with, a scheduled
# task keeps the code it loaded. These functions say which part runs older code; nothing here restarts anything.
function Get-LocalAI-HostParts([string]$Repo) {
    $file = Join-Path $Repo 'deploy/host-parts.json'
    if (-not (Test-Path -LiteralPath $file)) { throw "Host parts list missing: $file" }
    $list = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    $seen = @{}
    foreach ($part in @($list.parts)) {
        if ([string]$part.id -notmatch '^[a-z][a-z0-9-]*$') { throw "Host part has an invalid id: '$($part.id)'" }
        if ($seen.ContainsKey($part.id)) { throw "Host part listed twice: $($part.id)" }
        $seen[$part.id] = $true
        $need = switch ([string]$part.kind) {
            'compose-service' { @('service', 'container', 'compose') }
            'scheduled-task' { @('task', 'paths') }
            'self-reloading' { @('task', 'paths') }
            default { throw "Host part $($part.id) has an unknown kind: '$($part.kind)'" }
        }
        foreach ($field in $need) { if (-not $part.$field) { throw "Host part $($part.id) needs '$field'" } }
    }
    return @($list.parts)
}

# The commit the checkout held at $At, from `git reflog --date=iso-strict --format=%H%x09%gd` lines (newest first),
# or $null when the reflog doesn't reach back that far.
function Select-LocalAI-CommitAt([string[]]$Reflog, [DateTimeOffset]$At) {
    foreach ($line in $Reflog) {
        if ("$line" -notmatch '^([a-f0-9]{40})\t\S*@\{([^}]+)\}$') { continue }
        $when = [DateTimeOffset]::MinValue
        if (-not [DateTimeOffset]::TryParse($Matches[2], [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::None, [ref]$when)) { continue }
        if ($when -le $At) { return $Matches[1] }
    }
    return $null
}

# Whether one part runs $Release. $Observed is what was read on this host for it:
#   installed: $false when the part isn't on this host;
#   scheduled task: running ($false when stopped), startedFrom (the commit it started from, $null when unknown) and
#   changed (its paths that differ between that commit and the release; $null when git couldn't say);
#   compose service: wantHash (compose's hash for the release's compose.yml and stack.env) and runningHash (the
#   container's com.docker.compose.config-hash label), $null when unread.
# State is current, stale, unknown (never shown as current), stopped, not-installed or self-reloading.
function Test-LocalAI-HostPartStale([object]$Part, [string]$Release, [hashtable]$Observed) {
    $short = { param($sha) if ($sha) { ([string]$sha).Substring(0, [Math]::Min(7, ([string]$sha).Length)) } }
    $result = { param($state, $reason) [pscustomobject][ordered]@{ id = [string]$Part.id; kind = [string]$Part.kind; state = $state; reason = $reason } }
    if ($Observed.installed -eq $false) { return & $result 'not-installed' 'Not on this host' }
    switch ([string]$Part.kind) {
        'self-reloading' { return & $result 'self-reloading' 'Restarts itself when its code changes' }
        'scheduled-task' {
            if ($Observed.running -eq $false) { return & $result 'stopped' "The task $($Part.task) isn't running" }
            $from = [string]$Observed.startedFrom
            if (-not $from) { return & $result 'unknown' "No record of the release it started from; a restart runs $(& $short $Release)" }
            if ($from -eq $Release) { return & $result 'current' "Runs $(& $short $Release)" }
            if ($null -eq $Observed.changed) { return & $result 'unknown' "Runs $(& $short $from); couldn't compare it with $(& $short $Release)" }
            $changed = @($Observed.changed | Where-Object { $_ })
            if ($changed.Count) { return & $result 'stale' "Runs $(& $short $from), the release is $(& $short $Release); changed: $($changed -join ', ')" }
            return & $result 'current' "Runs $(& $short $from); nothing it runs changed in $(& $short $Release)"
        }
        'compose-service' {
            if (-not $Observed.wantHash -or -not $Observed.runningHash) { return & $result 'unknown' "Couldn't read $($Part.container)'s configuration" }
            if ($Observed.wantHash -eq $Observed.runningHash) { return & $result 'current' 'Runs the configuration in compose.yml and stack.env' }
            return & $result 'stale' "$($Part.container) was created from an older compose.yml or stack.env; recreating it picks them up"
        }
    }
}

# Reads what Test-LocalAI-HostPartStale needs for one part, from git, docker and the Task Scheduler. Read only.
function Get-LocalAI-HostPartObservation([object]$Part, [string]$Repo, [string]$Release, [string]$StackEnvFile) {
    $observed = @{}
    $preference = $ErrorActionPreference
    $encoding = [Console]::OutputEncoding
    try {
        # git and docker write to stderr; under Stop that would end the status read.
        $ErrorActionPreference = 'Continue'
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        if ($Part.kind -eq 'compose-service') {
            # The labels as JSON: Windows PowerShell 5.1 strips the inner quotes of an `index ... "label"` format.
            $labels = @(docker inspect $Part.container --format '{{json .Config.Labels}}' 2>&1 | ForEach-Object { "$_" })
            if ($LASTEXITCODE -ne 0) {
                if (($labels -join ' ') -match 'No such') { $observed.installed = $false }
                return $observed
            }
            $hashLabel = (($labels -join '') | ConvertFrom-Json).'com.docker.compose.config-hash'
            if ($hashLabel) { $observed.runningHash = [string]$hashLabel }
            $hash = @(docker compose --env-file $StackEnvFile -f (Join-Path $Repo $Part.compose) config --hash $Part.service 2>$null | ForEach-Object { "$_" })
            if ($LASTEXITCODE -eq 0 -and ($hash -join ' ') -match "(?:^|\s)$([regex]::Escape($Part.service))\s+([a-f0-9]{64})") { $observed.wantHash = $Matches[1] }
            return $observed
        }
        $task = if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) { Get-ScheduledTask -TaskName $Part.task -ErrorAction SilentlyContinue } else { $null }
        if (-not $task) { $observed.installed = $false; return $observed }
        if ($Part.kind -ne 'scheduled-task') { return $observed }
        $observed.running = [string]$task.State -eq 'Running'
        if ($Part.home) {
            $partHome = Get-LocalAI-HostPartHome $Part $Repo
            if (Test-LocalAI-HostTaskInHome $task $partHome) {
                # Its own copy: the deploy restarts it whenever that copy changes, so the copy's release is what it runs.
                $observed.startedFrom = Read-LocalAI-HostPartCommit $partHome
                if ($observed.startedFrom -and $observed.startedFrom -ne $Release) { $observed.changed = Get-LocalAI-ChangedPaths $Repo $observed.startedFrom $Release @($Part.paths) }
                return $observed
            }
        }
        $info = Get-ScheduledTaskInfo -TaskName $Part.task -ErrorAction SilentlyContinue
        if (-not $info -or -not $info.LastRunTime) { return $observed }
        $reflog = @(git -C $Repo reflog show --date=iso-strict '--format=%H%x09%gd' HEAD 2>$null | ForEach-Object { "$_" })
        $observed.startedFrom = Select-LocalAI-CommitAt $reflog ([DateTimeOffset]$info.LastRunTime)
        if ($observed.startedFrom -and $observed.startedFrom -ne $Release) { $observed.changed = Get-LocalAI-ChangedPaths $Repo $observed.startedFrom $Release @($Part.paths) }
        return $observed
    } catch {
        return $observed
    } finally {
        $ErrorActionPreference = $preference
        [Console]::OutputEncoding = $encoding
        $global:LASTEXITCODE = 0
    }
}

# The paths that differ between two commits, limited to $Paths; $null when git can't say (an unknown commit).
function Get-LocalAI-ChangedPaths([string]$Repo, [string]$From, [string]$To, [string[]]$Paths) {
    $preference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $diff = @(git -C $Repo diff --name-only $From $To -- @($Paths) 2>$null | ForEach-Object { "$_" } | Where-Object { $_ })
        if ($LASTEXITCODE -ne 0) { return $null }
        return , $diff
    } catch { return $null }
    finally { $ErrorActionPreference = $preference; $global:LASTEXITCODE = 0 }
}

# A scheduled-task part with a `home` runs from its own copy of the release beside the checkout (Atlas: C:\LocalAI\atlas),
# so its code changes only when a deploy promotes or rolls back, never when Safe Deploy moves the checkout (#450).
# deploy/Install-LocalAI-HostTask.ps1 moves a task there once.
function Get-LocalAI-HostPartHome([object]$Part, [string]$Repo) {
    return Join-Path (Split-Path -Parent ([System.IO.Path]::GetFullPath($Repo))) $Part.home
}
function Test-LocalAI-HostTaskInHome([object]$Task, [string]$PartHome) {
    $dir = [string](@($Task.Actions)[0].WorkingDirectory)
    if (-not $dir) { return $false }
    return [System.IO.Path]::GetFullPath($dir).TrimEnd('\', '/') -eq [System.IO.Path]::GetFullPath($PartHome).TrimEnd('\', '/')
}
function Read-LocalAI-HostPartCommit([string]$PartHome) {
    $file = Join-Path $PartHome 'release.json'
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    try { $commit = [string](Get-Content -LiteralPath $file -Raw | ConvertFrom-Json).commit } catch { return $null }
    if ($commit -match '^[a-f0-9]{40}$') { return $commit }
    return $null
}

# Fills $To with a part's files from $From (a release folder or the checkout), its release.json and repo-root.txt
# (the checkout Atlas maps and keeps .atlas/ in).
function Copy-LocalAI-HostPartFiles([object]$Part, [string]$From, [string]$To, [string]$Commit, [string]$Repo) {
    if (Test-Path -LiteralPath $To) { Remove-Item -LiteralPath $To -Recurse -Force }
    [System.IO.Directory]::CreateDirectory($To) | Out-Null
    foreach ($path in @($Part.paths)) {
        $source = Join-Path $From $path
        if (-not (Test-Path -LiteralPath $source)) { throw "$($Part.id): $path is missing from $From" }
        $target = Join-Path $To $path
        [System.IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
        Copy-Item -LiteralPath $source -Destination $target -Force
    }
    Write-LocalAI-DeployState -Path (Join-Path $To 'release.json') -State ([ordered]@{ commit = $Commit; part = $Part.id })
    [System.IO.File]::WriteAllText((Join-Path $To 'repo-root.txt'), [System.IO.Path]::GetFullPath($Repo))
}

# Stops a task's process by ending only what listens on its health port (the task's wrapper then ends with it), and
# starts it again through the Task Scheduler. Never anything else on the host.
function Stop-LocalAI-HostTask([object]$Part) {
    $port = ([Uri]$Part.health).Port
    foreach ($listener in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    for ($i = 0; $i -lt 20; $i++) {
        $task = Get-ScheduledTask -TaskName $Part.task -ErrorAction SilentlyContinue
        if (-not $task -or [string]$task.State -ne 'Running') { return }
        Start-Sleep -Seconds 1
    }
    throw "$($Part.task) is still running after its process was stopped"
}
function Start-LocalAI-HostTask([object]$Part) { Start-ScheduledTask -TaskName $Part.task }
function Wait-LocalAI-HostPartHealth([object]$Part, [int]$Attempts = 30, [int]$DelaySeconds = 2) {
    for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
        try { if ((Invoke-RestMethod -Uri $Part.health -TimeoutSec 5).ok -eq $true) { return $true } } catch { }
        if ($attempt + 1 -lt $Attempts) { Start-Sleep -Seconds $DelaySeconds }
    }
    return $false
}

# Brings each scheduled-task part that runs from its home to $Commit, from the release folder $Source. When a file it
# runs changed (or its home has no release yet, or it isn't running) it is stopped, its home swapped for the release's
# copy, started and checked for up to a minute. A part that doesn't come back gets its previous copy back and is started
# again, and this throws so the deploy rolls the app back too. A part still running from the checkout is left alone
# with a warning. Returns one line per part, for the log.
function Update-LocalAI-HostTasks([string]$Repo, [string]$Source, [string]$Commit) {
    if (-not (Test-Path -LiteralPath (Join-Path $Source 'deploy/host-parts.json'))) { return @() }
    $lines = @()
    foreach ($part in (Get-LocalAI-HostParts $Source)) {
        if ($part.kind -ne 'scheduled-task' -or -not $part.home) { continue }
        $task = Get-ScheduledTask -TaskName $part.task -ErrorAction SilentlyContinue
        if (-not $task) { $lines += "$($part.id): not on this host"; continue }
        $partHome = Get-LocalAI-HostPartHome $part $Repo
        if (-not (Test-LocalAI-HostTaskInHome $task $partHome)) {
            Write-Warning "$($part.id) still runs from the checkout, so a deploy can't refresh or roll it back; move it with deploy/Install-LocalAI-HostTask.ps1 -Part $($part.id)"
            $lines += "$($part.id): runs from the checkout; not refreshed"
            continue
        }
        $from = Read-LocalAI-HostPartCommit $partHome
        if ($from -eq $Commit) { $lines += "$($part.id): runs $($Commit.Substring(0, 7))"; continue }
        # A plain assignment: an `if` expression would turn an empty list (nothing changed) into $null (unknown).
        $changed = $null
        if ($from) { $changed = Get-LocalAI-ChangedPaths $Repo $from $Commit @($part.paths) }
        $running = [string]$task.State -eq 'Running'
        if ($running -and $null -ne $changed -and $changed.Count -eq 0) {
            # Same files: record the release without a restart.
            Write-LocalAI-DeployState -Path (Join-Path $partHome 'release.json') -State ([ordered]@{ commit = $Commit; part = $part.id })
            $lines += "$($part.id): nothing it runs changed; now $($Commit.Substring(0, 7))"
            continue
        }
        $next = "$partHome.next"
        $previous = "$partHome.previous"
        Copy-LocalAI-HostPartFiles $part $Source $next $Commit $Repo
        Stop-LocalAI-HostTask $part
        if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }
        if (Test-Path -LiteralPath $partHome) { Move-Item -LiteralPath $partHome -Destination $previous }
        Move-Item -LiteralPath $next -Destination $partHome
        Start-LocalAI-HostTask $part
        if (Wait-LocalAI-HostPartHealth $part) {
            $lines += "$($part.id): restarted on $($Commit.Substring(0, 7))" + $(if ($from) { " (was $($from.Substring(0, 7)))" } else { '' })
            continue
        }
        $cause = "$($part.id) didn't come back on $($Commit.Substring(0, 7))"
        Stop-LocalAI-HostTask $part
        Remove-Item -LiteralPath $partHome -Recurse -Force
        if (-not (Test-Path -LiteralPath $previous)) { throw "$cause, and it had no previous copy to go back to" }
        Move-Item -LiteralPath $previous -Destination $partHome
        Start-LocalAI-HostTask $part
        if (Wait-LocalAI-HostPartHealth $part) { throw "$cause; it runs $(if ($from) { $from.Substring(0, 7) } else { 'its previous copy' }) again" }
        throw "$cause, and its previous copy didn't come back either"
    }
    return $lines
}
