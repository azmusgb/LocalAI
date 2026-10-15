param(
    [string]$ShortcutName = "GridCraft Local AI",
    [string]$AgentDir = "$env:USERPROFILE\gridcraft-local-ai"
)

$ErrorActionPreference = "Stop"

$Launcher = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "Start-GridCraft-AI.ps1"
if (-not (Test-Path $Launcher)) {
    throw "Launcher not found: $Launcher"
}

$Desktop = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $Desktop "$ShortcutName.lnk"

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)

# The launcher ends in the agent's interactive prompt, so open the console normally rather than minimized.
$Shortcut.TargetPath = "powershell.exe"
$Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Launcher`""
$Shortcut.WorkingDirectory = $AgentDir
$Shortcut.WindowStyle = 1
$Shortcut.Description = "Start GridCraft, Ollama integration, and the local AI spreadsheet agent"

$GridCraftExe = "C:\Program Files\GridCraft\gridcraft.exe"
if (Test-Path $GridCraftExe) {
    $Shortcut.IconLocation = "$GridCraftExe,0"
}

$Shortcut.Save()

Write-Host "Desktop shortcut: $ShortcutPath"
Write-Host "Launcher: $Launcher"
