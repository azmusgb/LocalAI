param(
    [string]$RepoRoot = 'C:\LocalAI\repo',
    [string]$AgentDir = "$env:USERPROFILE\gridcraft-local-ai",
    [string]$Workbook = "$env:USERPROFILE\Documents\GridCraft\Quarterly-Sales-Dashboard.xlsx",
    [string]$Model = 'qwen3:4b-instruct',
    [int]$Port = 8787,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$TaskName = 'LocalAI GridCraft Bridge'
$BridgeScript = Join-Path $RepoRoot 'host\gridcraft-bridge.py'
$Python = Join-Path $AgentDir '.venv\Scripts\python.exe'

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task: $TaskName"
    exit 0
}

if (-not (Test-Path $BridgeScript)) { throw "Bridge script not found: $BridgeScript" }
if (-not (Test-Path $Python)) { throw "GridCraft agent Python not found: $Python" }
if (-not (Test-Path (Join-Path $AgentDir 'gridcraft_ai.py'))) { throw "GridCraft agent not found in $AgentDir" }

$envPath = Join-Path $AgentDir 'gridcraft-bridge.env.ps1'
@"
`$env:GRIDCRAFT_AGENT_DIR = '$AgentDir'
`$env:GRIDCRAFT_WORKBOOK = '$Workbook'
`$env:GRIDCRAFT_MODEL = '$Model'
`$env:GRIDCRAFT_BRIDGE_PORT = '$Port'
`$env:GRIDCRAFT_ALLOWED_ORIGINS = 'http://10.0.0.21:3080,http://127.0.0.1:3080,http://localhost:3080'
& '$Python' '$BridgeScript'
"@ | Set-Content -Path $envPath -Encoding UTF8

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$envPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2

Write-Host "Installed and started: $TaskName"
Write-Host "Bridge URL: http://127.0.0.1:$Port/health"
Write-Host "LocalAI UI: http://10.0.0.21:3080/gridcraft.html"
