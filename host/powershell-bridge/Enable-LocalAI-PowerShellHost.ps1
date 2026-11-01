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

# Approval key: signs Workbench jobs in the browser and is checked here on the host. It must never be given to the container.
$approvalKeyFile='C:\LocalAI\powershell-bridge\approval-key.txt'
if(-not(Test-Path $approvalKeyFile)){
    $bytes=New-Object byte[] 32;[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    [System.IO.File]::WriteAllText($approvalKeyFile,(($bytes|ForEach-Object{$_.ToString('x2')})-join''))
    Write-Host "Created approval key: $approvalKeyFile (enter it in the Workbench when queueing a job)"
}

$actionArgs='-NoProfile -ExecutionPolicy Bypass -File "{0}" -Port {1}' -f $helper,$Port
# conhost --headless starts PowerShell with no console window; the task runs every minute in the owner's session,
# so a plain powershell.exe would flash a black window each time.
$action=New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ('--headless powershell.exe '+$actionArgs)
$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(20) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Description 'Executes explicitly approved Local AI PowerShell Workbench jobs as the logged-on user at limited privilege.' -Force | Out-Null
Write-Host "Scheduled task enabled: $taskName"
