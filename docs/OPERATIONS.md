# Operating the appliance

## What is reachable from the network

Only the appliance itself, `http://<host>:3080`. Everything it depends on listens on the Windows host's
localhost; the appliance container reaches them through `host.docker.internal` (Docker Desktop forwards that to
the host's 127.0.0.1) or the Docker network.

| Service | Listens on | How the appliance reaches it | Set by |
|---|---|---|---|
| Ollama | `127.0.0.1:11434` | `host.docker.internal:11434` | user env `OLLAMA_HOST=127.0.0.1:11434`, then restart the Ollama app |
| ComfyUI (images) | `127.0.0.1:8188` | `host.docker.internal:8188` | `host/comfyui/Install-ComfyUI-Task.ps1` |
| GridCraft bridge | `127.0.0.1:8787` | `host.docker.internal:8787`; browsers use `/api/gridcraft` | `deploy/Install-GridCraft-Bridge.ps1` (binds 127.0.0.1) |
| n8n | `127.0.0.1:5678` | `local-ai-n8n:5678` on `local-ai-sandbox-net` | container published with `-p 127.0.0.1:5678:5678` |

The n8n editor therefore opens only on the Windows host (`http://localhost:5678`) until sign-in can expose it through
the appliance. To recreate the n8n container the same way (keeps its data volume, environment and network):

```powershell
$j = (docker inspect local-ai-n8n | ConvertFrom-Json)[0]; $env = "$env:TEMP\n8n.env"; [IO.File]::WriteAllLines($env, [string[]]$j.Config.Env)
docker rename local-ai-n8n local-ai-n8n-old; docker stop local-ai-n8n-old
docker run -d --name local-ai-n8n --restart unless-stopped -p 127.0.0.1:5678:5678 -v n8n_data:/home/node/.n8n --env-file $env --network local-ai-sandbox-net $j.Image
Remove-Item $env
```

## Backups

`deploy/Backup-LocalAI-Data.ps1` runs nightly at 02:30 (`deploy/Install-LocalAI-Backup.ps1` schedules it; a missed night
runs when the machine is next on). Each run:

1. takes a consistent SQLite snapshot inside the container (`storage-cli backup`, includes WAL writes);
2. copies it to `C:\LocalAI\backups\data` and to `%USERPROFILE%\OneDrive\LocalAI-Backups` (off this disk);
3. restore-tests it by opening it read-only with the app's own storage code before keeping it;
4. keeps 7 daily copies plus 4 weekly copies from the weeks before;
5. writes `C:\LocalAI\backups\last-backup.json` (time, file, size, record counts, error).

Restore (stops the appliance briefly; the current data is snapshotted first so a restore can be undone):

```powershell
C:\LocalAI\repo\deploy\Restore-LocalAI-Data.ps1 -Backup C:\LocalAI\backups\data\localai-YYYYMMDD-HHMMSS.db -Force
```

## Automatic updates

The `LocalAI Safe Deploy` task runs `deploy/Run-LocalAI-AutoDeploy.ps1` every 5 minutes for the logged-on user:

1. fast-forwards `C:\LocalAI\repo` (when it tracks `origin/main` and has no local edits), so the deploy scripts stay current;
2. runs `Deploy-LocalAI.ps1`: an idle poll returns *NO CHANGE* in about a second; a new commit is certified, promoted,
   health-checked, and rolled back automatically if it is unhealthy;
3. posts to the Inbox (`POST /api/notifications/system`) when a release goes live or a deploy fails (once per failing
   commit), and stays silent otherwise;
4. keeps `C:\LocalAI\.deploy\auto-deploy.log`: a one-line history plus the last run's full output.

```powershell
C:\LocalAI\repo\deploy\Install-LocalAI-DeployAgent.ps1 -Install -StartNow                 # track main
C:\LocalAI\repo\deploy\Install-LocalAI-DeployAgent.ps1 -Install -TargetRef <release ref>  # a release channel
C:\LocalAI\repo\deploy\Install-LocalAI-DeployAgent.ps1 -Uninstall
```

Manual deploys still work; the deploy lock keeps a manual run and the task from overlapping.
