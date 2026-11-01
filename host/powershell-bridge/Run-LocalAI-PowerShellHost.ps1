param(
    [int]$Port = 3080,
    [int]$MaxJobs = 5,
    # Tests point this at a scratch folder so they never touch the real token and key.
    [string]$BridgeRoot = 'C:\LocalAI\powershell-bridge'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$bridgeRoot = $BridgeRoot
$tokenFile = Join-Path $bridgeRoot 'host-token.txt'
$approvalKeyFile = Join-Path $bridgeRoot 'approval-key.txt'
$jobRoot = Join-Path $bridgeRoot 'jobs'

if (-not (Test-Path $tokenFile)) { throw "PowerShell bridge token not found: $tokenFile" }
New-Item -ItemType Directory -Path $jobRoot -Force | Out-Null

$token = (Get-Content $tokenFile -Raw).Trim()
if (-not $token) { throw 'PowerShell bridge token is empty.' }
$headers = @{ Authorization = "Bearer $token" }

# Jobs are signed in the browser with this key, which never leaves the host and the operator's browser.
# The appliance container can be fully compromised without being able to produce a runnable job.
if (-not (Test-Path $approvalKeyFile)) { throw "PowerShell approval key not found: $approvalKeyFile (run Enable-LocalAI-PowerShellHost.ps1)" }
$approvalKey = (Get-Content $approvalKeyFile -Raw).Trim()
if ($approvalKey.Length -lt 32) { throw 'PowerShell approval key is missing or too short.' }

function Test-JobSignature {
    param($Job)
    $message = "localai-ps-v1`n$([string]$Job.id)`n$([string]$Job.cwd)`n$([string]$Job.timeoutSec)`n$([string]$Job.script)"
    $hmac = New-Object System.Security.Cryptography.HMACSHA256 (,[System.Text.Encoding]::UTF8.GetBytes($approvalKey))
    try { $expected = ($hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($message)) | ForEach-Object { $_.ToString('x2') }) -join '' }
    finally { $hmac.Dispose() }
    $actual = ([string]$Job.signature).ToLowerInvariant()
    if ($actual.Length -ne $expected.Length) { return $false }
    $diff = 0
    for ($i = 0; $i -lt $expected.Length; $i++) { $diff = $diff -bor ([int][char]$expected[$i] -bxor [int][char]$actual[$i]) }
    return $diff -eq 0
}
$base = "http://127.0.0.1:$Port"

# The ids of every job this host has started, kept here and never in the container. A signature proves the operator
# approved a job, not how often: without this, a container that rewrote its own queue could hand back an old signed
# job and have it run again. A job runs once; running it again means queueing a new one, which gets a new id.
$ranFile = Join-Path $bridgeRoot 'ran-jobs.txt'
function Test-JobAlreadyRan {
    param([string]$Id)
    if (-not (Test-Path $ranFile)) { return $false }
    foreach ($line in [System.IO.File]::ReadAllLines($ranFile)) { if ($line.Split("`t")[0] -ceq $Id) { return $true } }
    return $false
}
function Add-RanJob {
    param([string]$Id)
    # No BOM (Add-Content -Encoding UTF8 writes one), so the first line's id matches like every other.
    [System.IO.File]::AppendAllText($ranFile, ("{0}`t{1}`r`n" -f $Id, (Get-Date).ToString('o')), (New-Object System.Text.UTF8Encoding($false)))
}

function Invoke-BridgePost {
    param([string]$Path, [hashtable]$Body)
    # UTF-8 bytes: a string body goes out as ISO-8859-1 in Windows PowerShell and loses any non-Latin-1 output.
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 12))
    Invoke-RestMethod -Method Post -Uri ($base + $Path) -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 30
}

function Test-AllowedWorkingDirectory {
    param([string]$PathValue)
    $full = [System.IO.Path]::GetFullPath($PathValue)
    $roots = @('C:\Projects','C:\repos','C:\LocalAI')
    foreach ($root in $roots) {
        $rootFull = [System.IO.Path]::GetFullPath($root).TrimEnd('\')
        if ($full.TrimEnd('\').Equals($rootFull,[System.StringComparison]::OrdinalIgnoreCase) -or
            $full.StartsWith($rootFull + '\',[System.StringComparison]::OrdinalIgnoreCase)) {
            return $full
        }
    }
    throw "Working directory is outside the allowed roots: $PathValue"
}

for ($n = 0; $n -lt $MaxJobs; $n++) {
    try {
        $next = Invoke-RestMethod -Uri "$base/api/powershell/host/next" -Headers $headers -TimeoutSec 15
    }
    catch {
        Write-Warning "Unable to query Local AI PowerShell queue: $($_.Exception.Message)"
        break
    }

    if (-not $next.item) { break }
    $job = $next.item
    $started = Get-Date
    $exitCode = -1
    $stdout = ''
    $stderr = ''
    $scriptFile = Join-Path $jobRoot ("{0}.ps1" -f $job.id)
    $outFile = Join-Path $jobRoot ("{0}.stdout.txt" -f $job.id)
    $errFile = Join-Path $jobRoot ("{0}.stderr.txt" -f $job.id)

    try {
        if (-not (Test-JobSignature $job)) { throw 'Rejected: the approval signature does not match this job. Re-queue it from the Workbench with the key in approval-key.txt.' }
        if ([string]$job.id -notmatch '^[A-Za-z0-9_-]{1,80}$') { throw 'Rejected: the job id is not one the Workbench makes.' }
        if (Test-JobAlreadyRan ([string]$job.id)) { throw 'Refused: this job already ran on this host. A job runs once; queue a new one from the Workbench to run it again.' }
        $cwd = Test-AllowedWorkingDirectory ([string]$job.cwd)
        if (-not (Test-Path $cwd)) { throw "Working directory does not exist: $cwd" }

        # The job writes its output as UTF-8 (not the console code page), and it is read back as UTF-8 below.
        Set-Content -Path $scriptFile -Value ("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; `$OutputEncoding = [System.Text.Encoding]::UTF8`r`n" + [string]$job.script) -Encoding UTF8
        Remove-Item $outFile,$errFile -Force -ErrorAction SilentlyContinue

        $argLine = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptFile`""
        Add-RanJob ([string]$job.id)  # before it starts: a runner that dies mid-job must not run it again next time
        $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argLine -WorkingDirectory $cwd -RedirectStandardOutput $outFile -RedirectStandardError $errFile -PassThru -WindowStyle Hidden
        $timeoutMs = [Math]::Max(5000, [Math]::Min(600000, [int]$job.timeoutSec * 1000))
        if (-not $proc.WaitForExit($timeoutMs)) {
            # The whole tree: Kill() stops only powershell.exe and leaves anything the script started still running.
            & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null
            try { if (-not $proc.HasExited) { $proc.Kill() } } catch {}
            $exitCode = 124
            $stderr = "PowerShell job exceeded timeout of $($job.timeoutSec) seconds."
        }
        else {
            $exitCode = $proc.ExitCode
        }

        if (Test-Path $outFile) { $stdout = Get-Content $outFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue }
        if (Test-Path $errFile) {
            $captured = Get-Content $errFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
            if ($captured) { $stderr = (($stderr + "`r`n" + $captured).Trim()) }
        }
    }
    catch {
        $exitCode = 1
        $stderr = $_.Exception.Message
    }

    $durationMs = [int]((Get-Date) - $started).TotalMilliseconds
    try {
        Invoke-BridgePost '/api/powershell/host/result' @{
            id = [string]$job.id
            exitCode = $exitCode
            stdout = [string]$stdout
            stderr = [string]$stderr
            durationMs = $durationMs
        } | Out-Null
    }
    catch {
        Write-Warning "Unable to report PowerShell result for $($job.id): $($_.Exception.Message)"
    }
}
