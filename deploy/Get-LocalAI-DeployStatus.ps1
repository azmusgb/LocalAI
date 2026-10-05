[CmdletBinding()]
param(
    [string]$Repo = 'C:\LocalAI\repo',
    [string]$StatePath = 'C:\LocalAI\.deploy\state.json',
    [string]$HealthUrl = 'http://127.0.0.1:3080/healthz',
    [string]$TaskName = 'LocalAI Safe Deploy',
    [switch]$AsJson
)

$ErrorActionPreference = 'Stop'

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
        $value = (& git -C $Repository rev-parse $Ref 2>$null | Select-Object -First 1)
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

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$taskInfo = if ($null -ne $task) {
    Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
} else {
    $null
}

$healthState = 'UNREACHABLE'
$healthDetail = $null
try {
    $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5
    $healthState = if ($null -ne $health) { 'HEALTHY' } else { 'UNKNOWN' }
    if ($health.PSObject.Properties.Name -contains 'status') {
        $healthDetail = [string]$health.status
    }
}
catch {
    $healthDetail = $_.Exception.Message
}

$originMain = Get-GitSha -Repository $Repo -Ref 'origin/main'
$localHead = Get-GitSha -Repository $Repo -Ref 'HEAD'
$currentCommit = if ($null -ne $state -and $state.PSObject.Properties.Name -contains 'currentCommit') {
    [string]$state.currentCommit
} else {
    $null
}

$deploymentStatus = if ($null -ne $state -and $state.PSObject.Properties.Name -contains 'status') {
    [string]$state.status
} else {
    'NO_STATE'
}

$behindOrigin = $null
if ($currentCommit -and $originMain) {
    $behindOrigin = $currentCommit -ne $originMain
}

$result = [ordered]@{
    health = $healthState
    healthDetail = $healthDetail
    deploymentStatus = $deploymentStatus
    currentCommit = $currentCommit
    currentCommitShort = Get-ShortSha $currentCommit
    originMain = $originMain
    originMainShort = Get-ShortSha $originMain
    repoHead = $localHead
    repoHeadShort = Get-ShortSha $localHead
    deploymentBehindOrigin = $behindOrigin
    deployedAt = if ($null -ne $state -and $state.PSObject.Properties.Name -contains 'deployedAt') { $state.deployedAt } else { $null }
    previousCommit = if ($null -ne $state -and $state.PSObject.Properties.Name -contains 'previousCommit') { $state.previousCommit } else { $null }
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
