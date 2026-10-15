# Security

What LocalAI protects, how, and where it does not. Everything here is what the code does today
(file references are to this repository); planned work is listed only under [Known gaps](#known-gaps).

## Threat model

- **Trusted:** the owner, the Windows host's logged-on user, the Mac running Claude Code.
- **Semi-trusted:** any device on the home LAN. It can use the app. It must not be able to run code on the
  Windows host, read host secrets, or impersonate the Mac.
- **Untrusted:** the internet, and other websites open in a LAN browser.
- **Treated as compromisable:** the appliance container itself. It runs developer commands for anyone on
  the LAN, so host-side execution must not depend on trusting it.

## Network exposure

| Surface | Reachable from | Control |
|---|---|---|
| App and API, port 3080 | LAN | No sign-in (see gaps) |
| HTTPS, ports 80/443 (Caddy) | LAN, private network profile only | Firewall rule `Local AI HTTPS` (`deploy/Install-LocalAI-HTTPS.ps1`) |
| PowerShell Workbench, port 3090 | Windows host only | Published on `127.0.0.1` only (`deploy/Enable-LocalAI-HostOnlyPort.ps1`) |
| Ollama, ComfyUI, GridCraft bridge, n8n | Windows host only | Bound to `127.0.0.1`; the container reaches them via `host.docker.internal` |
| Mac | nothing | The chat bridge and hooks only make outbound calls |

Nothing should be port-forwarded from the router.

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
  `/api/claude/chat`, valid 180 days; the appliance stores only its hash. Any paired device can revoke any device.
- POSTs to the relay reject a foreign `Origin` and require `Content-Type: application/json` (`checkPost`).
- Web messages act with the Claude Code session's own permissions and cannot answer permission prompts.

## Other controls

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
- **Deploys** are pulled by the host from GitHub; nothing on the network can push code to the appliance.
- **HTTPS.** Caddy with a local CA (`deploy/caddy/Caddyfile`); each device trusts the CA once.

## Known gaps

| Gap | Effect | Where |
|---|---|---|
| No user authentication on port 3080 or 443 | Anyone on the LAN can read conversations and projects, start runs, edit files under `WORKSPACE_ROOT`, and run `node`/`npm`/`npx` there (code execution inside the container) | `app/server.js` request router |
| Most POST routes do not check `Origin` or `Content-Type` | `readBody` parses any body as JSON, so another website open in a LAN browser can send simple cross-site POSTs to the API | `readBody`, `sameOriginJson` in `app/server.js` |
| Port 3080 stays plain HTTP | HTTPS is optional; anything using `http://<host>:3080` is unencrypted on the Wi-Fi | `deploy/Install-LocalAI-HTTPS.ps1` |
| Mac bridge and hooks default to `http://10.0.0.21:3080` | The Mac key crosses the Wi-Fi in clear on every poll; whoever captures it can approve pairings and impersonate sessions. Rotate it if exposed ([steps](CLAUDE-CHAT.md#security-notes)) | `host/claude-chat/bridge.mjs`, `cli.mjs`, `hook.py` (`LOCALAI_URL`) |
| Chat device cookie lacks `Secure` | Also sent over plain HTTP | `app/claude-chat.js` |
| Claude board endpoints are unauthenticated | Any LAN client can post events and findings, vote, and change finding status | `/api/claude/*` in `app/server.js` |
| Host notifications endpoint is unauthenticated | Any LAN client can post `deploy`/`backup`/`monitor` notices to the Inbox | `/api/notifications/system` |
| GridCraft bridge task runs elevated | The bridge and the agent it starts run with highest privileges | `deploy/Install-GridCraft-Bridge.ps1` (`-RunLevel Highest`) |
| Nightly backups go to OneDrive | A copy of the whole database leaves the PC | `deploy/Backup-LocalAI-Data.ps1` (`-OffsiteRoot`) |
| `/go/n8n` and `/go/comfy` redirect to ports bound to loopback | They only work on the host itself | `redirectFor` in `app/server.js` |
