param(
    [string]$Name = 'localai.home.arpa',
    [string]$HostIp = '',
    [string]$Image = 'caddy:2.10-alpine',
    [string]$Repo = 'C:\LocalAI\repo',
    [string]$RemoteName = '',
    [switch]$NoRemote,
    [switch]$SkipTrustOnHost
)
# Serves Local AI over HTTPS at https://<Name> and https://<HostIp> (ports 443/80) through a Caddy container on
# the appliance's Docker network. Port 3080 keeps working. Re-run to apply Caddyfile changes or a new IP.
# The CA certificate is exported to C:\LocalAI\https\localai-ca.crt and offered at http://<HostIp>/localai-ca.crt.
# Away from home: with Tailscale signed in on this computer, its Tailscale name (or -RemoteName) is added too, and ports
# 80/443 are opened to Tailscale addresses (100.64.0.0/10) only. -NoRemote leaves it out.
# On a host whose containers come from deploy\stack\compose.yml, the values go into stack.env and compose recreates
# Caddy and the appliance (so the phone QR code in Health picks up the Tailscale name); otherwise Caddy is run directly.
$ErrorActionPreference = 'Stop'
function Invoke-Docker { & docker @args; if ($LASTEXITCODE -ne 0) { throw "docker $($args[0]) failed ($LASTEXITCODE)" } }
if (-not $HostIp) {
    $HostIp = (Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred | Where-Object { $_.InterfaceAlias -notmatch 'vEthernet|Loopback|WSL|Docker' -and $_.PrefixOrigin -ne 'WellKnown' } | Sort-Object InterfaceMetric | Select-Object -First 1).IPAddress
}
if (-not $HostIp) { throw 'Could not find this computer''s LAN address; pass -HostIp.' }
# A fresh Tailscale install is not on PATH until a new session, so also look where its installer puts it.
$tailscale = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $tailscale -and (Test-Path "$env:ProgramFiles\Tailscale\tailscale.exe")) { $tailscale = "$env:ProgramFiles\Tailscale\tailscale.exe" }
if (-not $RemoteName -and -not $NoRemote -and $tailscale) {
    try {
        $status = & $tailscale status --json | ConvertFrom-Json
        # Only a signed-in node has a name others can reach.
        if ($status.BackendState -eq 'Running') { $RemoteName = ([string]$status.Self.DNSName).TrimEnd('.').ToLowerInvariant() }
    } catch { $RemoteName = '' }
}
if ($NoRemote) { $RemoteName = '' }
if ($RemoteName -and $RemoteName -notmatch '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$') { throw "Not a host name: $RemoteName" }
# Caddy must never get an empty site address (it would drop every host match), so no Tailscale means a placeholder.
$remoteSite = if ($RemoteName) { $RemoteName } else { 'localai.remote.invalid' }
$caddyDir = Join-Path $Repo 'deploy\caddy'
if (-not (Test-Path (Join-Path $caddyDir 'Caddyfile'))) { throw "Caddyfile not found in $caddyDir" }
$network = (docker inspect local-ai-appliance --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}').Trim().Split(' ')[0]
if (-not $network) { throw 'The local-ai-appliance container is not running.' }

& docker image inspect $Image *> $null
if ($LASTEXITCODE -ne 0) { throw "Image $Image is not present. Pull it once from a normal (non-SSH) session: docker pull $Image" }

# Sets KEY=value lines in stack.env, keeping every other line, its order, and the file's permissions.
function Set-StackEnv([string]$Path, [hashtable]$Values) {
    $lines = [System.Collections.Generic.List[string]]@(Get-Content -LiteralPath $Path)
    foreach ($key in $Values.Keys) {
        $at = -1; for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -like "$key=*") { $at = $i; break } }
        if ($at -ge 0) { $lines[$at] = "$key=$($Values[$key])" } else { $lines.Add("$key=$($Values[$key])") }
    }
    [IO.File]::WriteAllText($Path, (($lines -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding($false)))
}
$stackEnv = 'C:\LocalAI\stack\stack.env'; $compose = Join-Path $Repo 'deploy\stack\compose.yml'
$labels = (& docker inspect local-ai-https --format '{{json .Config.Labels}}' 2>$null) | ConvertFrom-Json -ErrorAction SilentlyContinue
$composed = $labels -and $labels.'com.docker.compose.project' -eq 'local-ai' -and (Test-Path $stackEnv) -and (Test-Path $compose)
if ($composed) {
    # Compose substitutes the placeholder for an empty LOCALAI_REMOTE_NAME, so Caddy never gets an empty site address.
    Set-StackEnv $stackEnv @{ LOCALAI_HOST_IP = $HostIp; LOCALAI_NAME = $Name; LOCALAI_REMOTE_NAME = $RemoteName }
    Invoke-Docker compose --env-file $stackEnv -f $compose up -d https appliance
} else {
    & docker rm -f local-ai-https *> $null
    Invoke-Docker volume create localai-caddy-data | Out-Null
    Invoke-Docker run -d --name local-ai-https --restart unless-stopped --network $network `
        -p 80:80 -p 443:443 -v localai-caddy-data:/data -v "${caddyDir}:/etc/caddy:ro" `
        -e "LOCALAI_NAME=$Name" -e "LOCALAI_HOST_IP=$HostIp" -e "LOCALAI_REMOTE_NAME=$remoteSite" $Image | Out-Null
}

# Wait until it answers over HTTPS (the first start creates the CA).
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
    $code = & curl.exe -sk -o NUL -w '%{http_code}' --max-time 5 "https://127.0.0.1/healthz"
    if ($code -eq '200') { $ok = $true; break }
    Start-Sleep 2
}
if (-not $ok) { & docker logs --tail 30 local-ai-https; throw 'Caddy did not start serving HTTPS' }

$out = 'C:\LocalAI\https'; New-Item -ItemType Directory -Force $out | Out-Null
Invoke-Docker cp local-ai-https:/data/caddy/pki/authorities/local/root.crt (Join-Path $out 'localai-ca.crt')
if (-not $SkipTrustOnHost) {
    Import-Certificate -FilePath (Join-Path $out 'localai-ca.crt') -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
}

# Inbound 80/443 on private networks only (home Wi-Fi), never public ones.
if (-not (Get-NetFirewallRule -DisplayName 'Local AI HTTPS' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'Local AI HTTPS' -Direction Inbound -Protocol TCP -LocalPort 80,443 -Action Allow -Profile Private | Out-Null
}
# Tailscale's adapter may not be a Private network, so allow its address range on any profile, and nothing else.
if ($RemoteName -and -not (Get-NetFirewallRule -DisplayName 'Local AI HTTPS (Tailscale)' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'Local AI HTTPS (Tailscale)' -Direction Inbound -Protocol TCP -LocalPort 80,443 -RemoteAddress 100.64.0.0/10 -Action Allow -Profile Any | Out-Null
}
"HTTPS ready: https://$HostIp and https://$Name (add '$HostIp $Name' to your router's DNS or each device's hosts file)."
"CA certificate: $(Join-Path $out 'localai-ca.crt'); devices can download it from http://$HostIp/localai-ca.crt"
if ($RemoteName) {
    "Away from home (Tailscale): https://$RemoteName"
    if ($composed) { "stack.env updated and the appliance recreated: Health shows the phone QR code for it." }
    else { "For the phone QR code in Health, run the appliance with LOCALAI_REMOTE_NAME=$RemoteName." }
} elseif (-not $NoRemote) { 'Tailscale is not signed in on this computer, so access away from home is not set up.' }
