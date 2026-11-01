// The 'Local AI PowerShell Host' task runs every minute in the user's session. Started as powershell.exe it flashed
// a console window each run, so it starts the runner through the hidden .vbs launcher; the deploy keeps that
// launcher's installed copy current like the runner's. These read the scripts, which only run on the Windows host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const ENABLE = 'host/powershell-bridge/Enable-LocalAI-PowerShellHost.ps1';
const LAUNCHER = 'host/powershell-bridge/Run-LocalAI-PowerShellHost-Hidden.vbs';

test('the task starts the runner through wscript and the hidden launcher, not powershell.exe', () => {
  const s = read(ENABLE);
  const action = s.match(/New-ScheduledTaskAction -Execute '([^']+)' -Argument \$actionArgs/);
  assert.ok(action, `${ENABLE}: task action not found`);
  assert.equal(action[1], 'wscript.exe');
  assert.match(s, /\$launcher='C:\\LocalAI\\powershell-bridge\\Run-LocalAI-PowerShellHost-Hidden\.vbs'/);
  assert.match(s, /\$actionArgs='\/\/B \/\/Nologo "\{0\}" \{1\}' -f \$launcher,\$Port/);
  assert.match(s, /if\(-not\(Test-Path \$launcher\)\)\{throw/);
});

test('the launcher runs the runner beside it, hidden, waits, and passes on its exit code', () => {
  const s = read(LAUNCHER);
  assert.match(s, /GetParentFolderName\(WScript\.ScriptFullName\), "Run-LocalAI-PowerShellHost\.ps1"/);
  assert.match(s, /WScript\.Quit shell\.Run\(command, 0, True\)/);
  assert.match(s, /re\.Pattern = "\^\[0-9\]\{1,5\}\$"/);
  assert.doesNotMatch(s, /C:\\LocalAI/, 'the launcher finds the runner beside it, not at a fixed path');
});

test('a release updates the installed launcher as well as the runner', () => {
  const s = read('deploy/Deployment-LocalAI.ps1');
  const fn = s.slice(s.indexOf('function Update-LocalAI-PowerShellHost'), s.indexOf('function Copy-LocalAI-AppTree'));
  assert.match(fn, /@\('Run-LocalAI-PowerShellHost\.ps1', 'Run-LocalAI-PowerShellHost-Hidden\.vbs'\)/);
});
