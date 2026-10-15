param(
    [string]$Model = "qwen3:4b-instruct",
    [int]$Port = 7979,
    [string]$Workbook = "$env:USERPROFILE\Documents\GridCraft\Quarterly-Sales-Dashboard.xlsx",
    [string]$AgentDir = "$env:USERPROFILE\gridcraft-local-ai",
    [switch]$NoOpenWorkbook
)

$ErrorActionPreference = "Stop"

# The agent source sits next to this script in the LocalAI repo; $AgentDir holds its virtual
# environment (created by deploy\Install-GridCraft-Bridge.ps1).
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $AgentDir

$GridCraftExe = "C:\Program Files\GridCraft\gridcraft.exe"
$PythonExe = Join-Path $AgentDir ".venv\Scripts\python.exe"
$AgentScript = Join-Path $ScriptDir "gridcraft_ai.py"
$OllamaBase = "http://127.0.0.1:11434/v1"

function Test-TcpPort {
    param(
        [string]$ComputerName = "127.0.0.1",
        [int]$Port
    )

    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect($ComputerName, $Port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(800)
        if (-not $ok) {
            $client.Close()
            return $false
        }
        $client.EndConnect($iar)
        $client.Close()
        return $true
    }
    catch {
        return $false
    }
}

Write-Host ""
Write-Host "=== GridCraft Local AI Launcher ==="
Write-Host ""

if (-not (Test-Path $GridCraftExe)) {
    throw "GridCraft executable not found: $GridCraftExe"
}

if (-not (Test-Path $PythonExe)) {
    throw "Python virtual environment not found: $PythonExe"
}

if (-not (Test-Path $AgentScript)) {
    throw "Agent script not found: $AgentScript"
}

Write-Host "[1/4] Checking Ollama..."

try {
    $models = Invoke-RestMethod `
        -Uri "$OllamaBase/models" `
        -Method Get `
        -TimeoutSec 5

    $modelNames = @($models.data | ForEach-Object { $_.id })

    if ($modelNames -notcontains $Model) {
        Write-Host "Available Ollama models:"
        $modelNames | ForEach-Object { Write-Host "  - $_" }
        throw "Requested model '$Model' is not installed."
    }

    Write-Host "      Ollama OK - model '$Model' available."
}
catch {
    throw "Ollama check failed: $($_.Exception.Message)"
}

Write-Host "[2/4] Checking GridCraft control port $Port..."

if (-not (Test-TcpPort -Port $Port)) {
    Write-Host "      GridCraft control port is not listening. Starting GridCraft..."

    $env:WGPU_BACKEND = "vulkan"

    $gcArgs = @()

    if (-not $NoOpenWorkbook -and (Test-Path $Workbook)) {
        $gcArgs += $Workbook
    }
    else {
        $gcArgs += "--sample"
        $gcArgs += "sales"
    }

    $gcArgs += "--control"
    $gcArgs += "$Port"

    Start-Process `
        -FilePath $GridCraftExe `
        -ArgumentList $gcArgs `
        -WindowStyle Normal | Out-Null

    $ready = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-TcpPort -Port $Port) {
            $ready = $true
            break
        }
    }

    if (-not $ready) {
        throw "GridCraft did not begin listening on port $Port."
    }

    Write-Host "      GridCraft started successfully."
}
else {
    Write-Host "      GridCraft is already listening."
}

Write-Host "[3/4] Verifying workbook..."

if (Test-Path $Workbook) {
    Write-Host "      Workbook: $Workbook"
}
else {
    Write-Host "      Saved workbook not found; using the currently open GridCraft workbook."
}

Write-Host "[4/4] Starting local AI agent..."
Write-Host ""
Write-Host "Commands inside the agent:"
Write-Host "  /tools  - show available tools"
Write-Host "  /quit   - exit"
Write-Host ""

& $PythonExe $AgentScript `
    --model $Model `
    --port $Port
