# Operating the appliance

Day-to-day running of LocalAI on the Windows host: checking health, backups and restores, logs, and where to
look when something breaks. Deploys and rollback are in [Deploy](DEPLOY.md); how the parts fit together is
in [Architecture](ARCHITECTURE.md).

## Is it healthy?

| Check | How | Healthy looks like |
|---|---|---|
| Appliance alive, which release | `curl -s http://<host>:3080/healthz` | `status: ok`, `releaseCommit` = the SHA you expect |
| Services it depends on | **System › Health** page, or `GET /api/status` | Core services `HEALTHY`; the two Mac companions may show *optional offline* |
| Database | `GET /api/storage/status` | `engine: sqlite`, `journalMode: wal`, collection counts |
| Deploys | `.\deploy\Get-LocalAI-DeployStatus.ps1` | Running SHA = recorded SHA = `origin/main`, task `Ready` |
| Last backup | `Get-Content C:\LocalAI\backups\last-backup.json` | `ok: true`, `at` within the last day |
| Host services stay on loopback | see [below](#check-loopback-bindings) | every address `127.0.0.1` |

`/healthz` only says the LocalAI server is up. The Health page probes each dependency:

| Service | Probe | Counts toward overall health |
|---|---|---|
| Intelligence (Ollama) | `OLLAMA_URL/api/tags` | yes |
| Image generation (ComfyUI) | `COMFY_URL/system_stats` | yes |
| Automation engine (n8n) | `N8N_URL/healthz` | yes |
| Conversation compatibility (responses proxy) | `PROXY_URL/healthz` | yes |
| Web research (SearXNG) | `SEARXNG_URL/search?q=health&format=json` | yes |
| Companion home (Mac) | `MAC_AI_HOME_URL/` | no |
| Developer assistant (Mac) | `MAC_DSH_URL/` | no |

A change in overall health is recorded in the Audit log and Inbox only after it has held for two minutes
(`HEALTH_SETTLE_MS`), so a single slow probe does not raise an alert.

## Check loopback bindings

Ollama and n8n are kept off the LAN by host configuration, not by this repo ([Security](SECURITY.md#network-exposure)).
After changing either, or after a Windows or Docker update, check:

```powershell
Get-NetTCPConnection -State Listen | ? LocalPort -in 11434,5678,8188,8787 | Select LocalAddress, LocalPort, OwningProcess
docker ps --format '{{.Names}} {{.Ports}}'
```

Every `LocalAddress` should be `127.0.0.1`, and n8n's mapping should read `127.0.0.1:5678->5678/tcp`.

## Scheduled tasks and containers

| Name | Kind | Installed by | Purpose |
|---|---|---|---|
| `local-ai-appliance` | container | not in this repo (see [Architecture](ARCHITECTURE.md#gaps)) | The app, port 3080 (and 3090 host-only) |
| `local-ai-n8n` | container | not in this repo | n8n, `127.0.0.1:5678` |
| `local-ai-searxng`, `local-ai-ollama-responses-proxy` | containers | not in this repo | Web search; conversation compatibility |
| `local-ai-https` | container | `deploy\Install-LocalAI-HTTPS.ps1` | Caddy on 80/443 |
| `LocalAI Safe Deploy` | task, every 5 min | `deploy\Install-LocalAI-DeployAgent.ps1` | [Automatic deploys](DEPLOY.md#automatic-deploys) |
| `LocalAI Nightly Backup` | task, daily 02:30 | `deploy\Install-LocalAI-Backup.ps1` | [Backups](#backups) |
| `LocalAI ComfyUI` | task, at logon | `host\comfyui\Install-ComfyUI-Task.ps1` | [ComfyUI](../host/comfyui/README.md) |
| `LocalAI GridCraft Bridge` | task, at logon | `deploy\Install-GridCraft-Bridge.ps1` | [GridCraft](GRIDCRAFT.md) |
| `Local AI PowerShell Host` | task, every minute | `C:\LocalAI\powershell-bridge\Enable-LocalAI-PowerShellHost.ps1` | [PowerShell Workbench](../host/powershell-bridge/README.md); remove with `-Disable` |

```powershell
Get-ScheduledTask -TaskName 'LocalAI*', 'Local AI*' | Format-Table TaskName, State
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

## Backups

`deploy\Backup-LocalAI-Data.ps1` runs nightly at 02:30 as the logged-on user (a missed night runs when the
machine is next on). Each run:

1. takes a consistent SQLite snapshot inside the container (`storage-cli.js backup`, which includes WAL writes);
2. copies it to `C:\LocalAI\backups\data\localai-<yyyyMMdd-HHmmss>.db` and to
   `%USERPROFILE%\OneDrive\LocalAI-Backups` (`-OffsiteRoot ''` skips the second copy);
3. restore-tests the copy by opening it with the app's own storage code (`storage-cli.js status`) before keeping it;
4. keeps 7 daily copies plus 4 weekly copies from the weeks before (`-KeepDaily`, `-KeepWeekly`), in both places;
5. writes `C:\LocalAI\backups\last-backup.json` (time, file, size, record counts, error).

```powershell
.\deploy\Install-LocalAI-Backup.ps1                 # schedule at 02:30
.\deploy\Install-LocalAI-Backup.ps1 -At 04:00       # another time
.\deploy\Install-LocalAI-Backup.ps1 -Uninstall
.\deploy\Backup-LocalAI-Data.ps1                    # run one now
```

Deploys and rollbacks also leave database backups in `/data/backups` (`before-deploy-*.db`,
`before-rollback-*.db`); those stay inside the data volume.

## Restore

```powershell
.\deploy\Restore-LocalAI-Data.ps1 -Backup C:\LocalAI\backups\data\localai-YYYYMMDD-HHMMSS.db -Force
```

Without `-Force` it refuses and says what it would replace. With it, it snapshots the current database to
`/data/backups/pre-restore-<stamp>.db` (so a restore can be undone), stops the container, swaps the
database in (removing stale `-wal`/`-shm` files), starts the container and waits up to two minutes for
`/healthz`. A restore deliberately reverts all data to the backup's point in time.

## Logs

| What | Where |
|---|---|
| Appliance server | `docker logs local-ai-appliance` |
| Auto-deploy history and last run | `C:\LocalAI\.deploy\auto-deploy.log` |
| Deploy state | `C:\LocalAI\.deploy\state.json` |
| Backups | `C:\LocalAI\backups\last-backup.json` |
| ComfyUI | `C:\Projects\ComfyHost\user\comfyui_8188.log` |
| GridCraft bridge | `%USERPROFILE%\gridcraft-local-ai\gridcraft-bridge.log` (rotated, 2 MB × 3) and `gridcraft-bridge.crash.log` |
| HTTPS | `docker logs local-ai-https` |
| Claude chat bridge (Mac) | `~/.claude/localai-chat/bridge.log` |
| What the app did | **System › Audit log** and **System › Runs** |

## n8n

n8n listens on `127.0.0.1:5678` on the host, so its editor (and the **n8n workflows** links, which redirect
to port 5678 on the same host name) only opens on the Windows host itself (`http://localhost:5678`). The
appliance reaches it as `local-ai-n8n:5678` on the shared Docker network.

To recreate the n8n container with the same data volume, environment and network, read them from the
existing container first and check what the snippet prints before running the rest:

```powershell
$j = (docker inspect local-ai-n8n | ConvertFrom-Json)[0]
$volume = ($j.Mounts | Where-Object Destination -eq '/home/node/.n8n').Name
$network = @($j.NetworkSettings.Networks.PSObject.Properties.Name)[0]
$image = $j.Config.Image          # the tag it was created from; $j.Image is the image id
"volume=$volume network=$network image=$image"
$envFile = "$env:TEMP\n8n.env"; [IO.File]::WriteAllLines($envFile, [string[]]$j.Config.Env)
docker rename local-ai-n8n local-ai-n8n-old; docker stop local-ai-n8n-old
docker run -d --name local-ai-n8n --restart unless-stopped -p 127.0.0.1:5678:5678 -v "${volume}:/home/node/.n8n" --env-file $envFile --network $network $image
Remove-Item $envFile
```

Using `$j.Config.Image` (the tag) picks up a newer pulled image under that tag; `$j.Image` would pin the exact
image id the old container ran. Remove `local-ai-n8n-old` only once the new one works.

## Troubleshooting

| Symptom | Start here |
|---|---|
| Page does not load at all | `docker ps -a`; `docker logs local-ai-appliance`; `/healthz` |
| Health shows Intelligence down | Ollama app running on the host and listening on `127.0.0.1:11434` (user env `OLLAMA_HOST=127.0.0.1:11434`) |
| Health shows Image generation down | [ComfyUI](../host/comfyui/README.md): task `LocalAI ComfyUI` and its log |
| A merge did not go live | `auto-deploy.log`, `Get-LocalAI-DeployStatus.ps1`, the Inbox; [Deploy](DEPLOY.md) |
| Deploy state is `RECOVERY_REQUIRED` | [Deploy › Deploy states](DEPLOY.md#deploy-states) |
| Storage preflight fails only when the container is stopped | [Storage › Troubleshooting](STORAGE.md#troubleshooting) |
| `STORAGE_CONFLICT` / HTTP 409 on save | Another request changed the record; reload and retry ([Storage](STORAGE.md#writes-and-history)) |
| Backup reported a failure | `last-backup.json` `error`; run `Backup-LocalAI-Data.ps1` by hand |
| GridCraft page cannot reach the bridge | [GridCraft](GRIDCRAFT.md); `Invoke-RestMethod http://127.0.0.1:8787/health` on the host |
| PowerShell Workbench says it is only available from localhost | Open `http://localhost:3090` on the host; [PowerShell bridge](../host/powershell-bridge/README.md) |
| Claude Code page shows no sessions, or chat messages stuck | [Claude chat › Troubleshooting](CLAUDE-CHAT.md#troubleshooting) |
| Browser says the HTTPS connection is not private | Trust the CA: **Health › Secure connection**; [Deploy › HTTPS](DEPLOY.md#https-with-caddy) |

## Notifications

Local AI sends phone notifications with Web Push, built in (`app/push.js` signs and encrypts, `app/notify.js`
decides; design: `docs/superpowers/specs/2026-10-15-notifications-design.md`). Messages are end-to-end encrypted to
the device; the appliance contacts only Apple, Google and Mozilla push services.

**Turn on, iPhone:** trust the Local AI certificate (Health › Secure connection), open `https://<host>` in Safari,
Share › Add to Home Screen, open Local AI from the Home Screen, then Health › Notifications › Allow notifications,
and Send a test. iPhone delivers web push only to Home Screen apps.

| Kind | When |
|---|---|
| Needs you | An approval is created, a run waits for approval, a Claude session posts a new finding |
| Failed | A run fails, an automatic update rolls back, a nightly backup fails |
| Down and recovered | Core health changes and holds for 2 minutes |
| Finished | A run of 30 s or more completes while no Local AI page is open on any device |

Each device chooses its kinds and quiet hours (default 22:00–07:00 in the appliance's `TZ`; only Failed and Down get
through). At most 10 per device per 10 minutes, then one "N more updates" summary. Everything is also in the Inbox.

- Devices are settings `push:device:<id>`; the signing key is `push:vapid` (losing it means each device turns
  notifications on again; the card notices). `VAPID_SUBJECT` (default the repo URL) is the contact sent to push
  services.
- A device the push service no longer knows (404/410) is removed; other failures are retried once after 30 s and
  shown as the device's last error in the card.
