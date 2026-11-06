$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
. (Join-Path $repository 'deploy/Deployment-LocalAI.ps1')
. (Join-Path $repository 'deploy/Storage-LocalAI.ps1')
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ('localai-deploy-tests-' + [Guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($temporary) | Out-Null
$script:failures = [System.Collections.Generic.List[string]]::new()
$script:passed = 0
$script:newSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
$script:oldSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function Assert-True([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Assert-Throws([scriptblock]$Action, [string]$Pattern) {
    try { & $Action } catch { if ($_.Exception.Message -match $Pattern) { return }; throw }
    throw "Expected failure matching $Pattern"
}
function Test-Case([string]$Name, [scriptblock]$Action) {
    try { & $Action; $script:passed++; Write-Host "PASS: $Name" }
    catch { $script:failures.Add("${Name}: $($_.Exception.Message)"); Write-Host "FAIL: ${Name}: $($_.Exception.Message)`n$($_.ScriptStackTrace)" }
}

# These fixtures simulate native command boundaries, not the functions being tested.
# Deployment/rollback scripts, health predicates, manifests and state writes are real.
function New-Fixture {
    $root = Join-Path $temporary ([Guid]::NewGuid().ToString('N'))
    $repo = Join-Path $root 'repo'
    $live = Join-Path $root 'live'
    foreach ($dir in @($repo, $live, (Join-Path $repo 'app'), (Join-Path $repo 'deploy'), (Join-Path $repo 'tests'))) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }
    foreach ($name in @('server.js','storage.js','storage-cli.js','release.js')) { Set-Content -LiteralPath (Join-Path $repo "app/$name") -Value 'candidate source' }
    Set-Content -LiteralPath (Join-Path $live 'server.js') -Value 'legacy source'
    foreach ($dir in @((Join-Path $repo 'docs'), (Join-Path $repo 'host'))) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }
    Set-Content -LiteralPath (Join-Path $repo 'docs/GRIDCRAFT.md') -Value '# GridCraft'
    Set-Content -LiteralPath (Join-Path $repo 'host/gridcraft-bridge.py') -Value 'bridge'
    Copy-Item -LiteralPath (Join-Path $repository 'deploy/Storage-LocalAI.ps1') -Destination (Join-Path $repo 'deploy/Storage-LocalAI.ps1')
    Copy-Item -LiteralPath (Join-Path $repository 'deploy/Deployment-LocalAI.ps1') -Destination (Join-Path $repo 'deploy/Deployment-LocalAI.ps1')
    Set-Content -LiteralPath (Join-Path $repo 'deploy/Test-LocalAI-Candidate.ps1') -Value 'param($CandidateRoot)'
    $script:fixture = [pscustomobject]@{
        Root = $root; Repo = $repo; Live = $live; Releases = (Join-Path $root 'releases'); StateDir = (Join-Path $root 'state')
        Running = $true; RejectNewRelease = $false; RejectAllHealth = $false; PreflightFailure = $false; ExportFailure = $false
        Calls = [System.Collections.Generic.List[object]]::new()
        # Auto-deploy: what GET /api/busy answers ($null with BusyFails = no answer), and the Inbox notices sent.
        Busy = $null; BusyFails = $false; BusyAsked = 0; Notices = [System.Collections.Generic.List[object]]::new()
        # Backup tidy: the containers `docker ps -a` lists (New-FixtureContainer), and simulated docker failures.
        Containers = [System.Collections.Generic.List[object]]::new(); PsFails = $false; RmFails = @(); NoChange = $false; DeployFails = $false
        # Stack repair: what `docker compose ps -a` lists (New-FixtureStack), printed as a JSON array or one object per
        # line, and simulated compose failures.
        Stack = [System.Collections.Generic.List[object]]::new(); StackAsArray = $false; ComposeFails = $false; ComposeUpFails = $false
        StackEnv = (Join-Path $root 'stack.env'); StackCompose = (Join-Path $root 'compose.yml')
        # Auto-deploy's release gate: commits on origin/main not yet on origin/release, and whether the checkout is dirty.
        Ahead = 0; Dirty = ''
        # History prune: the files in the appliance's /data/backups, newest first, and a simulated docker exec failure.
        DataBackups = [System.Collections.Generic.List[string]]::new(); ExecFails = $false
        # Host parts: compose's hash for the release and the running container's config-hash label.
        ComposeHash = ('c' * 64); ConfigHash = ('c' * 64)
    }
    [System.IO.Directory]::CreateDirectory($fixture.StateDir) | Out-Null
    Write-LocalAI-DeployState (Join-Path $fixture.StateDir 'state.json') ([ordered]@{status='HEALTHY';currentCommit=$oldSha})
    return $fixture
}
# A container for the backup tidy. Times are ISO 8601 (Docker's 9 fractional digits included); $null FinishedAt is
# Docker's zero time (never ran).
function New-FixtureContainer([string]$Name, [string]$State = 'exited', [double]$StoppedDaysAgo = 10, [string]$Health = $null, [string]$Labels = '', [double]$CreatedDaysAgo = -1, [string]$Restart = 'unless-stopped') {
    $now = (Get-Date).ToUniversalTime()
    if ($CreatedDaysAgo -lt 0) { $CreatedDaysAgo = $StoppedDaysAgo + 30 }
    $finished = if ($State -eq 'exited') { $now.AddDays(-$StoppedDaysAgo).ToString('yyyy-MM-ddTHH:mm:ss') + '.123456789Z' } else { '0001-01-01T00:00:00Z' }
    $fixture.Containers.Add([pscustomobject]@{ Name = $Name; State = $State; Health = $Health; Labels = $Labels; Restart = $Restart; Created = $now.AddDays(-$CreatedDaysAgo).ToString('yyyy-MM-ddTHH:mm:ss') + '.987654321Z'; FinishedAt = $finished })
}
# The compose stack for the repair: stack.env and compose.yml exist, and every service runs unless listed in $Stopped
# (name = 'exited <code>' or 'created'). sandbox-certs is the one-shot job: exited 0, no restart policy.
$script:stackServices = [ordered]@{ appliance = 'unless-stopped'; https = 'unless-stopped'; n8n = 'unless-stopped'; 'ollama-responses-proxy' = 'unless-stopped'; searxng = 'unless-stopped'; 'sandbox-certs' = ''; 'sandbox-api' = 'unless-stopped'; 'sandbox-runner-1' = 'unless-stopped' }
function New-FixtureStack([hashtable]$Stopped = @{}) {
    Set-Content -LiteralPath $fixture.StackEnv -Value 'LOCALAI_HOST_IP=10.0.0.21'
    Set-Content -LiteralPath $fixture.StackCompose -Value 'name: local-ai'
    foreach ($service in $stackServices.Keys) {
        $name = "local-ai-$service"
        $state = if ($Stopped.ContainsKey($name)) { $Stopped[$name] } elseif ($service -eq 'sandbox-certs') { 'exited 0' } else { 'running' }
        Add-FixtureStackEntry $name $service $state
    }
}
function Add-FixtureStackEntry([string]$Name, [string]$Service, [string]$State, [string]$Project = 'local-ai') {
    $parts = $State -split ' '
    $fixture.Stack.Add([pscustomobject]@{ Name = $Name; Service = $Service; Project = $Project; State = $parts[0]; ExitCode = $(if ($parts.Count -gt 1) { [int]$parts[1] } else { 0 }) })
}
function Get-FixtureStackEntry([string]$Name) { @($fixture.Stack | Where-Object { $_.Name -eq $Name })[0] }
function Invoke-FixtureRepair { & (Join-Path $repository 'deploy/Repair-LocalAI-Stack.ps1') -EnvFile $fixture.StackEnv -Compose $fixture.StackCompose -HealthUrl 'http://fixture/healthz' }
function Get-FixtureContainer([string]$Name) { @($fixture.Containers | Where-Object { $_.Name -eq $Name })[0] }
function docker {
    $Arguments = [string[]]$args
    $fixture.Calls.Add($Arguments)
    $global:LASTEXITCODE = 0
    switch ($Arguments[0]) {
        'compose' {
            if ($fixture.ComposeFails) { $global:LASTEXITCODE = 1; return 'error during connect: Docker Desktop is not running' }
            $sub = $Arguments[5]
            # The host-parts check: compose's hash for one service.
            if ($Arguments -contains '--hash') { return "$($Arguments[-1]) $($fixture.ComposeHash)" }
            if ($Arguments[1] -ne '--env-file' -or $Arguments[2] -ne $fixture.StackEnv -or $Arguments[4] -ne $fixture.StackCompose) { throw "Unexpected compose files: $($Arguments -join ' ')" }
            if ($sub -eq 'config') {
                $services = [ordered]@{}
                foreach ($k in $stackServices.Keys) { $svc = [ordered]@{ container_name = "local-ai-$k"; image = 'img' }; if ($stackServices[$k]) { $svc.restart = $stackServices[$k] }; $services[$k] = $svc }
                return (ConvertTo-Json -Depth 6 -InputObject ([ordered]@{ name = 'local-ai'; services = $services }))
            }
            if ($sub -eq 'ps') {
                # Other projects' containers too: a real `compose ps` leaves them out, but the script must not rely on it.
                $rows = @($fixture.Stack | ForEach-Object { [ordered]@{ Name = $_.Name; Service = $_.Service; Project = $_.Project; State = $_.State; ExitCode = $_.ExitCode; Status = "$($_.State)"; Labels = "com.docker.compose.project=$($_.Project)" } })
                if ($fixture.StackAsArray) { return (ConvertTo-Json -Depth 4 -Compress -InputObject @($rows)) }
                foreach ($r in $rows) { $r | ConvertTo-Json -Compress }
                return
            }
            if ($sub -eq 'up') {
                if ($fixture.ComposeUpFails) { $global:LASTEXITCODE = 1; return 'Error response from daemon: Bind for 0.0.0.0:443 failed: port is already allocated' }
                foreach ($e in $fixture.Stack) { if ($e.Project -eq 'local-ai' -and $e.Name -notmatch '-pre-' -and $e.Service -ne 'sandbox-certs') { $e.State = 'running' } }
                return 'Container local-ai-n8n  Started'
            }
            throw "Unexpected docker compose command: $($Arguments -join ' ')"
        }
        'ps' {
            if ($fixture.PsFails) { throw 'error during connect: Docker Desktop is not running' }
            foreach ($c in $fixture.Containers) { [ordered]@{ ID = "id$($c.Name.Length)"; Names = $c.Name; State = $c.State; Status = 'whatever'; Labels = $c.Labels; CreatedAt = '2026-10-01 10:00:00 -0700 PDT' } | ConvertTo-Json -Compress }
            return
        }
        'update' {
            $c = Get-FixtureContainer $Arguments[-1]
            if (-not $c) { $global:LASTEXITCODE = 1; return }
            if ($Arguments -contains '--restart=no') { $c.Restart = 'no' }
            return $c.Name
        }
        'rm' {
            $c = Get-FixtureContainer $Arguments[-1]
            if (-not $c -or $fixture.RmFails -contains $c.Name -or $c.State -eq 'running') { $global:LASTEXITCODE = 1; return }
            [void]$fixture.Containers.Remove($c)
            return $c.Name
        }
        'inspect' {
            $c = Get-FixtureContainer $Arguments[1]
            if ($Arguments -contains '{{json .Config.Labels}}') {
                if (-not $c) { $global:LASTEXITCODE = 1; return "Error: No such object: $($Arguments[1])" }
                return (ConvertTo-Json -Compress -InputObject @{ 'com.docker.compose.project' = 'local-ai'; 'com.docker.compose.config-hash' = $fixture.ConfigHash })
            }
            if ($c) {
                $health = if ($c.Health) { @{ Status = $c.Health } } else { $null }
                return (ConvertTo-Json -Depth 8 -InputObject @([ordered]@{ Id = "id-$($c.Name)"; Name = "/$($c.Name)"; Created = $c.Created; State = [ordered]@{ Status = $c.State; Running = ($c.State -eq 'running'); FinishedAt = $c.FinishedAt; Health = $health }; HostConfig = @{ RestartPolicy = @{ Name = $c.Restart; MaximumRetryCount = 0 } } }))
            }
            if ($fixture.Containers.Count -and $Arguments[1] -ne 'fixture-appliance') { $global:LASTEXITCODE = 1; return }
            return @([ordered]@{Image='sha256:existing-image';State=@{Running=$fixture.Running};Config=@{Env=@('DATA_DIR=/data')};Mounts=@(@{Destination='/app'},@{Destination='/data'})}) | ConvertTo-Json -Depth 8 -Compress }
        'exec' {
            if ($fixture.ExecFails) { $global:LASTEXITCODE = 1; return }
            $command = $Arguments[-1]
            if ($command -like 'ls -1t /data/backups/*') { return @($fixture.DataBackups) }
            if ($command -match '^cd /data/backups && rm -f -- (.+)$') { foreach ($name in ($Matches[1] -split ' ')) { [void]$fixture.DataBackups.Remove($name) }; return }
            throw "Unexpected docker exec: $command"
        }
        'stop' { $fixture.Running=$false; return }
        'start' {
            $e = Get-FixtureStackEntry $Arguments[1]
            if ($e) { $e.State = 'running'; return $e.Name }
            $fixture.Running=$true; return
        }
        'run' {
            if ($Arguments -contains 'preflight' -and $fixture.PreflightFailure) { $global:LASTEXITCODE=1 }
            if ($Arguments -contains 'downgrade-json' -and $fixture.ExportFailure) { $global:LASTEXITCODE=1 }
            return
        }
        default { throw "Unexpected docker command: $($Arguments -join ' ')" }
    }
}
function git {
    $Arguments = [string[]]$args
    $global:LASTEXITCODE=0
    if ($Arguments -contains 'rev-parse') { return $newSha }
    if ($Arguments -contains 'rev-list') { return [string]$fixture.Ahead }
    if ($Arguments -contains 'status') { return $fixture.Dirty }
    if ($Arguments -contains 'checkout' -or $Arguments -contains 'pull') { $fixture.Calls.Add(@('git') + $Arguments) }
    if ($Arguments -contains 'archive') {
        $output = $Arguments[[Array]::IndexOf($Arguments,'-o')+1]
        Set-Content -LiteralPath $output -Value 'fixture archive'
    }
}
function tar {
    $Arguments = [string[]]$args
    $destination = $Arguments[[Array]::IndexOf($Arguments,'-C')+1]
    foreach ($dir in @('app','deploy','tests','docs','host')) { if (Test-Path -LiteralPath (Join-Path $fixture.Repo $dir)) { Copy-Item -LiteralPath (Join-Path $fixture.Repo $dir) -Destination $destination -Recurse } }
    $global:LASTEXITCODE=0
}
function robocopy {
    $Arguments = [string[]]$args
    foreach ($item in Get-ChildItem -LiteralPath $Arguments[0] -Force) { Copy-Item -LiteralPath $item.FullName -Destination $Arguments[1] -Recurse -Force }
    $global:LASTEXITCODE=1
}
function Start-Sleep { param([int]$Seconds) }
function Get-ScheduledTask { param($TaskName, $ErrorAction) return $null }
function Invoke-RestMethod {
    param($Uri, $TimeoutSec, $Method, $ContentType, $Body, $ErrorAction)
    if ("$Uri" -like '*/api/busy') { $fixture.BusyAsked++; if ($fixture.BusyFails) { throw 'Unable to connect to the remote server' }; return $fixture.Busy }
    if ("$Uri" -like '*/api/notifications/system') { $fixture.Notices.Add(([System.Text.Encoding]::UTF8.GetString($Body) | ConvertFrom-Json)); return }
    $commit = Read-LocalAI-ReleaseCommit $fixture.Live
    $status = if ($fixture.RejectAllHealth -or ($fixture.RejectNewRelease -and $commit -eq $newSha)) { 'error' } else { 'ok' }
    return [pscustomobject]@{status=$status;releaseCommit=$commit;storage=[pscustomobject]@{engine=$(if(Test-Path -LiteralPath (Join-Path $fixture.Live 'storage.js')){'sqlite'}else{'json'});schemaVersion=1}}
}
function Invoke-FixtureDeploy([switch]$CheckOnly) {
    & (Join-Path $repository 'deploy/Deploy-LocalAI.ps1') -Repo $fixture.Repo -Live $fixture.Live -Releases $fixture.Releases -StateDir $fixture.StateDir -Container 'fixture-appliance' -HealthUrl 'http://fixture/healthz' -SkipFetch -CheckOnly:$CheckOnly -PowerShellHost (Join-Path $fixture.Root 'powershell-bridge')
}
# The auto-deploy's child Windows PowerShell running Deploy-LocalAI.ps1.
function powershell.exe {
    $fixture.Calls.Add(@('auto-deploy') + [string[]]$args)
    $global:LASTEXITCODE = 0
    if ($fixture.DeployFails) { $global:LASTEXITCODE = 1; return 'Candidate health check failed; rolled back to the previous release' }
    if ($fixture.NoChange) { return "NO CHANGE: $($newSha.Substring(0,12)) is running and healthy." }
    Write-LocalAI-DeployState (Join-Path $fixture.Live 'release.json') ([ordered]@{commit=$newSha;version='2.0.1';notes=@()})
    "DEPLOYED: $newSha"
}
function Invoke-FixtureAutoDeploy([int]$MaxHoldMinutes = 45) {
    & (Join-Path $repository 'deploy/Run-LocalAI-AutoDeploy.ps1') -Repo $fixture.Repo -Live $fixture.Live -StateDir $fixture.StateDir -Releases $fixture.Releases -NotifyUrl 'http://fixture/api/notifications/system' -BusyUrl 'http://fixture/api/busy' -HealthUrl 'http://fixture/healthz' -MaxHoldMinutes $MaxHoldMinutes -StackEnvFile $fixture.StackEnv -StackCompose $fixture.StackCompose
}
function Get-AutoDeployCount { @($fixture.Calls | Where-Object { $_[0] -eq 'auto-deploy' }).Count }
function Invoke-FixtureRollback([string]$Snapshot) {
    & (Join-Path $repository 'deploy/Rollback-LocalAI.ps1') -Snapshot $Snapshot -Live $fixture.Live -StateDir $fixture.StateDir -Container 'fixture-appliance' -HealthUrl 'http://fixture/healthz'
}

try {
    Test-Case 'health rejects error/empty JSON, missing storage and the wrong release identity' {
        Assert-True (-not (Test-LocalAI-HealthPayload @{status='error'})) 'Error JSON accepted'
        Assert-True (-not (Test-LocalAI-HealthPayload @{})) 'Empty JSON accepted'
        Assert-True (-not (Test-LocalAI-HealthPayload @{status='ok'} -RequireSqlite)) 'Missing SQLite accepted'
        $healthy = @{status='ok';storage=@{engine='sqlite';schemaVersion=1};releaseCommit=$newSha}
        Assert-True (Test-LocalAI-HealthPayload $healthy -RequireSqlite -ExpectedCommit $newSha) 'Valid health rejected'
        Assert-True (-not (Test-LocalAI-HealthPayload $healthy -ExpectedCommit $oldSha)) 'Wrong SHA accepted'
    }
    Test-Case 'state replacement is complete and locks prevent concurrent deployment' {
        $f = New-Fixture
        $path = Join-Path $f.StateDir 'state.json'
        Write-LocalAI-DeployState $path @{status='ROLLED_BACK';currentCommit=$oldSha}
        Assert-True ((Read-LocalAI-DeployState $path).status -eq 'ROLLED_BACK') 'State replacement failed'
        $lock = Enter-LocalAI-DeployLock $f.StateDir
        Assert-Throws { Enter-LocalAI-DeployLock $f.StateDir } 'exist|used|another|already'
        Remove-Item -LiteralPath $lock
        # A lock left by a process that no longer exists is reclaimed; a live owner's lock is not.
        $dead = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList '-NoProfile','-Command','exit' -PassThru
        $dead.WaitForExit()
        [System.IO.File]::WriteAllText((Join-Path $f.StateDir 'deploy.lock'), "$($dead.Id) $((Get-Date).AddMinutes(-40).ToString('o'))")
        $lock = Enter-LocalAI-DeployLock $f.StateDir
        Assert-True ((Get-Content -LiteralPath $lock -Raw) -like "$PID *") 'Stale lock was not reclaimed'
        Remove-Item -LiteralPath $lock
        [System.IO.File]::WriteAllText((Join-Path $f.StateDir 'deploy.lock'), 'garbage')
        $lock = Enter-LocalAI-DeployLock $f.StateDir
        Remove-Item -LiteralPath $lock
        Set-Content -LiteralPath $path -Value '[]'
        Assert-Throws { Read-LocalAI-DeployState $path } 'Expected a JSON object'
    }
    Test-Case 'runtime check supports stopped containers and candidate volumes are read-only' {
        $f = New-Fixture; $f.Running=$false
        Test-LocalAI-StorageRuntime 'fixture-appliance'
        Test-LocalAI-StorageCandidate 'fixture-appliance' (Join-Path $f.Repo 'app')
        $runs = @($f.Calls | Where-Object { $_[0] -eq 'run' })
        Assert-True ($runs.Count -eq 2) 'Expected isolated runtime and data workers'
        Assert-True ($runs[0] -contains 'sha256:existing-image') 'Worker image was not pinned'
        Assert-True ($runs[1] -contains 'fixture-appliance:ro') 'Data source is writable'
        Assert-True (($runs[1] -join ' ') -match '/candidate,readonly') 'Candidate source is writable'
        Assert-True ($runs[1] -contains 'none') 'Worker has network access'
    }
    Test-Case 'unmounted data and data inside the replaceable application are rejected' {
        Assert-Throws { Get-LocalAI-DataDirectory ([pscustomobject]@{Config=@{Env=@('DATA_DIR=/app/data')};Mounts=@(@{Destination='/app'})}) } 'outside /app'
        Assert-Throws { Get-LocalAI-DataDirectory ([pscustomobject]@{Config=@{Env=@('DATA_DIR=/data')};Mounts=@(@{Destination='/app'})}) } 'not backed'
    }
    Test-Case 'validation-only data failure does not stop or replace the appliance' {
        $f = New-Fixture; $f.PreflightFailure=$true
        Assert-Throws { Invoke-FixtureDeploy -CheckOnly } 'preflight failed'
        Assert-True (-not (@($f.Calls | Where-Object { $_[0] -eq 'stop' }).Count)) 'Appliance was stopped'
        Assert-True ((Get-Content -LiteralPath (Join-Path $f.Live 'server.js') -Raw) -match 'legacy source') 'Live code changed'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $f.StateDir 'deploy.lock'))) 'Lock was left behind'
    }
    Test-Case 'promotion records the exact release and rollback SHA after certification' {
        $f = New-Fixture; Invoke-FixtureDeploy
        $state = Read-LocalAI-DeployState (Join-Path $f.StateDir 'state.json')
        Assert-True ($state.currentCommit -eq $newSha -and $state.status -eq 'HEALTHY') 'Deployment state is wrong'
        Assert-True ((Read-LocalAI-ReleaseCommit $f.Live) -eq $newSha) 'Runtime manifest is wrong'
        Assert-True ($state.rollbackSnapshotCommit -eq $oldSha) 'Rollback identity missing'
        Assert-True ($f.Running) 'Container did not restart'
        Assert-True (@($f.Calls | Where-Object { $_ -contains 'preflight' }).Count -eq 2) 'Stopped-data recheck was omitted'
        # Missions read docs/ and host/ from inside the app tree (app/mission-evidence.js).
        Assert-True ((Test-Path -LiteralPath (Join-Path $f.Live 'repo-context/docs/GRIDCRAFT.md')) -and (Test-Path -LiteralPath (Join-Path $f.Live 'repo-context/host/gridcraft-bridge.py'))) 'Docs and host scripts did not ship with the app'
    }
    Test-Case 'a healthy deploy updates the installed PowerShell host script, a failed one and an uninstalled host do not' {
        $f = New-Fixture
        [System.IO.Directory]::CreateDirectory((Join-Path $f.Repo 'host/powershell-bridge')) | Out-Null
        Set-Content -LiteralPath (Join-Path $f.Repo 'host/powershell-bridge/Run-LocalAI-PowerShellHost.ps1') -Value 'new host'
        Invoke-FixtureDeploy
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $f.Root 'powershell-bridge'))) 'Deploy installed a host that was never enabled'
        $f = New-Fixture; $f.RejectNewRelease=$true
        [System.IO.Directory]::CreateDirectory((Join-Path $f.Repo 'host/powershell-bridge')) | Out-Null
        Set-Content -LiteralPath (Join-Path $f.Repo 'host/powershell-bridge/Run-LocalAI-PowerShellHost.ps1') -Value 'new host'
        $installed = Join-Path $f.Root 'powershell-bridge/Run-LocalAI-PowerShellHost.ps1'
        [System.IO.Directory]::CreateDirectory((Split-Path $installed)) | Out-Null
        Set-Content -LiteralPath $installed -Value 'old host'
        Assert-Throws { Invoke-FixtureDeploy } 'previous live application restored'
        Assert-True ((Get-Content -LiteralPath $installed -Raw) -match 'old host') 'A rolled-back deploy changed the host script'
        $f.RejectNewRelease=$false
        Invoke-FixtureDeploy
        Assert-True ((Get-Content -LiteralPath $installed -Raw) -match 'new host') 'Host script was not updated'
        Assert-True (-not (Test-Path -LiteralPath "$installed.next")) 'Temporary copy left behind'
    }
    Test-Case 'failed candidate health restores old code and exports SQLite before JSON rollback' {
        $f = New-Fixture; $f.RejectNewRelease=$true
        Assert-Throws { Invoke-FixtureDeploy } 'previous live application restored'
        $state = Read-LocalAI-DeployState (Join-Path $f.StateDir 'state.json')
        Assert-True ($state.status -eq 'ROLLED_BACK' -and $state.currentCommit -eq $oldSha) 'Rollback state is stale'
        Assert-True (@($f.Calls | Where-Object { $_ -contains 'downgrade-json' }).Count -eq 1) 'JSON recovery omitted current state'
        Assert-True ((Get-Content -LiteralPath (Join-Path $f.Live 'server.js') -Raw) -match 'legacy source') 'Old code was not restored'
    }
    Test-Case 'failed data export records recovery required and does not start older code' {
        $f = New-Fixture; $f.RejectNewRelease=$true; $f.ExportFailure=$true
        Assert-Throws { Invoke-FixtureDeploy } 'Automatic recovery failed'
        $state = Read-LocalAI-DeployState (Join-Path $f.StateDir 'state.json')
        Assert-True ($state.status -eq 'RECOVERY_REQUIRED' -and -not $state.currentCommit) 'False current SHA reported'
        Assert-True (-not $f.Running) 'Unsafe application was started'
        Assert-True ((Get-Content -LiteralPath (Join-Path $f.Live 'server.js') -Raw) -match 'candidate source') 'Older code copied despite export failure'
    }
    Test-Case 'failed recovery health leaves the appliance stopped with no claimed release' {
        $f = New-Fixture; $f.RejectAllHealth=$true
        Assert-Throws { Invoke-FixtureDeploy } 'Automatic recovery failed'
        $state = Read-LocalAI-DeployState (Join-Path $f.StateDir 'state.json')
        Assert-True ($state.status -eq 'RECOVERY_REQUIRED' -and -not $state.currentCommit) 'Unhealthy restoration reported a current release'
        Assert-True (-not $f.Running) 'Unhealthy restoration remained running'
    }
    Test-Case 'matching healthy releases skip promotion but stale manifests trigger repair' {
        $f = New-Fixture; Invoke-FixtureDeploy
        $stops = @($f.Calls | Where-Object { $_[0] -eq 'stop' }).Count
        Invoke-FixtureDeploy
        Assert-True (@($f.Calls | Where-Object { $_[0] -eq 'stop' }).Count -eq $stops) 'Healthy matching release was restarted'
        Remove-Item -LiteralPath (Join-Path $f.Live 'release.json')
        Invoke-FixtureDeploy
        Assert-True (@($f.Calls | Where-Object { $_[0] -eq 'stop' }).Count -gt $stops) 'Stale runtime identity was skipped'
        Assert-True ((Read-LocalAI-ReleaseCommit $f.Live) -eq $newSha) 'Release identity was not repaired'
    }
    Test-Case 'manual legacy rollback updates state so the next deploy cannot falsely skip' {
        $f = New-Fixture; Invoke-FixtureDeploy
        Invoke-FixtureRollback
        $state = Read-LocalAI-DeployState (Join-Path $f.StateDir 'state.json')
        Assert-True ($state.currentCommit -eq $oldSha -and $state.status -eq 'ROLLED_BACK') 'Manual rollback left the deployed SHA stale'
        Invoke-FixtureDeploy
        Assert-True ((Read-LocalAI-ReleaseCommit $f.Live) -eq $newSha) 'Next deployment falsely skipped'
    }
    Test-Case 'custom legacy snapshot is reported as unknown rather than inventing a commit' {
        $f = New-Fixture
        $snapshot = Join-Path $f.Root 'custom'
        [System.IO.Directory]::CreateDirectory($snapshot) | Out-Null
        Set-Content -LiteralPath (Join-Path $snapshot 'server.js') -Value 'custom legacy source'
        Invoke-FixtureRollback $snapshot
        Assert-True (-not (Read-LocalAI-DeployState (Join-Path $f.StateDir 'state.json')).currentCommit) 'Unknown SHA invented'
    }
    Test-Case 'status rejects unhealthy responses and reports runtime/state identity disagreement' {
        $f = New-Fixture
        Write-LocalAI-DeployState (Join-Path $f.Live 'release.json') @{commit=$newSha}
        $report = & (Join-Path $repository 'deploy/Get-LocalAI-DeployStatus.ps1') -Repo $f.Repo -StatePath (Join-Path $f.StateDir 'state.json') -AsJson | ConvertFrom-Json
        Assert-True ($report.currentCommit -eq $newSha -and $report.deploymentIdentityMismatch) 'Runtime disagreement was hidden'
        $f.RejectAllHealth=$true
        $report = & (Join-Path $repository 'deploy/Get-LocalAI-DeployStatus.ps1') -Repo $f.Repo -StatePath (Join-Path $f.StateDir 'state.json') -AsJson | ConvertFrom-Json
        Assert-True ($report.health -eq 'UNHEALTHY') 'Error JSON reported healthy'
    }
    Test-Case 'auto-deploy runs the release branch, never main, and says once when main has unshipped commits' {
        $f = New-Fixture
        $f.Ahead = 2
        Invoke-FixtureAutoDeploy | Out-Null
        $deploy = @($f.Calls | Where-Object { $_[0] -eq 'auto-deploy' })[0]
        Assert-True ($deploy[[Array]::IndexOf($deploy, '-TargetRef') + 1] -eq 'origin/release') "Deployed $($deploy -join ' ')"
        $git = @($f.Calls | Where-Object { $_[0] -eq 'git' })
        Assert-True (@($git | Where-Object { ($_ -join ' ') -match 'checkout -q -B release origin/release' }).Count -gt 0) "Checkout not moved to release: $(($git | % { $_ -join ' ' }) -join '; ')"
        Assert-True (-not @($git | Where-Object { $_ -contains 'pull' }).Count) 'Pulled main into the checkout'
        $held = @($f.Notices | Where-Object { $_.meta.outcome -eq 'held' })
        Assert-True ($held.Count -eq 1 -and $held[0].title -eq '2 commits on main not deployed yet') "Unexpected notices: $($f.Notices | ConvertTo-Json -Compress)"
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True (@($f.Notices | Where-Object { $_.meta.outcome -eq 'held' }).Count -eq 1) 'Told twice about the same main commit'
        $f.Ahead = 0
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $f.StateDir 'auto-deploy-unreleased.txt'))) 'Unreleased note left behind'
        $f2 = New-Fixture; $f2.Dirty = ' M deploy/x.ps1'
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True (-not @($f2.Calls | Where-Object { $_[0] -eq 'git' -and $_ -contains 'checkout' }).Count) 'Moved a dirty checkout'
    }
    Test-Case 'auto-deploy does not retry a commit that already failed, but still deploys a new one' {
        $f = New-Fixture
        $f.DeployFails = $true
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True ($LASTEXITCODE -eq 1 -and (Get-AutoDeployCount) -eq 1) 'The failed deploy did not run once with a failing exit code'
        Assert-True (@($f.Notices | Where-Object { $_.meta.outcome -eq 'failed' }).Count -eq 1) 'No failure notice'
        # Same commit on the next polls: no deploy, no new notice, exit 0.
        $said = Invoke-FixtureAutoDeploy
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True ($LASTEXITCODE -eq 0 -and (Get-AutoDeployCount) -eq 1) "Retried the failed commit ($(Get-AutoDeployCount) deploys)"
        Assert-True ("$said" -match "Skipping $($newSha.Substring(0,12)): failed before; waiting for a new release") "Skip not reported: $said"
        Assert-True (@($f.Notices | Where-Object { $_.meta.outcome -eq 'failed' }).Count -eq 1) 'Notified again for the same failure'
        Assert-True ((Get-Content -LiteralPath (Join-Path $f.StateDir 'auto-deploy.log') -Raw) -match 'Skipping .* failed before') 'Skip not logged'
        # A different release commit deploys, and a success clears the state.
        $originalSha = $script:newSha
        $script:newSha = 'cccccccccccccccccccccccccccccccccccccccc'
        $f.DeployFails = $false
        try { Invoke-FixtureAutoDeploy | Out-Null } finally { $script:newSha = $originalSha }
        Assert-True ((Get-AutoDeployCount) -eq 2 -and $LASTEXITCODE -eq 0) 'A new release commit did not deploy'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $f.StateDir 'auto-deploy-last-failure.txt'))) 'Failure state kept after a successful deploy'
    }
    Test-Case 'auto-deploy waits while the appliance is busy and records when the hold began' {
        $f = New-Fixture
        $f.Busy = [pscustomobject]@{ busy = $true; since = '2026-10-17T10:00:00.000Z'; active = @([pscustomobject]@{ kind = 'agent'; title = 'Review the Work page'; startedAt = '2026-10-17T10:00:00.000Z' }, [pscustomobject]@{ kind = 'image'; title = 'A {lighthouse} at dusk'; startedAt = '2026-10-17T10:02:00.000Z' }) }
        $said = Invoke-FixtureAutoDeploy
        Assert-True ((Get-AutoDeployCount) -eq 0) 'Deployed while work was running'
        Assert-True ("$said" -match 'Waiting: 2 things running \(Review the Work page; A \{lighthouse\} at dusk\)') "Unexpected output: $said"
        $hold = Join-Path $f.StateDir 'auto-deploy-held-since.txt'
        Assert-True (Test-Path -LiteralPath $hold) 'Hold start was not recorded'
        $first = Get-Content -LiteralPath $hold -Raw
        $log = Get-Content -LiteralPath (Join-Path $f.StateDir 'auto-deploy.log') -Raw
        Assert-True ($log -match 'exit=0 aaaaaaaaaaaa Waiting: 2 things running') "Wait not logged: $log"
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True ((Get-AutoDeployCount) -eq 0) 'Deployed on the second busy run'
        Assert-True ((Get-Content -LiteralPath $hold -Raw) -eq $first) 'The hold start moved, so the limit would never be reached'
        Assert-True ($f.Notices.Count -eq 0) 'Waiting sent a notice'
        $f.Busy = [pscustomobject]@{ busy = $false; since = $null; active = @() }
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True ((Get-AutoDeployCount) -eq 1) 'Did not deploy once idle'
        Assert-True (-not (Test-Path -LiteralPath $hold)) 'Hold state was left behind'
        Assert-True (-not @($f.Notices | Where-Object { $_.meta.outcome -eq 'forced' }).Count) 'An idle deploy said it stopped work'
    }
    Test-Case 'auto-deploy goes ahead after the hold limit and tells the owner what it stopped' {
        $f = New-Fixture
        $f.Busy = [pscustomobject]@{ busy = $true; active = @([pscustomobject]@{ kind = 'agent'; title = 'Review the Work page' }, [pscustomobject]@{ kind = 'chat'; title = 'Plan the week' }) }
        Set-Content -LiteralPath (Join-Path $f.StateDir 'auto-deploy-held-since.txt') -Value (Get-Date).ToUniversalTime().AddMinutes(-46).ToString('o')
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True ((Get-AutoDeployCount) -eq 1) 'Did not deploy after the limit'
        $forced = @($f.Notices | Where-Object { $_.meta.outcome -eq 'forced' })
        Assert-True ($forced.Count -eq 1 -and $forced[0].title -eq 'Updating now; 2 things were still running and were stopped') "Unexpected notice: $($f.Notices | ConvertTo-Json -Compress -Depth 4)"
        Assert-True ($forced[0].kind -eq 'deploy' -and $forced[0].detail -match 'Review the Work page; Plan the week') 'The notice does not say what stopped'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $f.StateDir 'auto-deploy-held-since.txt'))) 'Hold state was left behind'
        # A shorter limit set on the task applies too.
        $g = New-Fixture
        $g.Busy = $f.Busy
        Set-Content -LiteralPath (Join-Path $g.StateDir 'auto-deploy-held-since.txt') -Value (Get-Date).ToUniversalTime().AddMinutes(-11).ToString('o')
        $script:fixture = $g
        Invoke-FixtureAutoDeploy -MaxHoldMinutes 10 | Out-Null
        Assert-True ((Get-AutoDeployCount) -eq 1) 'MaxHoldMinutes was ignored'
    }
    Test-Case 'auto-deploy deploys as before when /api/busy does not answer, and does not ask when nothing is new' {
        $f = New-Fixture; $f.BusyFails = $true
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True ($f.BusyAsked -eq 1 -and (Get-AutoDeployCount) -eq 1) 'An appliance that cannot answer blocked the deploy'
        $f = New-Fixture; $f.Busy = '<!doctype html><title>Local AI</title>'
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True ((Get-AutoDeployCount) -eq 1) 'A build without /api/busy blocked the deploy'
        $f = New-Fixture; $f.Busy = [pscustomobject]@{ busy = $true; active = @([pscustomobject]@{ title = 'Running' }) }
        Write-LocalAI-DeployState (Join-Path $f.StateDir 'state.json') ([ordered]@{status='HEALTHY';currentCommit=$newSha})
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True ($f.BusyAsked -eq 0) 'Asked /api/busy with nothing new to deploy'
        Assert-True ((Get-AutoDeployCount) -eq 1) 'The idle deploy check did not run'
    }
    Test-Case 'backup tidy removes only old stopped migration backups whose live twin is healthy' {
        $f = New-Fixture
        New-FixtureContainer 'local-ai-n8n' 'running' -Health 'healthy'
        New-FixtureContainer 'local-ai-appliance' 'running'
        New-FixtureContainer 'local-ai-https-new' 'running' -Labels 'com.docker.compose.project=local-ai,com.docker.compose.service=https'
        New-FixtureContainer 'local-ai-sandbox-api' 'running' -Health 'unhealthy'
        New-FixtureContainer 'local-ai-searxng' 'running' -Health 'healthy'
        New-FixtureContainer 'local-ai-sandbox-runner-1' 'running' -Health 'healthy'
        New-FixtureContainer 'local-ai-ollama-responses-proxy' 'running'
        # Removed: stopped 10 days, healthy twin by name / by name without a healthcheck / by compose service.
        New-FixtureContainer 'local-ai-n8n-pre-compose' 'exited' 10
        New-FixtureContainer 'local-ai-appliance-pre-hostport' 'exited' 9
        New-FixtureContainer 'local-ai-https-pre-compose' 'created' -CreatedDaysAgo 20
        New-FixtureContainer 'local-ai-n8n-pre-lockdown' 'exited' 30
        # Kept: too recent; renamed recently although created long ago; twin unhealthy; running; no twin;
        # unknown suffix; not ours.
        New-FixtureContainer 'local-ai-searxng-pre-compose' 'exited' 3
        New-FixtureContainer 'local-ai-sandbox-runner-1-pre-compose' 'exited' 2 -CreatedDaysAgo 90
        New-FixtureContainer 'local-ai-sandbox-api-pre-lockdown' 'exited' 10
        New-FixtureContainer 'local-ai-ollama-responses-proxy-pre-compose' 'running' 10
        New-FixtureContainer 'local-ai-gone-pre-compose' 'exited' 40
        New-FixtureContainer 'local-ai-n8n-pre-upgrade' 'exited' 40
        New-FixtureContainer 'local-ai-n8n-pre-compose-old' 'exited' 40
        New-FixtureContainer 'festive_turing' 'exited' 60 -Restart 'no'
        New-FixtureContainer 'localai-agent-design-candidate' 'exited' 60
        $result = & (Join-Path $repository 'deploy/Remove-LocalAI-OldBackups.ps1')
        $removed = (@($result.Removed) | Sort-Object) -join ' '
        Assert-True ($removed -eq 'local-ai-appliance-pre-hostport local-ai-https-pre-compose local-ai-n8n-pre-compose local-ai-n8n-pre-lockdown') "Unexpected removals: $removed`n$($result.Log -join "`n")"
        $left = @($f.Containers | ForEach-Object { $_.Name })
        foreach ($kept in @('local-ai-searxng-pre-compose','local-ai-sandbox-runner-1-pre-compose','local-ai-sandbox-api-pre-lockdown','local-ai-ollama-responses-proxy-pre-compose','local-ai-gone-pre-compose','local-ai-n8n-pre-upgrade','local-ai-n8n-pre-compose-old','festive_turing','localai-agent-design-candidate','local-ai-n8n','local-ai-appliance')) {
            Assert-True ($left -contains $kept) "$kept was removed"
        }
        # Volumes are never touched: plain `docker rm <name>`, no -v/-f, no prune or volume/image commands.
        $rms = @($f.Calls | Where-Object { $_[0] -eq 'rm' })
        Assert-True ($rms.Count -eq 4) "Expected 4 docker rm calls, got $($rms.Count)"
        foreach ($rm in $rms) { Assert-True ($rm.Count -eq 2) "docker rm with options: $($rm -join ' ')" }
        Assert-True (-not @($f.Calls | Where-Object { ($_ -join ' ') -match '(^| )(-v|--volumes|-f|--force|prune|volume|image)( |$)' }).Count) 'A volume, prune, image or forced command was run'
        # --restart=no comes first, for each removal.
        foreach ($name in @($result.Removed)) {
            $calls = @($f.Calls | ForEach-Object { $_ -join ' ' })
            $update = [Array]::IndexOf($calls, "update --restart=no $name"); $rm = [Array]::IndexOf($calls, "rm $name")
            Assert-True ($update -ge 0 -and $update -lt $rm) "$name was not set to --restart=no before rm"
        }
        # Stopped backups that stay are stopped from restarting on a reboot; running ones and strangers are untouched.
        Assert-True ((Get-FixtureContainer 'local-ai-searxng-pre-compose').Restart -eq 'no') 'A kept stopped backup can still restart on a reboot'
        Assert-True ((Get-FixtureContainer 'local-ai-ollama-responses-proxy-pre-compose').Restart -eq 'unless-stopped') 'A running backup was changed'
        Assert-True ((Get-FixtureContainer 'localai-agent-design-candidate').Restart -eq 'unless-stopped') 'A container that is not ours was changed'
        Assert-True (@($result.Log | Where-Object { $_ -like 'Removed old backup container local-ai-n8n-pre-compose (stopped 10 days; local-ai-n8n is running and healthy; volumes kept)' }).Count -eq 1) "Removal not logged: $($result.Log -join '; ')"
        # Idempotent: a second run removes and changes nothing.
        $before = $f.Calls.Count
        $again = & (Join-Path $repository 'deploy/Remove-LocalAI-OldBackups.ps1')
        Assert-True (@($again.Removed).Count -eq 0 -and @($again.Log).Count -eq 0) "Second run did something: $($again.Log -join '; ')"
        Assert-True (-not @($f.Calls | Select-Object -Skip $before | Where-Object { $_[0] -in @('rm','update') }).Count) 'Second run changed containers'
    }
    Test-Case 'backup tidy failures are logged, never thrown' {
        $f = New-Fixture; $f.PsFails = $true
        $result = & (Join-Path $repository 'deploy/Remove-LocalAI-OldBackups.ps1')
        Assert-True (@($result.Removed).Count -eq 0 -and "$($result.Log)" -match 'Backup tidy skipped: .*Docker Desktop is not running') "Unexpected: $($result.Log)"
        $f = New-Fixture
        New-FixtureContainer 'local-ai-n8n' 'running' -Health 'healthy'
        New-FixtureContainer 'local-ai-appliance' 'running' -Health 'healthy'
        New-FixtureContainer 'local-ai-n8n-pre-compose' 'exited' 10
        New-FixtureContainer 'local-ai-appliance-pre-hostport' 'exited' 10
        $f.RmFails = @('local-ai-n8n-pre-compose')
        $result = & (Join-Path $repository 'deploy/Remove-LocalAI-OldBackups.ps1')
        Assert-True ((@($result.Removed) -join ' ') -eq 'local-ai-appliance-pre-hostport') "One failure stopped the rest: $($result.Removed)"
        Assert-True ("$($result.Log)" -match 'Kept local-ai-n8n-pre-compose: docker rm failed') "rm failure not logged: $($result.Log)"
        # The auto-deploy still succeeds when the tidy fails.
        $f = New-Fixture; $f.PsFails = $true
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True ($LASTEXITCODE -eq 0 -and (Get-AutoDeployCount) -eq 1) 'A tidy failure failed the deploy'
        Assert-True ((Get-Content -LiteralPath (Join-Path $f.StateDir 'auto-deploy.log') -Raw) -match 'tidy: Backup tidy skipped') 'Tidy failure not logged'
    }
    Test-Case 'auto-deploy tidies backups after a healthy deploy or a healthy quiet run, and tells the Inbox once' {
        $f = New-Fixture
        New-FixtureContainer 'local-ai-n8n' 'running' -Health 'healthy'
        New-FixtureContainer 'local-ai-appliance' 'running' -Health 'healthy'
        New-FixtureContainer 'local-ai-n8n-pre-compose' 'exited' 10
        New-FixtureContainer 'local-ai-appliance-pre-hostport' 'exited' 10
        # Quiet run, appliance unhealthy: nothing is touched.
        $f.NoChange = $true; $f.RejectAllHealth = $true
        Write-LocalAI-DeployState (Join-Path $f.StateDir 'state.json') ([ordered]@{status='HEALTHY';currentCommit=$newSha})
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True (-not @($f.Calls | Where-Object { $_[0] -in @('ps','update','rm') }).Count) 'Tidied while /healthz was not OK'
        # Quiet run, healthy: both go, one notice.
        $f.RejectAllHealth = $false
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True (@($f.Containers | Where-Object { $_.Name -like '*-pre-*' }).Count -eq 0) 'Backups were not removed on a healthy quiet run'
        $tidied = @($f.Notices | Where-Object { $_.meta.action -eq 'tidy-backups' })
        Assert-True ($tidied.Count -eq 1 -and $tidied[0].title -eq 'Removed 2 old backup containers (stopped copies from earlier migrations)' -and $tidied[0].kind -eq 'deploy' -and $tidied[0].meta.outcome -eq 'done') "Unexpected notices: $($f.Notices | ConvertTo-Json -Compress -Depth 4)"
        $log = Get-Content -LiteralPath (Join-Path $f.StateDir 'auto-deploy.log') -Encoding UTF8
        Assert-True (@($log | Where-Object { $_ -match '^\d{4}-\d\d-\d\dT\S+ tidy: Removed old backup container local-ai-(n8n-pre-compose|appliance-pre-hostport) ' }).Count -eq 2) "Removals not in the log: $($log -join "`n")"
        Assert-True ($log -contains '--- last run ---') 'The log lost its last-run section'
        # Next run: nothing left, no notice.
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True (@($f.Notices | Where-Object { $_.meta.action -eq 'tidy-backups' }).Count -eq 1) 'A run with nothing to tidy sent a notice'
        # After a healthy deploy too.
        $g = New-Fixture; $script:fixture = $g
        New-FixtureContainer 'local-ai-n8n' 'running' -Health 'healthy'
        New-FixtureContainer 'local-ai-n8n-pre-lockdown' 'exited' 8
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True ((Get-AutoDeployCount) -eq 1 -and -not (Get-FixtureContainer 'local-ai-n8n-pre-lockdown')) 'No tidy after a healthy deploy'
        Assert-True (@($g.Notices | Where-Object { $_.title -eq 'Removed 1 old backup container (a stopped copy from an earlier migration)' }).Count -eq 1) 'Singular notice missing'
    }
    Test-Case 'history prune keeps the newest releases, snapshots and data backups plus every rollback target' {
        $f = New-Fixture
        $base = (Get-Date).AddDays(-1)
        foreach ($n in 1..14) {
            $r = New-Item -ItemType Directory -Force -Path (Join-Path $f.Releases ('{0:d40}' -f $n))
            $r.LastWriteTime = $base.AddMinutes($n)
            $s = New-Item -ItemType Directory -Force -Path (Join-Path $f.StateDir ('live-before-{0:d32}' -f $n))
            $s.LastWriteTime = $base.AddMinutes($n)
        }
        foreach ($n in 14..1) { $f.DataBackups.Add(('before-deploy-{0:d32}.db' -f $n)) }
        $f.DataBackups.Add('nightly.db'); $f.DataBackups.Add('before-deploy-x;rm -rf .db')
        New-Item -ItemType Directory -Force -Path (Join-Path $f.Releases 'not-a-sha') | Out-Null
        # Oldest ones are the rollback targets: they must survive.
        Write-LocalAI-DeployState (Join-Path $f.StateDir 'state.json') ([ordered]@{
            status = 'HEALTHY'; currentCommit = ('{0:d40}' -f 14); previousCommit = ('{0:d40}' -f 1); rollbackSnapshotCommit = ('{0:d40}' -f 1)
            rollbackSnapshot = (Join-Path $f.StateDir ('live-before-{0:d32}' -f 2)); dataBackupName = ('before-deploy-{0:d32}.db' -f 3)
        })
        Write-LocalAI-DeployState (Join-Path $f.Live 'release.json') ([ordered]@{ commit = ('{0:d40}' -f 2) })
        $result = & (Join-Path $repository 'deploy/Remove-LocalAI-DeployHistory.ps1') -KeepCount 10 -Releases $f.Releases -StateDir $f.StateDir -Live $f.Live -Container 'fixture-appliance'
        $releases = @(Get-ChildItem -LiteralPath $f.Releases -Directory | ForEach-Object Name | Sort-Object)
        $expected = @(@(1, 2) + @(5..14) | ForEach-Object { '{0:d40}' -f $_ }) + 'not-a-sha' | Sort-Object
        Assert-True (($releases -join ',') -eq ($expected -join ',')) "Releases left: $($releases -join ', ')"
        $snapshots = @(Get-ChildItem -LiteralPath $f.StateDir -Directory -Filter 'live-before-*' | ForEach-Object Name | Sort-Object)
        $expected = @(@(2) + @(5..14) | ForEach-Object { 'live-before-{0:d32}' -f $_ }) | Sort-Object
        Assert-True (($snapshots -join ',') -eq ($expected -join ',')) "Snapshots left: $($snapshots -join ', ')"
        $backups = @($f.DataBackups | Sort-Object)
        $expected = @(@(3) + @(5..14) | ForEach-Object { 'before-deploy-{0:d32}.db' -f $_ }) + 'nightly.db' + 'before-deploy-x;rm -rf .db' | Sort-Object
        Assert-True (($backups -join ',') -eq ($expected -join ',')) "Data backups left: $($backups -join ', ')"
        Assert-True ($result.Removed.Releases -eq 2 -and $result.Removed.Snapshots -eq 3 -and $result.Removed.DataBackups -eq 3) "Unexpected counts: $($result.Removed | ConvertTo-Json -Compress)"
        Assert-True ("$($result.Log)" -match 'Removed 2 old releases, 3 app snapshots and 3 pre-deploy data backups') "Not logged: $($result.Log)"
        # Idempotent.
        $again = & (Join-Path $repository 'deploy/Remove-LocalAI-DeployHistory.ps1') -KeepCount 10 -Releases $f.Releases -StateDir $f.StateDir -Live $f.Live -Container 'fixture-appliance'
        Assert-True (($again.Removed.Releases + $again.Removed.Snapshots + $again.Removed.DataBackups) -eq 0 -and @($again.Log).Count -eq 0) "Second run did something: $($again.Log)"
    }
    Test-Case 'history prune does nothing during a deploy or when the deploy is not healthy, and never throws' {
        $f = New-Fixture
        foreach ($n in 1..12) { New-Item -ItemType Directory -Force -Path (Join-Path $f.Releases ('{0:d40}' -f $n)) | Out-Null }
        Set-Content -LiteralPath (Join-Path $f.StateDir 'deploy.lock') -Value 'held'
        $result = & (Join-Path $repository 'deploy/Remove-LocalAI-DeployHistory.ps1') -Releases $f.Releases -StateDir $f.StateDir -Live $f.Live -Container 'fixture-appliance'
        Assert-True ($result.Removed.Releases -eq 0 -and "$($result.Log)" -match 'holds the lock') "Pruned under the lock: $($result.Log)"
        Remove-Item -LiteralPath (Join-Path $f.StateDir 'deploy.lock')
        Write-LocalAI-DeployState (Join-Path $f.StateDir 'state.json') ([ordered]@{ status = 'ROLLED_BACK'; currentCommit = $oldSha })
        $result = & (Join-Path $repository 'deploy/Remove-LocalAI-DeployHistory.ps1') -Releases $f.Releases -StateDir $f.StateDir -Live $f.Live -Container 'fixture-appliance'
        Assert-True ($result.Removed.Releases -eq 0 -and "$($result.Log)" -match "'ROLLED_BACK', not HEALTHY") "Pruned after a rollback: $($result.Log)"
        Assert-True (@(Get-ChildItem -LiteralPath $f.Releases -Directory).Count -eq 12) 'Releases removed while not healthy'
        # Docker down: folders are still pruned, the data step is skipped with a log line.
        Write-LocalAI-DeployState (Join-Path $f.StateDir 'state.json') ([ordered]@{ status = 'HEALTHY'; currentCommit = $oldSha })
        $f.ExecFails = $true
        $result = & (Join-Path $repository 'deploy/Remove-LocalAI-DeployHistory.ps1') -Releases $f.Releases -StateDir $f.StateDir -Live $f.Live -Container 'fixture-appliance'
        Assert-True ($result.Removed.Releases -eq 2 -and "$($result.Log)" -match 'Data backup prune skipped') "Unexpected: $($result.Removed | ConvertTo-Json -Compress) $($result.Log)"
    }
    Test-Case 'auto-deploy prunes deploy history after a healthy deploy only, and logs it' {
        $f = New-Fixture
        foreach ($n in 1..12) { New-Item -ItemType Directory -Force -Path (Join-Path $f.Releases ('{0:d40}' -f $n)) | Out-Null }
        $f.NoChange = $true
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True (@(Get-ChildItem -LiteralPath $f.Releases -Directory).Count -eq 12) 'Pruned on a quiet run'
        $f.NoChange = $false
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True (@(Get-ChildItem -LiteralPath $f.Releases -Directory).Count -eq 10) 'Not pruned after a healthy deploy'
        $log = Get-Content -LiteralPath (Join-Path $f.StateDir 'auto-deploy.log') -Encoding UTF8
        Assert-True (@($log | Where-Object { $_ -match '^\d{4}-\d\d-\d\dT\S+ prune: Removed 2 old releases' }).Count -eq 1) "Prune not logged: $($log -join "`n")"
        Assert-True (-not @($f.Notices | Where-Object { $_.title -match 'prune|releases' }).Count) 'Routine prune sent an Inbox notice'
        $g = New-Fixture; $script:fixture = $g
        foreach ($n in 1..12) { New-Item -ItemType Directory -Force -Path (Join-Path $g.Releases ('{0:d40}' -f $n)) | Out-Null }
        $g.DeployFails = $true
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True (@(Get-ChildItem -LiteralPath $g.Releases -Directory).Count -eq 12) 'Pruned after a failed deploy'
    }
    Test-Case 'stack repair does nothing on a host without the compose stack or when every service runs' {
        $f = New-Fixture
        $result = Invoke-FixtureRepair
        Assert-True (@($result.Started).Count -eq 0 -and @($result.Log).Count -eq 0) "Non-compose host: $($result.Log -join '; ')"
        Assert-True (-not @($f.Calls | Where-Object { $_[0] -eq 'compose' }).Count) 'Ran docker compose on a host without the stack'
        # All running (the one-shot sandbox-certs exited 0 by design): no up, no start, no log.
        $f = New-Fixture; New-FixtureStack
        $result = Invoke-FixtureRepair
        Assert-True (@($result.Started).Count -eq 0 -and @($result.Log).Count -eq 0 -and $null -eq $result.Healthy) "All running: $($result.Log -join '; ')"
        Assert-True (-not @($f.Calls | Where-Object { $_[0] -eq 'start' -or ($_[0] -eq 'compose' -and $_ -contains 'up') }).Count) 'Started something while everything was running'
        # Through the auto-deploy: silent.
        $f.NoChange = $true
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True (-not @($f.Notices | Where-Object { $_.meta.action -eq 'repair-stack' }).Count) 'A run with nothing stopped sent a notice'
        Assert-True (-not ((Get-Content -LiteralPath (Join-Path $f.StateDir 'auto-deploy.log') -Raw) -match 'repair:')) 'A run with nothing stopped logged a repair'
    }
    Test-Case 'stack repair starts stopped services once with up -d --no-recreate and tells the Inbox' {
        foreach ($asArray in @($false, $true)) {
            $f = New-Fixture; $f.StackAsArray = $asArray
            New-FixtureStack @{ 'local-ai-https' = 'exited 137'; 'local-ai-n8n' = 'exited 143'; 'local-ai-searxng' = 'exited 0'; 'local-ai-ollama-responses-proxy' = 'exited 137'; 'local-ai-sandbox-api' = 'exited 2'; 'local-ai-sandbox-runner-1' = 'created' }
            $result = Invoke-FixtureRepair
            $ups = @($f.Calls | Where-Object { $_[0] -eq 'compose' -and $_ -contains 'up' })
            Assert-True ($ups.Count -eq 1 -and (($ups[0] | Select-Object -Skip 5) -join ' ') -eq 'up -d --no-recreate') "Expected one up -d --no-recreate (array=$asArray): $($ups | ForEach-Object { $_ -join ' ' })"
            Assert-True (-not @($f.Calls | Where-Object { $_[0] -in @('start','stop','restart','rm') }).Count) 'Touched containers outside docker compose up'
            Assert-True ((@($result.Started) | Sort-Object) -join ' ' -eq 'local-ai-https local-ai-n8n local-ai-ollama-responses-proxy local-ai-sandbox-api local-ai-sandbox-runner-1 local-ai-searxng') "Unexpected starts (array=$asArray): $($result.Started)"
            Assert-True ($result.Log -contains 'started local-ai-n8n (was Exited 143)' -and $result.Log -contains 'started local-ai-sandbox-runner-1 (was Created)') "Unexpected log: $($result.Log -join '; ')"
            Assert-True ($result.Healthy -eq $true -and $result.Log -contains 'appliance /healthz OK') 'Health not checked'
        }
        # Through the auto-deploy: one notice, filed as info, and one log line per service; the deploy still runs.
        $f = New-Fixture
        New-FixtureStack @{ 'local-ai-https' = 'exited 137'; 'local-ai-n8n' = 'exited 143'; 'local-ai-searxng' = 'exited 0'; 'local-ai-ollama-responses-proxy' = 'exited 137'; 'local-ai-sandbox-api' = 'exited 2'; 'local-ai-sandbox-runner-1' = 'created' }
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True ($LASTEXITCODE -eq 0 -and (Get-AutoDeployCount) -eq 1) 'The repair stopped the deploy'
        $notice = @($f.Notices | Where-Object { $_.meta.action -eq 'repair-stack' })
        Assert-True ($notice.Count -eq 1 -and $notice[0].title -eq 'Restarted 6 Local AI services that were stopped (probably by a Windows restart)' -and $notice[0].meta.outcome -eq 'done' -and $notice[0].detail -match 'local-ai-n8n') "Unexpected notices: $($f.Notices | ConvertTo-Json -Compress -Depth 4)"
        $log = Get-Content -LiteralPath (Join-Path $f.StateDir 'auto-deploy.log') -Encoding UTF8
        Assert-True (@($log | Where-Object { $_ -match '^\d{4}-\d\d-\d\dT\S+ repair: started local-ai-' }).Count -eq 6) "Starts not in the log: $($log -join "`n")"
        Assert-True (@($log | Where-Object { $_ -match ' repair: started local-ai-n8n \(was Exited 143\)$' }).Count -eq 1) 'n8n start not logged'
        # The repair runs before the deploy.
        $order = @($f.Calls | ForEach-Object { if ($_[0] -eq 'compose' -and $_ -contains 'up') { 'up' } elseif ($_[0] -eq 'auto-deploy') { 'deploy' } } | Where-Object { $_ })
        Assert-True (($order -join ' ') -eq 'up deploy') "Unexpected order: $($order -join ' ')"
        # Next run: nothing stopped, no second notice. A stopped appliance alone is also brought back (singular).
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True (@($f.Notices | Where-Object { $_.meta.action -eq 'repair-stack' }).Count -eq 1) 'A second run sent another notice'
        $g = New-Fixture; $script:fixture = $g
        New-FixtureStack @{ 'local-ai-appliance' = 'exited 137' }
        $g.NoChange = $true
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True (@($g.Notices | Where-Object { $_.title -eq 'Restarted 1 Local AI service that was stopped (probably by a Windows restart)' }).Count -eq 1) 'Singular notice missing'
    }
    Test-Case 'stack repair ignores *-pre-* backups and containers outside the compose project' {
        $f = New-Fixture; New-FixtureStack
        Add-FixtureStackEntry 'local-ai-n8n-pre-compose' 'n8n' 'exited 0'
        Add-FixtureStackEntry 'local-ai-appliance-pre-hostport' 'appliance' 'exited 137'
        Add-FixtureStackEntry 'localai-agent-design-candidate' 'app' 'exited 1' 'design'
        Add-FixtureStackEntry 'local-ai-searxng' 'searxng' 'exited 0' 'other-project'
        $result = Invoke-FixtureRepair
        Assert-True (@($result.Started).Count -eq 0 -and @($result.Log).Count -eq 0) "Acted on backups or strangers: $($result.Log -join '; ')"
        Assert-True (-not @($f.Calls | Where-Object { $_[0] -eq 'start' -or ($_[0] -eq 'compose' -and $_ -contains 'up') }).Count) 'Started a backup or a stranger'
        # With a backup carrying this project's labels, `up` could remove it as an extra replica: start by name instead.
        $f = New-Fixture
        New-FixtureStack @{ 'local-ai-n8n' = 'exited 143'; 'local-ai-https' = 'exited 137' }
        Add-FixtureStackEntry 'local-ai-appliance-pre-hostport' 'appliance' 'exited 137'
        $result = Invoke-FixtureRepair
        Assert-True (-not @($f.Calls | Where-Object { $_[0] -eq 'compose' -and $_ -contains 'up' }).Count) 'Ran docker compose up next to a labelled backup'
        $starts = @($f.Calls | Where-Object { $_[0] -eq 'start' } | ForEach-Object { $_[1] } | Sort-Object)
        Assert-True (($starts -join ' ') -eq 'local-ai-https local-ai-n8n') "Unexpected docker start calls: $($starts -join ' ')"
        Assert-True ((Get-FixtureStackEntry 'local-ai-appliance-pre-hostport').State -eq 'exited') 'A backup was started'
        Assert-True (@($result.Started).Count -eq 2) "Unexpected starts: $($result.Started)"
    }
    Test-Case 'stack repair logs docker failures and never throws out of the auto-deploy' {
        $f = New-Fixture; New-FixtureStack @{ 'local-ai-n8n' = 'exited 143' }; $f.ComposeFails = $true
        $result = Invoke-FixtureRepair
        Assert-True (@($result.Started).Count -eq 0 -and "$($result.Log)" -match 'stack check skipped: docker compose config --format json failed \(1\): .*Docker Desktop is not running') "Unexpected: $($result.Log)"
        $f = New-Fixture; New-FixtureStack @{ 'local-ai-https' = 'exited 137' }; $f.ComposeUpFails = $true
        $result = Invoke-FixtureRepair
        Assert-True (@($result.Started).Count -eq 0 -and "$($result.Log)" -match 'stack check skipped: docker compose up -d --no-recreate failed \(1\): .*port is already allocated') "Unexpected: $($result.Log)"
        $f = New-Fixture; New-FixtureStack @{ 'local-ai-n8n' = 'exited 143' }; $f.ComposeFails = $true
        Invoke-FixtureAutoDeploy | Out-Null
        Assert-True ($LASTEXITCODE -eq 0 -and (Get-AutoDeployCount) -eq 1) 'A docker failure failed the deploy'
        Assert-True ((Get-Content -LiteralPath (Join-Path $f.StateDir 'auto-deploy.log') -Raw) -match 'repair: stack check skipped') 'The failure was not logged'
        Assert-True (-not @($f.Notices | Where-Object { $_.meta.action -eq 'repair-stack' }).Count) 'A failed repair sent a notice'
        # An appliance that stays unhealthy is logged, and the notice says so.
        $f = New-Fixture; New-FixtureStack @{ 'local-ai-n8n' = 'exited 143' }; $f.RejectAllHealth = $true
        $result = Invoke-FixtureRepair
        Assert-True ($result.Healthy -eq $false -and $result.Log -contains 'appliance /healthz not OK after 60 s') "Unexpected: $($result.Log -join '; ')"
    }
    Test-Case 'nightly backups keep 7 daily and 4 older weekly copies' {
        $source = Get-Content (Join-Path $repository 'deploy/Backup-LocalAI-Data.ps1') -Raw
        Invoke-Expression ([regex]::Match($source, '(?s)function Select-Keep.*?\n\}').Value)
        $KeepDaily = 7; $KeepWeekly = 4
        $dir = Join-Path ([IO.Path]::GetTempPath()) ('localai-retention-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory $dir | Out-Null
        try {
            for ($i = 0; $i -lt 40; $i++) { New-Item -ItemType File (Join-Path $dir ('localai-' + (Get-Date '2026-10-15').AddDays(-$i).ToString('yyyyMMdd') + '-023000.db')) | Out-Null }
            $kept = (Select-Keep (Get-ChildItem $dir -File) | ForEach-Object { $_.Name.Substring(8, 8) } | Sort-Object -Descending) -join ' '
            Assert-True ($kept -eq '20261015 20261014 20261013 20261012 20261011 20261010 20261009 20261004 20260927 20260920 20260913') "Unexpected retention: $kept"
        } finally { Remove-Item $dir -Recurse -Force }
    }
    Test-Case 'volume archives keep 7 daily and 4 older weekly copies, by the date in their name' {
        $source = Get-Content (Join-Path $repository 'deploy/Backup-LocalAI-Data.ps1') -Raw
        Invoke-Expression ([regex]::Match($source, '(?s)function Select-Keep.*?\n\}').Value)
        $KeepDaily = 7; $KeepWeekly = 4
        $dir = Join-Path ([IO.Path]::GetTempPath()) ('localai-retention-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory $dir | Out-Null
        try {
            for ($i = 0; $i -lt 40; $i++) { New-Item -ItemType File (Join-Path $dir ('volume-n8n_data-' + (Get-Date '2026-10-15').AddDays(-$i).ToString('yyyyMMdd') + '-023000.tgz')) | Out-Null }
            $kept = (Select-Keep (Get-ChildItem $dir -File) | ForEach-Object { [regex]::Match($_.Name, '(\d{8})-\d{6}').Groups[1].Value } | Sort-Object -Descending) -join ' '
            Assert-True ($kept -eq '20261015 20261014 20261013 20261012 20261011 20261010 20261009 20261004 20260927 20260920 20260913') "Unexpected retention: $kept"
        } finally { Remove-Item $dir -Recurse -Force }
    }
    Test-Case 'volume archives never go to a cloud-synced folder, and have no second copy by default' {
        $source = Get-Content (Join-Path $repository 'deploy/Backup-LocalAI-Data.ps1') -Raw
        Assert-True ($source -match "\[string\]\`$VolumeCopyRoot = ''") 'The second copy must be off by default (this PC has no second local disk; G: is Google Drive)'
        Invoke-Expression ([regex]::Match($source, '(?s)function Test-CloudPath.*?\n\}').Value)
        foreach ($p in 'C:\Users\me\OneDrive\LocalAI-Backups', 'C:\Users\me\OneDrive - Work\x', 'C:\Users\me\Dropbox\b', 'C:\Users\me\iCloudDrive\b', 'G:\My Drive\b') {
            Assert-True (Test-CloudPath $p -Labels @{ G = 'Google Drive' }) "Not refused: $p"
        }
        Assert-True (-not (Test-CloudPath 'D:\Backups' -Labels @{ D = 'Data' })) 'A local disk was refused'
    }
    Test-Case 'host parts: the repo list loads, and a broken list is refused' {
        $parts = Get-LocalAI-HostParts $repository
        Assert-True ((@($parts).id -join ' ') -eq 'appliance atlas gridcraft-bridge') "Unexpected parts: $(@($parts).id -join ' ')"
        $dir = Join-Path $temporary 'parts'
        [System.IO.Directory]::CreateDirectory((Join-Path $dir 'deploy')) | Out-Null
        $write = { param($json) Set-Content -LiteralPath (Join-Path $dir 'deploy/host-parts.json') -Value $json }
        & $write '{"parts":[{"id":"a","kind":"scheduled-task","task":"T","paths":["a.py"]},{"id":"a","kind":"scheduled-task","task":"T","paths":["a.py"]}]}'
        Assert-Throws { Get-LocalAI-HostParts $dir } 'listed twice'
        & $write '{"parts":[{"id":"a","kind":"service","task":"T"}]}'
        Assert-Throws { Get-LocalAI-HostParts $dir } 'unknown kind'
        & $write '{"parts":[{"id":"a","kind":"compose-service","service":"s"}]}'
        Assert-Throws { Get-LocalAI-HostParts $dir } "needs 'container'"
    }
    Test-Case 'host parts: a scheduled task is stale only when a file it runs changed' {
        $atlas = [pscustomobject]@{ id = 'atlas'; kind = 'scheduled-task'; task = 'LocalAI Atlas'; paths = @('atlas_intelligence.py') }
        $stale = Test-LocalAI-HostPartStale $atlas $newSha @{ running = $true; startedFrom = $oldSha; changed = @('atlas_intelligence.py') }
        Assert-True ($stale.state -eq 'stale' -and $stale.reason -match 'Runs bbbbbbb, the release is aaaaaaa; changed: atlas_intelligence.py') "Changed path: $($stale.state) $($stale.reason)"
        $same = Test-LocalAI-HostPartStale $atlas $newSha @{ running = $true; startedFrom = $oldSha; changed = @() }
        Assert-True ($same.state -eq 'current') "Unchanged path: $($same.state)"
        Assert-True ((Test-LocalAI-HostPartStale $atlas $newSha @{ running = $true; startedFrom = $newSha }).state -eq 'current') 'Started from the release'
        $none = Test-LocalAI-HostPartStale $atlas $newSha @{ running = $true; startedFrom = $null }
        Assert-True ($none.state -eq 'unknown' -and $none.reason -match 'No record') "No record must be unknown, never current: $($none.state)"
        Assert-True ((Test-LocalAI-HostPartStale $atlas $newSha @{ running = $true; startedFrom = $oldSha }).state -eq 'unknown') 'A failed git diff must be unknown'
        Assert-True ((Test-LocalAI-HostPartStale $atlas $newSha @{ running = $false; startedFrom = $newSha }).state -eq 'stopped') 'A stopped task'
        Assert-True ((Test-LocalAI-HostPartStale $atlas $newSha @{ installed = $false }).state -eq 'not-installed') 'A task not on this host'
        $bridge = [pscustomobject]@{ id = 'gridcraft-bridge'; kind = 'self-reloading'; task = 'B'; paths = @('host/gridcraft-bridge.py') }
        Assert-True ((Test-LocalAI-HostPartStale $bridge $newSha @{}).state -eq 'self-reloading') 'A self-reloading part'
    }
    Test-Case 'host parts: the commit a task started from comes from the reflog entry in effect when it started' {
        $reflog = @("$newSha`tHEAD@{2026-11-06T00:27:41-05:00}", "$oldSha`tHEAD@{2026-11-04T09:00:00-05:00}", 'garbage')
        Assert-True ((Select-LocalAI-CommitAt $reflog ([DateTimeOffset]'2026-11-04T10:33:00-05:00')) -eq $oldSha) 'Started between entries'
        Assert-True ((Select-LocalAI-CommitAt $reflog ([DateTimeOffset]'2026-11-06T05:30:00Z')) -eq $newSha) 'Started after the newest entry (another zone)'
        Assert-True ($null -eq (Select-LocalAI-CommitAt $reflog ([DateTimeOffset]'2026-11-01T00:00:00Z'))) 'Started before the reflog reaches back'
    }
    Test-Case 'host parts: the container is stale when its config hash differs from the release compose' {
        $f = New-Fixture
        New-FixtureContainer 'local-ai-appliance' 'running'
        $appliance = @(Get-LocalAI-HostParts $repository | Where-Object { $_.id -eq 'appliance' })[0]
        $equal = Get-LocalAI-HostPartObservation $appliance $repository $newSha $f.StackEnv
        Assert-True ((Test-LocalAI-HostPartStale $appliance $newSha $equal).state -eq 'current') 'Equal hashes'
        $f.ConfigHash = 'd' * 64
        $changed = Test-LocalAI-HostPartStale $appliance $newSha (Get-LocalAI-HostPartObservation $appliance $repository $newSha $f.StackEnv)
        Assert-True ($changed.state -eq 'stale' -and $changed.reason -match 'recreating it') "Different hashes: $($changed.state)"
        $f.ComposeFails = $true
        Assert-True ((Test-LocalAI-HostPartStale $appliance $newSha (Get-LocalAI-HostPartObservation $appliance $repository $newSha $f.StackEnv)).state -eq 'unknown') 'Compose unreadable must be unknown'
        $f.ComposeFails = $false
        [void]$f.Containers.Clear()
        New-FixtureContainer 'other' 'running'
        Assert-True ((Test-LocalAI-HostPartStale $appliance $newSha (Get-LocalAI-HostPartObservation $appliance $repository $newSha $f.StackEnv)).state -eq 'not-installed') 'No container on this host'
    }
    if ($failures.Count) { throw "$($failures.Count) deployment contract failure(s):`n$($failures -join "`n")" }
    Write-Host "PASS: $passed deployment contracts (native boundaries simulated; actual Docker promotion requires host verification)."
} finally { Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue }
