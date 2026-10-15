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
    Copy-Item -LiteralPath (Join-Path $repository 'deploy/Storage-LocalAI.ps1') -Destination (Join-Path $repo 'deploy/Storage-LocalAI.ps1')
    Copy-Item -LiteralPath (Join-Path $repository 'deploy/Deployment-LocalAI.ps1') -Destination (Join-Path $repo 'deploy/Deployment-LocalAI.ps1')
    Set-Content -LiteralPath (Join-Path $repo 'deploy/Test-LocalAI-Candidate.ps1') -Value 'param($CandidateRoot)'
    $script:fixture = [pscustomobject]@{
        Root = $root; Repo = $repo; Live = $live; Releases = (Join-Path $root 'releases'); StateDir = (Join-Path $root 'state')
        Running = $true; RejectNewRelease = $false; RejectAllHealth = $false; PreflightFailure = $false; ExportFailure = $false
        Calls = [System.Collections.Generic.List[object]]::new()
    }
    [System.IO.Directory]::CreateDirectory($fixture.StateDir) | Out-Null
    Write-LocalAI-DeployState (Join-Path $fixture.StateDir 'state.json') ([ordered]@{status='HEALTHY';currentCommit=$oldSha})
    return $fixture
}
function docker {
    $Arguments = [string[]]$args
    $fixture.Calls.Add($Arguments)
    $global:LASTEXITCODE = 0
    switch ($Arguments[0]) {
        'inspect' { return @([ordered]@{Image='sha256:existing-image';State=@{Running=$fixture.Running};Config=@{Env=@('DATA_DIR=/data')};Mounts=@(@{Destination='/app'},@{Destination='/data'})}) | ConvertTo-Json -Depth 8 -Compress }
        'stop' { $fixture.Running=$false; return }
        'start' { $fixture.Running=$true; return }
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
    if ($Arguments -contains 'archive') {
        $output = $Arguments[[Array]::IndexOf($Arguments,'-o')+1]
        Set-Content -LiteralPath $output -Value 'fixture archive'
    }
}
function tar {
    $Arguments = [string[]]$args
    $destination = $Arguments[[Array]::IndexOf($Arguments,'-C')+1]
    foreach ($dir in @('app','deploy','tests')) { Copy-Item -LiteralPath (Join-Path $fixture.Repo $dir) -Destination $destination -Recurse }
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
    param($Uri, $TimeoutSec)
    $commit = Read-LocalAI-ReleaseCommit $fixture.Live
    $status = if ($fixture.RejectAllHealth -or ($fixture.RejectNewRelease -and $commit -eq $newSha)) { 'error' } else { 'ok' }
    return [pscustomobject]@{status=$status;releaseCommit=$commit;storage=[pscustomobject]@{engine=$(if(Test-Path -LiteralPath (Join-Path $fixture.Live 'storage.js')){'sqlite'}else{'json'});schemaVersion=1}}
}
function Invoke-FixtureDeploy([switch]$CheckOnly) {
    & (Join-Path $repository 'deploy/Deploy-LocalAI.ps1') -Repo $fixture.Repo -Live $fixture.Live -Releases $fixture.Releases -StateDir $fixture.StateDir -Container 'fixture-appliance' -HealthUrl 'http://fixture/healthz' -SkipFetch -CheckOnly:$CheckOnly
}
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
    if ($failures.Count) { throw "$($failures.Count) deployment contract failure(s):`n$($failures -join "`n")" }
    Write-Host "PASS: $passed deployment contracts (native boundaries simulated; actual Docker promotion requires host verification)."
} finally { Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue }
