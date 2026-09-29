$ErrorActionPreference="Stop";Set-Location C:\LocalAI\repo
Write-Host "LocalAI deployment verification" -ForegroundColor Cyan
Write-Host ("Repo HEAD: "+(git rev-parse --short HEAD));Write-Host ("Origin main: "+(git rev-parse --short origin/main))
node --check .\app\server.js;node --check .\app\public\app.js
Invoke-RestMethod http://127.0.0.1:3080/healthz -TimeoutSec 8|ConvertTo-Json -Depth 5
if(Test-Path C:\LocalAI\.deploy\state.json){Get-Content C:\LocalAI\.deploy\state.json}