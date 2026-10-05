[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$SkipFetch,
    [string]$TargetRef = 'origin/main',
    [string]$Repo = 'C:\LocalAI\repo',
    [string]$Live = 'C:\LocalAI\appliance\app',
    [string]$Releases = 'C:\LocalAI\releases',
    [string]$StateDir = 'C:\LocalAI\.deploy',
    [string]$Container = 'local-ai-appliance',
    [string]$HealthUrl = 'http://127.0.0.1:3080/healthz'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Deployment-LocalAI.ps1')
. (Join-Path $PSScriptRoot 'Storage-LocalAI.ps1')
[System.IO.Directory]::CreateDirectory($Releases) | Out-Null
$lock = Enter-LocalAI-DeployLock $StateDir
try {
    if (-not $SkipFetch) {
        git -C $Repo fetch --prune origin
        if ($LASTEXITCODE -ne 0) { throw 'git fetch failed' }
    }
    $sha = [string](git -C $Repo rev-parse --verify "$TargetRef^{commit}" | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or $sha.Trim() -notmatch '^[a-f0-9]{40}$') { throw "Cannot resolve commit $TargetRef" }
    $sha = $sha.Trim()
    $candidate = Join-Path $Releases $sha
    # Re-extract this exact revision instead of trusting an old/incomplete cache.
    if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate -Recurse -Force }
    [System.IO.Directory]::CreateDirectory($candidate) | Out-Null
    $archive = Join-Path $StateDir ('candidate-' + [Guid]::NewGuid().ToString('N') + '.tar')
    try {
        git -C $Repo archive --format=tar -o $archive $sha app deploy tests
        if ($LASTEXITCODE -ne 0) { throw 'Failed to create candidate archive' }
        tar -xf $archive -C $candidate
        if ($LASTEXITCODE -ne 0) { throw 'Failed to extract candidate archive' }
    } finally { Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue }

    & (Join-Path $candidate 'deploy/Test-LocalAI-Candidate.ps1') -CandidateRoot $candidate
    # Run the candidate's worker contracts rather than assuming repo and target match.
    . (Join-Path $candidate 'deploy/Storage-LocalAI.ps1')
    . (Join-Path $candidate 'deploy/Deployment-LocalAI.ps1')
    Test-LocalAI-StorageRuntime -Container $Container
    Test-LocalAI-StorageCandidate -Container $Container -CandidateApp (Join-Path $candidate 'app')
    if ($CheckOnly) { Write-Host "PASS: candidate $($sha.Substring(0,12)), image runtime and disposable data migration validated." -ForegroundColor Green; return }

    $statePath = Join-Path $StateDir 'state.json'
    $state = Read-LocalAI-DeployState $statePath
    $liveCommit = Read-LocalAI-ReleaseCommit $Live
    if ($state.currentCommit -eq $sha -and $liveCommit -eq $sha -and (Wait-LocalAI-Health -HealthUrl $HealthUrl -ExpectedCommit $sha -RequireSqlite -Attempts 1)) {
        Write-Host "NO CHANGE: $($sha.Substring(0,12)) is running and healthy." -ForegroundColor Green
        return
    }
    $previous = if ($liveCommit) { $liveCommit } else { $state.currentCommit }
    $backup = Join-Path $StateDir ('live-before-' + [Guid]::NewGuid().ToString('N'))
    $dataBackupName = $null
    $codeReplacementStarted = $false
    $newContainerStarted = $false
    Stop-LocalAI-Container $Container
    try {
        Copy-LocalAI-AppTree -From $Live -To $backup
        if (Test-Path -LiteralPath (Join-Path $Live 'storage-cli.js')) {
            $dataBackupName = 'before-deploy-' + [Guid]::NewGuid().ToString('N') + '.db'
            Invoke-LocalAI-StorageMaintenance -Container $Container -Command backup -OutputName $dataBackupName
        }
        # Repeat with writes stopped to catch any data changes since certification.
        Test-LocalAI-StorageCandidate -Container $Container -CandidateApp (Join-Path $candidate 'app')
        $codeReplacementStarted = $true
        Copy-LocalAI-AppTree -From (Join-Path $candidate 'app') -To $Live -Replace
        Write-LocalAI-DeployState -Path (Join-Path $Live 'release.json') -State ([ordered]@{ commit = $sha })
        $newContainerStarted = $true
        Start-LocalAI-Container $Container
        if (-not (Wait-LocalAI-Health -HealthUrl $HealthUrl -ExpectedCommit $sha -RequireSqlite)) { throw 'Candidate health/storage/release identity check failed' }
        Write-LocalAI-DeployState -Path $statePath -State ([ordered]@{
            status = 'HEALTHY'; currentCommit = $sha; previousCommit = $previous
            deployedAt = Get-Date -Format o; source = $TargetRef
            rollbackSnapshot = $backup; rollbackSnapshotCommit = $previous; dataBackupName = $dataBackupName
        })
        Write-Host "DEPLOYED: $($sha.Substring(0,12)) is healthy and reports the expected release." -ForegroundColor Green
    } catch {
        $failure = $_.Exception.Message
        try {
            Stop-LocalAI-Container $Container
            if ($codeReplacementStarted) {
                if ($newContainerStarted -and (Test-Path -LiteralPath (Join-Path $Live 'storage-cli.js')) -and -not (Test-Path -LiteralPath (Join-Path $backup 'storage-cli.js'))) {
                    Invoke-LocalAI-StorageMaintenance -Container $Container -Command downgrade-json -OutputName ('json-rollback-' + [Guid]::NewGuid().ToString('N'))
                }
                Copy-LocalAI-AppTree -From $backup -To $Live -Replace
            }
            Start-LocalAI-Container $Container
            $requiresSqlite = Test-Path -LiteralPath (Join-Path $Live 'storage.js')
            $expected = if (Test-Path -LiteralPath (Join-Path $Live 'release.json')) { Read-LocalAI-ReleaseCommit $Live } else { $null }
            if (-not (Wait-LocalAI-Health -HealthUrl $HealthUrl -ExpectedCommit $expected -RequireSqlite:$requiresSqlite)) { throw 'Restored application health check failed' }
            Write-LocalAI-DeployState -Path $statePath -State ([ordered]@{
                status = $(if ($codeReplacementStarted) { 'ROLLED_BACK' } else { 'DEPLOY_FAILED_UNCHANGED' }); currentCommit = $previous; failedCommit = $sha
                rolledBackAt = Get-Date -Format o
                rollbackSnapshot = $(if ($codeReplacementStarted) { $backup } else { $state.rollbackSnapshot })
                rollbackSnapshotCommit = $(if ($codeReplacementStarted) { $previous } else { $state.rollbackSnapshotCommit })
                dataBackupName = $dataBackupName; error = $failure
            })
        } catch {
            $recoveryFailure = $_.Exception.Message
            try { Stop-LocalAI-Container $Container } catch { $recoveryFailure += "; could not stop container: $($_.Exception.Message)" }
            Write-LocalAI-DeployState -Path $statePath -State ([ordered]@{
                status = 'RECOVERY_REQUIRED'; currentCommit = $null; failedCommit = $sha
                rollbackSnapshot = $backup; rollbackSnapshotCommit = $previous; dataBackupName = $dataBackupName
                error = $failure; recoveryError = $recoveryFailure; checkedAt = Get-Date -Format o
            })
            throw "Deployment failed: $failure. Automatic recovery failed: $recoveryFailure. Preserve the data and snapshot at $backup."
        }
        throw "Deployment failed; previous live application restored. Cause: $failure"
    }
} finally { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue }
