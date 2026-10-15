param(
    [string]$RepoRoot = 'C:\LocalAI\repo',
    [string]$AgentDir = "$env:USERPROFILE\gridcraft-local-ai",
    [string]$Workbook = "$env:USERPROFILE\Documents\GridCraft\Quarterly-Sales-Dashboard.xlsx",
    [string]$Model = 'qwen3:4b-instruct',
    [int]$Port = 8787,
    [string[]]$AllowedOrigins = @(),
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$TaskName = 'LocalAI GridCraft Bridge'
$FirewallRule = 'LocalAI GridCraft Bridge'
$BridgeScript = Join-Path $RepoRoot 'host\gridcraft-bridge.py'
$Python = Join-Path $AgentDir '.venv\Scripts\python.exe'
$LogPath = Join-Path $AgentDir 'gridcraft-bridge.log'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Run this script from an elevated PowerShell (Run as administrator); it registers a scheduled task and a firewall rule.' }

if ($Uninstall) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task and firewall rule: $TaskName"
    exit 0
}

if (-not (Test-Path $BridgeScript)) { throw "Bridge script not found: $BridgeScript" }
if (-not (Test-Path $Python)) { throw "GridCraft agent Python not found: $Python" }
if (-not (Test-Path (Join-Path $AgentDir 'gridcraft_ai.py'))) { throw "GridCraft agent not found in $AgentDir" }

# Browsers may reach LocalAI by LAN IP, localhost or the machine name; allow each of them by default.
if (-not $AllowedOrigins) {
    $hosts = @('127.0.0.1', 'localhost', $env:COMPUTERNAME, $env:COMPUTERNAME.ToLower())
    $hosts += Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '127.0.0.1' } |
        ForEach-Object { $_.IPAddress }
    $AllowedOrigins = $hosts | Select-Object -Unique | ForEach-Object { "http://${_}:3080" }
}
$origins = $AllowedOrigins -join ','

$envPath = Join-Path $AgentDir 'gridcraft-bridge.env.ps1'
@"
`$env:GRIDCRAFT_AGENT_DIR = '$AgentDir'
`$env:GRIDCRAFT_WORKBOOK = '$Workbook'
`$env:GRIDCRAFT_MODEL = '$Model'
`$env:GRIDCRAFT_BRIDGE_PORT = '$Port'
`$env:GRIDCRAFT_ALLOWED_ORIGINS = '$origins'
`$env:PYTHONUNBUFFERED = '1'
& '$Python' '$BridgeScript' *>> '$LogPath'
"@ | Set-Content -Path $envPath -Encoding UTF8

# Restart cleanly if an older bridge is already holding the port.
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$envPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

if (-not (Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $FirewallRule -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private,Domain | Out-Null
}

Start-ScheduledTask -TaskName $TaskName

$health = $null
for ($i = 0; $i -lt 20 -and -not $health; $i++) {
    Start-Sleep -Milliseconds 500
    try { $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2 } catch { }
}
if (-not $health) { throw "Bridge did not answer on port $Port. See $LogPath" }

Write-Host "Installed and started: $TaskName"
$health | Format-List
Write-Host "Allowed origins: $origins"
Write-Host "Log: $LogPath"
Write-Host "LocalAI UI: http://<this-host>:3080/gridcraft.html"
