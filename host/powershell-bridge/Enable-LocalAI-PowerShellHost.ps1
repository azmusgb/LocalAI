param([int]$Port=3080,[switch]$Disable)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$taskName='Local AI PowerShell Host'
$helper='C:\LocalAI\powershell-bridge\Run-LocalAI-PowerShellHost.ps1'

if($Disable){
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host 'Local AI PowerShell Host scheduled task disabled.'
    exit 0
}
if(-not(Test-Path $helper)){throw "PowerShell host helper not found: $helper"}

$actionArgs='-NoProfile -ExecutionPolicy Bypass -File "{0}" -Port {1}' -f $helper,$Port
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $actionArgs
$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(20) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Description 'Executes explicitly approved Local AI PowerShell Workbench jobs as the logged-on user at limited privilege.' -Force | Out-Null
Write-Host "Scheduled task enabled: $taskName"
