param(
    [int]$Port = 3080,
    [int]$MaxJobs = 5
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$bridgeRoot = 'C:\LocalAI\powershell-bridge'
$tokenFile = Join-Path $bridgeRoot 'host-token.txt'
$jobRoot = Join-Path $bridgeRoot 'jobs'

if (-not (Test-Path $tokenFile)) { throw "PowerShell bridge token not found: $tokenFile" }
New-Item -ItemType Directory -Path $jobRoot -Force | Out-Null

$token = (Get-Content $tokenFile -Raw).Trim()
if (-not $token) { throw 'PowerShell bridge token is empty.' }
$headers = @{ Authorization = "Bearer $token" }
$base = "http://127.0.0.1:$Port"

function Invoke-BridgePost {
    param([string]$Path, [hashtable]$Body)
    Invoke-RestMethod -Method Post -Uri ($base + $Path) -Headers $headers -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 12) -TimeoutSec 30
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
        $cwd = Test-AllowedWorkingDirectory ([string]$job.cwd)
        if (-not (Test-Path $cwd)) { throw "Working directory does not exist: $cwd" }

        Set-Content -Path $scriptFile -Value ([string]$job.script) -Encoding UTF8
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

        if (Test-Path $outFile) { $stdout = Get-Content $outFile -Raw -ErrorAction SilentlyContinue }
        if (Test-Path $errFile) {
            $captured = Get-Content $errFile -Raw -ErrorAction SilentlyContinue
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
