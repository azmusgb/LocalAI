# LocalAI Safe Deploy v2

Pull-based deployment for the LAN-only LocalAI appliance. The production application lives under `C:\LocalAI\appliance\app`; deployment candidates are built from the repository at `C:\LocalAI\repo` and promoted only after validation.

## 1. Inspect deployment state

```powershell
Set-Location C:\LocalAI\repo
.\deploy\Get-LocalAI-DeployStatus.ps1
```

This reports appliance health, the deployed commit, `origin/main`, whether production is behind the remote ref, and scheduled-task state.

## 2. Manually certify the current `origin/main`

```powershell
.\deploy\Deploy-LocalAI.ps1 -CheckOnly
```

Fetching and candidate validation do not alter production.

## 3. Manually deploy

After certification passes:

```powershell
.\deploy\Deploy-LocalAI.ps1
```

Deployment behavior:

1. Fetch `origin/main`.
2. Materialize an immutable candidate release by commit SHA.
3. Run `deploy\Test-LocalAI-Candidate.ps1`.
4. Snapshot the current live application.
5. Promote the candidate and restart `local-ai-appliance`.
6. Require `http://127.0.0.1:3080/healthz` to recover.
7. Restore the snapshot automatically if the health check fails.

## 4. Install unattended checks or deployment

The scheduler is hidden and launches PowerShell with `-NonInteractive -WindowStyle Hidden`, so it does not create a recurring console window.

Start with **validation-only** mode:

```powershell
.\deploy\Install-LocalAI-DeployAgent.ps1 -Install -ValidateOnly -EveryMinutes 5 -StartNow
```

Inspect it:

```powershell
.\deploy\Get-LocalAI-DeployStatus.ps1
Get-ScheduledTask -TaskName 'LocalAI Safe Deploy'
Get-ScheduledTaskInfo -TaskName 'LocalAI Safe Deploy'
```

Once manual deployment and rollback have been proven on the host, switch the same task to deployment mode:

```powershell
.\deploy\Install-LocalAI-DeployAgent.ps1 -Install -EveryMinutes 5 -StartNow
```

To remove the task:

```powershell
.\deploy\Install-LocalAI-DeployAgent.ps1 -Uninstall
```

## Recovery

The deployment state is stored under `C:\LocalAI\.deploy`. Each promotion records the deployed SHA and the pre-deploy snapshot used for rollback.

Use the dedicated rollback script when a manual rollback is required:

```powershell
.\deploy\Rollback-LocalAI.ps1
```

Do not delete `C:\LocalAI\.deploy` or `C:\LocalAI\releases` while diagnosing a failed deployment; they contain the state and candidate snapshots needed to explain or reverse the change.


## SQLite rollout

The Node runtime inside `local-ai-appliance` must support `node:sqlite` (Node 22.13+); the deployment script checks this before touching live code. Candidate archives now include native regression tests. The application is stopped during promotion. SQLite deployments back up data separately from application snapshots; rollback to a pre-SQLite snapshot exports current data before starting the older JSON-backed application. See [docs/STORAGE.md](docs/STORAGE.md) for migration and recovery details. Verify the first promotion and rollback manually on the host before enabling unattended deployment.
