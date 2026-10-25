[CmdletBinding()]
param(
    [string]$Repo = 'C:\LocalAI\repo',
    [string]$StatePath = 'C:\LocalAI\.deploy\state.json',
    [string]$HealthUrl = 'http://127.0.0.1:3080/healthz',
    [string]$TaskName = 'LocalAI Safe Deploy',
    [switch]$AsJson
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Deployment-LocalAI.ps1')

function Get-ShortSha {
    param([AllowNull()][string]$Sha)
    if ([string]::IsNullOrWhiteSpace($Sha)) { return $null }
    if ($Sha.Length -le 12) { return $Sha }
    return $Sha.Substring(0, 12)
}

function Get-GitSha {
    param([string]$Repository, [string]$Ref)
    if (-not (Test-Path -LiteralPath $Repository)) { return $null }
    try {
        $value = (& git -C $Repository rev-parse $Ref 2>$null)
        if ($LASTEXITCODE -ne 0) { return $null }
        return [string]$value.Trim()
    }
    catch {
        return $null
    }
}

$state = $null
if (Test-Path -LiteralPath $StatePath) {
    try {
        $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    }
    catch {
        $state = [pscustomobject]@{
            status = 'STATE_READ_FAILED'
            error = $_.Exception.Message
        }
    }
}

$schedulerAvailable = $null -ne (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)
$task = if ($schedulerAvailable) { Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } else { $null }
$taskInfo = if ($null -ne $task) { Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue } else { $null }

$healthState = 'UNREACHABLE'
$healthDetail = $null
$health = $null
try {
    $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5
    $healthState = if (Test-LocalAI-HealthPayload -Health $health) { 'HEALTHY' } else { 'UNHEALTHY' }
    if ($health.PSObject.Properties.Name -contains 'status') {
        $healthDetail = [string]$health.status
    }
}
catch {
    $healthDetail = $_.Exception.Message
}

$originMain = Get-GitSha -Repository $Repo -Ref 'origin/main'
# What the host deploys: release, which only npm run ship moves (Run-LocalAI-AutoDeploy.ps1).
$originRelease = Get-GitSha -Repository $Repo -Ref 'origin/release'
$localHead = Get-GitSha -Repository $Repo -Ref 'HEAD'
$currentCommit = if ($null -ne $state -and $state.PSObject.Properties.Name -contains 'currentCommit') {
    [string]$state.currentCommit
} else {
    $null
}

$recordedCommit = $currentCommit
$runtimeCommit = if ($null -ne $health -and [string]$health.releaseCommit -match '^[a-f0-9]{40}$') { [string]$health.releaseCommit } else { $null }
$identityMismatch = [bool]($runtimeCommit -and $recordedCommit -and $runtimeCommit -ne $recordedCommit)
if ($runtimeCommit) { $currentCommit = $runtimeCommit }

$deploymentStatus = if ($null -ne $state -and $state.PSObject.Properties.Name -contains 'status') {
    [string]$state.status
} else {
    'NO_STATE'
}

$behindOrigin = $null
if ($currentCommit -and $originRelease) {
    $behindOrigin = $currentCommit -ne $originRelease
}

$result = [ordered]@{
    health = $healthState
    healthDetail = $healthDetail
    runtimeCommit = $runtimeCommit
    recordedCommit = $recordedCommit
    deploymentIdentityMismatch = $identityMismatch
    storageEngine = if ($null -ne $health) { $health.storage.engine } else { $null }
    deploymentStatus = $deploymentStatus
    currentCommit = $currentCommit
    currentCommitShort = Get-ShortSha $currentCommit
    originMain = $originMain
    originMainShort = Get-ShortSha $originMain
    originRelease = $originRelease
    originReleaseShort = Get-ShortSha $originRelease
    repoHead = $localHead
    repoHeadShort = Get-ShortSha $localHead
    deploymentBehindOrigin = $behindOrigin
    deployedAt = if ($null -ne $state -and $state.PSObject.Properties.Name -contains 'deployedAt') { $state.deployedAt } else { $null }
    previousCommit = if ($null -ne $state -and $state.PSObject.Properties.Name -contains 'previousCommit') { $state.previousCommit } else { $null }
    taskSchedulerAvailable = $schedulerAvailable
    taskInstalled = $null -ne $task
    taskState = if ($null -ne $task) { [string]$task.State } else { 'NotInstalled' }
    taskLastRunTime = if ($null -ne $taskInfo) { $taskInfo.LastRunTime } else { $null }
    taskLastResult = if ($null -ne $taskInfo) { $taskInfo.LastTaskResult } else { $null }
    taskNextRunTime = if ($null -ne $taskInfo) { $taskInfo.NextRunTime } else { $null }
    checkedAt = Get-Date -Format o
}

if ($AsJson) {
    $result | ConvertTo-Json -Depth 4
    return
}

[pscustomobject]$result | Format-List

