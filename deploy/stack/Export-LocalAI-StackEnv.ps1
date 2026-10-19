param([string]$Out = 'C:\LocalAI\stack\stack.env')
# Writes the running stack's secrets and host values to stack.env (readable only by you), so the stack can be rebuilt
# from deploy\stack\compose.yml with the same keys. Prints names, never values.
$ErrorActionPreference = 'Stop'
function EnvOf([string]$Container) {
    $h = @{}
    $lines = & docker inspect $Container --format '{{range .Config.Env}}{{println .}}{{end}}' 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Container $Container is not there" }
    foreach ($line in $lines) { if ($line) { $k, $v = $line -split '=', 2; $h[$k] = $v } }
    return $h
}
$app = EnvOf 'local-ai-appliance'; $https = EnvOf 'local-ai-https'; $n8n = EnvOf 'local-ai-n8n'
$search = EnvOf 'local-ai-searxng'; $sandbox = EnvOf 'local-ai-sandbox-api'
$sandboxImage = & docker inspect local-ai-sandbox-api --format '{{.Config.Image}}'
$values = [ordered]@{
    LOCALAI_HOST_IP = $https['LOCALAI_HOST_IP']; LOCALAI_NAME = $https['LOCALAI_NAME']; TZ = $n8n['TZ']
    LOCALAI_REMOTE_NAME = $(if ($https['LOCALAI_REMOTE_NAME'] -and $https['LOCALAI_REMOTE_NAME'] -notlike '*.invalid') { $https['LOCALAI_REMOTE_NAME'] } else { '' })
    LOCALAI_ALLOWED_HOSTS = $app['LOCALAI_ALLOWED_HOSTS']
    MAC_AI_HOME_URL = $app['MAC_AI_HOME_URL']; MAC_DSH_URL = $app['MAC_DSH_URL']
    LOCALAI_WORKSHOP_URL = $app['LOCALAI_WORKSHOP_URL']; LOCALAI_WORKSHOP_STATUS_TOKEN = $app['LOCALAI_WORKSHOP_STATUS_TOKEN']
    LOCALAI_WORKSHOP_CODE_TOKEN = $app['LOCALAI_WORKSHOP_CODE_TOKEN']
    POWERSHELL_UI_TOKEN = $app['POWERSHELL_UI_TOKEN']; POWERSHELL_BRIDGE_TOKEN = $app['POWERSHELL_BRIDGE_TOKEN']
    N8N_ENCRYPTION_KEY = $n8n['N8N_ENCRYPTION_KEY']; SEARXNG_SECRET = $search['SEARXNG_SECRET']
    N8N_SANDBOX_VERSION = ($sandboxImage -split ':')[-1]
    SANDBOX_API_KEYS = $sandbox['SANDBOX_API_KEYS']; SANDBOX_API_RUNNER_REGISTRATION_TOKEN = $sandbox['SANDBOX_API_RUNNER_REGISTRATION_TOKEN']
    SANDBOX_API_RUNNER_API_KEY = $sandbox['SANDBOX_API_RUNNER_API_KEY']
}
$missing = @($values.Keys | Where-Object { [string]::IsNullOrEmpty($values[$_]) -and $_ -notlike 'MAC_*' -and $_ -notin 'LOCALAI_REMOTE_NAME', 'LOCALAI_ALLOWED_HOSTS', 'LOCALAI_WORKSHOP_URL', 'LOCALAI_WORKSHOP_STATUS_TOKEN', 'LOCALAI_WORKSHOP_CODE_TOKEN' })
if ($missing) { throw "Not found in the running containers: $($missing -join ', ')" }
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$text = "# Exported $(Get-Date -Format s) from the running containers by Export-LocalAI-StackEnv.ps1. Secret: never commit.`r`n" + (($values.Keys | ForEach-Object { "$_=$($values[$_])" }) -join "`r`n") + "`r`n"
[IO.File]::WriteAllText($Out, $text, (New-Object Text.UTF8Encoding($false)))
# Only this account (and SYSTEM, for backups) can read it.
& icacls $Out /inheritance:r /grant:r "${env:USERNAME}:F" /grant:r 'SYSTEM:F' | Out-Null
"Wrote $Out with: $($values.Keys -join ', ')"
