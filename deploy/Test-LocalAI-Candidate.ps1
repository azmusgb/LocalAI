param([Parameter(Mandatory=$true)][string]$CandidateRoot)
$ErrorActionPreference="Stop"
$app=Join-Path $CandidateRoot "app"
foreach($r in @("server.js","public\app.js","public\index.html","public\manifest.json","public\sw.js")){if(-not(Test-Path(Join-Path $app $r))){throw "Missing required file: $r"}}
Get-ChildItem $app -Recurse -File -Filter *.js|ForEach-Object{node --check $_.FullName|Out-Null;if($LASTEXITCODE -ne 0){throw "JavaScript syntax failure: $($_.FullName)"}}
$server=Get-Content (Join-Path $app "server.js") -Raw;$frontend=Get-Content (Join-Path $app "public\app.js") -Raw
foreach($s in @("/healthz","/api/engineering/runs")){if(-not $server.Contains($s)){throw "Server contract missing: $s"}}
foreach($s in @("pollEngineeringIntent","engineeringRunText","loadEngineeringRuns","persistMessages")){if(-not $frontend.Contains($s)){throw "Frontend contract missing: $s"}}
$bad=Get-ChildItem $app -Recurse -Force -File|Where-Object{$_.Name -match '(^\.env)|(\.key$)|(\.pem$)|(\.pfx$)|(\.p12$)'}
if($bad){throw "Sensitive file type found"}
Write-Host "PASS: required files, JS syntax, lifecycle contracts, and sensitive-file checks." -ForegroundColor Green