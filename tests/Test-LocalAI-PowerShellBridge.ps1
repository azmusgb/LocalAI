param([string]$Node = 'node')
# PowerShell Workbench end to end on Windows: the appliance queues approved, signed jobs and the real host runner
# (host/powershell-bridge/Run-LocalAI-PowerShellHost.ps1, under Windows PowerShell 5.1) runs them or refuses them.
# Signatures are made by Node's crypto, a separate implementation from the runner's .NET HMAC; the browser's
# WebCrypto signing is checked against Node in tests/powershell-signing-ui.mjs.
# Uses a scratch bridge folder (never C:\LocalAI\powershell-bridge) and needs Node 22.13+ on PATH.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$id = [guid]::NewGuid().ToString('N')
$tmp = Join-Path ([IO.Path]::GetTempPath()) "localai-psbridge-$id"
$bridge = Join-Path $tmp 'bridge'
$data = Join-Path $tmp 'data'
# The appliance only accepts working folders under C:\Projects, C:\repos or C:\LocalAI.
$work = "C:\LocalAI\ci-powershell-$id"
New-Item -ItemType Directory -Force -Path $bridge, $data, $work | Out-Null

$uiToken = "ui-$id"
$bridgeToken = "bridge-$id"
$key = -join ((1..48) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
[IO.File]::WriteAllText((Join-Path $bridge 'host-token.txt'), $bridgeToken)
[IO.File]::WriteAllText((Join-Path $bridge 'approval-key.txt'), $key)

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $listener.Start()
$port = $listener.LocalEndpoint.Port; $listener.Stop()
$base = "http://127.0.0.1:$port"

$failures = 0
function Check([string]$Name, [scriptblock]$Body) {
    try { & $Body; Write-Host "PASS $Name" }
    catch { $script:failures++; Write-Host "FAIL $Name : $($_.Exception.Message)" }
}
function Assert-Equal($Actual, $Expected, [string]$What) { if ($Actual -ne $Expected) { throw "$What`: expected '$Expected', got '$Actual'" } }

# The child inherits these; Start-Process in Windows PowerShell has no -Environment.
$saved = @{}
$vars = @{ PORT = "$port"; DATA_DIR = $data; WORKSPACE_ROOT = $data; POWERSHELL_UI_TOKEN = $uiToken; POWERSHELL_BRIDGE_TOKEN = $bridgeToken }
foreach ($k in $vars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $vars[$k]) }
$server = Start-Process -FilePath $Node -ArgumentList "`"$repo\app\server.js`"" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $tmp 'server.log') -RedirectStandardError (Join-Path $tmp 'server.err')
foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }

try {
    $up = $false
    for ($i = 0; $i -lt 100 -and -not $up; $i++) { try { $up = (Invoke-RestMethod "$base/healthz" -TimeoutSec 2).status -eq 'ok' } catch { Start-Sleep -Milliseconds 200 } }
    if (-not $up) { Get-Content (Join-Path $tmp 'server.err') -ErrorAction SilentlyContinue; throw 'The appliance did not start' }

    $ui = @{ 'X-LocalAI-PowerShell-Token' = $uiToken }
    function Ui([string]$Path, [hashtable]$Body) {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Compress))
        Invoke-RestMethod -Method Post -Uri "$base$Path" -Headers $ui -ContentType 'application/json; charset=utf-8' -Body $bytes
    }
    # Node signs: localai-ps-v1 \n id \n cwd \n timeoutSec \n script, HMAC-SHA256 keyed by the approval key.
    function Sign($Job, [string]$Key) {
        $file = Join-Path $tmp "sign-$($Job.id).json"
        [IO.File]::WriteAllText($file, (@{ key = $Key; id = $Job.id; cwd = $Job.cwd; timeoutSec = $Job.timeoutSec; script = $Job.script } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
        $code = "const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(require('crypto').createHmac('sha256',j.key).update('localai-ps-v1\n'+j.id+'\n'+j.cwd+'\n'+j.timeoutSec+'\n'+j.script,'utf8').digest('hex'))"
        return (& $Node -e $code $file).Trim()
    }
    function Queue([string]$Script, [int]$Timeout, [string]$SignScript = $null) {
        $job = (Ui '/api/powershell/create' @{ script = $Script; cwd = $work; timeoutSec = $Timeout }).item
        Ui '/api/powershell/approve' @{ id = $job.id; decision = 'approved' } | Out-Null
        $signed = if ($SignScript) { [pscustomobject]@{ id = $job.id; cwd = $job.cwd; timeoutSec = $job.timeoutSec; script = $SignScript } } else { $job }
        Ui '/api/powershell/request-run' @{ id = $job.id; confirmation = 'RUN'; signature = (Sign $signed $key) } | Out-Null
        return $job.id
    }

    # Non-ASCII built from code points, so this file's own encoding can't matter: "ok → é".
    $text = 'ok ' + [char]0x2192 + ' ' + [char]0xE9
    $good = Queue "Write-Output '$text'; Write-Output (Get-Location).Path" 30
    $tampered = Queue "Write-Output 'what the approver saw'" 30 "Write-Output 'something else'"
    $slow = Queue 'Start-Sleep -Seconds 30' 5

    Check 'the appliance refuses a working folder outside the allowed roots' {
        $refused = $false
        try { Ui '/api/powershell/create' @{ script = 'Get-Date'; cwd = 'C:\Windows'; timeoutSec = 10 } | Out-Null } catch { $refused = $true }
        if (-not $refused) { throw 'C:\Windows was accepted' }
    }

    # One pass of the real runner, as the scheduled task would run it.
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$repo\host\powershell-bridge\Run-LocalAI-PowerShellHost.ps1" -Port $port -MaxJobs 5 -BridgeRoot $bridge
    $jobs = @((Invoke-RestMethod -Uri "$base/api/powershell/jobs" -Headers $ui).items)
    function Job([string]$JobId) { $jobs | Where-Object { $_.id -eq $JobId } | Select-Object -First 1 }

    Check 'a signed job runs in its folder and returns UTF-8 output' {
        $j = Job $good
        Assert-Equal $j.status 'completed' 'status'
        Assert-Equal $j.exitCode 0 'exit code'
        $lines = @(([string]$j.stdout).Trim() -split "`r?`n")
        Assert-Equal $lines[0] $text 'first line'
        Assert-Equal $lines[1] $work 'working folder'
    }
    Check 'a job whose script does not match its signature is refused, not run' {
        $j = Job $tampered
        Assert-Equal $j.status 'failed' 'status'
        if ([string]$j.stderr -notmatch 'Rejected: the approval signature') { throw "stderr: $($j.stderr)" }
        if ([string]$j.stdout) { throw "it ran: $($j.stdout)" }
    }
    Check 'a job past its timeout is stopped with exit code 124' {
        $j = Job $slow
        Assert-Equal $j.exitCode 124 'exit code'
        Assert-Equal $j.status 'failed' 'status'
    }
    Check 'nothing is left queued' {
        $next = Invoke-RestMethod -Uri "$base/api/powershell/host/next" -Headers @{ Authorization = "Bearer $bridgeToken" }
        if ($next.item) { throw "still queued: $($next.item.id)" }
    }
    Check 'the runner needs the bridge token' {
        $code = 0
        try { Invoke-RestMethod -Uri "$base/api/powershell/host/next" -Headers @{ Authorization = 'Bearer wrong' } | Out-Null } catch { $code = [int]$_.Exception.Response.StatusCode }
        Assert-Equal $code 401 'status'
    }
}
finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
    Start-Sleep -Milliseconds 300
    Remove-Item -Recurse -Force $tmp, $work -ErrorAction SilentlyContinue
}
if ($failures) { Write-Host "$failures PowerShell bridge check(s) failed"; exit 1 }
Write-Host 'PowerShell bridge end to end: all checks passed'
