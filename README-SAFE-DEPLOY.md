# LocalAI Safe Deploy v1
Pull-based deployment for the LAN-only LocalAI appliance.

## Manual certification
```powershell
.\deploy\Deploy-LocalAI.ps1 -CheckOnly
```
Then deploy:
```powershell
.\deploy\Deploy-LocalAI.ps1
```
After manual deployment and rollback behavior are proven:
```powershell
.\deploy\Install-LocalAI-DeployAgent.ps1 -Install -EveryMinutes 5
```
Fetching does not alter production. Candidates are staged and validated before promotion. Production is snapshotted, Docker is restarted, /healthz is checked, and failed deployment restores the snapshot.