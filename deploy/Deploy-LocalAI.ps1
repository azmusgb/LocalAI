param([switch]$CheckOnly,[switch]$SkipFetch,[string]$TargetRef="origin/main")
$ErrorActionPreference="Stop"
$Repo="C:\LocalAI\repo";$Live="C:\LocalAI\appliance\app";$Releases="C:\LocalAI\releases";$StateDir="C:\LocalAI\.deploy";$Container="local-ai-appliance";$Health="http://127.0.0.1:3080/healthz";$Lock=Join-Path $StateDir "deploy.lock"
function Copy-Tree($From,$To){if(Test-Path $To){Remove-Item $To -Recurse -Force};New-Item -ItemType Directory -Force $To|Out-Null;robocopy $From $To /MIR /XD node_modules .git data reports logs backups /XF .env "*.log" "*.tmp" "*.bak"|Out-Null;if($LASTEXITCODE -gt 7){throw "robocopy failed: $LASTEXITCODE"}}
function Healthy{for($i=0;$i -lt 12;$i++){try{if($null -ne (Invoke-RestMethod $Health -TimeoutSec 5)){return $true}}catch{};Start-Sleep 2};return $false}
New-Item -ItemType Directory -Force $Releases,$StateDir|Out-Null;$lockStream=[System.IO.File]::Open($Lock,[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::Write,[System.IO.FileShare]::None);$lockStream.Close();Set-Content $Lock "$PID $(Get-Date -Format o)"
try{Set-Location $Repo;if(-not $SkipFetch){git fetch --prune origin;if($LASTEXITCODE -ne 0){throw "git fetch failed"}}
$sha=(git rev-parse $TargetRef).Trim();if(-not $sha){throw "Cannot resolve $TargetRef"};$candidate=Join-Path $Releases $sha
if((Test-Path $candidate) -and -not (Test-Path (Join-Path $candidate "app\server.js"))){Remove-Item $candidate -Recurse -Force}
if(-not(Test-Path $candidate)){
  New-Item -ItemType Directory -Force $candidate|Out-Null
  $archive=Join-Path $StateDir ("candidate-"+$sha+".tar")
  Remove-Item $archive -Force -ErrorAction SilentlyContinue
  git archive --format=tar -o $archive $sha app deploy tests
  if($LASTEXITCODE -ne 0 -or -not(Test-Path $archive)){throw "Failed to create candidate archive"}
  tar -xf $archive -C $candidate
  $tarExit=$LASTEXITCODE
  Remove-Item $archive -Force -ErrorAction SilentlyContinue
  if($tarExit -ne 0 -or -not(Test-Path (Join-Path $candidate "app\server.js"))){Remove-Item $candidate -Recurse -Force -ErrorAction SilentlyContinue;throw "Failed to extract candidate archive"}
}
& (Join-Path $candidate "deploy\Test-LocalAI-Candidate.ps1") -CandidateRoot $candidate
. (Join-Path $candidate "deploy\Storage-LocalAI.ps1")
Test-LocalAI-StorageRuntime -Container $Container
if($CheckOnly){Write-Host "PASS: candidate $($sha.Substring(0,12)) validated; production unchanged." -ForegroundColor Green;exit 0}
$previous=$null;$state=Join-Path $StateDir "state.json";if(Test-Path $state){try{$previous=(Get-Content $state -Raw|ConvertFrom-Json).currentCommit}catch{}}
if($previous -eq $sha){
  Write-Host "NO CHANGE: $($sha.Substring(0,12)) is already deployed." -ForegroundColor Green
  exit 0
}
$backup=Join-Path $StateDir ("live-before-"+(Get-Date -Format "yyyyMMdd-HHmmss"));Copy-Tree $Live $backup
Stop-LocalAI-Container -Container $Container
$dataBackupName=$null
try{
if(Test-Path (Join-Path $backup "storage-cli.js")){
  $dataBackupName="before-"+(Get-Date -Format "yyyyMMdd-HHmmss")+".db"
  Invoke-LocalAI-StorageMaintenance -Container $Container -Command backup -OutputName $dataBackupName
}
Copy-Tree (Join-Path $candidate "app") $Live;Start-LocalAI-Container -Container $Container;if(-not(Healthy)){throw "Health check failed"}
[ordered]@{status="HEALTHY";currentCommit=$sha;previousCommit=$previous;deployedAt=(Get-Date -Format o);source=$TargetRef;rollbackSnapshot=$backup;dataBackupName=$dataBackupName}|ConvertTo-Json|Set-Content $state
Write-Host "DEPLOYED: $($sha.Substring(0,12)) is healthy." -ForegroundColor Green
}catch{$failure=$_.Exception.Message;
Stop-LocalAI-Container -Container $Container
if((Test-Path (Join-Path $Live "storage-cli.js")) -and -not(Test-Path (Join-Path $backup "storage-cli.js"))){
  Invoke-LocalAI-StorageMaintenance -Container $Container -Command downgrade-json -OutputName ("json-rollback-"+(Get-Date -Format "yyyyMMdd-HHmmss"))
}
Copy-Tree $backup $Live;Start-LocalAI-Container -Container $Container;$ok=Healthy;[ordered]@{status=$(if($ok){"ROLLED_BACK"}else{"ROLLBACK_HEALTH_FAILED"});failedCommit=$sha;currentCommit=$previous;rolledBackAt=(Get-Date -Format o);rollbackSnapshot=$backup;error=$failure}|ConvertTo-Json|Set-Content $state;if(-not $ok){throw "Deployment and rollback health checks failed"};throw "Deployment failed; previous live application restored."}
}finally{Remove-Item $Lock -Force -ErrorAction SilentlyContinue}
