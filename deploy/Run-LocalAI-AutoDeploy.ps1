param(
    [string]$TargetRef = 'origin/main',
    [string]$Repo = 'C:\LocalAI\repo',
    [string]$StateDir = 'C:\LocalAI\.deploy',
    [string]$NotifyUrl = 'http://127.0.0.1:3080/api/notifications/system'
)
# What the 'LocalAI Safe Deploy' task runs every few minutes. Keeps the host checkout current, runs the safe
# deploy (certify, promote, health-check, roll back), logs it, and tells the Inbox when something happened:
# a new release went live, or a deploy failed (once per failing commit, not on every retry). No change = silent.
$ErrorActionPreference = 'Continue'
# git prints UTF-8; without this Windows PowerShell decodes it with the console code page (IBM437), so a commit
# subject with an em dash reached the Inbox as mojibake.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$log = Join-Path $StateDir 'auto-deploy.log'
$failState = Join-Path $StateDir 'auto-deploy-last-failure.txt'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
function Notify([string]$title, [string]$detail, [hashtable]$meta) {
    # Send UTF-8 bytes: Windows PowerShell sends a string body as ISO-8859-1, turning an em dash into '-' and arrows into '?'.
    $body = [System.Text.Encoding]::UTF8.GetBytes((@{ kind = 'deploy'; title = $title; detail = $detail; meta = $meta } | ConvertTo-Json -Compress))
    try { Invoke-RestMethod -Method Post -Uri $NotifyUrl -ContentType 'application/json; charset=utf-8' -TimeoutSec 10 -Body $body | Out-Null } catch { }
}

# The deploy scripts themselves come from this checkout, so fast-forward it when it tracks main and is clean.
if ($TargetRef -eq 'origin/main' -and -not (git -C $Repo status --porcelain 2>$null)) { git -C $Repo pull -q --ff-only origin main 2>&1 | Out-Null }

$started = Get-Date
$output = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $Repo 'deploy\Deploy-LocalAI.ps1') -TargetRef $TargetRef -Repo $Repo -StateDir $StateDir 2>&1 | ForEach-Object { "$_" }
$code = $LASTEXITCODE
$last = ($output | Where-Object { $_ -match '^(DEPLOYED|NO CHANGE):' } | Select-Object -Last 1)
$sha = [string](git -C $Repo rev-parse --verify "$TargetRef^{commit}" 2>$null)
$short = if ($sha) { $sha.Trim().Substring(0, 12) } else { 'unknown' }

# Keep the log bounded: the last run in full plus a one-line history.
$summary = "{0} exit={1} {2} {3}" -f $started.ToString('s'), $code, $short, ($(if ($last) { $last } else { 'FAILED' }))
$history = @(if (Test-Path $log) { Get-Content $log | Where-Object { $_ -match '^\d{4}-\d\d-\d\dT' } | Select-Object -Last 500 })
Set-Content -Path $log -Value (@($history) + $summary + '--- last run ---' + $output) -Encoding UTF8

if ($code -eq 0 -and $last -like 'DEPLOYED:*') {
    $subject = [string](git -C $Repo log -1 --format=%s $sha 2>$null)
    Notify "Local AI updated to $short" $subject @{ commit = $sha.Trim(); outcome = 'deployed' }
    Remove-Item $failState -ErrorAction SilentlyContinue
} elseif ($code -ne 0) {
    $previous = if (Test-Path $failState) { (Get-Content $failState -Raw).Trim() } else { '' }
    if ($previous -ne $short) {
        $cause = ($output | Where-Object { $_ -match 'failed|Exception|Cannot|rolled|restored' } | Select-Object -Last 3) -join "`n"
        Notify "Automatic update to $short failed" ("The previous release is still running. " + $cause) @{ commit = "$sha".Trim(); outcome = 'failed'; log = $log }
        Set-Content -Path $failState -Value $short
    }
}
exit $code
