param(
    [string]$Container = 'local-ai-appliance',
    [int]$LocalPort = 3090,
    [string]$HealthUrl = 'http://127.0.0.1:3080/healthz'
)
# One-time change: recreate the appliance container with a second port published on 127.0.0.1 only and
# LOCAL_UI_PORT set, so the PowerShell Workbench answers only to requests made on the Windows host itself.
# Same image, env, mounts, network and restart policy. The old container is kept (stopped) for rollback.

function Invoke-Docker { & docker @args; if ($LASTEXITCODE -ne 0) { throw "docker $($args[0]) failed ($LASTEXITCODE)" } }
function Test-Health {
    for ($i = 0; $i -lt 30; $i++) {
        try { if ((Invoke-WebRequest -UseBasicParsing $HealthUrl -TimeoutSec 3).StatusCode -eq 200) { return $true } } catch {}
        Start-Sleep 2
    }
    return $false
}

$info = (& docker inspect $Container | ConvertFrom-Json)[0]
if (-not $info) { throw "Container $Container not found" }
$envVars = @($info.Config.Env | Where-Object { $_ -notmatch '^(PATH|NODE_VERSION|YARN_VERSION)=' -and $_ -notmatch '^LOCAL_UI_PORT=' })
$bindings = $info.HostConfig.PortBindings
if (($info.Config.Env -contains "LOCAL_UI_PORT=$LocalPort") -and $bindings."$LocalPort/tcp") {
    "Already enabled: Workbench at http://localhost:$LocalPort"
    return
}

$runArgs = @('run', '-d', '--name', $Container, '--restart', $info.HostConfig.RestartPolicy.Name)
foreach ($prop in $bindings.PSObject.Properties) {
    $containerPort = $prop.Name -replace '/tcp$', ''
    if ($containerPort -eq "$LocalPort") { continue }
    foreach ($b in $prop.Value) { $runArgs += '-p'; $runArgs += $(if ($b.HostIp) { "$($b.HostIp):$($b.HostPort):$containerPort" } else { "$($b.HostPort):$containerPort" }) }
}
$runArgs += '-p'; $runArgs += "127.0.0.1:${LocalPort}:$LocalPort"
foreach ($bind in $info.HostConfig.Binds) { $runArgs += '-v'; $runArgs += $bind }
foreach ($h in $info.HostConfig.ExtraHosts) { $runArgs += '--add-host'; $runArgs += $h }
$network = @($info.NetworkSettings.Networks.PSObject.Properties.Name)[0]
if ($network) { $runArgs += '--network'; $runArgs += $network }

# Tokens go through an env file readable only by this user, never the command line, and the file is deleted after.
$envFile = Join-Path $env:TEMP "localai-env-$([guid]::NewGuid().ToString('N')).txt"
[System.IO.File]::WriteAllLines($envFile, [string[]]($envVars + "LOCAL_UI_PORT=$LocalPort"))
icacls $envFile /inheritance:r /grant:r "${env:USERNAME}:F" | Out-Null
$runArgs += '--env-file'; $runArgs += $envFile
$runArgs += $info.Config.Image
$runArgs += $info.Config.Cmd

$backup = "$Container-pre-hostport"
& docker rm -f $backup 2>$null | Out-Null
try {
    Invoke-Docker stop $Container | Out-Null
    Invoke-Docker rename $Container $backup
    Invoke-Docker @runArgs | Out-Null
    if (-not (Test-Health)) { throw 'New container did not become healthy' }
    "Enabled: PowerShell Workbench at http://localhost:$LocalPort (host only). Old container kept stopped as $backup."
} catch {
    "Rolling back: $_"
    & docker rm -f $Container 2>$null | Out-Null
    & docker rename $backup $Container 2>$null
    & docker start $Container | Out-Null
    throw
} finally {
    Remove-Item -LiteralPath $envFile -Force -ErrorAction SilentlyContinue
}
