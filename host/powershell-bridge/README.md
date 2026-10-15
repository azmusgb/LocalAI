# PowerShell Workbench host bridge

These scripts run on the Windows host, in `C:\LocalAI\powershell-bridge`, and execute PowerShell
Workbench jobs that were explicitly approved in the LocalAI UI.

## Trust model

The appliance container is reachable by every LAN client and can run developer commands, so it is
treated as untrusted for host execution. A job runs only if it carries an HMAC-SHA256 signature over
`localai-ps-v1\n<id>\n<cwd>\n<timeoutSec>\n<script>`, keyed with `approval-key.txt`. The browser computes
the signature when you queue a job (you paste the key once per browser session); this script verifies it
before running anything. The key exists only on the host and in your browser session and must never be
given to the container, so a compromised container cannot produce a runnable job.

| File | Purpose | Given to the container? |
| --- | --- | --- |
| `host-token.txt` | Bearer token the host uses to poll the appliance | yes (`POWERSHELL_BRIDGE_TOKEN`) |
| `ui-token.txt` | Unlocks the Workbench UI | yes (`POWERSHELL_UI_TOKEN`) |
| `approval-key.txt` | Signs and verifies jobs | **never** |

## Install / update

```powershell
Copy-Item C:\LocalAI\repo\host\powershell-bridge\*.ps1, C:\LocalAI\repo\host\powershell-bridge\*.vbs C:\LocalAI\powershell-bridge\ -Force
C:\LocalAI\powershell-bridge\Enable-LocalAI-PowerShellHost.ps1   # creates approval-key.txt if missing, registers the task
```

The Workbench has to be opened at `http://localhost:3080` (or `127.0.0.1`), which browsers treat as a secure
context; signing uses WebCrypto, which is unavailable on plain-HTTP LAN addresses.
