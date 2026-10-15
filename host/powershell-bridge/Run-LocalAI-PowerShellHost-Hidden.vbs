Option Explicit

Dim shell
Dim command

Set shell = CreateObject("WScript.Shell")

command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""C:\LocalAI\powershell-bridge\Run-LocalAI-PowerShellHost.ps1"" -Port 3080"

' 0 = hidden window
' True = wait for PowerShell to finish before WScript exits
shell.Run command, 0, True
