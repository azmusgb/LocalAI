param(
    [string]$RepoRoot = '',
    [string]$LiveRoot = 'C:\LocalAI\appliance\app',
    [switch]$NoPromote
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $RepoRoot) { $RepoRoot = 'C:\LocalAI\repo' }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$PayloadRoot = $PSScriptRoot

$Python = 'C:\Python312\python.exe'
if (-not (Test-Path -LiteralPath $Python)) {
    $pythonCmd = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pythonCmd) { throw 'Python 3 is required but was not found.' }
    $Python = $pythonCmd.Source
}

$Required = @(
    'atlas_intelligence.py','system-atlas.html','app\server\atlas.js',
    'app\public\index.html','app\public\sw.js','app\public\architecture.js',
    'app\public\architecture.css','tests\atlas-integration.test.cjs'
)
foreach ($relative in $Required) {
    $path = Join-Path $RepoRoot $relative
    if (-not (Test-Path -LiteralPath $path)) { throw "Required current Atlas integration file is missing: $path" }
}
foreach ($payload in @('patch.py','harden.py','atlas-investigations.js','atlas-investigations.css','atlas-investigations.test.cjs')) {
    $path = Join-Path $PayloadRoot $payload
    if (-not (Test-Path -LiteralPath $path)) { throw "Installer payload is incomplete: $path" }
}

$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Backup = Join-Path $RepoRoot ".atlas\investigation-upgrade-backups\$Stamp"
New-Item -ItemType Directory -Force -Path $Backup | Out-Null
$Touched = @(
    'atlas_intelligence.py','app\server\atlas.js','app\public\index.html','app\public\sw.js',
    'app\public\atlas-investigations.js','app\public\atlas-investigations.css','tests\atlas-investigations.test.cjs'
)
foreach ($relative in $Touched) {
    $source = Join-Path $RepoRoot $relative
    if (Test-Path -LiteralPath $source) {
        $dest = Join-Path $Backup $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
        Copy-Item -LiteralPath $source -Destination $dest -Force
    }
}
Write-Host "Repo backup: $Backup"

Write-Host "`n=== Patch Atlas Investigations v1 ===" -ForegroundColor Cyan
& $Python (Join-Path $PayloadRoot 'patch.py') $RepoRoot $PayloadRoot
if ($LASTEXITCODE -ne 0) { throw 'Atlas Investigations patch failed. Live files were not changed.' }
& $Python (Join-Path $PayloadRoot 'harden.py') $RepoRoot
if ($LASTEXITCODE -ne 0) { throw 'Atlas Investigations hardening failed. Live files were not changed.' }

Write-Host "`n=== Validate source ===" -ForegroundColor Cyan
Push-Location $RepoRoot
try {
    & $Python .\atlas_intelligence.py --self-test
    if ($LASTEXITCODE -ne 0) { throw 'atlas_intelligence.py --self-test failed.' }
    node --check .\app\server\atlas.js
    if ($LASTEXITCODE -ne 0) { throw 'app/server/atlas.js syntax failed.' }
    node --check .\app\public\atlas-investigations.js
    if ($LASTEXITCODE -ne 0) { throw 'atlas-investigations.js syntax failed.' }
    node --test .\tests\atlas-integration.test.cjs .\tests\atlas-investigations.test.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Focused Atlas tests failed.' }
    git --no-pager diff --check -- `
        atlas_intelligence.py `
        app/server/atlas.js `
        app/public/index.html `
        app/public/sw.js `
        app/public/atlas-investigations.js `
        app/public/atlas-investigations.css `
        tests/atlas-investigations.test.cjs
    if ($LASTEXITCODE -ne 0) { throw 'git diff --check failed for Atlas investigation files.' }
}
finally { Pop-Location }

if ($NoPromote) {
    Write-Host "`nPASS: source patched and validated; -NoPromote requested." -ForegroundColor Green
    exit 0
}

Write-Host "`n=== Promote validated Local AI files ===" -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath $LiveRoot)) { throw "Live Local AI app root was not found: $LiveRoot" }
$LiveBackup = "C:\LocalAI\.deploy\atlas-investigations-before-$Stamp"
New-Item -ItemType Directory -Force -Path $LiveBackup | Out-Null
$Promote = @('server\atlas.js','public\index.html','public\sw.js','public\atlas-investigations.js','public\atlas-investigations.css')
foreach ($relative in $Promote) {
    $source = Join-Path (Join-Path $RepoRoot 'app') $relative
    $dest = Join-Path $LiveRoot $relative
    if (-not (Test-Path -LiteralPath $source)) { throw "Validated source missing before promotion: $source" }
    if (Test-Path -LiteralPath $dest) {
        $backupDest = Join-Path $LiveBackup $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupDest) | Out-Null
        Copy-Item -LiteralPath $dest -Destination $backupDest -Force
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    Copy-Item -LiteralPath $source -Destination $dest -Force
}
Write-Host "Live backup: $LiveBackup"

$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) { throw 'Docker CLI was not found; source/live files are updated but the appliance was not restarted.' }
docker restart local-ai-appliance | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restart local-ai-appliance.' }

Write-Host "`n=== Restart Atlas Intelligence ===" -ForegroundColor Cyan
$atlasListener = Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($atlasListener) { Stop-Process -Id $atlasListener.OwningProcess -Force }
$starter = 'C:\LocalAI\Start-LocalAI.ps1'
if (Test-Path -LiteralPath $starter) { & $starter }
else {
    $env:PYTHONUTF8 = '1'
    Start-Process -FilePath $Python -ArgumentList @((Join-Path $RepoRoot 'atlas_intelligence.py'),'--host','0.0.0.0','--no-browser') -WorkingDirectory $RepoRoot -WindowStyle Hidden
}

$atlasReady = $false
for ($i=0; $i -lt 60; $i++) {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 2
        if ($health.ok -eq $true) { $atlasReady = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 500
}
if (-not $atlasReady) { throw 'Atlas Intelligence did not become healthy on 127.0.0.1:8765.' }

Write-Host "`n=== Runtime verification ===" -ForegroundColor Cyan
$localHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:3080/healthz' -TimeoutSec 5
if ($localHealth.status -ne 'ok') { throw 'Local AI /healthz did not report status=ok.' }
$history = Invoke-RestMethod -Uri 'http://127.0.0.1:3080/api/atlas/investigations?limit=3' -TimeoutSec 10
if ($null -eq $history.items) { throw 'Local AI Atlas investigation history proxy did not return items.' }
$liveJs = curl.exe -ks https://localai.home.arpa/atlas-investigations.js
if ($LASTEXITCODE -ne 0 -or $liveJs -notmatch 'atlas-investigations-v1') { throw 'HTTPS did not serve the Atlas investigation viewer.' }
$liveSw = curl.exe -ks https://localai.home.arpa/sw.js
if ($LASTEXITCODE -ne 0 -or $liveSw -notmatch 'investigations1-atlas1') { throw 'HTTPS service worker does not contain the Atlas investigation cache generation.' }

Write-Host ''
Write-Host 'PASS: Atlas Investigations v1 is installed and runtime-visible.' -ForegroundColor Green
Write-Host 'Architecture now runs Goose, saves the actual result, exposes history, and renders reports in Local AI.'
Write-Host 'Existing prompt-only files remain visible as Legacy prompt.'
Write-Host 'Open: https://localai.home.arpa/#architecture'
