[CmdletBinding()]
param(
    [ValidateRange(1, 1440)]
    [int]$EveryMinutes = 5,
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$ValidateOnly,
    [switch]$StartNow,
    # What to deploy: origin/main today; a release ref once releases are tagged.
    [string]$TargetRef = 'origin/main'
)

$ErrorActionPreference = 'Stop'

$TaskName = 'LocalAI Safe Deploy'
$Script = 'C:\LocalAI\repo\deploy\Run-LocalAI-AutoDeploy.ps1'
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

if ($Install -and $Uninstall) {
    throw 'Use either -Install or -Uninstall, not both.'
}

if ($Uninstall) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $existing) {
        Write-Host "Task '$TaskName' is not installed." -ForegroundColor Yellow
        return
    }

    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
    return
}

if (-not (Test-Path -LiteralPath $Script)) {
    throw "Deployment script not found: $Script"
}

if (-not (Test-Path -LiteralPath $PowerShellExe)) {
    throw "Windows PowerShell executable not found: $PowerShellExe"
}

$mode = if ($ValidateOnly) { 'validate-only' } else { 'deploy' }
$arguments = @(
    '-NoProfile'
    '-NonInteractive'
    '-WindowStyle Hidden'
    '-ExecutionPolicy Bypass'
    '-File'
    ('"{0}"' -f $Script)
    '-TargetRef'
    $TargetRef
)
if ($ValidateOnly) {
    # Certification only: run the deploy script directly without promotion or notifications.
    $arguments = $arguments -replace 'Run-LocalAI-AutoDeploy\.ps1', 'Deploy-LocalAI.ps1'
    $arguments += '-CheckOnly'
}
$argumentLine = $arguments -join ' '

if (-not $Install) {
    Write-Host 'Dry run. No scheduled task was changed.' -ForegroundColor Yellow
    Write-Host "Task:     $TaskName"
    Write-Host "Mode:     $mode"
    Write-Host "Interval: every $EveryMinutes minute(s)"
    Write-Host "Command:  $PowerShellExe $argumentLine"
    Write-Host 'Use -Install when ready, or -Install -ValidateOnly to schedule certification without promotion.'
    return
}

$action = New-ScheduledTaskAction -Execute $PowerShellExe -Argument $argumentLine
$trigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -Hidden `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

$description = if ($ValidateOnly) {
    'Hidden LocalAI candidate certification from origin/main. Production is not modified.'
} else {
    'Hidden LocalAI safe deployment from origin/main with candidate validation, health check, and rollback.'
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description $description `
    -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
Write-Host "Installed '$TaskName' in $mode mode." -ForegroundColor Green
Write-Host "State: $($task.State); interval: $EveryMinutes minute(s); hidden: True"

if ($StartNow) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host 'Started the task once immediately.' -ForegroundColor Green
}
