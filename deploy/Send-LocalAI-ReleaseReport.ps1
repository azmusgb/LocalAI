param(
    # Queue: add one report to the outbox, then send. Flush: send what the outbox holds (every Safe Deploy run).
    [ValidateSet('Queue', 'Flush')]
    [string]$Action = 'Flush',
    [string]$Commit = '',
    [ValidateSet('', 'deployed', 'failed', 'rolled-back')]
    [string]$Result = '',
    [string]$Running = '',
    [string]$Head = '',
    [string]$Message = '',
    [string]$StateDir = 'C:\LocalAI\.deploy',
    [string]$HubUrl = 'https://hub.rahe-home.duckdns.org',
    # Placed by pi-hub's deploy/deploy-key.sh localai, readable by this task's account only. Never logged.
    [string]$KeyFile = 'C:\LocalAI\stack\pi-hub-deploy.key'
)
# Local AI's release report to Pi Hub (platform step 3): Pi Hub's release:localai record is the canonical "what is live"
# for Local AI, and this deploy writes it. Reports wait in an outbox and go out oldest first; one Pi Hub didn't take
# stays for the next run (Safe Deploy runs every 5 minutes), so a deploy while Pi Hub is down is reported once it is
# back. A report Pi Hub refuses as invalid (400) is dropped: it would never be taken. Never fails the caller.
$ErrorActionPreference = 'Stop'
$outbox = Join-Path $StateDir 'release-outbox.json'
$keep = 20

function Read-Outbox {
    # Piping the parsed value enumerates it: Windows PowerShell's ConvertFrom-Json returns a JSON array as one object.
    try { $parsed = Get-Content $outbox -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json } catch { return @() }
    return @($parsed | Where-Object { $_ })
}
function Write-Outbox($items) {
    if (@($items).Count -eq 0) { Remove-Item $outbox -ErrorAction SilentlyContinue; return }
    $tmp = "$outbox.new"
    # -InputObject keeps a one-item list a list; ConvertTo-Json would otherwise write a bare object.
    Set-Content -Path $tmp -Value (ConvertTo-Json -InputObject @($items) -Depth 4 -Compress) -Encoding UTF8
    Move-Item -Force $tmp $outbox
}

try {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    $items = @(Read-Outbox | Where-Object { $_ })
    if ($Action -eq 'Queue') {
        if ($Commit -notmatch '^[0-9a-f]{7,40}$' -or -not $Result) { throw 'A report needs a commit and a result.' }
        $report = [ordered]@{ target = 'localai'; commit = $Commit; result = $Result; at = (Get-Date).ToUniversalTime().ToString('o')
                              mechanism = 'safe-deploy'; message = $(if ($Message.Length -gt 200) { $Message.Substring(0, 200) } else { $Message }) }
        if ($Running -match '^[0-9a-f]{7,40}$') { $report.running = $Running }
        if ($Head -match '^[0-9a-f]{7,40}$') { $report.head = $Head }
        $items = @($items) + @([pscustomobject]$report) | Select-Object -Last $keep
        Write-Outbox $items
    }
    if (@($items).Count -eq 0) { exit 0 }
    $key = if (Test-Path $KeyFile) { ([IO.File]::ReadAllText($KeyFile)).Trim() } else { '' }
    if (-not $key) { Write-Output "release report: no deploy key yet; $(@($items).Count) waiting"; exit 0 }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $left = New-Object System.Collections.ArrayList
    $stop = $false
    foreach ($item in $items) {
        if ($stop) { [void]$left.Add($item); continue }
        $fields = [ordered]@{}
        foreach ($p in $item.PSObject.Properties) { if ($p.Name -ne 'target') { $fields[$p.Name] = $p.Value } }
        # UTF-8 bytes: Windows PowerShell sends a string body as ISO-8859-1.
        $body = [Text.Encoding]::UTF8.GetBytes(($fields | ConvertTo-Json -Compress))
        try {
            Invoke-RestMethod -Method Post -Uri "$HubUrl/api/releases/localai" -Headers @{ 'X-Hub-Deploy-Key' = $key } `
                -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 15 | Out-Null
            Write-Output "release report: $($item.result) $($item.commit.Substring(0, 7)) taken"
        } catch {
            $status = 0
            if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
            if ($status -eq 400) {
                Write-Output "release report: $($item.result) $($item.commit.Substring(0, 7)) refused as invalid; dropped"
            } else {
                # Pi Hub down, unreachable or refusing the key: keep this one and everything after it, in order.
                Write-Output "release report: Pi Hub didn't take it (status $status); kept for the next run"
                [void]$left.Add($item)
                $stop = $true
            }
        }
    }
    Write-Outbox @($left)
} catch {
    Write-Output "release report: $($_.Exception.Message)"
}
exit 0
