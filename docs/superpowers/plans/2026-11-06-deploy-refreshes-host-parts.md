# Deploys refresh the long-running parts a release changes (#450): plan

Date: 2026-11-06 · Status: for the owner's review · Issue: #450 (and its comment on container configuration).
Documentation only.

**Goal:** when Safe Deploy promotes or rolls back a release, every long-running part that the release changed is
running that release's code and configuration, has been checked, and a failure is a failed deploy. Nothing on the PC
quietly keeps running older code.

## What exists today (read on 6 Nov 2026)

`origin/release` `8e76eb7`, live and healthy (`/healthz`, `mcp__home__deploy_state`).

- **What a deploy does** (`deploy/Deploy-LocalAI.ps1`):
  - It extracts the release.
  - It certifies it (`Test-LocalAI-Candidate.ps1`, storage checks).
  - It runs `docker stop` on `local-ai-appliance`, mirrors `app/` into `C:\LocalAI\appliance\app`, runs `docker start`
    and checks `/healthz` for the commit.
  - On failure it restores the snapshot and starts the container again.
  - `Rollback-LocalAI.ps1` does the same in reverse.
  - The only other part it refreshes is the PowerShell host's script (`Update-LocalAI-PowerShellHost`).
- **`docker start` reuses the container as it was created.** Compose changes (environment, mounts) never reach it.
  - `local-ai-appliance` was created on 2 Nov at 03:49 UTC.
  - Three later commits changed its compose service: `0c80627` and `41b25b0` (2 Nov, phone notices through Pi Hub)
    and `041b10b` (4 Nov, `LOCALAI_PUBLIC_HOST`).
  - The running container has neither `LOCALAI_PI_HUB_TOKEN` nor `LOCALAI_PUBLIC_HOST`. Only the names were read
    (`docker inspect`), never the values.
  - `stack.env` doesn't have them either: a `findstr` count of 0 for each.
  - So phone notices go by Web Push only (`app/hub-notify.js`: no token means no Pi Hub channel), and tap links use
    the default host. The deploy key the token is meant to hold is in `C:\LocalAI\stack\pi-hub-deploy.key`.
  - #445's `/atlas-snapshots` mount, which the issue's comment found missing, is present now: someone recreated the
    container by hand on 2 Nov.
- **Atlas Intelligence is a scheduled task**, `LocalAI Atlas`:
  - At logon, as `bjrmc`, it runs `C:\Python312\python.exe -u atlas_intelligence.py --host 127.0.0.1 --port 8765`.
  - It starts in `C:\LocalAI\repo` and logs to `C:\LocalAI\logs\atlas.log`.
  - It last started on 4 Nov at 10:33 AM.
  - Two later commits on `release` changed it (`504da6f` and `95cad57`, Atlas PR 6, both 4 Nov). It is running older
    code today.
  - Safe Deploy moves that checkout to `release` (`Run-LocalAI-AutoDeploy.ps1:149-153`) but never restarts the task.
  - The one script that restarts it by hand is `scripts/atlas-investigations/Install-Atlas-Investigations.ps1:108-127`.
    It kills the port-8765 listener, starts it again and waits up to 30 s for `GET /health` `{ok:true}`.
- **No list exists** of the long-running parts and the paths that feed them.
- **Pi Hub has the same kind of gap.** `pi-hub-release-incoming` is refreshed only by `install.sh`. It's out of scope
  here (see the end).

## Decisions this plan makes (for the owner's review)

None changes the platform spec. If you disagree with one, it changes here.

1. **One list of the PC's long-running parts, kept in the repo:** `deploy/host-parts.json`.
   - Each part has an `id`, a `kind`, what it runs from, how to restart it and its health check.
   - `kind` is `scheduled-task` or `compose-service`.
   - The two first entries:
     - `atlas`: a `scheduled-task`, `LocalAI Atlas`. Its paths are `atlas_intelligence.py`,
       `atlas_snapshot_runner.py` and `quick_arch.py`; its health is `GET http://127.0.0.1:8765/health` with
       `ok: true`.
     - `appliance`: a `compose-service`, `appliance`, in `deploy/stack/compose.yml`, with `/healthz` as today.
   - A test fails if a Python or PowerShell file at the repo root, or under `host/`, runs as a long-lived process but
     isn't listed.
   - Rejected: restarting everything on every deploy. It would cut Atlas and the container on every release, even when
     nothing of theirs changed.
2. **What "changed" means.**
   - A **scheduled task** changed when the release changes a file in its `paths`, compared with the commit it last
     started from. The deploy records that commit in `C:\LocalAI\.deploy\parts.json` each time it starts the task. The
     first deploy, with no record, counts it as changed, which is safe.
   - A **compose service** changed when `docker compose config --hash appliance` differs from the running container's
     `com.docker.compose.config-hash` label. That also catches `stack.env` edits, not only `compose.yml`.
   - Rejected: comparing `compose.yml` by path only, which misses an owner's `stack.env` change.
3. **Recreate, not start, when the container changed.**
   - The deploy runs `docker compose up -d --no-deps --force-recreate appliance` in place of `docker start`. Any other
     time it keeps `docker start`.
   - Rollback recreates it from the previous release's `deploy/stack/compose.yml`. Every release folder under
     `C:\LocalAI\releases\<sha>` has one.
   - Data isn't touched: the volume is outside the container.
4. **A part that fails to come back is a failed deploy, rolled back like the app.**
   - Atlas is restarted after the app passes `/healthz`. If `/health` doesn't answer `ok` within 60 s, the deploy rolls
     back the app and the checkout, starts Atlas again at the previous commit, and records `ROLLED_BACK` with the cause
     "Atlas didn't come back".
   - **This trades availability for honesty:** an Atlas bug stops an unrelated app change from shipping.
   - Rejected: a "deployed, Atlas degraded" state. It would let the platform claim a release that is half running, which
     is the situation #450 is about.
5. **Restarts are scoped to the one part.** Atlas restarts by ending only the process listening on 8765 and starting
   the task (`schtasks /run`), the way the manual script does. Never `docker restart` for everything, and never a
   reboot.
6. **A stale part shows before it's fixed.** Until a part is refreshed, `Get-LocalAI-DeployStatus.ps1` and the release
   report name it ("Atlas runs `a1b2c3d`, the release is `8e76eb7`"). `mcp__home__deploy_state` then shows it as a
   warning, so the drift we found today would have been visible on 4 Nov.

## PRs

Each is its own PR, shipped with `npm run ship`. The order lets PR 1 report the drift before anything restarts
anything.

### PR 1: the parts list and drift reporting, no restarts

- **Covers:** decisions 1, 2 and 6. **Partial:** nothing restarts yet.
- **Files:**
  - `deploy/host-parts.json`.
  - `deploy/Deployment-LocalAI.ps1`: `Get-LocalAI-HostParts`, `Test-LocalAI-HostPartStale`.
  - `deploy/Get-LocalAI-DeployStatus.ps1`, which reports stale parts.
  - `deploy/Send-LocalAI-ReleaseReport.ps1`, which adds a `parts` block.
  - `tests/Test-LocalAI-DeployContracts.ps1`: fixtures for a changed path, an unchanged path, no record yet, a changed
    hash, an equal hash, and a part that isn't on this host.
- **Evidence:** the contract tests. On the PC, a read-only `Get-LocalAI-DeployStatus.ps1` that names today's two stale
  parts (Atlas and `appliance`).

### PR 2: Atlas restarts in promotion and rollback

- **Covers:** decisions 4 and 5 for `scheduled-task`.
- **Files:** `Deploy-LocalAI.ps1`, `Rollback-LocalAI.ps1`, `Deployment-LocalAI.ps1` (`Restart-LocalAI-HostPart`,
  `Wait-LocalAI-PartHealth`) and the contract tests: restart OK, health timeout leading to rollback, a part not
  installed (skipped and reported).
- **Evidence:** the contract tests. Then the first release that changes Atlas restarts it on its own, with `/health`
  `ok` and `parts.json` holding the new commit.

### PR 3: the appliance recreates when its configuration changed

- **Covers:** decisions 2 and 3 for `compose-service`.
- **Files:** `Storage-LocalAI.ps1` (`Start-LocalAI-Container` takes `-Recreate`), `Deploy-LocalAI.ps1`,
  `Rollback-LocalAI.ps1`, and the contract tests: equal hash means start; different hash means recreate; a failed
  recreate means rollback recreates from the previous release.
- **Evidence:** the contract tests. The first deploy after it merges recreates `local-ai-appliance`, because today's
  hash differs, and `/healthz` passes. `docker inspect` then shows the new created time and hash.

### PR 4 (docs): `docs/DEPLOY.md`

What restarts when, how to add a part, and the recovery when a part won't come back.

## Owner steps

Each needs your confirmation: service restarts and a secret.

1. **Now, independent of the PRs:** add `LOCALAI_PI_HUB_TOKEN` to `C:\LocalAI\stack\stack.env`, from
   `C:\LocalAI\stack\pi-hub-deploy.key` as the compose comment says. Add `LOCALAI_PUBLIC_HOST` only if you want a host
   other than the default. Phone notices through Pi Hub stay off until this is done.
2. **Now, or let PR 3's first deploy do it:** recreate `local-ai-appliance` so it picks up the three compose changes
   (`docker compose up -d --no-deps --force-recreate appliance` in `C:\LocalAI\repo\deploy\stack`). The page is down
   for about 20 s.
3. **Now, or let PR 2's first Atlas release do it:** restart `LocalAI Atlas` so it runs Atlas PR 6. Only that task.
4. Merge each PR and `npm run ship` it.

## Acceptance

Recorded in `docs/DEPLOY.md` as "Host parts accepted <date>":

- After PR 2, a release that changes an Atlas file: `parts.json` and Atlas `/health` show the new commit, and the
  deploy log names the restart.
- After PR 3, the deploy that follows a compose change: the container's created time and hash change, and `/healthz`
  passes.
- One deliberate failure, on a test release whose Atlas health never answers: the deploy rolls back, and the state
  reads `ROLLED_BACK` with the cause. This is the owner's call, because it takes the page down briefly.

Until then, each PR is merged and deployed, never "done".

## Out of scope (noted, not gated)

- **Pi Hub's `pi-hub-release-incoming`, refreshed only by `install.sh`.** Same class of gap. It needs its own pi-hub
  issue, filed with this plan's PR.
- **The other compose services** (`local-ai-https`, `local-ai-n8n`, `local-ai-ollama-responses-proxy`). They can join
  `host-parts.json` with the same rule once the appliance's path is proven. No change to them is pending today.
- **ComfyUI and Ollama** run outside this repo's code. A release doesn't change them.
