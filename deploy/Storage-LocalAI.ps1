# Workers use the exact existing image. They never pull an image or start companion services.
function Get-LocalAI-ContainerConfiguration([string]$Container) {
    $inspection = docker inspect $Container
    if ($LASTEXITCODE -ne 0) { throw "Cannot inspect $Container." }
    $configuration = @($inspection | ConvertFrom-Json)[0]
    if (-not $configuration.Image) { throw "Container image identity is unavailable: $Container" }
    return $configuration
}

function Get-LocalAI-DataDirectory([object]$Configuration) {
    $dataEnv = @($Configuration.Config.Env | Where-Object { $_ -like 'DATA_DIR=*' })
    $dataDir = if ($dataEnv.Count) { $dataEnv[0].Substring(9).TrimEnd('/') } else { '/data' }
    if (-not $dataDir.StartsWith('/') -or $dataDir -eq '/app' -or $dataDir.StartsWith('/app/') -or $dataDir.Split('/') -contains '..') {
        throw 'DATA_DIR must be an absolute mounted directory outside /app; application replacement must not delete data.'
    }
    $mounts = @($Configuration.Mounts | Where-Object {
        $destination = ([string]$_.Destination).TrimEnd('/')
        $destination -and ($dataDir -eq $destination -or $dataDir.StartsWith($destination + '/'))
    })
    if (-not $mounts.Count) { throw "DATA_DIR $dataDir is not backed by a container mount; storage workers cannot safely access it." }
    return $dataDir
}

function Test-LocalAI-StorageRuntime([string]$Container) {
    $configuration = Get-LocalAI-ContainerConfiguration $Container
    docker run --rm --network none --entrypoint node $configuration.Image -e "const v=process.versions.node.split('.').map(Number);if(v[0]<22||(v[0]===22&&v[1]<13))throw new Error('Node.js 22.13+ required');require('node:sqlite');"
    if ($LASTEXITCODE -ne 0) { throw 'The appliance image requires Node.js 22.13+ with node:sqlite before this candidate can be deployed.' }
}

function Test-LocalAI-StorageCandidate([string]$Container, [string]$CandidateApp) {
    $configuration = Get-LocalAI-ContainerConfiguration $Container
    $dataDir = Get-LocalAI-DataDirectory $configuration
    $source = (Resolve-Path -LiteralPath $CandidateApp).Path
    if ($source.Contains(',')) { throw 'Candidate app path cannot contain a comma in a Docker bind mount.' }
    # Source volumes are mounted read-only; the CLI migrates only a disposable /tmp copy.
    docker run --rm --network none --volumes-from "${Container}:ro" --mount "type=bind,source=$source,target=/candidate,readonly" --env "DATA_DIR=$dataDir" --entrypoint node $configuration.Image /candidate/storage-cli.js preflight
    if ($LASTEXITCODE -ne 0) { throw 'Candidate migration/data preflight failed; the live application and data were not replaced.' }
}

function Stop-LocalAI-Container([string]$Container) {
    docker stop --time 15 $Container | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Cannot stop $Container; application/data were not replaced." }
}

function Start-LocalAI-Container([string]$Container) {
    docker start $Container | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Cannot start $Container." }
}

function Invoke-LocalAI-StorageMaintenance {
    param(
        [Parameter(Mandatory=$true)][string]$Container,
        [Parameter(Mandatory=$true)][ValidateSet('backup','check','downgrade-json')][string]$Command,
        [string]$OutputName
    )
    $configuration = Get-LocalAI-ContainerConfiguration $Container
    if ($configuration.State.Running) { throw 'Storage maintenance requires the application container to be stopped.' }
    $dataDir = Get-LocalAI-DataDirectory $configuration
    $arguments = @('run','--rm','--network','none','--volumes-from',$Container,'--env',"DATA_DIR=$dataDir",'--entrypoint','node',$configuration.Image,'/app/storage-cli.js',$Command)
    if ($OutputName) {
        if ($OutputName -notmatch '^[A-Za-z0-9_.-]+$') { throw 'OutputName must be a simple backup filename.' }
        $arguments += @('--output',($dataDir + '/backups/' + $OutputName))
    }
    docker @arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "SQLite $Command failed. Keep the container stopped and inspect the data before restoring application code." }
}
