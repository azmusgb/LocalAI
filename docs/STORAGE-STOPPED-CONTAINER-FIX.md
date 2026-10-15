# Stopped-container SQLite preflight fix

## Reproduction

On Docker Desktop for Windows, LocalAI's storage preflight behaved differently depending on whether the source appliance container was running:

```powershell
# running source container: succeeds
docker run --rm --network none --volumes-from "local-ai-appliance:ro" --env "DATA_DIR=/data" --entrypoint node $image /app/storage-cli.js preflight

# stopped source container: fails with
# LocalAI storage: unable to open database file
```

The production container uses a named Docker volume for `/data` (`local-ai-appliance-data`) and a bind mount for `/app`.

## Fix

`deploy/Storage-LocalAI.ps1` now resolves the actual Docker mount backing `DATA_DIR` and mounts that volume or bind explicitly into storage workers. This avoids depending on `--volumes-from` for a stopped container.

Candidate preflight mounts `/data` read-only. Storage maintenance mounts `/data` read-write and the deployed `/app` bind read-only so the exact deployed `storage-cli.js` is used.

The older `--volumes-from` path remains only as a fallback for simulated fixtures or unusual configurations that do not expose enough mount metadata.

## Verification

After pulling the fix, validate the stopped-container case directly:

```powershell
$image = docker inspect local-ai-appliance --format '{{.Config.Image}}'
docker stop --timeout 15 local-ai-appliance
. .\deploy\Storage-LocalAI.ps1
Test-LocalAI-StorageCandidate -Container 'local-ai-appliance' -CandidateApp '.\app'
docker start local-ai-appliance
```

Then run the normal deployment certification:

```powershell
.\deploy\Deploy-LocalAI.ps1 -CheckOnly
```
