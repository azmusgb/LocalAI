param([string]$Snapshot)
$ErrorActionPreference="Stop";$Live="C:\LocalAI\appliance\app";$StateDir="C:\LocalAI\.deploy";$Container="local-ai-appliance";$Health="http://127.0.0.1:3080/healthz"
if(-not $Snapshot){$state=Get-Content (Join-Path $StateDir "state.json") -Raw|ConvertFrom-Json;$Snapshot=$state.rollbackSnapshot}
if(-not $Snapshot -or -not(Test-Path (Join-Path $Snapshot "server.js"))){throw "Rollback snapshot not found."}
New-Item -ItemType Directory -Force $StateDir | Out-Null
$lock=Join-Path $StateDir 'deploy.lock'
$lockStream=[System.IO.File]::Open($lock,[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::Write,[System.IO.FileShare]::None)
$lockStream.Close()
try {
. (Join-Path $PSScriptRoot 'Storage-LocalAI.ps1')
Stop-LocalAI-Container -Container $Container
if((Test-Path (Join-Path $Live 'storage-cli.js')) -and -not(Test-Path (Join-Path $Snapshot 'storage-cli.js'))){
    Invoke-LocalAI-StorageMaintenance -Container $Container -Command downgrade-json -OutputName ("json-rollback-"+(Get-Date -Format 'yyyyMMdd-HHmmss'))
}
elseif(Test-Path (Join-Path $Live 'storage-cli.js')){
    Invoke-LocalAI-StorageMaintenance -Container $Container -Command backup -OutputName ("before-rollback-"+(Get-Date -Format 'yyyyMMdd-HHmmss')+".db")
}
robocopy $Snapshot $Live /MIR /XD node_modules .git data reports logs backups /XF .env "*.log" "*.tmp" "*.bak"|Out-Null;if($LASTEXITCODE -gt 7){throw "Rollback copy failed"}
Start-LocalAI-Container -Container $Container;Start-Sleep 4;Invoke-RestMethod $Health -TimeoutSec 8|ConvertTo-Json -Depth 5
Write-Host "Rollback completed from $Snapshot" -ForegroundColor Green

} finally { Remove-Item $lock -Force -ErrorAction SilentlyContinue }
