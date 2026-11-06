[CmdletBinding()]
param(
    # The id of a scheduled-task part with a home in deploy/host-parts.json (Atlas: atlas).
    [Parameter(Mandatory)][string]$Part,
    [string]$Repo = 'C:\LocalAI\repo',
    # Put the task back on the checkout (and leave its home folder in place).
    [switch]$Undo
)
# Moves a host part's scheduled task onto its own copy of the release (#450), once, by the owner. Only the task's
# working folder changes (its command runs the script by a relative name); its trigger, account and settings stay. The
# copy is the checkout's current release. The task is restarted and checked; if it doesn't come back it is put back on
# the checkout and restarted. Run from an elevated Windows PowerShell on the host.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Deployment-LocalAI.ps1')

$entry = @(Get-LocalAI-HostParts $Repo | Where-Object { $_.id -eq $Part })[0]
if (-not $entry -or $entry.kind -ne 'scheduled-task' -or -not $entry.home) { throw "$Part isn't a scheduled-task part with a home in deploy/host-parts.json" }
$task = Get-ScheduledTask -TaskName $entry.task -ErrorAction SilentlyContinue
if (-not $task) { throw "The task $($entry.task) isn't on this host" }
$action = @($task.Actions)[0]
$partHome = Get-LocalAI-HostPartHome $entry $Repo
$target = if ($Undo) { [System.IO.Path]::GetFullPath($Repo) } else { $partHome }
foreach ($path in @($entry.paths)) {
    if ("$($action.Execute) $($action.Arguments)" -match [regex]::Escape((Join-Path $Repo $path))) { throw "The task names $path by its full path in the checkout; change its command to the bare name first" }
}

function Set-TaskFolder([string]$Folder) {
    $next = New-ScheduledTaskAction -Execute $action.Execute -Argument $action.Arguments -WorkingDirectory $Folder
    Set-ScheduledTask -TaskName $entry.task -Action $next | Out-Null
}

if (-not $Undo) {
    $preference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $commit = ([string](git -C $Repo rev-parse HEAD 2>$null)).Trim()
    $ErrorActionPreference = $preference
    if ($commit -notmatch '^[a-f0-9]{40}$') { throw "Can't read the checkout's commit" }
    Copy-LocalAI-HostPartFiles $entry $Repo "$partHome.next" $commit $Repo
}
$was = [string]$action.WorkingDirectory
Stop-LocalAI-HostTask $entry
if (-not $Undo) {
    if (Test-Path -LiteralPath $partHome) { Remove-Item -LiteralPath $partHome -Recurse -Force }
    Move-Item -LiteralPath "$partHome.next" -Destination $partHome
}
Set-TaskFolder $target
Start-LocalAI-HostTask $entry
if (Wait-LocalAI-HostPartHealth $entry) {
    Write-Host "$($entry.task) runs from $target and answers $($entry.health)." -ForegroundColor Green
    return
}
Stop-LocalAI-HostTask $entry
Set-TaskFolder $was
Start-LocalAI-HostTask $entry
$back = if (Wait-LocalAI-HostPartHealth $entry) { 'it runs from there again' } else { "it doesn't answer $($entry.health) there either" }
throw "$($entry.task) didn't come back from $target; put back on $was, and $back"
