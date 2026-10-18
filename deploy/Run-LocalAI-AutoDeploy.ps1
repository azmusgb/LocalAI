param(
    [string]$TargetRef = 'origin/main',
    [string]$Repo = 'C:\LocalAI\repo',
    [string]$StateDir = 'C:\LocalAI\.deploy',
    [string]$Live = 'C:\LocalAI\appliance\app',
    [string]$NotifyUrl = 'http://127.0.0.1:3080/api/notifications/system',
    # Asked before an update restarts the appliance: while something is running the update waits, up to MaxHoldMinutes.
    [string]$BusyUrl = 'http://127.0.0.1:3080/api/busy',
    [ValidateRange(0, 1440)]
    [int]$MaxHoldMinutes = 45
)
# What the 'LocalAI Safe Deploy' task runs every few minutes. Keeps the host checkout current, runs the safe
# deploy (certify, promote, health-check, roll back), logs it, and tells the Inbox when something happened:
# a new release went live, or a deploy failed (once per failing commit, not on every retry). No change = silent.
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
function Write-AutoDeployLog([string]$summary, $runOutput) {
    $lines = @(if (Test-Path $log) { Get-Content $log -Encoding UTF8 })
    $marker = [Array]::IndexOf($lines, '--- last run ---')
    $history = @($(if ($marker -gt 0) { $lines[0..($marker - 1)] } elseif ($marker -lt 0) { $lines }) | Where-Object { $_ -match '^\d{4}-\d\d-\d\dT' } | Select-Object -Last 500)
    if ($null -eq $runOutput) { $runOutput = @(if ($marker -ge 0 -and $marker -lt $lines.Count - 1) { $lines[($marker + 1)..($lines.Count - 1)] }) }
    Set-Content -Path $log -Value (@($history) + $summary + '--- last run ---' + @($runOutput)) -Encoding UTF8
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

# The deploy scripts themselves come from this checkout, so fast-forward it when it tracks main and is clean.
# Otherwise fetch, so the check below sees what the deploy would.
if ($TargetRef -eq 'origin/main' -and -not (git -C $Repo status --porcelain 2>$null)) { git -C $Repo pull -q --ff-only origin main 2>&1 | Out-Null }
else { git -C $Repo fetch -q --prune origin 2>&1 | Out-Null }

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
