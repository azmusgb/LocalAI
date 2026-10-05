$ErrorActionPreference = 'Stop'

function Test-LocalAI-StorageRuntime([string]$Container) {
    docker exec $Container node -e "const v=process.versions.node.split('.').map(Number);if(v[0]<22||(v[0]===22&&v[1]<13))throw new Error('Node.js 22.13+ required');require('node:sqlite');"
    if ($LASTEXITCODE -ne 0) { throw 'The appliance container requires Node.js 22.13+ with node:sqlite before this candidate can be deployed.' }
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
    $inspection = docker inspect $Container
    if ($LASTEXITCODE -ne 0) { throw "Cannot inspect $Container." }
    $configuration = ($inspection | ConvertFrom-Json)[0]
    if ($configuration.State.Running) { throw 'Storage maintenance requires the application container to be stopped.' }
    $dataEnv = @($configuration.Config.Env | Where-Object { $_ -like 'DATA_DIR=*' })
    $dataDir = if ($dataEnv.Count) { $dataEnv[0].Substring(9) } else { '/data' }
    $arguments = @('run','--rm','--network','none','--volumes-from',$Container,'--env',"DATA_DIR=$dataDir",'--entrypoint','node',$configuration.Image,'/app/storage-cli.js',$Command)
    if ($OutputName) {
        if ($OutputName -notmatch '^[A-Za-z0-9_.-]+$') { throw 'OutputName must be a simple backup filename.' }
        $arguments += @('--output',($dataDir.TrimEnd('/') + '/backups/' + $OutputName))
    }
    $result = docker @arguments
    if ($LASTEXITCODE -ne 0) { throw "SQLite $Command failed. Keep the container stopped and inspect the data before restoring application code." }
    $result | Out-Host
}
