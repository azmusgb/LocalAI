param(
    [string]$EnvFile = 'C:\LocalAI\stack\stack.env',
    [string]$Root = 'C:\LocalAI',
    # Recreate containers that already exist but weren't made by this compose project (data volumes are kept,
    # the old containers are renamed *-pre-compose and stopped, and restored if the new stack isn't healthy).
    [switch]$Adopt,
    [switch]$DryRun
)
# Provisions every Local AI container from deploy\stack\compose.yml on a Windows host with Docker Desktop:
# creates stack.env (new secrets) if there isn't one, the folders the stack mounts, a first copy of the app, then
# starts the stack and waits for /healthz. Run it from a normal Windows session: over SSH, Docker's credential
# helper can't pull images ("A specified logon session does not exist").
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$compose = Join-Path $PSScriptRoot 'compose.yml'
function Invoke-Compose { & docker compose --env-file $EnvFile -f $compose @args; if ($LASTEXITCODE -ne 0) { throw "docker compose $($args -join ' ') failed ($LASTEXITCODE)" } }
function New-Secret { -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) }) }

# 1. stack.env: reuse the PowerShell bridge's tokens if they exist, otherwise make everything new.
if (-not (Test-Path $EnvFile)) {
    $bridge = Join-Path $Root 'powershell-bridge'
    $read = { param($f) $p = Join-Path $bridge $f; if (Test-Path $p) { (Get-Content $p -Raw).Trim() } else { $null } }
    $ui = & $read 'ui-token.txt'; if (-not $ui) { $ui = New-Secret }
    $hostToken = & $read 'host-token.txt'; if (-not $hostToken) { $hostToken = New-Secret }
    $ip = (Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred | Where-Object { $_.InterfaceAlias -notmatch 'vEthernet|Loopback|WSL|Docker' -and $_.PrefixOrigin -ne 'WellKnown' } | Sort-Object InterfaceMetric | Select-Object -First 1).IPAddress
    $lines = (Get-Content (Join-Path $PSScriptRoot 'stack.env.example')) | ForEach-Object {
        switch -Regex ($_) {
            '^LOCALAI_HOST_IP=' { "LOCALAI_HOST_IP=$ip"; break }
            '^POWERSHELL_UI_TOKEN=' { "POWERSHELL_UI_TOKEN=$ui"; break }
            '^POWERSHELL_BRIDGE_TOKEN=' { "POWERSHELL_BRIDGE_TOKEN=$hostToken"; break }
            '^(N8N_ENCRYPTION_KEY|SEARXNG_SECRET|SANDBOX_API_KEYS|SANDBOX_API_RUNNER_REGISTRATION_TOKEN|SANDBOX_API_RUNNER_API_KEY)=$' { "$($Matches[1])=$(New-Secret)"; break }
            default { $_ }
        }
    }
    New-Item -ItemType Directory -Force (Split-Path $EnvFile) | Out-Null
    [IO.File]::WriteAllText($EnvFile, (($lines -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding($false)))
    & icacls $EnvFile /inheritance:r /grant:r "${env:USERNAME}:F" /grant:r 'SYSTEM:F' | Out-Null
    New-Item -ItemType Directory -Force $bridge | Out-Null
    foreach ($pair in @(@('ui-token.txt', $ui), @('host-token.txt', $hostToken))) { $p = Join-Path $bridge $pair[0]; if (-not (Test-Path $p)) { [IO.File]::WriteAllText($p, $pair[1]) } }
    "Created $EnvFile with new secrets. Back it up: n8n's saved credentials need N8N_ENCRYPTION_KEY."
}

# 2. Folders the stack mounts, and a first copy of the app (later deploys replace it).
foreach ($dir in (Join-Path $Root 'appliance\app'), (Join-Path $Root 'reports'), 'C:\Projects', 'C:\repos') { New-Item -ItemType Directory -Force $dir | Out-Null }
$app = Join-Path $Root 'appliance\app'
if (-not (Get-ChildItem $app -Force -ErrorAction SilentlyContinue)) { Copy-Item -Path (Join-Path $repo 'app\*') -Destination $app -Recurse; "Seeded $app from the repo." }

Invoke-Compose config --quiet
if ($DryRun) { Invoke-Compose --dry-run up -d; return }

# 3. Containers that exist but belong to no compose project (or another one) are in the way.
$names = (& docker compose --env-file $EnvFile -f $compose config --format json | ConvertFrom-Json).services.PSObject.Properties.Value.container_name
$foreign = @(foreach ($n in $names) {
    # {{json}} rather than {{index ... "com.docker..."}}: Windows PowerShell 5.1 strips quotes from native arguments.
    $labels = & docker inspect $n --format '{{json .Config.Labels}}' 2>$null
    if ($LASTEXITCODE -eq 0) { $project = ($labels | ConvertFrom-Json).'com.docker.compose.project'; if ($project -ne 'local-ai') { $n } }
})
$renamed = @()
if ($foreign) {
    if (-not $Adopt) { throw "These containers exist outside this stack: $($foreign -join ', '). Re-run with -Adopt to recreate them from compose.yml (volumes are kept)." }
    foreach ($n in $foreign) { & docker rm -f "$n-pre-compose" *> $null; & docker stop $n | Out-Null; & docker rename $n "$n-pre-compose"; $renamed += $n }
}

try {
    Invoke-Compose up -d --wait
    $ok = $false
    for ($i = 0; $i -lt 30 -and -not $ok; $i++) { try { $ok = (Invoke-RestMethod http://127.0.0.1:3080/healthz -TimeoutSec 3).status -eq 'ok' } catch { Start-Sleep 2 } }
    if (-not $ok) { throw 'The appliance did not become healthy' }
} catch {
    if ($renamed) {
        "Restoring the previous containers: $_"
        Invoke-Compose down 2>$null
        foreach ($n in $renamed) { & docker rename "$n-pre-compose" $n; & docker start $n | Out-Null }
    }
    throw
}

# 4. Firewall (3080 everywhere it was before; 80/443 on private networks) and the HTTPS certificate authority.
if (-not (Get-NetFirewallRule -DisplayName 'Local AI Appliance 3080' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName 'Local AI Appliance 3080' -Direction Inbound -Protocol TCP -LocalPort 3080 -Action Allow | Out-Null }
if (-not (Get-NetFirewallRule -DisplayName 'Local AI HTTPS' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName 'Local AI HTTPS' -Direction Inbound -Protocol TCP -LocalPort 80,443 -Action Allow -Profile Private | Out-Null }
$ca = Join-Path $Root 'https\localai-ca.crt'; New-Item -ItemType Directory -Force (Split-Path $ca) | Out-Null
for ($i = 0; $i -lt 15 -and -not (Test-Path $ca); $i++) { & docker cp local-ai-https:/data/caddy/pki/authorities/local/root.crt $ca 2>$null; if (-not (Test-Path $ca)) { Start-Sleep 2 } }
if (Test-Path $ca) { Import-Certificate -FilePath $ca -CertStoreLocation Cert:\LocalMachine\Root | Out-Null }
if ($renamed) { "Adopted: $($renamed -join ', '). The old containers are stopped as *-pre-compose; remove them once you're happy." }
'Local AI stack is up: http://127.0.0.1:3080 and https://' + ((Get-Content $EnvFile | Where-Object { $_ -like 'LOCALAI_HOST_IP=*' }) -replace '^LOCALAI_HOST_IP=')
