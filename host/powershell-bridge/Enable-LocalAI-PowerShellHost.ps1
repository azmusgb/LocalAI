param([int]$Port=3080,[switch]$Disable)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$taskName='Local AI PowerShell Host'
$helper='C:\LocalAI\powershell-bridge\Run-LocalAI-PowerShellHost.ps1'
# The task starts the runner through this launcher: powershell.exe started straight from the task opens a console
# window in the user's session every minute.
$launcher='C:\LocalAI\powershell-bridge\Run-LocalAI-PowerShellHost-Hidden.vbs'

if($Disable){
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host 'Local AI PowerShell Host scheduled task disabled.'
    exit 0
}
if(-not(Test-Path $helper)){throw "PowerShell host helper not found: $helper"}
if(-not(Test-Path $launcher)){throw "PowerShell host launcher not found: $launcher"}

# Approval key: signs Workbench jobs in the browser and is checked here on the host. It must never be given to the container.
$approvalKeyFile='C:\LocalAI\powershell-bridge\approval-key.txt'
if(-not(Test-Path $approvalKeyFile)){
    $bytes=New-Object byte[] 32;[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    [System.IO.File]::WriteAllText($approvalKeyFile,(($bytes|ForEach-Object{$_.ToString('x2')})-join''))
    Write-Host "Created approval key: $approvalKeyFile (enter it in the Workbench when queueing a job)"
}

$actionArgs='//B //Nologo "{0}" {1}' -f $launcher,$Port
$action=New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $actionArgs
$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(20) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Description 'Executes explicitly approved Local AI PowerShell Workbench jobs as the logged-on user at limited privilege.' -Force | Out-Null
Write-Host "Scheduled task enabled: $taskName"
