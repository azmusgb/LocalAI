[CmdletBinding()]
param(
    [string]$Snapshot,
    [string]$Live = 'C:\LocalAI\appliance\app',
    [string]$StateDir = 'C:\LocalAI\.deploy',
    [string]$Container = 'local-ai-appliance',
    [string]$HealthUrl = 'http://127.0.0.1:3080/healthz'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Deployment-LocalAI.ps1')
. (Join-Path $PSScriptRoot 'Storage-LocalAI.ps1')
$lock = Enter-LocalAI-DeployLock $StateDir
try {
    $statePath = Join-Path $StateDir 'state.json'
    $state = Read-LocalAI-DeployState $statePath
    if (-not $Snapshot) { $Snapshot = $state.rollbackSnapshot }
    if (-not $Snapshot -or -not (Test-Path -LiteralPath (Join-Path $Snapshot 'server.js'))) { throw 'Rollback snapshot not found.' }
    if ([System.IO.Path]::GetFullPath($Snapshot) -eq [System.IO.Path]::GetFullPath($Live)) { throw 'Rollback snapshot must differ from the live application directory.' }
    $restoredCommit = Get-LocalAI-RollbackCommit -Snapshot $Snapshot -State $state
    $fromCommit = Read-LocalAI-ReleaseCommit $Live
    if (-not $fromCommit) { $fromCommit = $state.currentCommit }
    $dataBackupName = $null
    Stop-LocalAI-Container $Container
    try {
        if ((Test-Path -LiteralPath (Join-Path $Live 'storage-cli.js')) -and -not (Test-Path -LiteralPath (Join-Path $Snapshot 'storage-cli.js'))) {
            $dataBackupName = 'json-rollback-' + [Guid]::NewGuid().ToString('N')
            Invoke-LocalAI-StorageMaintenance -Container $Container -Command downgrade-json -OutputName $dataBackupName
        } elseif (Test-Path -LiteralPath (Join-Path $Live 'storage-cli.js')) {
            $dataBackupName = 'before-rollback-' + [Guid]::NewGuid().ToString('N') + '.db'
            Invoke-LocalAI-StorageMaintenance -Container $Container -Command backup -OutputName $dataBackupName
        }
        Copy-LocalAI-AppTree -From $Snapshot -To $Live -Replace
        Start-LocalAI-Container $Container
        $requiresSqlite = Test-Path -LiteralPath (Join-Path $Live 'storage.js')
        $expected = if (Test-Path -LiteralPath (Join-Path $Live 'release.json')) { Read-LocalAI-ReleaseCommit $Live } else { $null }
        if (-not (Wait-LocalAI-Health -HealthUrl $HealthUrl -ExpectedCommit $expected -RequireSqlite:$requiresSqlite)) { throw 'Rollback health/storage/release identity check failed' }
        Write-LocalAI-DeployState -Path $statePath -State ([ordered]@{
            status = 'ROLLED_BACK'; currentCommit = $restoredCommit; previousCommit = $fromCommit
            rolledBackAt = Get-Date -Format o; rollbackSnapshot = $Snapshot; rollbackSnapshotCommit = $restoredCommit
            dataBackupName = $dataBackupName
        })
        Write-Host "Rollback completed from $Snapshot" -ForegroundColor Green
    } catch {
        $failure = $_.Exception.Message
        try { Stop-LocalAI-Container $Container } catch { $failure += "; could not stop container: $($_.Exception.Message)" }
        Write-LocalAI-DeployState -Path $statePath -State ([ordered]@{
            status = 'RECOVERY_REQUIRED'; currentCommit = $null; previousCommit = $fromCommit
            rollbackSnapshot = $Snapshot; rollbackSnapshotCommit = $restoredCommit; dataBackupName = $dataBackupName
            error = $failure; checkedAt = Get-Date -Format o
        })
        throw "Rollback failed: $failure. Preserve the data and snapshot; inspect the container before further promotion."
    }
} finally { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue }
