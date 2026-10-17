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
$AgentScript = Join-Path $RepoRoot 'host\gridcraft-agent\gridcraft_ai.py'
$Requirements = Join-Path $RepoRoot 'host\gridcraft-agent\requirements.txt'
$Python = Join-Path $AgentDir '.venv\Scripts\python.exe'
$LogPath = Join-Path $AgentDir 'gridcraft-bridge.log'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Run this script from an elevated PowerShell (Run as administrator); it registers a scheduled task that runs elevated.' }

if ($Uninstall) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task: $TaskName"
    exit 0
}

if (-not (Test-Path $BridgeScript)) { throw "Bridge script not found: $BridgeScript" }
if (-not (Test-Path $AgentScript)) { throw "GridCraft agent not found: $AgentScript" }

# The agent source lives in the repo; $AgentDir only holds its virtual environment, settings and log.
New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
# Native tools write progress and warnings to stderr; judge them by exit code, not by stderr.
$ErrorActionPreference = 'Continue'
if (-not (Test-Path $Python)) {
    Write-Host "Creating Python virtual environment in $AgentDir\.venv ..."
    & py -3.12 -m venv (Join-Path $AgentDir '.venv')
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $Python)) { throw "Could not create the agent virtual environment (requires 'py -3.12')." }
}
& $Python -m pip install --disable-pip-version-check -q -r $Requirements
if ($LASTEXITCODE -ne 0) { throw "Installing GridCraft agent dependencies failed: $Requirements" }
$ErrorActionPreference = 'Stop'

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
# Values go into single-quoted strings in a generated script: double any apostrophes (C:\Users\O'Brien).
function Format-Quoted([string]$Value) { "'" + $Value.Replace("'", "''") + "'" }
$launcher = @(
    "`$env:GRIDCRAFT_AGENT_DIR = $(Format-Quoted $AgentDir)"
    "`$env:GRIDCRAFT_AGENT_SCRIPT = $(Format-Quoted $AgentScript)"
    "`$env:GRIDCRAFT_WORKBOOK = $(Format-Quoted $Workbook)"
    "`$env:GRIDCRAFT_MODEL = $(Format-Quoted $Model)"
    "`$env:GRIDCRAFT_BRIDGE_HOST = '127.0.0.1'"
    "`$env:GRIDCRAFT_BRIDGE_PORT = $(Format-Quoted $Port)"
    "`$env:GRIDCRAFT_ALLOWED_ORIGINS = $(Format-Quoted $origins)"
    "`$env:PYTHONUNBUFFERED = '1'"
    # The bridge rotates its own log (2 MB x 3). Only a startup crash or traceback lands in the side file.
    "`$env:GRIDCRAFT_BRIDGE_LOG = $(Format-Quoted $LogPath)"
    "& $(Format-Quoted $Python) $(Format-Quoted $BridgeScript) *>> $(Format-Quoted ([IO.Path]::ChangeExtension($LogPath, '.crash.log')))"
) -join "`r`n"
# UTF-8 with BOM so Windows PowerShell 5.1 (which runs the task) reads non-ASCII paths correctly whichever edition ran this installer.
[System.IO.File]::WriteAllText($envPath, $launcher + "`r`n", (New-Object System.Text.UTF8Encoding($true)))

# Restart cleanly if an older bridge is already holding the port.
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

# Older installs appended PowerShell's UTF-16 output to the log; the bridge now writes UTF-8 itself. Archive the old file once.
if (Test-Path -LiteralPath $LogPath) {
    $head = [byte[]]::new(2)
    $stream = [System.IO.File]::OpenRead($LogPath)
    try { [void]$stream.Read($head, 0, 2) } finally { $stream.Dispose() }
    if ($head[0] -eq 0xFF -and $head[1] -eq 0xFE) {
        Move-Item -LiteralPath $LogPath -Destination ([IO.Path]::ChangeExtension($LogPath, '.legacy.log')) -Force
    }
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$envPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

# The bridge listens on loopback only and is reached through the appliance, so it needs no inbound rule.
# Remove the rule older installs created.
Remove-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue

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
Write-Host "LocalAI UI: http://<this-host>:3080/#spreadsheets (System > Spreadsheets)"
