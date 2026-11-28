param(
    [string]$EnvFile = 'C:\LocalAI\stack\stack.env',
    [string]$Compose = (Join-Path $PSScriptRoot 'stack\compose.yml'),
    [string]$HealthUrl = 'http://127.0.0.1:3080/healthz',
    # How long to wait for the appliance's /healthz after starting services.
    [ValidateRange(0, 600)]
    [int]$HealthWaitSeconds = 60,
    # The scheduled task that opens Docker Desktop in the owner's session. It is started when the Docker engine does
    # not answer. No script here registers it; without it the engine being down is only logged.
    [string]$DockerDesktopTask = 'LocalAI-DockerDesktop',
    # Docker Desktop's own process. While it runs the task is not started, whatever docker compose printed.
    [string]$DockerDesktopProcess = 'com.docker.backend',
    # How long to wait for the Docker engine after starting that task.
    [ValidateRange(0, 600)]
    [int]$EngineWaitSeconds = 120,
    # The least time between two starts of that task while the engine stays down.
    [ValidateRange(0, 1440)]
    [int]$EngineStartGapMinutes = 15,
    # When the task was last started and how often (JSON). It exists only from a start until the engine answers again.
    [string]$EngineStartState = 'C:\LocalAI\.deploy\docker-desktop-start.json'
)
# Starts compose services that should be running but are stopped. Docker Desktop treats containers stopped by a
# Windows shutdown as stopped by the user, so `restart: unless-stopped` never brings them back after a reboot (18 Oct:
# everything but the appliance stayed Exited; the next deploy recreated only the appliance).
# Run-LocalAI-AutoDeploy.ps1 calls it on every run, before the deploy decision. It:
#   - does nothing on a host without the compose stack (no stack.env or compose.yml);
#   - lists the project's containers (`docker compose ps -a --format json`: a JSON array or one object per line);
#   - counts a service as stopped when its container (the service's container_name) is exited or created and the
#     service has a restart policy (so the one-shot sandbox-certs job, which exits 0 by design, never counts);
#   - then runs `docker compose up -d --no-recreate`: running containers, the appliance included, are left alone;
#   - ignores *-pre-* backups and containers outside the compose project. If a backup (or any container not named
#     as its service) still carries this project's compose labels, `up` could treat it as an extra replica and
#     remove it, so then it starts only the stopped service containers by name (`docker start`) instead;
#   - afterwards waits up to HealthWaitSeconds for the appliance's /healthz.
# When Docker Desktop itself has quit (27 Nov: the engine's pipe was gone for 70 minutes and every run only logged
# it), docker compose fails with the CLI's cannot-connect message for a pipe that is not there. Then, and only then, it:
#   - checks that Docker Desktop's process (DockerDesktopProcess) is not running. If it is, or the process list
#     cannot be read, it starts nothing and logs that;
#   - starts the DockerDesktopTask scheduled task, waits up to EngineWaitSeconds for `docker version` to answer, and
#     runs the check above in the same run. No task, a task that cannot be started, or an engine that still does not
#     answer is a log line saying which, followed by the same "stack check skipped" line as before;
#   - writes EngineStartState before each start and does not start the task again until EngineStartGapMinutes have
#     passed. A record that cannot be read is logged and counts as a start made now, never as "not tried";
#   - once the engine answers again (in that run or a later one) checks the appliance's /healthz, removes the record
#     and returns Engine, so the caller sends one Inbox line for the outage. If /healthz is not OK yet, that waits
#     one run (Engine.Notify is $false).
# Any other compose failure ("port is already allocated") is logged as before and starts nothing.
# Returns @{ Started = names; Log = lines; Healthy = $true/$false/$null (not checked); Engine = $null, or
# @{ Notify; StartedNow; Attempts ($null = not known) } when Docker Desktop had quit and the engine answers again }.
# Never throws: a failure is a log line. A no-op (no output, no log) when everything is running.
$ErrorActionPreference = 'Continue'
$project = 'local-ai'
$started = [System.Collections.Generic.List[string]]::new()
$log = [System.Collections.Generic.List[string]]::new()
$healthy = $null
$engine = $null

# The docker CLI's words for "the engine's pipe is not there": Docker Desktop has quit or is still starting. An engine
# that answers with an error, times out or refuses the caller (500, deadline exceeded, access denied, elevated
# privileges) names the same pipe while Docker Desktop runs, so those are left out.
function Test-EngineUnreachable([string]$text) {
    if ($text -match 'Access is denied|elevated privileges') { return $false }
    return $text -match 'failed to connect to the docker API|open //\./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified|Docker Desktop is not running|cannot connect to the Docker daemon|is the docker daemon running'
}
# Parses `docker compose ... --format json` output: one JSON array, or one object per line (Compose 2.21+).
function ConvertFrom-ComposeJson($lines) {
    $text = (@($lines) | ForEach-Object { "$_" }) -join "`n"
    if (-not $text.Trim()) { return @() }
    if ($text.Trim().StartsWith('[')) {
        $parsed = $text | ConvertFrom-Json
        return @(foreach ($item in $parsed) { $item })
    }
    return @(foreach ($line in ($text -split "`n")) {
        if (-not $line.Trim()) { continue }
        try { $line | ConvertFrom-Json } catch { }
    })
}
# Runs docker compose with the stack's files; returns its output as strings and throws when it fails.
function Invoke-StackCompose([string[]]$arguments) {
    $output = @(& docker compose --env-file $EnvFile -f $Compose @arguments 2>&1 | ForEach-Object { "$_" })
    if ($LASTEXITCODE -ne 0) {
        $detail = (@($output | Where-Object { $_.Trim() -and $_ -notmatch '^\s*System\.Management\.Automation\.RemoteException\s*$' }) | Select-Object -Last 2) -join ' '
        $failure = [System.InvalidOperationException]::new("docker compose $($arguments -join ' ') failed ($LASTEXITCODE)$(if ($detail) { ': ' + $detail })")
        $failure.Data['EngineUnreachable'] = (Test-EngineUnreachable ($output -join "`n"))
        throw $failure
    }
    return $output
}
# The project's containers that belong to a service, by container name; *-pre-* backups and strangers left out.
function Get-StackContainers($services) {
    $entries = ConvertFrom-ComposeJson (Invoke-StackCompose @('ps', '-a', '--format', 'json'))
    $result = @{ Live = @{}; Strays = @() }
    foreach ($e in $entries) {
        $name = "$($e.Name)".Trim().TrimStart('/')
        if (-not $name) { continue }
        if ($e.Project -and "$($e.Project)" -ne $project) { continue }
        $service = "$($e.Service)"
        if ($services.ContainsKey($service) -and $services[$service].Name -eq $name -and $name -notmatch '-pre-') { $result.Live[$name] = $e }
        else { $result.Strays += $name }
    }
    return $result
}
function Get-WasText($entry) {
    $state = "$($entry.State)"
    $text = if ($state) { $state.Substring(0, 1).ToUpperInvariant() + $state.Substring(1) } else { 'stopped' }
    if ($state -eq 'exited' -and "$($entry.ExitCode)" -ne '') { $text += " $($entry.ExitCode)" }
    return $text
}

# Waits up to HealthWaitSeconds for the appliance's /healthz and logs the result.
function Wait-ApplianceHealth {
    $ok = $false
    $deadline = (Get-Date).AddSeconds($HealthWaitSeconds)
    $tries = [Math]::Max(1, [int][Math]::Ceiling($HealthWaitSeconds / 3))
    for ($i = 0; $i -lt $tries; $i++) {
        try { $ok = (Invoke-RestMethod -Method Get -Uri $HealthUrl -TimeoutSec 5 -ErrorAction Stop).status -eq 'ok' } catch { $ok = $false }
        if ($ok -or (Get-Date) -ge $deadline) { break }
        Start-Sleep -Seconds 3
    }
    if ($ok) { $log.Add('appliance /healthz OK') } else { $log.Add("appliance /healthz not OK after $HealthWaitSeconds s") }
    return $ok
}
# Starts the stopped services. Throws when docker compose fails; the exception's Data says if the engine was unreachable.
function Invoke-StackCheck {
    # The services that should keep running: those with a restart policy, by their fixed container name.
    $config = (Invoke-StackCompose @('config', '--format', 'json')) -join "`n" | ConvertFrom-Json
    $services = @{}
    foreach ($p in $config.services.PSObject.Properties) {
        $name = if ($p.Value.container_name) { "$($p.Value.container_name)" } else { '' }
        $restart = "$($p.Value.restart)"
        $services[$p.Name] = @{ Name = $name; ShouldRun = ($restart -and $restart -ne 'no') }
    }

    $stack = Get-StackContainers $services
    $stopped = @(foreach ($service in ($services.Keys | Sort-Object)) {
        $want = $services[$service]
        if (-not $want.ShouldRun -or -not $want.Name -or -not $stack.Live.ContainsKey($want.Name)) { continue }
        $entry = $stack.Live[$want.Name]
        if ("$($entry.State)" -in @('exited', 'created')) { [pscustomobject]@{ Name = $want.Name; Was = (Get-WasText $entry) } }
    })
    if (-not $stopped.Count) { return }

    $strays = @($stack.Strays)
    if ($strays.Count) {
        # A backup with this project's labels: `up` might scale it away, so start the stopped containers one by one.
        $log.Add("compose project also lists $($strays -join ', '); starting stopped services by name instead of docker compose up")
        foreach ($s in $stopped) {
            & docker start $s.Name 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { $log.Add("could not start $($s.Name) (docker start failed, $LASTEXITCODE)") }
        }
    } else {
        Invoke-StackCompose @('up', '-d', '--no-recreate') | Out-Null
    }

    # What is running now.
    $after = Get-StackContainers $services
    foreach ($s in $stopped) {
        $entry = $after.Live[$s.Name]
        if ($entry -and "$($entry.State)" -eq 'running') { $started.Add($s.Name); $log.Add("started $($s.Name) (was $($s.Was))") }
        else { $log.Add("$($s.Name) is still not running (was $($s.Was); now $(if ($entry) { $entry.State } else { 'missing' }))") }
    }

    $script:healthy = Wait-ApplianceHealth
}
function ConvertTo-UtcTime($value) {
    if ($value -is [DateTime]) { return $value.ToUniversalTime() }
    return [DateTime]::Parse("$value", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
}
# The record of Docker Desktop starts. Throws when the file cannot be read or does not hold a time.
function Read-EngineStartState {
    $record = Get-Content -LiteralPath $EngineStartState -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    # engineBack: the engine answered in an earlier run and the Inbox line waits for the appliance; startedIt: it
    # answered in the run that started it.
    return @{ Last = (ConvertTo-UtcTime $record.lastAttempt); Attempts = [int]$record.attempts; Back = [bool]$record.engineBack; StartedIt = [bool]$record.startedIt }
}
function Write-EngineStartState([DateTime]$last, [int]$attempts, [bool]$back = $false, [bool]$startedIt = $false) {
    $record = [ordered]@{ lastAttempt = $last.ToString('o'); attempts = $attempts }
    if ($back) { $record.engineBack = $true; $record.startedIt = $startedIt }
    Set-Content -LiteralPath $EngineStartState -Value ($record | ConvertTo-Json -Compress) -Encoding UTF8 -ErrorAction Stop
}
# The engine does not answer: starts Docker Desktop's task, unless it was started less than EngineStartGapMinutes
# ago, and waits for the engine. Logs what it did or why not; returns $true only when the engine answers.
function Start-DockerDesktop {
    $down = 'Docker engine is not reachable;'
    $now = (Get-Date).ToUniversalTime()
    $attempts = 0
    if (Test-Path -LiteralPath $EngineStartState) {
        try { $record = Read-EngineStartState } catch {
            # Not known when it was last started: count that as now, so a bad file cannot start it on every run.
            $log.Add("$down could not read $EngineStartState ($($_.Exception.Message)), so Docker Desktop is not started now; the next try is in $EngineStartGapMinutes min")
            try { Write-EngineStartState $now 0 } catch { $log.Add("could not rewrite $EngineStartState ($($_.Exception.Message)); Docker Desktop is not started until it can be read") }
            return $false
        }
        $attempts = $record.Attempts
        # A time in the future (the clock was set back) is as far away as one in the past.
        $ago = [Math]::Abs(($now - $record.Last).TotalMinutes)
        if ($ago -lt $EngineStartGapMinutes) {
            $log.Add("$down Docker Desktop was started $([int][Math]::Floor($ago)) min ago and is not started again until $EngineStartGapMinutes min have passed")
            return $false
        }
    }
    # A second sign, apart from docker's message: Docker Desktop's process must be gone. A list that cannot be read is
    # not "gone".
    try { $running = @(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -eq $DockerDesktopProcess }).Count -gt 0 } catch {
        $log.Add("$down could not check whether Docker Desktop is running ($($_.Exception.Message)), so it was not started")
        return $false
    }
    if ($running) {
        $log.Add("Docker engine is not reachable although Docker Desktop is running (process $DockerDesktopProcess), so it was not started")
        return $false
    }
    if (-not $DockerDesktopTask -or -not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) {
        $log.Add("$down there is no scheduled task to start Docker Desktop with here")
        return $false
    }
    $task = $null
    try { $task = Get-ScheduledTask -TaskName $DockerDesktopTask -ErrorAction Stop } catch {
        if ($_.CategoryInfo.Category -ne [System.Management.Automation.ErrorCategory]::ObjectNotFound) {
            $log.Add("$down could not look up scheduled task '$DockerDesktopTask' ($($_.Exception.Message)), so Docker Desktop was not started")
            return $false
        }
    }
    if (-not $task) {
        $log.Add("$down scheduled task '$DockerDesktopTask' does not exist, so Docker Desktop was not started")
        return $false
    }
    # Recorded before the start: if it cannot be recorded it is not started, or every run would start it again.
    try { Write-EngineStartState $now ($attempts + 1) } catch {
        $log.Add("$down could not record the start in $EngineStartState ($($_.Exception.Message)), so Docker Desktop was not started")
        return $false
    }
    try { Start-ScheduledTask -TaskName $DockerDesktopTask -ErrorAction Stop } catch {
        $log.Add("$down could not start scheduled task '$DockerDesktopTask' ($($_.Exception.Message))")
        return $false
    }
    $from = Get-Date
    $deadline = $from.AddSeconds($EngineWaitSeconds)
    $tries = [Math]::Max(1, [int][Math]::Ceiling($EngineWaitSeconds / 3))
    $answers = $false
    for ($i = 0; $i -lt $tries; $i++) {
        & docker version --format '{{.Server.Version}}' 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $answers = $true; break }
        if ((Get-Date) -ge $deadline) { break }
        Start-Sleep -Seconds 3
    }
    if (-not $answers) {
        $log.Add("$down started scheduled task '$DockerDesktopTask' but the engine did not answer within $EngineWaitSeconds s")
        return $false
    }
    $log.Add("Docker Desktop had quit; started scheduled task '$DockerDesktopTask' and the Docker engine answered after $([int][Math]::Round(((Get-Date) - $from).TotalSeconds)) s")
    return $true
}
# The engine answers and a start record exists: the outage is over. Removes the record and sets $engine for the
# caller's one Inbox line; while the appliance does not answer yet, that waits for the next run (once).
function Complete-EngineOutage([bool]$startedNow) {
    $record = $null
    try { $record = Read-EngineStartState } catch { $log.Add("could not read $EngineStartState ($($_.Exception.Message)); how often Docker Desktop was started is not known") }
    if (-not $startedNow) { $log.Add('Docker engine answers again') }
    if ($null -eq $healthy) { $script:healthy = Wait-ApplianceHealth }
    if ($record -and $record.StartedIt) { $startedNow = $true }
    if (-not $healthy -and $record -and -not $record.Back) {
        try {
            Write-EngineStartState $record.Last $record.Attempts $true $startedNow
            $log.Add('the appliance does not answer yet; the Inbox is told at the next check')
            $script:engine = [pscustomobject]@{ Notify = $false; StartedNow = $startedNow; Attempts = $record.Attempts }
            return
        } catch { $log.Add("could not update $EngineStartState ($($_.Exception.Message))") }
    }
    try { Remove-Item -LiteralPath $EngineStartState -Force -ErrorAction Stop } catch {
        # With the record still there the next run would tell the Inbox again: say it here instead.
        $log.Add("could not remove $EngineStartState ($($_.Exception.Message)); the Inbox is not told that Docker Desktop is running again")
        return
    }
    $script:engine = [pscustomobject]@{ Notify = $true; StartedNow = $startedNow; Attempts = $(if ($record) { $record.Attempts } else { $null }) }
}

try {
    if (-not (Test-Path -LiteralPath $EnvFile) -or -not (Test-Path -LiteralPath $Compose)) {
        return [pscustomobject]@{ Started = @(); Log = @(); Healthy = $null; Engine = $null }
    }
    $startedEngine = $false

    try { Invoke-StackCheck } catch {
        if (-not $_.Exception.Data['EngineUnreachable']) { throw }
        $failure = $_
        # Lines from the part of the check that ran come back if Docker Desktop is not started; else the check runs again.
        $partial = [string[]]@($log); $log.Clear()
        if (-not (Start-DockerDesktop)) { $log.InsertRange(0, $partial); throw $failure }
        $startedEngine = $true
        $started.Clear(); $healthy = $null
        Invoke-StackCheck
    }
    if (Test-Path -LiteralPath $EngineStartState) { Complete-EngineOutage $startedEngine }
} catch {
    $log.Add("stack check skipped: $($_.Exception.Message)")
}
[pscustomobject]@{ Started = @($started); Log = @($log); Healthy = $healthy; Engine = $engine }
