param([Parameter(Mandatory=$true)][string]$CandidateRoot,[switch]$LocalNode)
$ErrorActionPreference="Stop"
$app=Join-Path $CandidateRoot "app"
foreach($r in @("server.js","release.js","storage.js","storage-cli.js","agent-orchestrator.js","specialist-agents.json","public\app.js","public\index.html","public\manifest.json","public\sw.js","public\agent-specialists.js","public\agent-specialists.css","public\ux-architecture-v2.js","public\ux-architecture-v2.css","public\agent-world-city.js","public\agent-world-city.css","public\integration-hub-v2.js","public\integration-hub-v2.css")){if(-not(Test-Path(Join-Path $app $r))){throw "Missing required file: $r"}}
Get-ChildItem $app -Recurse -File -Filter *.js|ForEach-Object{node --check $_.FullName|Out-Null;if($LASTEXITCODE -ne 0){throw "JavaScript syntax failure: $($_.FullName)"}}
$server=Get-Content (Join-Path $app "server.js") -Raw;$frontend=Get-Content (Join-Path $app "public\app.js") -Raw;$orchestrator=Get-Content (Join-Path $app "agent-orchestrator.js") -Raw;$ux=Get-Content (Join-Path $app "public\ux-architecture-v2.js") -Raw;$uxcss=Get-Content (Join-Path $app "public\ux-architecture-v2.css") -Raw;$agentCity=Get-Content (Join-Path $app "public\agent-world-city.js") -Raw;$agentOps=Get-Content (Join-Path $app "public\agent-specialists.js") -Raw;$index=Get-Content (Join-Path $app "public\index.html") -Raw
foreach($s in @("/healthz","/api/engineering/runs","/api/agents/catalog","/api/agents/models","/api/agents/dispatch","/api/agents/specialist/run","/api/agents/missions/start","/api/agents/missions/events")){if(-not $server.Contains($s)){throw "Server contract missing: $s"}}
foreach($s in @("pollEngineeringIntent","engineeringRunText","loadEngineeringRuns","persistMessages","serviceDisplayState","OPTIONAL_OFFLINE","statusRetryBtn")){if(-not $frontend.Contains($s)){throw "Frontend contract missing: $s"}}
foreach($s in @("presentService","Core appliance unaffected","optionalUnhealthy")){if(-not $server.Contains($s)){throw "Capability resilience contract missing: $s"}}
foreach($s in @("statusRetryBtn","statusCheckedAt","Core services determine appliance health")){if(-not $index.Contains($s)){throw "Capability status layout contract missing: $s"}}
foreach($s in @("agent-world-city.js","ux-architecture-v2.js","evidencePacket","projectGrounding","PRODUCT IDENTITY:","Authoritative project evidence:","Synthesize only claims grounded","GROUNDED_TIMEOUT_MS=600000","COORDINATOR_TIMEOUT_MS=600000","MODEL_TIMEOUT","needs_attention","Blocked because a prerequisite specialist failed","MODEL_RETRY_DELAYS_MS","MODEL_CONNECTION_ERROR","dependencyContext","OBSERVED PRESENCE","OBSERVED ABSENCE IN SUPPLIED EXCERPTS","NOT VERIFIED","activeWorkload","capabilityScore","fallbackFor","dependencyPlan","routingMeta","missionSnapshot(m,type","timeline","fallback executed by")){if(-not $orchestrator.Contains($s)){throw "Agent grounding/runtime contract missing: $s"}}
foreach($s in @("DOMAINS","buildDesktopNav","renderSecondary","buildMobile","renderSheet","observeViews","uxNavRegistry")){if(-not $ux.Contains($s)){throw "Navigation architecture contract missing: $s"}};foreach($s in @(".ux-primary-rail",".ux-secondary-nav",".ux-secondary-link",".ux-context-bar",".ux-mobile-nav",".ux-mobile-sheet")){if(-not $uxcss.Contains($s)){throw "Navigation architecture style contract missing: $s"}}
foreach($s in @("DISTRICTS","ROLE_ZONE","ROLE_STYLE","Mission construction crew","workerTarget","districtDoor","drawInterior","drawDistrictScene","routeToTarget","workerIsRunning","spawnRunDust","drawRunningWorkerSprite","districtProgress","drawWorkingAction","recordReplayFrame","applyReplayFrame","loadMissionReplay","cycleReplaySpeed","awcReplayMarkers","drawCommandCelebration","toggleReplay","awcReplayRange","HANDOFF","REPLAY_KEY","loadReplay","persistReplay","dependencyState","awcStatArtifacts","drawWorkerSprite","drawWorkerTool","drawWorkerHat","drawWorkerBubble","drawWorksite","toggleExpanded","toggleCrew","toggleFollow","Exit theater","roundRect","s.vest","astar","applyMission","applyEngineering","startDemo","stepDemo","returnLive","focusActive","focusWorker","toggleDisplay","drawBuilding","drawFlows","drawAgents","spawnArtifact","spawnPacket","awcMinimap","awcRoster","pointerdown","pinch","/api/agents/missions","/api/agents/missions/events","/api/engineering/runs")){if(-not $agentCity.Contains($s)){throw "Operational Agent World v8 contract missing: $s"}}
foreach($s in @("renderTimeline","renderInspector","renderResults","loadHistory","startMission","agentRetryBtn","localai:agentworld-focus","route-scorebar","agentworld-replay-mission","Capability fit","Fallback")){if(-not $agentOps.Contains($s)){throw "Agent Operations v2 contract missing: $s"}}
foreach($s in @("agentWorldCityMount","agentTimeline","agentInspector","agentResultBody","agentMissionHistory","agentAdvancedPanel")){if(-not $index.Contains($s)){throw "Agent Operations layout contract missing: $s"}}
$bad=Get-ChildItem $app -Recurse -Force -File|Where-Object{$_.Name -match '(^\.env)|(\.key$)|(\.pem$)|(\.pfx$)|(\.p12$)'}
if($bad){throw "Sensitive file type found"}
Write-Host "PASS: required files, JS syntax, lifecycle contracts, and sensitive-file checks." -ForegroundColor Green


# Native storage checks need no npm packages or model services.
# The host runs them in the appliance image (its Node has node:sqlite); CI passes -LocalNode because it has no appliance container.
$nativeTests = @("tests/release.test.cjs","tests/storage.test.cjs","tests/storage-api.test.cjs","tests/agent-orchestrator.test.cjs")
if($LocalNode){
node --test ($nativeTests | ForEach-Object { Join-Path $CandidateRoot $_ })
}else{
$containerCandidate = "/candidate"
$image = docker inspect local-ai-appliance --format '{{.Config.Image}}'
if($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($image)){throw "Cannot determine appliance Docker image"}
docker run --rm -v "${CandidateRoot}:${containerCandidate}:ro" --entrypoint node $image --test ($nativeTests | ForEach-Object { "$containerCandidate/$_" })
}
if($LASTEXITCODE -ne 0){throw "SQLite migration, concurrency, API or agent regression failed"}

& (Join-Path $CandidateRoot 'tests/Test-LocalAI-DeployContracts.ps1')
