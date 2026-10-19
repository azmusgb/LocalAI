# Deploying the appliance

LocalAI deploys by pulling: the Windows host fetches `origin/main`, certifies the commit in a disposable
candidate, promotes it into the running container, checks health, and rolls back on its own if the new
release is unhealthy. Nothing pushes to the host.

All commands on this page run on the Windows host, in PowerShell, from `C:\LocalAI\repo` unless they give
a full path.

## Where things live on the host

| Path | What it holds | Owner |
|---|---|---|
| `C:\LocalAI\repo` | Git checkout the deploy scripts run from and fetch into | `Deploy-LocalAI.ps1` (`-Repo`) |
| `C:\LocalAI\appliance\app` | Live application code, bind-mounted into the container at `/app` | `Deploy-LocalAI.ps1` (`-Live`) |
| `C:\LocalAI\releases\<sha>` | Extracted candidate per commit (`app`, `deploy`, `tests`) | `Deploy-LocalAI.ps1` (`-Releases`) |
| `C:\LocalAI\.deploy` | `state.json`, `deploy.lock`, pre-deploy code snapshots (`live-before-*`), `auto-deploy.log` | `Deploy-LocalAI.ps1` (`-StateDir`) |
| `C:\LocalAI\backups` | Nightly database backups and `last-backup.json` | [Operations › Backups](OPERATIONS.md#backups) |
| `C:\LocalAI\https` | Exported HTTPS root certificate | [HTTPS](#https-with-caddy) |
| `/data` in the container | SQLite database and its backups (Docker volume, outside `/app`) | [Storage](STORAGE.md) |

Data must stay on a mount outside `/app`; promotion replaces `/app` wholesale.

## The normal path: merge and wait

1. Open a pull request. The CI workflows that apply must pass ([Development › CI](DEVELOPMENT.md#ci));
   docs-only PRs run none.
2. Merge to `main`.
3. Within about five minutes the `LocalAI Safe Deploy` task picks the commit up, certifies it and promotes it.
4. Confirm the running release:

   ```sh
   curl -s https://<host>/healthz        # from another computer; on the host: http://127.0.0.1:3080/healthz
   ```

   `releaseCommit` must be the merge commit's full SHA. Do not rely on deploy output alone: the candidate
   tests print simulated `DEPLOYED: aaaa…` lines from the deployment contract tests.

The Inbox gets a notice when a release goes live or a deploy fails.

## What a deploy does

`deploy\Deploy-LocalAI.ps1`, in order:

1. Takes the deploy lock (`C:\LocalAI\.deploy\deploy.lock`); a lock whose process is gone is removed as stale.
2. `git fetch --prune origin` (skip with `-SkipFetch`) and resolves `-TargetRef` (default `origin/main`) to a SHA.
3. Stops early with `NO CHANGE` when `state.json`, the live `app\release.json` and `/healthz` all already
   report that SHA.
4. Extracts `app`, `deploy` and `tests` at that SHA into `C:\LocalAI\releases\<sha>` (always re-extracted).
5. Runs the candidate's own `deploy\Test-LocalAI-Candidate.ps1` (see [Candidate tests](#candidate-tests)).
6. Checks the appliance image's Node is 22.13 or newer, then migrates a disposable copy of the live data
   with the candidate code (`Test-LocalAI-StorageCandidate`). `-CheckOnly` stops here.
7. Stops `local-ai-appliance`, snapshots the live code to `C:\LocalAI\.deploy\live-before-<guid>`, backs up
   the database to `/data/backups/before-deploy-<guid>.db`, and repeats the migration preflight with
   writes stopped.
8. Copies the candidate `app` over `C:\LocalAI\appliance\app`, writes `app\release.json` (SHA, version, time,
   release notes; see [Versions and release notes](#versions-and-release-notes)), and starts the container.
9. Waits for `/healthz` to report `status: ok`, SQLite storage and the expected `releaseCommit`
   (12 tries, 2 s apart).
10. On success writes `state.json` with `status: HEALTHY`. On failure restores the snapshot, restarts, and
    records `ROLLED_BACK` (or `DEPLOY_FAILED_UNCHANGED` if the code was never replaced).

## Automatic deploys

The `LocalAI Safe Deploy` scheduled task runs `deploy\Run-LocalAI-AutoDeploy.ps1` every five minutes. Each run:

1. Fast-forwards `C:\LocalAI\repo` with `git pull --ff-only origin main`, but only when the target is
   `origin/main` and the checkout has no local changes, so the deploy scripts themselves stay current.
2. Starts any stopped Local AI services (see [After a Windows restart](#after-a-windows-restart)).
3. When the target commit isn't the one running, waits for running work (see [Updates wait for running
   work](#updates-wait-for-running-work)).
4. Runs `Deploy-LocalAI.ps1` in a child Windows PowerShell. An idle run ends with `NO CHANGE` in about a second.
5. Posts to the Inbox (`POST /api/notifications/system`, kind `deploy`) when a release goes live, or when a
   deploy fails (once per failing commit, not on every retry).
6. Rewrites `C:\LocalAI\.deploy\auto-deploy.log`: up to 500 one-line summaries plus the last deploy's full output.
7. After a healthy deploy, or a run with nothing to deploy and `/healthz` OK, tidies old backup containers (see
   [Old backup containers](#old-backup-containers)).

### After a Windows restart

Docker Desktop treats containers stopped by a Windows shutdown as stopped on purpose, so `restart: unless-stopped`
doesn't bring them back: after a reboot, everything except the appliance can stay `Exited` (n8n, the Responses proxy,
search, HTTPS, the code sandbox). The next update check (within 5 minutes) starts them again, even when there is
nothing to deploy. `deploy\Repair-LocalAI-Stack.ps1` lists the stack's services
(`docker compose --env-file C:\LocalAI\stack\stack.env -f deploy\stack\compose.yml ps -a`) and, if any that should
run is exited or created, runs `docker compose ... up -d --no-recreate`, which leaves running containers (the
appliance included) alone. The one-shot `local-ai-sandbox-certs` job, `*-pre-*` backups and containers outside the
compose project are never started; if a backup still carries the project's labels it starts the stopped services by
name instead, so `up` can't remove the backup. Each start is a line in `auto-deploy.log` (`repair: started
local-ai-n8n (was Exited 143)`), followed by the appliance's `/healthz` result after up to a minute, and the Inbox
gets one notice, e.g. "Restarted 6 Local AI services that were stopped (probably by a Windows restart)". It does
nothing on a host without `stack.env`, is silent when everything runs, and a failure is logged and never stops the
deploy.

### Updates wait for running work

A deploy restarts the appliance, and a restart stops whatever is running. Before deploying a new commit the task
asks the appliance `GET http://127.0.0.1:3080/api/busy`, which answers `{busy, active: [{kind, title, startedAt}], since}`:

- run-ledger runs that are queued, running or streaming (chats, research, images, missions…);
- running missions and specialist runs in the orchestrator;
- GridCraft requests and automation runs in flight.

A record that hasn't changed for an hour counts as stuck, not running. The answer carries only a kind, a short
title and a start time.

While it says busy, the run deploys nothing and logs `Waiting: 2 things running (Review the Work page; A
lighthouse at dusk); held 5 of 45 min`. The first time an update was held back is kept in
`C:\LocalAI\.deploy\auto-deploy-held-since.txt`. Once the hold has lasted `-MaxHoldMinutes` (default 45), the
next run deploys anyway and the Inbox says "Updating now; 2 things were still running and were stopped", naming
them. Missions stopped this way read "Local AI restarted for an update while this was running".

If `/api/busy` doesn't answer (the appliance is down, or a build from before it), the run deploys as before, so a
broken appliance can always be fixed by a deploy. Manual `Deploy-LocalAI.ps1` runs don't wait.

Install, change or remove the task:

```powershell
.\deploy\Install-LocalAI-DeployAgent.ps1                                   # dry run: prints what it would register
.\deploy\Install-LocalAI-DeployAgent.ps1 -Install -StartNow                # deploy origin/main every 5 minutes
.\deploy\Install-LocalAI-DeployAgent.ps1 -Install -ValidateOnly -StartNow  # certify only (Deploy-LocalAI.ps1 -CheckOnly), never promote
.\deploy\Install-LocalAI-DeployAgent.ps1 -Install -TargetRef <ref>         # follow another ref
.\deploy\Install-LocalAI-DeployAgent.ps1 -Install -EveryMinutes 15         # another interval (1-1440)
.\deploy\Install-LocalAI-DeployAgent.ps1 -Uninstall
```

The task is hidden, runs `C:\LocalAI\repo\deploy\Run-LocalAI-AutoDeploy.ps1` (path fixed in the installer),
skips a run while the previous one is still going, and is stopped after 30 minutes. Validate-only mode
sends no Inbox notices. On a new host, prove a manual deploy and a manual rollback before enabling deploy mode.

## Provisioning the containers

`deploy\stack\compose.yml` describes every container Local AI runs:

- the appliance and the HTTPS proxy (Caddy);
- n8n, the Ollama responses proxy and SearXNG;
- n8n's code sandbox (a certificate job, its API and a Docker-in-Docker runner).

They share the `local-ai-sandbox-net` network, and the existing volumes keep their names. Secrets and host values
live only in `C:\LocalAI\stack\stack.env`, which is readable by your account and SYSTEM only; the names are in
`deploy\stack\stack.env.example`. The proxy's code and SearXNG's settings now live in `deploy\stack\`.

| Script | Does |
|---|---|
| `deploy\stack\Install-LocalAI-Stack.ps1` | New host: creates `stack.env` with new secrets (reusing the PowerShell bridge tokens if present), the mounted folders and a first copy of the app; starts the stack, waits for `/healthz`, opens the firewall and trusts the HTTPS CA. `-DryRun` plans only. `-Adopt` recreates containers that were made by hand, keeping volumes and the old containers (`*-pre-compose`, set never to restart) for rollback; they are [tidied after 7 days](#old-backup-containers). |
| `deploy\stack\Export-LocalAI-StackEnv.ps1` | Writes the running stack's secrets to `stack.env` so a rebuild keeps the same keys (above all `N8N_ENCRYPTION_KEY`, without which n8n's saved credentials can't be read). Back the file up. |
| `deploy\stack\Test-LocalAI-Stack.ps1` | Compares every running container with `compose.yml` (image, restart, ports, mounts, network, command, environment values) without changing anything or printing values. |

Run them from a normal Windows session, not SSH: Docker's credential helper can't pull images over SSH.

On the current host the containers were made by hand and from compose files in `C:\LocalAI\n8n`. They match
`compose.yml` except where the repo is now the source: the proxy and SearXNG still read their (identical) config
from `C:\LocalAI\n8n`, and the appliance still sets `APP_VERSION`, which no longer matters (the release
sets the version). `Install-LocalAI-Stack.ps1 -Adopt` brings them under compose.

**Rotating the sandbox key.** Put a new random value in `SANDBOX_API_KEYS` in `stack.env`, then run
`docker compose --env-file C:\LocalAI\stack\stack.env -f deploy\stack\compose.yml up -d sandbox-api` (after adopting). Finally, give
n8n's assistant the new key in its sandbox connection settings.

**Applying a `compose.yml` change.** Deploys and repairs never recreate running containers (`--no-recreate`), so a
change to `compose.yml` (a limit, a healthcheck, a pinned image) waits until it is applied by hand:

```powershell
Disable-ScheduledTask 'LocalAI Safe Deploy'
docker compose -p local-ai --env-file C:\LocalAI\stack\stack.env -f C:\LocalAI\repo\deploy\stack\compose.yml up -d
docker ps --format 'table {{.Names}}\t{{.Status}}'          # wait for (healthy)
.\deploy\stack\Test-LocalAI-Stack.ps1
Enable-ScheduledTask 'LocalAI Safe Deploy'
```

`up -d` recreates only the services whose settings changed; a running mission or image is interrupted, so pick a quiet
moment. Every service logs to json-file capped at 3 × 10 MB (`x-logging`), and the long-running ones have healthchecks.

## Old backup containers

Migrations keep the container they replace, stopped, for rollback: `local-ai-<name>-pre-compose`
(`Install-LocalAI-Stack.ps1 -Adopt`), `local-ai-appliance-pre-hostport` (`Enable-LocalAI-HostOnlyPort.ps1`) and
`local-ai-n8n-pre-lockdown`. They are kept for 7 days, then tidied automatically by
`deploy\Remove-LocalAI-OldBackups.ps1`, which the auto-deploy runs after a healthy deploy or on a quiet run while
`/healthz` is OK. It removes a backup only when all of these hold:

- the name is exactly `local-ai-<name>-pre-compose`, `-pre-hostport` or `-pre-lockdown`;
- it is stopped (exited or created), never running;
- its live twin (the name without the suffix, or that compose service) is running and healthy;
- it has been stopped for 7 days (the later of its created and finished times; a renamed container keeps its
  original created time).

It runs `docker update --restart=no`, then `docker rm` without `-v`: volumes are never removed, and it never prunes or
removes volumes or images. Each removal is a line in `auto-deploy.log` (`tidy: Removed old backup container …`), and
the Inbox gets one notice, e.g. "Removed 5 old backup containers (stopped copies from earlier migrations)". A failure
is logged and never fails the deploy.

Backups made before this change could still restart with Windows: Docker then tried to start one next to the live
stack and logged `Bind for 0.0.0.0:3080 failed: port is already allocated`. The scripts now create backups with
`--restart=no`, and the tidy sets `--restart=no` on any stopped backup it finds, old enough or not.

Two other stopped containers on the current host were not made by these scripts, so the tidy leaves them alone. Both
are safe to remove by hand if you don't want them:

```powershell
docker rm festive_turing                    # Docker Desktop's getting-started tutorial
docker rm localai-agent-design-candidate    # made by hand, not by these scripts
```

**Never run `docker system prune --volumes` (or `docker volume prune`) on this host.** Stopped containers' volumes count
as unused, and the volumes hold data that can't be recreated: Caddy's certificate authority (`localai-caddy-data`;
losing it means every phone and computer has to trust a new certificate), n8n's workflows and credentials (`n8n_data`), and the
appliance's database. Remove containers by name with `docker rm <name>`.

## Versions and release notes

Each deploy writes `app\release.json` (`New-LocalAI-ReleaseInfo` in `deploy\Deployment-LocalAI.ps1`):

- **version**: major.minor from `package.json` at that commit, then the number of commits on `main`
  (`git rev-list --count`), e.g. `2.0.431`. It rises with every release; bump major.minor in `package.json` by hand
  for a notable change.
- **notes**: one entry per merged PR since the previous live release (`git log --first-parent`): the PR title and
  number, from squash merges (`Title (#92)`) and merge commits (`Merge pull request #93 …`, title from the body).
- **deployedAt**.

Only the commit is required. If git can't answer, the release ships with just the commit. The app records each new
release once at startup (`release:history:*` settings, last 50) and serves them at `GET /api/releases`. Health ›
What's new lists them, and the first page load after an update says "Updated to …". The Inbox notice names the
version and the changes.

## Manual deploys

```powershell
.\deploy\Get-LocalAI-DeployStatus.ps1           # health, running vs recorded SHA, origin/main, task state
.\deploy\Get-LocalAI-DeployStatus.ps1 -AsJson
.\deploy\Deploy-LocalAI.ps1 -CheckOnly          # certify origin/main without touching production
.\deploy\Deploy-LocalAI.ps1                     # certify and promote
.\deploy\Deploy-LocalAI.ps1 -TargetRef <ref>    # a specific ref or SHA
```

The deploy lock keeps a manual run and the scheduled task from overlapping.

When driving the host remotely (for example `ssh windows` with an `-EncodedCommand`), run the deploy as a
child process and keep its output, rather than calling it inline:

```powershell
& powershell -NoProfile -File C:\LocalAI\repo\deploy\Deploy-LocalAI.ps1 *> C:\LocalAI\deploy-last.log
```

## Candidate tests

`deploy\Test-LocalAI-Candidate.ps1 -CandidateRoot <dir>` checks, in order:

- required files under `app` (server, storage, front-end bundle, view registry, service worker, manifest);
- `node --check` on every `.js` file;
- string contracts in `server.js`, `app.js`, `ui.js`, `app.css`, `index.html` and `agent-orchestrator.js`
  (routes, element ids, function names): renaming one of these fails the deploy;
- no `.env`, `.key`, `.pem`, `.pfx` or `.p12` files in `app`;
- the native tests `release`, `storage`, `storage-api` and `agent-orchestrator`, run with the appliance image's
  own Node (`docker run` of the `local-ai-appliance` image), or with local Node when `-LocalNode` is passed (CI);
- `tests\Test-LocalAI-DeployContracts.ps1`: the deploy and rollback scripts against simulated Docker and git.

## Rollback

A failed deploy rolls back by itself. To roll back a healthy release by hand:

```powershell
.\deploy\Rollback-LocalAI.ps1                                   # restore the snapshot recorded in state.json
.\deploy\Rollback-LocalAI.ps1 -Snapshot C:\LocalAI\.deploy\live-before-<guid>
```

Rollback takes the deploy lock, stops the container, backs up the database (`/data/backups/before-rollback-<guid>.db`),
restores the code, starts the container and checks health. Rolling back to a release that predates SQLite
first exports the database to JSON; see [Storage › Code rollback across the JSON boundary](STORAGE.md#code-rollback-across-the-json-boundary).

Rolling back code does not roll back data. To return data to an earlier point, restore a backup
([Operations › Restore](OPERATIONS.md#restore)).

The auto-deploy task will redeploy `origin/main` on its next run if `main` still points at the bad commit.
Revert the commit on `main`, or uninstall the task, before rolling back by hand.

### Deploy states

`C:\LocalAI\.deploy\state.json` `status`:

| Status | Meaning |
|---|---|
| `HEALTHY` | The last deploy succeeded; `currentCommit` is running |
| `ROLLED_BACK` | A deploy failed after replacing code (or a manual rollback ran); the previous code is running |
| `DEPLOY_FAILED_UNCHANGED` | A deploy failed before replacing code; production was not touched |
| `RECOVERY_REQUIRED` | Automatic recovery failed; the container is left stopped and `currentCommit` is null |

On `RECOVERY_REQUIRED`, keep `C:\LocalAI\.deploy`, `C:\LocalAI\releases` and `/data/backups`; they hold the
snapshot, the candidate and the data backup needed to explain or reverse the change. Inspect the stopped
container before trying again.

## HTTPS with Caddy

`deploy\Install-LocalAI-HTTPS.ps1` runs Caddy (`local-ai-https`, image `caddy:2.10-alpine`) on the
appliance's Docker network. It serves `https://<host IP>` and `https://localai.home.arpa` on port 443 and
redirects port 80 to HTTPS. Port 3080 keeps working, and the deploy scripts keep using it.

```powershell
docker pull caddy:2.10-alpine                       # once, from a normal (not SSH) session
.\deploy\Install-LocalAI-HTTPS.ps1                  # elevated: trusts the CA on this machine, adds a firewall rule
.\deploy\Install-LocalAI-HTTPS.ps1 -HostIp 10.0.0.21 -Name localai.home.arpa
```

- Certificates come from Caddy's own local CA; its data is in the `localai-caddy-data` volume.
- The root certificate is exported to `C:\LocalAI\https\localai-ca.crt` and imported into the host's
  `LocalMachine\Root` store (skip with `-SkipTrustOnHost`).
- Other devices download it from `http://<host IP>/localai-ca.crt` and trust it once. **Health › Secure
  connection** shows the steps for each platform (the current device's first) and whether it already trusts it.
- Setting up a phone: open Health on a computer **by the host's network address** (`https://<host IP>`, not
  `localhost`) and unfold **Set up a phone or tablet**. It shows two QR codes, one for the certificate and one for
  `https://<host IP>/`. A phone that opens the plain-HTTP address gets a **Use the secure address on this device**
  item in Home's Needs you until it switches, or until **Don't remind me on Home** is pressed in the setup.
- `localai.home.arpa` needs a DNS entry pointing at the host, in the router or a device's hosts file.
- Away from home (Tailscale): install Tailscale on the host and the phone and sign both in to the same account,
  then re-run `Install-LocalAI-HTTPS.ps1` (elevated). It reads the host's Tailscale name (`-RemoteName` to set it,
  `-NoRemote` to leave it out), serves HTTPS for it with the same certificate, and adds the firewall rule
  `Local AI HTTPS (Tailscale)`: ports 80/443 from `100.64.0.0/10` only. Nothing is opened to the internet. When the
  containers come from `deploy\stack\compose.yml` (the current host), it writes the values into
  `C:\LocalAI\stack\stack.env` and runs `docker compose ... up -d https appliance`, so Health's phone QR code picks
  up the name too. Otherwise it runs Caddy directly, and the appliance needs `LOCALAI_REMOTE_NAME` set by hand.
  Use the name, not the `100.x` address: browsers send no server name for an IP, so Caddy would answer with the LAN
  IP's certificate.
- The appliance lists its addresses in `/healthz` and `/api/access` as `addresses: [{label: 'Home Wi-Fi', url},
  {label: 'Anywhere (Tailscale)', url}]`, from `LOCALAI_HOST_IP` and `LOCALAI_REMOTE_NAME` (compose passes both from
  `stack.env`; the installer re-run recreates the appliance with them). A phone's saved copy offers the address it
  isn't using when Local AI can't be reached, and Health › Secure connection lists both. A missing value leaves its
  address out.
- The firewall rule `Local AI HTTPS` opens 80 and 443 on private networks only.
- After editing `deploy\caddy\Caddyfile`: `docker exec local-ai-https caddy reload --config /etc/caddy/Caddyfile`,
  or re-run the installer. Caddy reads the file from `C:\LocalAI\repo\deploy\caddy`, which the auto-deploy keeps
  current, but a deploy doesn't reload Caddy: a merged Caddyfile change takes effect on that one-line reload.
- While a deploy restarts the appliance, Caddy holds each request and retries for up to 20 s (`lb_try_duration`). If the
  appliance is still gone (a deploy backs up the database while it is stopped), API calls and `/healthz` get
  `503 {"error":"Local AI is updating","updating":true}` with `Retry-After: 5`, and pages get a short "Local AI is
  updating, back in a moment" page that reloads itself. Health reads the 503 as "Local AI is updating…" and checks
  again after `Retry-After`.
- Over SSH, `docker pull` fails with `A specified logon session does not exist` (Docker's credential helper);
  pull from a desktop session.

## Host-only Workbench port

The PowerShell Workbench must only answer on the Windows host. `deploy\Enable-LocalAI-HostOnlyPort.ps1`
(one time) recreates `local-ai-appliance` with the same image, environment, mounts, network and restart
policy, plus `LOCAL_UI_PORT=3090` published on `127.0.0.1:3090` only.

```powershell
.\deploy\Enable-LocalAI-HostOnlyPort.ps1             # -LocalPort 3090 by default
```

It keeps the old container stopped as `local-ai-appliance-pre-hostport` (set never to restart) and restores it,
with its restart policy, if the new one does not become healthy within a minute. The backup is
[tidied after 7 days](#old-backup-containers). Re-running it when the port is already set up does nothing. See
[Security](SECURITY.md#powershell-workbench) for why the port matters.

## SQLite and deploys

The image's Node must support `node:sqlite` (22.13 or newer); step 6 checks this before production is touched.
Each SQLite deploy backs up the database separately from the code snapshot. Storage workers run in throwaway
containers with `--network none`, mounting the data volume explicitly. Details, the JSON rollback boundary
and the Docker Desktop stopped-container case are in [Storage](STORAGE.md).
