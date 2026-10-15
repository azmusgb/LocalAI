param(
    [string]$ComfyDir = 'C:\Projects\ComfyHost',
    [string]$Python = 'C:\Python312\python.exe',
    [string]$Listen = '127.0.0.1',
    [int]$Port = 8188,
    [switch]$Uninstall
)
# Runs ComfyUI (LocalAI's image generation backend) at logon and keeps it running.
# It listens on localhost only: the appliance container reaches it through host.docker.internal,
# and nothing else on the network can.
$ErrorActionPreference = 'Stop'
$TaskName = 'LocalAI ComfyUI'

if ($Uninstall) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task: $TaskName"
    exit 0
}
if (-not (Test-Path (Join-Path $ComfyDir 'main.py'))) { throw "ComfyUI not found in $ComfyDir" }
if (-not (Test-Path $Python)) { throw "Python not found: $Python" }

$action = New-ScheduledTaskAction -Execute $Python -Argument "main.py --listen $Listen --port $Port" -WorkingDirectory $ComfyDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

# Replace anything already holding the port (an old manual run).
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-ScheduledTask -TaskName $TaskName

$stats = $null
for ($i = 0; $i -lt 90 -and -not $stats; $i++) {
    Start-Sleep -Seconds 2
    try { $stats = Invoke-RestMethod "http://127.0.0.1:$Port/system_stats" -TimeoutSec 3 } catch { }
}
if (-not $stats) { throw "ComfyUI did not answer on port $Port within 3 minutes. See $ComfyDir\user\comfyui_$Port.log" }
Write-Host "ComfyUI is running: $($stats.system.comfyui_version) on $($stats.devices[0].name)"
