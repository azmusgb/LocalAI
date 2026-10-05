# LocalAI Safe Deploy v2

Pull-based deployment for the LAN-only LocalAI appliance. The production application lives under `C:\LocalAI\appliance\app`; deployment candidates are built from the repository at `C:\LocalAI\repo` and promoted only after validation.

## 1. Inspect deployment state

```powershell
Set-Location C:\LocalAI\repo
.\deploy\Get-LocalAI-DeployStatus.ps1
```

This reports appliance health, the running release SHA, the recorded deployment SHA, any disagreement between them, `origin/main`, whether production is behind the remote ref, and scheduled-task state. An error JSON response is reported as unhealthy.

## 2. Manually certify the current `origin/main`

```powershell
.\deploy\Deploy-LocalAI.ps1 -CheckOnly
```

Fetching and candidate validation do not alter production. Validation includes the actual container image's Node runtime and migration of a disposable data copy with the original volumes mounted read-only.

## 3. Manually deploy

After certification passes:

```powershell
.\deploy\Deploy-LocalAI.ps1
```

Deployment behavior:

1. Fetch `origin/main`.
2. Materialize an immutable candidate release by commit SHA.
3. Run `deploy\Test-LocalAI-Candidate.ps1`.
4. Validate a disposable copy of current data, then stop the application, snapshot its code, back up existing SQLite data and repeat migration preflight.
5. Promote the candidate, write its exact SHA to `app\release.json` and restart `local-ai-appliance`.
6. Require `http://127.0.0.1:3080/healthz` to report `status: ok`, SQLite storage and the expected release SHA.
7. Restore the snapshot automatically if certification fails, preserving current data when crossing the JSON boundary.

A deployment is skipped only when recorded state, the live manifest and healthy runtime all agree on the target SHA. A shared lock prevents concurrent deployment/rollback, and state updates use atomic file replacement. Data must be mounted outside `/app` so application replacement cannot delete it.

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

Manual rollback updates the recorded current SHA to the restored release. Custom legacy snapshots without a manifest or tracked SHA report an unknown commit. If recovery fails, state becomes `RECOVERY_REQUIRED` with no claimed current SHA and retains error and backup details. Preserve those artifacts and inspect the stopped appliance before attempting further recovery.

Use the dedicated rollback script when a manual rollback is required:

```powershell
.\deploy\Rollback-LocalAI.ps1
```

Do not delete `C:\LocalAI\.deploy` or `C:\LocalAI\releases` while diagnosing a failed deployment; they contain the state and candidate snapshots needed to explain or reverse the change.


## SQLite rollout

The Node runtime inside `local-ai-appliance` must support `node:sqlite` (Node 22.13+); the deployment script checks this before touching live code. Candidate archives now include native regression tests. The application is stopped during promotion. SQLite deployments back up data separately from application snapshots; rollback to a pre-SQLite snapshot exports current data before starting the older JSON-backed application. See [docs/STORAGE.md](docs/STORAGE.md) for migration and recovery details. Verify the first promotion and rollback manually on the host before enabling unattended deployment.
