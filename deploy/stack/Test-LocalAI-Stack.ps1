param(
    [string]$EnvFile = 'C:\LocalAI\stack\stack.env',
    [string]$Compose = (Join-Path $PSScriptRoot 'compose.yml')
)
# Checks that the containers running now match deploy\stack\compose.yml: image, restart policy, user, ports, mounts,
# network, command and every environment value compose sets. Changes nothing. Values are compared, never printed.
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $EnvFile)) { throw "No $EnvFile; run Export-LocalAI-StackEnv.ps1 first" }
$config = (& docker compose --env-file $EnvFile -f $Compose config --format json) -join "`n" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'docker compose config failed' }
$norm = { param($p) ([string]$p).Replace('\', '/').ToLowerInvariant() -replace '^/run/desktop/mnt/host/([a-z])/', '$1:/' -replace '^([a-z]):', '$1:' }
$problems = 0
foreach ($svc in $config.services.PSObject.Properties) {
    $want = $svc.Value; $name = $want.container_name; $diff = @()
    # Continue here: under Windows PowerShell 5.1 with Stop, docker's 'no such object' on stderr ends the whole check.
    $live = (& { $ErrorActionPreference = 'Continue'; & docker inspect $name 2>$null } | ConvertFrom-Json)
    if (-not $live) { "MISSING  $name"; $problems++; continue }
    $live = $live[0]
    # Same image: compare image IDs, so a tag and the digest it points to count as equal.
    $wantId = & docker image inspect $want.image --format '{{.Id}}' 2>$null
    if ($wantId -ne $live.Image) { $diff += "image (compose $($want.image), running $($live.Config.Image))" }
    $restart = if ($want.restart) { $want.restart } else { 'no' }
    if ($live.HostConfig.RestartPolicy.Name -ne $restart) { $diff += "restart ($restart vs $($live.HostConfig.RestartPolicy.Name))" }
    if ([bool]$want.privileged -ne [bool]$live.HostConfig.Privileged) { $diff += 'privileged' }
    # User: what compose names, else the image's own (n8n's image runs as node, sandbox-api's as sandbox-api).
    $wantUser = if ($want.user) { [string]$want.user } else { [string](& docker image inspect $live.Image --format '{{.Config.User}}') }
    if ($wantUser -ne [string]$live.Config.User) { $diff += "user (compose '$wantUser', running '$($live.Config.User)')" }
    if ($want.command -and (($want.command -join ' ') -ne ($live.Config.Cmd -join ' '))) { $diff += 'command' }
    # Ports: host IP and port for each published container port.
    $wantPorts = @($want.ports | Where-Object { $_ } | ForEach-Object { "$($_.host_ip):$($_.published)->$($_.target)" } | Sort-Object)
    $livePorts = @($live.HostConfig.PortBindings.PSObject.Properties | Where-Object { $_ } | ForEach-Object { $t = $_.Name -replace '/tcp$'; $_.Value | ForEach-Object { "$($_.HostIp):$($_.HostPort)->$t" } } | Sort-Object)
    if (($wantPorts -join ',') -ne ($livePorts -join ',')) { $diff += "ports (compose $($wantPorts -join ', '); running $($livePorts -join ', '))" }
    # Mounts: destination, source (volume name or host path) and read-only.
    $wantMounts = @($want.volumes | ForEach-Object { $src = if ($_.type -eq 'volume') { $config.volumes.($_.source).name } else { & $norm $_.source }; "$($_.target)<=$src$(if ($_.read_only) {':ro'})" } | Sort-Object)
    $liveMounts = @($live.Mounts | ForEach-Object { $src = if ($_.Type -eq 'volume') { $_.Name } else { & $norm $_.Source }; "$($_.Destination)<=$src$(if (-not $_.RW) {':ro'})" } | Sort-Object)
    $extra = @($liveMounts | Where-Object { $wantMounts -notcontains $_ -and $_ -notmatch '^/var/lib/docker<=|^/etc/searxng<=|^/var/cache/searxng<=' })
    $absent = @($wantMounts | Where-Object { $liveMounts -notcontains $_ })
    if ($absent -or $extra) { $diff += "mounts (compose only: $($absent -join ', '); running only: $($extra -join ', '))" }
    # Network membership.
    foreach ($net in $want.networks.PSObject.Properties.Name) { $n = $config.networks.$net.name; if (-not $live.NetworkSettings.Networks.$n) { $diff += "network $n" } }
    # Environment: every value compose sets must be the running value.
    $liveEnv = @{}; foreach ($e in $live.Config.Env) { $k, $v = $e -split '=', 2; $liveEnv[$k] = $v }
    foreach ($p in $want.environment.PSObject.Properties) {
        if (-not $liveEnv.ContainsKey($p.Name)) { if ($p.Value) { $diff += "env $($p.Name) missing" } }
        elseif ($liveEnv[$p.Name] -ne [string]$p.Value) { $diff += "env $($p.Name) differs" }
    }
    # Values the image itself sets aren't drift.
    $imageEnv = @{}; foreach ($e in (& docker image inspect $live.Image --format '{{range .Config.Env}}{{println .}}{{end}}')) { if ($e) { $k, $v = $e -split '=', 2; $imageEnv[$k] = $v } }
    $extraEnv = @($liveEnv.Keys | Where-Object { $imageEnv[$_] -ne $liveEnv[$_] -and -not $want.environment.PSObject.Properties[$_] -and $_ -match '^(APP_|LOCAL|POWERSHELL|N8N_|SANDBOX_API|SEARXNG_SECRET|MAC_|MODEL|.*_URL$)' -and $_ -notmatch '^N8N_RELEASE_TYPE$' })
    if ($extraEnv) { $diff += "running sets env not in compose: $($extraEnv -join ', ')" }
    if ($diff) { "DIFFERS  $name"; $diff | ForEach-Object { "         - $_" }; $problems++ } else { "OK       $name" }
}
if ($problems) { "$problems container(s) differ from compose.yml"; exit 1 }
'All containers match deploy\stack\compose.yml.'
