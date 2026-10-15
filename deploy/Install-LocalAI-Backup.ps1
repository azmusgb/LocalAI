param([string]$At = '02:30', [string]$RepoRoot = 'C:\LocalAI\repo', [switch]$Uninstall)
# Schedules deploy\Backup-LocalAI-Data.ps1 nightly. Docker Desktop runs in the user session, so the task runs
# for the logged-on user; StartWhenAvailable catches up a missed night after the machine was off.
$ErrorActionPreference = 'Stop'
$TaskName = 'LocalAI Nightly Backup'
if ($Uninstall) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue; Write-Host "Removed $TaskName"; exit 0 }
$script = Join-Path $RepoRoot 'deploy\Backup-LocalAI-Data.ps1'
if (-not (Test-Path $script)) { throw "Backup script not found: $script" }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "Scheduled $TaskName daily at $At"
