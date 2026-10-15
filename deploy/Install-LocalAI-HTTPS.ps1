param(
    [string]$Name = 'localai.home.arpa',
    [string]$HostIp = '',
    [string]$Image = 'caddy:2.10-alpine',
    [string]$Repo = 'C:\LocalAI\repo',
    [switch]$SkipTrustOnHost
)
# Serves Local AI over HTTPS at https://<Name> and https://<HostIp> (ports 443/80) through a Caddy container on
# the appliance's Docker network. Port 3080 keeps working. Re-run to apply Caddyfile changes or a new IP.
# The CA certificate is exported to C:\LocalAI\https\localai-ca.crt and offered at http://<HostIp>/localai-ca.crt.
$ErrorActionPreference = 'Stop'
function Invoke-Docker { & docker @args; if ($LASTEXITCODE -ne 0) { throw "docker $($args[0]) failed ($LASTEXITCODE)" } }
if (-not $HostIp) {
    $HostIp = (Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred | Where-Object { $_.InterfaceAlias -notmatch 'vEthernet|Loopback|WSL|Docker' -and $_.PrefixOrigin -ne 'WellKnown' } | Sort-Object InterfaceMetric | Select-Object -First 1).IPAddress
}
if (-not $HostIp) { throw 'Could not find this computer''s LAN address; pass -HostIp.' }
$caddyDir = Join-Path $Repo 'deploy\caddy'
if (-not (Test-Path (Join-Path $caddyDir 'Caddyfile'))) { throw "Caddyfile not found in $caddyDir" }
$network = (docker inspect local-ai-appliance --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}').Trim().Split(' ')[0]
if (-not $network) { throw 'The local-ai-appliance container is not running.' }

& docker image inspect $Image *> $null
if ($LASTEXITCODE -ne 0) { throw "Image $Image is not present. Pull it once from a normal (non-SSH) session: docker pull $Image" }

& docker rm -f local-ai-https *> $null
Invoke-Docker volume create localai-caddy-data | Out-Null
Invoke-Docker run -d --name local-ai-https --restart unless-stopped --network $network `
    -p 80:80 -p 443:443 -v localai-caddy-data:/data -v "${caddyDir}:/etc/caddy:ro" `
    -e "LOCALAI_NAME=$Name" -e "LOCALAI_HOST_IP=$HostIp" $Image | Out-Null

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
"HTTPS ready: https://$HostIp and https://$Name (add '$HostIp $Name' to your router's DNS or each device's hosts file)."
"CA certificate: $(Join-Path $out 'localai-ca.crt'); devices can download it from http://$HostIp/localai-ca.crt"
