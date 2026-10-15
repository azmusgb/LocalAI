# Workers use the exact existing image. They never pull an image or start companion services.
function Get-LocalAI-ContainerConfiguration([string]$Container) {
    $inspection = docker inspect $Container
    if ($LASTEXITCODE -ne 0) { throw "Cannot inspect $Container." }
    $configuration = @($inspection | ConvertFrom-Json)[0]
    if (-not $configuration.Image) { throw "Container image identity is unavailable: $Container" }
    return $configuration
}

function Get-LocalAI-MountForPath([object]$Configuration, [string]$Path) {
    $normalized = ([string]$Path).TrimEnd('/')
    $matches = @($Configuration.Mounts | Where-Object {
        $destination = ([string]$_.Destination).TrimEnd('/')
        $destination -and ($normalized -eq $destination -or $normalized.StartsWith($destination + '/'))
    } | Sort-Object { ([string]$_.Destination).Length } -Descending)
    if (-not $matches.Count) { return $null }
    return $matches[0]
}

function Get-LocalAI-DataDirectory([object]$Configuration) {
    $dataEnv = @($Configuration.Config.Env | Where-Object { $_ -like 'DATA_DIR=*' })
    $dataDir = if ($dataEnv.Count) { $dataEnv[0].Substring(9).TrimEnd('/') } else { '/data' }
    if (-not $dataDir.StartsWith('/') -or $dataDir -eq '/app' -or $dataDir.StartsWith('/app/') -or $dataDir.Split('/') -contains '..') {
        throw 'DATA_DIR must be an absolute mounted directory outside /app; application replacement must not delete data.'
    }
    if (-not (Get-LocalAI-MountForPath $Configuration $dataDir)) { throw "DATA_DIR $dataDir is not backed by a container mount; storage workers cannot safely access it." }
    return $dataDir
}

function Get-LocalAI-ExplicitMountArgument([object]$Mount, [switch]$ReadOnly) {
    if (-not $Mount) { return $null }
    $destination = ([string]$Mount.Destination).TrimEnd('/')
    if (-not $destination) { return $null }
    $suffix = if ($ReadOnly) { ',readonly' } else { '' }
    if ([string]$Mount.Type -eq 'volume' -and [string]$Mount.Name) {
        return "type=volume,source=$($Mount.Name),target=$destination$suffix"
    }
    if ([string]$Mount.Type -eq 'bind' -and [string]$Mount.Source) {
        return "type=bind,source=$($Mount.Source),target=$destination$suffix"
    }
    return $null
}

function Test-LocalAI-StorageRuntime([string]$Container) {
    $configuration = Get-LocalAI-ContainerConfiguration $Container
    docker run --rm --network none --entrypoint node $configuration.Image -e "const v=process.versions.node.split('.').map(Number);if(v[0]<22||(v[0]===22&&v[1]<13))throw new Error('Node.js 22.13+ required');require('node:sqlite');"
    if ($LASTEXITCODE -ne 0) { throw 'The appliance image requires Node.js 22.13+ with node:sqlite before this candidate can be deployed.' }
}

function Test-LocalAI-StorageCandidate([string]$Container, [string]$CandidateApp) {
    $configuration = Get-LocalAI-ContainerConfiguration $Container
    $dataDir = Get-LocalAI-DataDirectory $configuration
    $dataMount = Get-LocalAI-MountForPath $configuration $dataDir
    $dataMountArgument = Get-LocalAI-ExplicitMountArgument $dataMount -ReadOnly
    $source = (Resolve-Path -LiteralPath $CandidateApp).Path
    if ($source.Contains(',')) { throw 'Candidate app path cannot contain a comma in a Docker bind mount.' }

    # Never open a WAL-mode SQLite database directly from the read-only live mount.
    # Docker Desktop can expose localai.db while preventing SQLite from creating or
    # updating shared-memory state, yielding "unable to open database file" when the
    # source appliance is stopped. Snapshot the database, WAL, SHM, and legacy JSON
    # into writable /tmp first, then let the candidate preflight operate only there.
    $arguments = @('run','--rm','--network','none')
    if ($dataMountArgument) { $arguments += @('--mount',$dataMountArgument) }
    else { $arguments += @('--volumes-from',"${Container}:ro") }
    $arguments += @(
        '--mount',"type=bind,source=$source,target=/candidate,readonly",
        '--env',"SOURCE_DATA_DIR=$dataDir",
        '--entrypoint','sh',$configuration.Image,
        '-c', 'set -eu; tmp=/tmp/localai-source; mkdir -p "$tmp"; for f in localai.db localai.db-wal localai.db-shm; do if [ -f "$SOURCE_DATA_DIR/$f" ]; then cp "$SOURCE_DATA_DIR/$f" "$tmp/$f"; fi; done; for f in "$SOURCE_DATA_DIR"/*.json; do if [ -f "$f" ]; then cp "$f" "$tmp/"; fi; done; DATA_DIR="$tmp" node /candidate/storage-cli.js preflight'
    )
    docker @arguments | Out-Host
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
    $dataMount = Get-LocalAI-MountForPath $configuration $dataDir
    $appMount = Get-LocalAI-MountForPath $configuration '/app'
    $dataMountArgument = Get-LocalAI-ExplicitMountArgument $dataMount
    $appMountArgument = Get-LocalAI-ExplicitMountArgument $appMount -ReadOnly
    $arguments = @('run','--rm','--network','none')
    if ($dataMountArgument -and $appMountArgument) {
        $arguments += @('--mount',$dataMountArgument,'--mount',$appMountArgument)
    } else {
        $arguments += @('--volumes-from',$Container)
    }
    $arguments += @('--env',"DATA_DIR=$dataDir",'--entrypoint','node',$configuration.Image,'/app/storage-cli.js',$Command)
    if ($OutputName) {
        if ($OutputName -notmatch '^[A-Za-z0-9_.-]+$') { throw 'OutputName must be a simple backup filename.' }
        $arguments += @('--output',($dataDir + '/backups/' + $OutputName))
    }
    docker @arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "SQLite $Command failed. Keep the container stopped and inspect the data before restoring application code." }
}
