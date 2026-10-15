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
   curl -s http://<host>:3080/healthz
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
2. Runs `Deploy-LocalAI.ps1` in a child Windows PowerShell. An idle run ends with `NO CHANGE` in about a second.
3. Posts to the Inbox (`POST /api/notifications/system`, kind `deploy`) when a release goes live, or when a
   deploy fails (once per failing commit, not on every retry).
4. Rewrites `C:\LocalAI\.deploy\auto-deploy.log`: up to 500 one-line summaries plus the last run's full output.

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

When driving the host remotely (for example `ssh windows-ai` with an `-EncodedCommand`), run the deploy as a
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
  connection** shows the steps for each platform and whether the current device already trusts it.
- `localai.home.arpa` needs a DNS entry pointing at the host, in the router or a device's hosts file.
- The firewall rule `Local AI HTTPS` opens 80 and 443 on private networks only.
- After editing `deploy\caddy\Caddyfile`: `docker exec local-ai-https caddy reload --config /etc/caddy/Caddyfile`,
  or re-run the installer.
- Over SSH, `docker pull` fails with `A specified logon session does not exist` (Docker's credential helper);
  pull from a desktop session.

## Host-only Workbench port

The PowerShell Workbench must only answer on the Windows host. `deploy\Enable-LocalAI-HostOnlyPort.ps1`
(one time) recreates `local-ai-appliance` with the same image, environment, mounts, network and restart
policy, plus `LOCAL_UI_PORT=3090` published on `127.0.0.1:3090` only.

```powershell
.\deploy\Enable-LocalAI-HostOnlyPort.ps1             # -LocalPort 3090 by default
```

It keeps the old container stopped as `local-ai-appliance-pre-hostport` and restores it if the new one does
not become healthy within a minute. Re-running it when the port is already set up does nothing. See
[Security](SECURITY.md#powershell-workbench) for why the port matters.

## SQLite and deploys

The image's Node must support `node:sqlite` (22.13 or newer); step 6 checks this before production is touched.
Each SQLite deploy backs up the database separately from the code snapshot. Storage workers run in throwaway
containers with `--network none`, mounting the data volume explicitly. Details, the JSON rollback boundary
and the Docker Desktop stopped-container case are in [Storage](STORAGE.md).
