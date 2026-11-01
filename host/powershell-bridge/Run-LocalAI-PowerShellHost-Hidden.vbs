Option Explicit

' What the 'Local AI PowerShell Host' task runs every minute: the runner beside this file, with no console window.
' powershell.exe started straight from a task in the user's session opens a window each run, even with
' -WindowStyle Hidden. Optional argument: the port (default 3080). Exits with the runner's exit code.

Dim shell
Dim fso
Dim port
Dim script
Dim command
Dim re

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

port = "3080"
If WScript.Arguments.Count > 0 Then port = WScript.Arguments(0)
Set re = New RegExp
re.Pattern = "^[0-9]{1,5}$"
If Not re.Test(port) Then WScript.Quit 2

script = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "Run-LocalAI-PowerShellHost.ps1")
command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & script & """ -Port " & port

' 0 = hidden window; True = wait for PowerShell to finish before WScript exits
WScript.Quit shell.Run(command, 0, True)
