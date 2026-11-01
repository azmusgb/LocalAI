# PowerShell Workbench host bridge

These scripts run on the Windows host, from `C:\LocalAI\powershell-bridge`, and execute PowerShell Workbench
jobs that were explicitly approved in the LocalAI UI (**Build › PowerShell**). The full set of controls is in
[Security › PowerShell Workbench](../../docs/SECURITY.md#powershell-workbench).

## Trust model

The appliance container is reachable by every LAN client and can run developer commands, so it is treated as
untrusted for host execution. A job runs only if it carries an HMAC-SHA256 signature over
`localai-ps-v1\n<id>\n<cwd>\n<timeoutSec>\n<script>`, keyed with `approval-key.txt`. The browser computes the
signature when you queue a job (you paste the key once per browser session); the runner verifies it before
running anything. The key exists only on the host and in your browser session and must never be given to
the container, so a compromised container cannot produce a runnable job.

| File in `C:\LocalAI\powershell-bridge` | Purpose | Given to the container? |
| --- | --- | --- |
| `host-token.txt` | Bearer token the runner uses to poll the appliance | yes, as `POWERSHELL_BRIDGE_TOKEN` |
| `ui-token.txt` | Unlocks the Workbench UI (`X-LocalAI-PowerShell-Token`) | yes, as `POWERSHELL_UI_TOKEN` |
| `approval-key.txt` | Signs and verifies jobs | **never** |

`Enable-LocalAI-PowerShellHost.ps1` creates `approval-key.txt` (32 random bytes, hex) if it is missing. Nothing
in this repo creates `host-token.txt` or `ui-token.txt`: generate each as a long random string, and put the
same values in the container's environment.

## Install / update

```powershell
New-Item -ItemType Directory -Force C:\LocalAI\powershell-bridge | Out-Null
Copy-Item C:\LocalAI\repo\host\powershell-bridge\*.ps1, C:\LocalAI\repo\host\powershell-bridge\*.vbs C:\LocalAI\powershell-bridge\ -Force
C:\LocalAI\powershell-bridge\Enable-LocalAI-PowerShellHost.ps1            # creates approval-key.txt if missing, registers the task
C:\LocalAI\powershell-bridge\Enable-LocalAI-PowerShellHost.ps1 -Disable   # remove the task
```

The task, `Local AI PowerShell Host`, runs `Run-LocalAI-PowerShellHost.ps1 -Port 3080` every minute as the
logged-on user at limited privilege. Each run polls `/api/powershell/host/next` up to five times
(`-MaxJobs`), checks the signature and that the working directory is under `C:\Projects`, `C:\repos` or
`C:\LocalAI`, runs the job, and posts the result to `/api/powershell/host/result`.
The task starts it through `Run-LocalAI-PowerShellHost-Hidden.vbs` (`wscript.exe`), which runs the script beside it
with no console window; `powershell.exe` started straight from the task flashed a window every minute. After
updating from a release that registered `powershell.exe`, run `Enable-LocalAI-PowerShellHost.ps1` once more.

## Using the Workbench

Open it on the Windows host at `http://localhost:3090`, the host-only port set up by
[`deploy/Enable-LocalAI-HostOnlyPort.ps1`](../../docs/DEPLOY.md#host-only-workbench-port). Before that port
exists it answers at `http://localhost:3080`. Browsers treat `localhost` as a secure context; signing uses
WebCrypto, which is unavailable on plain-HTTP LAN addresses.

A job goes: create → approve → queue with the confirmation `RUN` → picked up by the runner → result.
