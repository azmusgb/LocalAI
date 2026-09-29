param([string]$Snapshot)
$ErrorActionPreference="Stop";$Live="C:\LocalAI\appliance\app";$StateDir="C:\LocalAI\.deploy";$Container="local-ai-appliance";$Health="http://127.0.0.1:3080/healthz"
if(-not $Snapshot){$state=Get-Content (Join-Path $StateDir "state.json") -Raw|ConvertFrom-Json;$Snapshot=$state.rollbackSnapshot}
if(-not $Snapshot -or -not(Test-Path $Snapshot)){throw "Rollback snapshot not found."}
robocopy $Snapshot $Live /MIR /XD node_modules .git data reports logs backups /XF .env "*.log" "*.tmp" "*.bak"|Out-Null;if($LASTEXITCODE -gt 7){throw "Rollback copy failed"}
docker restart $Container|Out-Host;Start-Sleep 4;Invoke-RestMethod $Health -TimeoutSec 8|ConvertTo-Json -Depth 5
Write-Host "Rollback completed from $Snapshot" -ForegroundColor Green