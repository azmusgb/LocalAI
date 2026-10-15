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
        $cwd = Test-AllowedWorkingDirectory ([string]$job.cwd)
        if (-not (Test-Path $cwd)) { throw "Working directory does not exist: $cwd" }

        # The job writes its output as UTF-8 (not the console code page), and it is read back as UTF-8 below.
        Set-Content -Path $scriptFile -Value ("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; `$OutputEncoding = [System.Text.Encoding]::UTF8`r`n" + [string]$job.script) -Encoding UTF8
        Remove-Item $outFile,$errFile -Force -ErrorAction SilentlyContinue

        $argLine = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptFile`""
        $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argLine -WorkingDirectory $cwd -RedirectStandardOutput $outFile -RedirectStandardError $errFile -PassThru -WindowStyle Hidden
        $timeoutMs = [Math]::Max(5000, [Math]::Min(600000, [int]$job.timeoutSec * 1000))
        if (-not $proc.WaitForExit($timeoutMs)) {
            try { $proc.Kill() } catch {}
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
