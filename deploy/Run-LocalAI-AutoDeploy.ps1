param(
    # The branch the host deploys. Only `npm run ship` moves it, to a merge commit whose exact tree passed local CI
    # (scripts/local-ci.mjs), so a commit pushed straight to main never deploys.
    [string]$TargetRef = 'origin/release',
    [string]$Repo = 'C:\LocalAI\repo',
    [string]$StateDir = 'C:\LocalAI\.deploy',
    [string]$Live = 'C:\LocalAI\appliance\app',
    [string]$NotifyUrl = 'http://127.0.0.1:3080/api/notifications/system',
    # Asked before an update restarts the appliance: while something is running the update waits, up to MaxHoldMinutes.
    [string]$BusyUrl = 'http://127.0.0.1:3080/api/busy',
    # Checked before tidying old backup containers when there was nothing to deploy (and after a deploy).
    [string]$HealthUrl = 'http://127.0.0.1:3080/healthz',
    [ValidateRange(0, 1440)]
    [int]$MaxHoldMinutes = 45,
    # The compose stack whose stopped services each run starts again (Repair-LocalAI-Stack.ps1); skipped without them.
    [string]$StackEnvFile = 'C:\LocalAI\stack\stack.env',
    [string]$StackCompose = (Join-Path $Repo 'deploy\stack\compose.yml')
)
# What the 'LocalAI Safe Deploy' task runs every few minutes. Keeps the host checkout on the release branch, runs the safe
# deploy (certify, promote, health-check, roll back), logs it, and tells the Inbox when something happened:
# a new release went live, or a deploy failed (once per failing commit, not on every retry). No change = silent.
# After a healthy deploy, or a quiet run with /healthz OK, it removes stopped migration backups (local-ai-*-pre-*)
# older than 7 days whose live twin is healthy (Remove-LocalAI-OldBackups.ps1); that step never fails the run.
# Every run first starts compose services a Windows restart left stopped (Repair-LocalAI-Stack.ps1); that step
# never fails the run either.
# A new release waits while the appliance is running something a restart would stop (a mission, an image, a chat,
# a GridCraft request, an automation), for up to MaxHoldMinutes; then it goes ahead and says what it stopped.
$ErrorActionPreference = 'Continue'
# git prints UTF-8; without this Windows PowerShell decodes it with the console code page (IBM437), so a commit
# subject with an em dash reached the Inbox as mojibake.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$log = Join-Path $StateDir 'auto-deploy.log'
$failState = Join-Path $StateDir 'auto-deploy-last-failure.txt'
# When the update now waiting was first held back (ISO 8601), so the wait has a limit across runs.
$holdState = Join-Path $StateDir 'auto-deploy-held-since.txt'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
function Notify([string]$title, [string]$detail, [hashtable]$meta) {
    # Send UTF-8 bytes: Windows PowerShell sends a string body as ISO-8859-1, turning an em dash into '-' and arrows into '?'.
    $body = [System.Text.Encoding]::UTF8.GetBytes((@{ kind = 'deploy'; title = $title; detail = $detail; meta = $meta } | ConvertTo-Json -Compress))
    try { Invoke-RestMethod -Method Post -Uri $NotifyUrl -ContentType 'application/json; charset=utf-8' -TimeoutSec 10 -Body $body | Out-Null } catch { }
}

# Keep the log bounded: up to 500 one-line summaries, then the last deploy's full output. $runOutput $null keeps
# the previous output (a run that only waited has none worth keeping over it).
function Write-AutoDeployLog([string[]]$summary, $runOutput) {
    $lines = @(if (Test-Path $log) { Get-Content $log -Encoding UTF8 })
    $marker = [Array]::IndexOf($lines, '--- last run ---')
    $history = @($(if ($marker -gt 0) { $lines[0..($marker - 1)] } elseif ($marker -lt 0) { $lines }) | Where-Object { $_ -match '^\d{4}-\d\d-\d\dT' } | Select-Object -Last 500)
    if ($null -eq $runOutput) { $runOutput = @(if ($marker -ge 0 -and $marker -lt $lines.Count - 1) { $lines[($marker + 1)..($lines.Count - 1)] }) }
    Set-Content -Path $log -Value (@($history) + @($summary) + '--- last run ---' + @($runOutput)) -Encoding UTF8
}
# The commit the appliance runs: its release.json, else the deploy state.
function Get-RunningCommit {
    foreach ($source in @(@{ Path = (Join-Path $Live 'release.json'); Field = 'commit' }, @{ Path = (Join-Path $StateDir 'state.json'); Field = 'currentCommit' })) {
        try { $value = [string](Get-Content $source.Path -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json).($source.Field) } catch { $value = '' }
        if ($value) { return $value.Trim() }
    }
    return ''
}
# What a restart would stop, from GET /api/busy; $null when the appliance doesn't answer it (down, or a build without
# it): then the update goes ahead as before, so a broken appliance can still be fixed by deploying.
function Get-ApplianceBusy {
    try { $answer = Invoke-RestMethod -Method Get -Uri $BusyUrl -TimeoutSec 10 -ErrorAction Stop } catch { return $null }
    if ($null -eq $answer -or -not ($answer.busy -is [bool])) { return $null }
    return $answer
}
function Get-BusyTitles($busy, [int]$first = 3) {
    $titles = @($busy.active | ForEach-Object { [string]$_.title } | Where-Object { $_ })
    $text = ($titles | Select-Object -First $first) -join '; '
    if ($titles.Count -gt $first) { $text += "; and $($titles.Count - $first) more" }
    return $text
}
function Get-HeldSince {
    if (-not (Test-Path $holdState)) { return $null }
    try { return [DateTime]::Parse((Get-Content $holdState -Raw).Trim(), [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() } catch { return $null }
}
function Test-ApplianceHealthy {
    try { return (Invoke-RestMethod -Method Get -Uri $HealthUrl -TimeoutSec 10 -ErrorAction Stop).status -eq 'ok' } catch { return $false }
}
# Removes old stopped backup containers once the stack is healthy. Logs each removal, sends one Inbox line, and
# never fails the deploy.
function Invoke-BackupTidy {
    try {
        $tidy = & (Join-Path $PSScriptRoot 'Remove-LocalAI-OldBackups.ps1')
        $lines = @($tidy.Log | Where-Object { $_ } | ForEach-Object { (Get-Date).ToString('s') + ' tidy: ' + $_ })
        if ($lines.Count) { Write-AutoDeployLog $lines $null }
        $count = @($tidy.Removed).Count
        if ($count -gt 0) {
            $title = if ($count -eq 1) { 'Removed 1 old backup container (a stopped copy from an earlier migration)' } else { "Removed $count old backup containers (stopped copies from earlier migrations)" }
            Notify $title ('Removed: ' + (@($tidy.Removed) -join ', ') + '. Their volumes and data were kept.') @{ outcome = 'done'; action = 'tidy-backups'; removed = (@($tidy.Removed) -join ', ') }
        }
    } catch {
        try { Write-AutoDeployLog ((Get-Date).ToString('s') + ' tidy: failed: ' + $_.Exception.Message) $null } catch { }
    }
}
# Starts compose services that should be running but are stopped (a Windows restart leaves them Exited: Docker
# Desktop counts that as a user stop, so `restart: unless-stopped` doesn't bring them back). Logs each start, sends
# one Inbox line, and never fails the deploy. Silent when everything is running.
function Invoke-StackRepair {
    try {
        $repair = & (Join-Path $PSScriptRoot 'Repair-LocalAI-Stack.ps1') -EnvFile $StackEnvFile -Compose $StackCompose -HealthUrl $HealthUrl
        $lines = @($repair.Log | Where-Object { $_ } | ForEach-Object { (Get-Date).ToString('s') + ' repair: ' + $_ })
        if ($lines.Count) { Write-AutoDeployLog $lines $null }
        $count = @($repair.Started).Count
        if ($count -gt 0) {
            $title = if ($count -eq 1) { 'Restarted 1 Local AI service that was stopped (probably by a Windows restart)' } else { "Restarted $count Local AI services that were stopped (probably by a Windows restart)" }
            $health = if ($repair.Healthy) { 'The appliance answers /healthz.' } else { 'The appliance did not answer /healthz within a minute; see Health.' }
            Notify $title ('Started: ' + (@($repair.Started) -join ', ') + '. ' + $health) @{ outcome = 'done'; action = 'repair-stack'; started = (@($repair.Started) -join ', ') }
        }
    } catch {
        try { Write-AutoDeployLog ((Get-Date).ToString('s') + ' repair: failed: ' + $_.Exception.Message) $null } catch { }
    }
}

# The scheduled task was registered when it deployed main and still passes -TargetRef origin/main; main is now
# deployed only through release.
if ($TargetRef -eq 'origin/main') { $TargetRef = 'origin/release' }
$unreleasedState = Join-Path $StateDir 'auto-deploy-unreleased.txt'

# The deploy scripts themselves come from this checkout, so move it to the deployed branch when it is clean: the
# scripts that run are the checked release's, never an unchecked main's. Otherwise only fetch.
git -C $Repo fetch -q --prune origin 2>&1 | Out-Null
if ($TargetRef -match '^origin/(.+)$' -and -not (git -C $Repo status --porcelain 2>$null)) {
    git -C $Repo checkout -q -B $Matches[1] $TargetRef 2>&1 | Out-Null
}

# Commits on main that haven't been through ship don't deploy; say so once per main commit, so they aren't
# forgotten (a direct push, or a PR merged on GitHub).
if ($TargetRef -eq 'origin/release') {
    $mainSha = ([string](git -C $Repo rev-parse --verify 'origin/main^{commit}' 2>$null)).Trim()
    $ahead = 0; [void][int]::TryParse(([string](git -C $Repo rev-list --count 'origin/release..origin/main' 2>$null)).Trim(), [ref]$ahead)
    $told = if (Test-Path $unreleasedState) { (Get-Content $unreleasedState -Raw).Trim() } else { '' }
    if ($ahead -gt 0 -and $mainSha -and $mainSha -ne $told) {
        $commits = if ($ahead -eq 1) { '1 commit' } else { "$ahead commits" }
        Notify "$commits on main not deployed yet" "They haven't passed local CI through npm run ship, so the host keeps running the current release. Ship a pull request that includes them: npm run ship -- <PR>." @{ commit = $mainSha; outcome = 'held'; ahead = $ahead }
        Set-Content -Path $unreleasedState -Value $mainSha
    } elseif ($ahead -eq 0) { Remove-Item $unreleasedState -ErrorAction SilentlyContinue }
}

# Before anything else: services a Windows restart left stopped come back even when there is nothing to deploy.
Invoke-StackRepair

$started = Get-Date
$target = [string](git -C $Repo rev-parse --verify "$TargetRef^{commit}" 2>$null)
$target = $target.Trim()
$running = Get-RunningCommit
$stopped = $null
$stoppedNote = $null
if ($target -and $target -ne $running) {
    # Something new to deploy. Wait while the appliance is running work a restart would stop.
    $busy = Get-ApplianceBusy
    if ($busy -and $busy.busy) {
        $count = @($busy.active).Count
        $things = if ($count -eq 1) { '1 thing' } else { "$count things" }
        $since = Get-HeldSince
        if (-not $since) { $since = $started.ToUniversalTime(); Set-Content -Path $holdState -Value $since.ToString('o') }
        $waited = ($started.ToUniversalTime() - $since).TotalMinutes
        $minutes = [int][Math]::Floor([Math]::Max(0, $waited))
        # No -f below: titles are the owner's own words and may hold braces.
        if ($waited -lt $MaxHoldMinutes) {
            $line = "Waiting: $things running ($(Get-BusyTitles $busy)); held $minutes of $MaxHoldMinutes min"
            Write-Output $line
            Write-AutoDeployLog ($started.ToString('s') + ' exit=0 ' + $target.Substring(0, [Math]::Min(12, $target.Length)) + ' ' + $line) $null
            exit 0
        }
        $stopped = $busy
        $were = if ($count -eq 1) { 'was' } else { 'were' }
        Notify "Updating now; $things $were still running and $were stopped" "The update waited $minutes minutes for them. Stopped: $(Get-BusyTitles $busy 5). Start them again once the update is done." @{ commit = $target; outcome = 'forced'; stopped = $count }
        $stoppedNote = "Waited $minutes min (limit $MaxHoldMinutes); deploying with $things still running: $(Get-BusyTitles $busy 5)"
        Write-Output $stoppedNote
    }
}
Remove-Item $holdState -ErrorAction SilentlyContinue

$output = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $Repo 'deploy\Deploy-LocalAI.ps1') -TargetRef $TargetRef -Repo $Repo -Live $Live -StateDir $StateDir 2>&1 | ForEach-Object { "$_" }
$code = $LASTEXITCODE
$last = ($output | Where-Object { $_ -match '^(DEPLOYED|NO CHANGE):' } | Select-Object -Last 1)
$sha = [string](git -C $Repo rev-parse --verify "$TargetRef^{commit}" 2>$null)
$short = if ($sha) { $sha.Trim().Substring(0, 12) } else { 'unknown' }

$summary = "{0} exit={1} {2} {3}" -f $started.ToString('s'), $code, $short, ($(if ($last) { $last } else { 'FAILED' }))
if ($stopped) { $summary += " (stopped $(@($stopped.active).Count) running)" }
Write-AutoDeployLog $summary @(@($stoppedNote | Where-Object { $_ }) + @($output))

if ($code -eq 0 -and $last -like 'DEPLOYED:*') {
    # The release the deploy recorded: its version and the merged changes since the previous one.
    $release = try { Get-Content (Join-Path $Live 'release.json') -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $null }
    $notes = @($release.notes | Where-Object { $_.title } | ForEach-Object { $_.title })
    $name = if ($release.version) { $release.version } else { $short }
    $detail = if ($notes.Count -gt 1) { "$($notes.Count) changes, including: " + (($notes | Select-Object -First 3) -join '; ') + ". See Health › What's new." }
              elseif ($notes.Count -eq 1) { $notes[0] }
              else { [string](git -C $Repo log -1 --format=%s $sha 2>$null) }
    Notify "Local AI updated to $name" $detail @{ commit = $sha.Trim(); version = "$($release.version)"; outcome = 'deployed' }
    Remove-Item $failState -ErrorAction SilentlyContinue
    if (Test-ApplianceHealthy) { Invoke-BackupTidy }
} elseif ($code -eq 0 -and $last -like 'NO CHANGE:*') {
    if (Test-ApplianceHealthy) { Invoke-BackupTidy }
} elseif ($code -ne 0) {
    $previous = if (Test-Path $failState) { (Get-Content $failState -Raw).Trim() } else { '' }
    if ($previous -ne $short) {
        # A blank stderr line from a native command reads 'System.Management.Automation.RemoteException' here; it says nothing.
        $cause = ($output | Where-Object { $_ -match 'failed|Exception|Cannot|rolled|restored' -and $_ -notmatch '^\s*System\.Management\.Automation\.RemoteException\s*$' } | Select-Object -Last 3) -join "`n"
        if (-not $cause) { $cause = "The deploy log on the host has the details: $log" }
        Notify 'An automatic update failed' ("The previous release is still running. Commit $short.`n" + $cause) @{ commit = "$sha".Trim(); outcome = 'failed'; log = $log }
        Set-Content -Path $failState -Value $short
    }
}
exit $code
