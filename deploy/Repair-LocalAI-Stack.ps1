param(
    [string]$EnvFile = 'C:\LocalAI\stack\stack.env',
    [string]$Compose = (Join-Path $PSScriptRoot 'stack\compose.yml'),
    [string]$HealthUrl = 'http://127.0.0.1:3080/healthz',
    # How long to wait for the appliance's /healthz after starting services.
    [ValidateRange(0, 600)]
    [int]$HealthWaitSeconds = 60
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
# Returns @{ Started = names; Log = lines; Healthy = $true/$false/$null (not checked) }. Never throws: a failure is
# a log line. A no-op (no output, no log) when everything is running.
$ErrorActionPreference = 'Continue'
$project = 'local-ai'
$started = [System.Collections.Generic.List[string]]::new()
$log = [System.Collections.Generic.List[string]]::new()
$healthy = $null

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
        throw "docker compose $($arguments -join ' ') failed ($LASTEXITCODE)$(if ($detail) { ': ' + $detail })"
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

try {
    if (-not (Test-Path -LiteralPath $EnvFile) -or -not (Test-Path -LiteralPath $Compose)) {
        return [pscustomobject]@{ Started = @(); Log = @(); Healthy = $null }
    }

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
    if (-not $stopped.Count) { return [pscustomobject]@{ Started = @(); Log = @(); Healthy = $null } }

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

    # The appliance's /healthz, for up to HealthWaitSeconds.
    $healthy = $false
    $deadline = (Get-Date).AddSeconds($HealthWaitSeconds)
    $tries = [Math]::Max(1, [int][Math]::Ceiling($HealthWaitSeconds / 3))
    for ($i = 0; $i -lt $tries; $i++) {
        try { $healthy = (Invoke-RestMethod -Method Get -Uri $HealthUrl -TimeoutSec 5 -ErrorAction Stop).status -eq 'ok' } catch { $healthy = $false }
        if ($healthy -or (Get-Date) -ge $deadline) { break }
        Start-Sleep -Seconds 3
    }
    if ($healthy) { $log.Add('appliance /healthz OK') } else { $log.Add("appliance /healthz not OK after $HealthWaitSeconds s") }
} catch {
    $log.Add("stack check skipped: $($_.Exception.Message)")
}
[pscustomobject]@{ Started = @($started); Log = @($log); Healthy = $healthy }
