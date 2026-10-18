param(
    # A backup is removed only once it has been stopped this long.
    [ValidateRange(1, 3650)]
    [int]$MinAgeDays = 7,
    # For tests; defaults to now.
    [Nullable[DateTime]]$Now = $null
)
# Tidies the stopped backup containers our migrations leave behind (Install-LocalAI-Stack.ps1 -Adopt keeps
# *-pre-compose, Enable-LocalAI-HostOnlyPort.ps1 keeps *-pre-hostport, the n8n lockdown kept *-pre-lockdown).
# Run-LocalAI-AutoDeploy.ps1 calls it only after a healthy deploy, or when there was nothing to deploy and /healthz
# is OK. A backup is removed only when ALL of these hold:
#   - its name is exactly local-ai-<name>-pre-compose|pre-hostport|pre-lockdown;
#   - it is stopped (exited or created), never running;
#   - its live twin (the name without the suffix, or that compose service) exists, is running and is healthy;
#   - it has been stopped for MinAgeDays (the later of its created and finished times: a renamed container keeps
#     its original created time, so that alone would make yesterday's backup look months old).
# It runs `docker update --restart=no` first, then `docker rm` without -v: volumes are never removed. Every stopped
# backup also gets --restart=no straight away, so a reboot never tries to start one (and fails on its port).
# Returns @{ Removed = names; Log = lines }. Idempotent; never throws: a failure is a log line.
$ErrorActionPreference = 'Continue'
$pattern = '^local-ai-.+-(pre-compose|pre-hostport|pre-lockdown)$'
$suffix = '-(pre-compose|pre-hostport|pre-lockdown)$'
$removed = [System.Collections.Generic.List[string]]::new()
$log = [System.Collections.Generic.List[string]]::new()
if ($null -eq $Now) { $Now = Get-Date }
$nowUtc = ([DateTime]$Now).ToUniversalTime()

# Docker prints RFC 3339 with up to 9 fractional digits, which .NET can't parse; PowerShell 7's ConvertFrom-Json
# already returns a DateTime. $null for Docker's zero time (never finished) or anything unreadable.
function ConvertTo-UtcTime($value) {
    if ($value -is [DateTime]) { $t = $value.ToUniversalTime() }
    else {
        $m = [regex]::Match("$value", '^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d+)?(Z|[+-]\d\d:\d\d)$')
        if (-not $m.Success) { return $null }
        try { $t = [DateTime]::Parse($m.Groups[1].Value + $m.Groups[2].Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal) } catch { return $null }
    }
    if ($t.Year -lt 2000) { return $null }
    return $t
}
# docker inspect as an object, or $null.
function Get-ContainerInfo([string]$name) {
    $text = (& docker inspect $name 2>$null | Out-String)
    if ($LASTEXITCODE -ne 0 -or -not $text.Trim()) { return $null }
    try { return @($text | ConvertFrom-Json)[0] } catch { return $null }
}
function Test-Healthy($info) {
    if (-not $info -or -not $info.State -or $info.State.Running -ne $true) { return $false }
    # No healthcheck: running is all Docker can say. With one, only 'healthy' counts.
    if ($info.State.Health -and $info.State.Health.Status) { return $info.State.Health.Status -eq 'healthy' }
    return $true
}

try {
    # One JSON object per line: robust where table output and Go templates with quotes are not (Windows
    # PowerShell 5.1 strips quotes from native arguments).
    $lines = @(& docker ps -a --no-trunc --format '{{json .}}' 2>$null)
    if ($LASTEXITCODE -ne 0) { throw "docker ps failed ($LASTEXITCODE)" }
    $containers = @(foreach ($line in $lines) {
        if (-not "$line".Trim()) { continue }
        try { "$line" | ConvertFrom-Json } catch { }
    })
    $byName = @{}
    foreach ($c in $containers) { foreach ($n in ("$($c.Names)" -split ',')) { if ($n.Trim()) { $byName[$n.Trim().TrimStart('/')] = $c } } }

    foreach ($name in @($byName.Keys | Where-Object { $_ -cmatch $pattern } | Sort-Object)) {
        try {
            $info = Get-ContainerInfo $name
            if (-not $info -or -not $info.State) { $log.Add("Kept ${name}: docker inspect gave no answer"); continue }
            $state = "$($info.State.Status)"
            if ($info.State.Running -eq $true -or ($state -ne 'exited' -and $state -ne 'created')) { continue }

            # Stopped backups should never start on their own: on a reboot they fight the live stack for its ports.
            if ("$($info.HostConfig.RestartPolicy.Name)" -notin @('', 'no')) {
                & docker update --restart=no $name 2>$null | Out-Null
                if ($LASTEXITCODE -ne 0) { $log.Add("Kept ${name}: docker update --restart=no failed ($LASTEXITCODE)"); continue }
                $log.Add("Set restart=no on stopped backup $name")
            }

            $base = $name -creplace $suffix, ''
            $twin = $null
            if ($byName.ContainsKey($base)) { $twin = $base }
            else {
                # A compose-made twin: same service name, in the local-ai project.
                $service = $base -creplace '^local-ai-', ''
                foreach ($c in $containers) {
                    $labels = ",$($c.Labels),"
                    if ($labels.Contains(",com.docker.compose.service=$service,") -and $labels.Contains(',com.docker.compose.project=local-ai,')) { $twin = ("$($c.Names)" -split ',')[0].Trim(); break }
                }
            }
            if (-not $twin) { continue }
            if (-not (Test-Healthy (Get-ContainerInfo $twin))) { continue }

            $times = @((ConvertTo-UtcTime $info.Created), (ConvertTo-UtcTime $info.State.FinishedAt)) | Where-Object { $_ } | Sort-Object
            if (-not $times) { continue }
            $since = @($times)[-1]
            $days = ($nowUtc - $since).TotalDays
            if ($days -lt $MinAgeDays) { continue }

            & docker update --restart=no $name 2>$null | Out-Null
            if ($LASTEXITCODE -ne 0) { $log.Add("Kept ${name}: docker update --restart=no failed ($LASTEXITCODE)"); continue }
            # No -v: anonymous and named volumes stay. Never prune, never volume or image rm.
            & docker rm $name 2>$null | Out-Null
            if ($LASTEXITCODE -ne 0) { $log.Add("Kept ${name}: docker rm failed ($LASTEXITCODE)"); continue }
            $removed.Add($name)
            $log.Add(('Removed old backup container {0} (stopped {1} days; {2} is running and healthy; volumes kept)' -f $name, [int][Math]::Floor($days), $twin))
        } catch {
            $log.Add("Kept ${name}: $($_.Exception.Message)")
        }
    }
} catch {
    $log.Add("Backup tidy skipped: $($_.Exception.Message)")
}
[pscustomobject]@{ Removed = @($removed); Log = @($log) }
