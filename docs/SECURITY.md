# Security

What LocalAI protects, how, and where it does not. Everything here is what the code does today
(file references are to this repository); planned work is listed only under [Known gaps](#known-gaps).

## Threat model

- **Trusted:** the owner, the Windows host's logged-on user, the Mac running Claude Code, and anyone who can
  push to `main` on GitHub (the host deploys whatever is there).
- **Semi-trusted:** any device on the home LAN. It can use the app. It must not be able to run code on the
  Windows host, read host secrets, or impersonate the Mac.
- **Untrusted:** the internet, and other websites open in a LAN browser.
- **Treated as compromisable:** the appliance container itself. It runs developer commands for anyone on
  the LAN, so host-side execution must not depend on trusting it.

## Network exposure

| Surface | Reachable from | Control |
|---|---|---|
| App and API, port 3080 | LAN | No sign-in (see gaps); cross-site browser writes blocked ([guard](#other-controls)) |
| HTTPS, ports 80/443 (Caddy) | LAN, private network profile only | Firewall rule `Local AI HTTPS` (`deploy/Install-LocalAI-HTTPS.ps1`) |
| PowerShell Workbench, port 3090 | Windows host only | Published on `127.0.0.1` only (`deploy/Enable-LocalAI-HostOnlyPort.ps1`) |
| GridCraft bridge, ComfyUI | Windows host only | Bound to `127.0.0.1` by this repo's installers (`Install-GridCraft-Bridge.ps1`, `Install-ComfyUI-Task.ps1` `-Listen` default) |
| Ollama, n8n | Windows host only, **if configured so** | Expected host configuration, not enforced by this repo: Ollama via the user env var `OLLAMA_HOST=127.0.0.1:11434`, n8n via `-p 127.0.0.1:5678:5678` on a container defined outside the repo. Verify below |
| Mac | nothing | The chat bridge and hooks only make outbound calls |

Nothing should be port-forwarded from the router.

Verify the loopback bindings on the host (every `LocalAddress` should be `127.0.0.1`, and n8n's port
mapping should read `127.0.0.1:5678->5678/tcp`):

```powershell
Get-NetTCPConnection -State Listen | ? LocalPort -in 11434,5678,8188,8787 | Select LocalAddress, LocalPort, OwningProcess
docker ps --format '{{.Names}} {{.Ports}}'
```

## PowerShell Workbench

Running PowerShell on the host is the most powerful thing the system does, so it has the most layers
(`app/server.js` `localUiRequest`/`requireLocalUi`; `host/powershell-bridge/`):

1. **Host-only port.** With `LOCAL_UI_PORT` set, Workbench APIs answer only on requests that arrived on that
   socket port, which Docker publishes on the host's `127.0.0.1`. A LAN client cannot reach it, even by faking
   the Host header.
2. **Loopback Host header.** The Host header must be `localhost`, `127.0.0.1` or `::1`, which blocks
   DNS-rebinding pages in the host's own browser.
3. **UI token.** Every Workbench call needs `X-LocalAI-PowerShell-Token` matching `POWERSHELL_UI_TOKEN`
   (`C:\LocalAI\powershell-bridge\ui-token.txt`).
4. **Approval, then an explicit `RUN`.** A job is created, approved, then queued with the typed confirmation `RUN`.
5. **Signed jobs.** The browser signs `localai-ps-v1\n<id>\n<cwd>\n<timeoutSec>\n<script>` with HMAC-SHA256
   using `approval-key.txt`. The host runner verifies the signature (constant-time compare) before running.
   The key exists only on the host and in the operator's browser session, never in the container, so a
   compromised container cannot produce a runnable job.
6. **Runner limits.** The runner authenticates to the appliance with a bearer token (`host-token.txt` /
   `POWERSHELL_BRIDGE_TOKEN`), accepts working directories only under `C:\Projects`, `C:\repos` or `C:\LocalAI`
   (checked on both sides), and runs as the logged-on user at limited privilege.

The runner's scheduled task (`Local AI PowerShell Host`) can be removed with
`Enable-LocalAI-PowerShellHost.ps1 -Disable`; without it, approved jobs simply wait.

## Claude chat relay

Details in [Claude chat › Security notes](CLAUDE-CHAT.md#security-notes). In short (`app/claude-chat.js`):

- The Mac authenticates with a 32-byte key; the appliance stores only its SHA-256 in
  `/data/claude-chat-mac-key.sha256`, written by `host/claude-chat/install.sh` over ssh. No endpoint can set it.
- Phones and browsers pair with a 6-character code (10 minutes, at most 5 pending) that only the Mac can
  approve. The device cookie `localai_chat_device` is HttpOnly, `SameSite=Strict`, scoped to
  `/api/claude/chat`, valid 180 days, and `Secure` when the device paired over HTTPS (a TLS socket or
  `X-Forwarded-Proto: https` from Caddy; `requestIsHttps`); the appliance stores only its hash. Any paired device can
  revoke any device. The header is trusted from any client: spoofing it on port 3080 only makes that client's own
  cookie HTTPS-only.
- The Mac side (bridge, hooks, CLI) talks to `https://10.0.0.21` and verifies it against the LocalAI CA, which
  `install.sh` fetches over `ssh windows-ai` (authenticated), checks with `openssl x509` and records in
  `~/.claude/localai-chat/config.json`. Verification is never turned off; an untrusted certificate fails with a log
  line. If HTTPS is not available at install time, the installer keeps plain HTTP and says so (see gaps).
- POSTs to the relay reject a foreign `Origin` and require `Content-Type: application/json` (`checkPost`).
- Web messages act with the Claude Code session's own permissions and cannot answer permission prompts.

## Other controls

- **Cross-site request guard.** Before routing, every `POST`, `PUT`, `PATCH` and `DELETE` is rejected with 403
  `Cross-site request blocked` when `Sec-Fetch-Site` is `cross-site`, or when an `Origin` header is present and its
  host:port matches neither the `Host` header nor `X-Forwarded-Host` (`crossSiteRequest` in `app/server.js`;
  `tests/cross-site-guard.test.cjs`). So another website open in a LAN browser can no longer drive the API, whatever
  the content type. Requests that carry neither header (curl, scripts, hooks, the host's jobs) pass: this blocks
  browsers being used against the appliance, it does not authenticate anyone. `GET` is not checked, so `GET` routes
  must stay free of side effects.
- **Child process environment.** Commands the app spawns get its environment minus any variable whose name
  matches `TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL` (`childEnv` in `app/server.js`;
  `tests/security-contract.test.cjs`).
- **File access.** Files and Repository paths are resolved inside `WORKSPACE_ROOT` (`safeWorkspacePath`); writes
  and commands need `approved: true` in the request body. That flag is a confirmation step, not authentication.
  Commands are limited to `node`, `npm`, `npx`, `git`, `python3` and `pytest`, run without a shell, with a
  two-minute timeout.
- **Model management.** Pull, cancel and delete check `Origin` and `Content-Type`; the default model and
  the GridCraft model (plus `PROTECTED_MODELS`) cannot be deleted.
- **GridCraft bridge.** Bound to `127.0.0.1`; CORS limited to the configured LocalAI origins; one run at a time.
- **No secrets in the image or repo.** `.gitignore` excludes keys and `.env`; CI and the candidate test
  fail on `.env`, `.key`, `.pem`, `.pfx` or `.p12` files under `app/`. Tokens reach the container only as
  environment variables; `Enable-LocalAI-HostOnlyPort.ps1` passes them through a user-only temp file that it deletes.
- **Deploys** are pulled: the host fetches `origin/main` every five minutes and runs whatever is there,
  including that commit's own candidate tests and deploy scripts. Nothing on the LAN can push code to the
  appliance, but anyone who can push to `main` can run code on the host (see gaps).
- **HTTPS.** Shipped: Caddy (`local-ai-https`) terminates TLS on 443 with its own local CA
  (`deploy/caddy/Caddyfile`, `deploy/Install-LocalAI-HTTPS.ps1`), redirects port 80 to HTTPS, and serves the CA
  certificate at `http://<host>/localai-ca.crt`. Each device trusts the CA once; **Health › Secure connection**
  tells a device whether it is on HTTPS and whether it already trusts the CA. Setup: [Deploy › HTTPS](DEPLOY.md#https-with-caddy).

## Known gaps

| Gap | Effect | Where |
|---|---|---|
| GitHub access to this repo means code on the host | The auto-deploy runs `origin/main` and that commit's scripts as the host user. Enable branch protection on `main` with required CI and reviews, and protect the GitHub account. CI is path-filtered and docs-only PRs run none, so a required check that did not run will block those PRs. Whether branch protection is on cannot be checked from the repo | `deploy/Run-LocalAI-AutoDeploy.ps1`, `deploy/Deploy-LocalAI.ps1` |
| Ollama and n8n loopback binding is host configuration | If `OLLAMA_HOST` is unset or n8n is published on all interfaces, the model API or the n8n editor is open to the LAN without auth | [Network exposure](#network-exposure) |
| No user authentication on port 3080 or 443 | Anyone on the LAN can read conversations and projects, start runs, edit files under `WORKSPACE_ROOT`, and run `node`/`npm`/`npx` there (code execution inside the container) | `app/server.js` request router |
| Change requests are unauthenticated | Any LAN client can request a change. A `self` change copies `SELF_APP_ROOT` to `DATA_DIR/change-staging/<id>/app`, applies a model-written patch there and validates it by running `node --check` and starting the staged `server.js` inside the container. Shipping it only hands it to a Claude session as an Improve item; it reaches the live app only as a pull request the owner merges. A `workspace` change, once approved, writes its files into `WORKSPACE_ROOT` | `stageChangeByIdUnlocked`, `validateStagedChange`, `apiChangeRequestApply` in `app/server.js` |
| Files and Repository write under `WORKSPACE_ROOT` without auth | A LAN user can create or overwrite any file in the mounted workspace and run allow-listed commands there. What `/workspace` is mounted from is set by the container definition, which is not in this repo | `apiWorkbenchWrite`, `apiWorkbenchCommand` in `app/server.js` |
| Port 3080 stays plain HTTP | HTTPS on 443 is available, but 3080 is still open and nothing redirects it; anything using `http://<host>:3080` is unencrypted on the Wi-Fi | container port mapping; `deploy/caddy/Caddyfile` |
| The Mac falls back to plain HTTP when HTTPS is unavailable | On a fresh install, `install.sh` keeps `http://10.0.0.21:3080` (with a warning) if it cannot fetch a valid CA over ssh or cannot reach `https://10.0.0.21` with it, and a Mac installed before the HTTPS change stays on HTTP until `install.sh` is re-run. An existing HTTPS config is never downgraded without `install.sh --allow-http`, and an unreadable `config.json` stops sending instead of falling back. On HTTP the Mac key crosses the Wi-Fi in clear on every poll; whoever captures it can approve pairings and impersonate sessions. Rotate it if exposed ([steps](CLAUDE-CHAT.md#security-notes)) | `host/claude-chat/install.sh`, `~/.claude/localai-chat/config.json`, `LOCALAI_URL` |
| Chat device cookies paired over plain HTTP lack `Secure` | A device that paired on `http://<host>:3080` (or before this change) keeps a cookie its browser also sends over plain HTTP. Re-pair it on the HTTPS address to get a `Secure` cookie | `app/claude-chat.js` |
| Claude board endpoints are unauthenticated | Any LAN client can post events and findings, vote, and change finding status | `/api/claude/*` in `app/server.js` |
| Host notifications endpoint is unauthenticated | Any LAN client can post `deploy`/`backup`/`monitor` notices to the Inbox | `/api/notifications/system` |
| GridCraft bridge task runs elevated | The bridge and the agent it starts run with highest privileges | `deploy/Install-GridCraft-Bridge.ps1` (`-RunLevel Highest`) |
| Nightly backups go to OneDrive | A copy of the whole database leaves the PC | `deploy/Backup-LocalAI-Data.ps1` (`-OffsiteRoot`) |
| `/go/n8n` and `/go/comfy` redirect to ports bound to loopback | They only work on the host itself | `redirectFor` in `app/server.js` |
