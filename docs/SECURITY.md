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
| App and API, port 3080 (plain HTTP) | Windows host only | Published on `127.0.0.1` (`deploy/stack/compose.yml`); host scripts use it. Other devices come through HTTPS |
| HTTPS, ports 80/443 (Caddy) | LAN, private network profile only | Firewall rule `Local AI HTTPS` (`deploy/Install-LocalAI-HTTPS.ps1`). No sign-in (see gaps); cross-site browser writes blocked ([guard](#other-controls)) |
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
  approve. The device cookie `localai_chat_device` is HttpOnly, `SameSite=Lax` (a link from a notification still
  carries it; mutating routes have the cross-site guard), path `/` (it is the sign-in for all of Local AI, see
  [Sign-in](#sign-in-report-only-dangerous-routes-refused)), valid 180 days and renewed on each app load, and `Secure` when the device paired over HTTPS (a TLS socket or
  `X-Forwarded-Proto: https` from Caddy; `requestIsHttps`); the appliance stores only its hash. Any paired device can
  revoke any device. The header is trusted from any client: spoofing it on the host's port 3080 only makes that client's own
  cookie HTTPS-only.
- The Mac side (bridge, hooks, CLI) talks to `https://10.0.0.21` and verifies it against the LocalAI CA, which
  `install.sh` fetches over `ssh windows` (authenticated), checks with `openssl x509` and records in
  `~/.claude/localai-chat/config.json`. Verification is never turned off; an untrusted certificate fails with a log
  line. If HTTPS is not available at install time, the installer keeps plain HTTP and says so (see gaps).
- POSTs to the relay reject a foreign `Origin` and require `Content-Type: application/json` (`checkPost`).
- Web messages act with the Claude Code session's own permissions and cannot answer permission prompts.

## Other controls

- **The appliance runs as `node` (uid 1000), not root** (`user: "1000:1000"` in `deploy/stack/compose.yml`, since
  19 Oct 2026). It can write its data volume (a one-shot `appliance-data-owner` job hands `/data` to it on each
  `compose up`) and the workspace folders, and nothing else in the container. Host scripts that run the appliance image
  on its data (deploy maintenance in `Storage-LocalAI.ps1`, `Restore-LocalAI-Data.ps1`) use the same user, so the files
  SQLite creates stay writable by the appliance. `Test-LocalAI-Stack.ps1` reports a container running as another user.
- **Cross-site request guard.** Before routing, every `POST`, `PUT`, `PATCH` and `DELETE` is rejected with 403
  `Cross-site request blocked` when `Sec-Fetch-Site` is `cross-site`, or when an `Origin` header is present and its
  host:port matches neither the `Host` header nor `X-Forwarded-Host` (`crossSiteRequest` in `app/server.js`;
  `tests/cross-site-guard.test.cjs`). So another website open in a LAN browser can no longer drive the API, whatever
  the content type. Requests that carry neither header (curl, scripts, hooks, the host's jobs) pass: this blocks
  browsers being used against the appliance, it does not authenticate anyone. `GET` is not checked, so `GET` routes
  must stay free of side effects.
- **Host name guard (DNS rebinding).** Before anything else, a request whose `Host` is a name the appliance doesn't
  answer to gets 421 (`hostAllowed` in `app/server/http.js`; `tests/host-allowlist.test.cjs`). A page that re-points
  its own name at this machine looks same-origin to the browser, so the Origin checks can't catch it, but its `Host`
  is still its own name. Allowed: IP addresses, names without a dot (`localhost`, `local-ai-appliance`, the PC's name),
  names under suffixes no one can register publicly (`.localhost`, `.local`, `.home.arpa`, `.test`, `.invalid`,
  `.internal`, `.lan`), and the configured `LOCALAI_NAME`, `LOCALAI_HOST_IP`, `LOCALAI_REMOTE_NAME` (the Tailscale
  name) and `LOCALAI_ALLOWED_HOSTS`. Caddy keeps the browser's `Host` when it proxies, so its sites pass.
- **Board text is untrusted.** Until sign-in (#331) ships, anyone who can open Local AI can type a backlog item or a
  Hand to Claude request. `POST /api/improve/handoff` has the same-origin and JSON checks, and the typed text is kept
  in the item's `request` and quoted in its `fix` between `<<<UNTRUSTED_REQUEST` and `UNTRUSTED_REQUEST>>>` (any
  `<<<`/`>>>` inside it defused), never spliced into the instruction (`handoffItem` in `app/improve.js`).
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
- **Workshop display.** The appliance sends the display only `GET` requests: `/hardware/health` (a `401` there
  means its sign-in is on); when `LOCALAI_WORKSHOP_STATUS_TOKEN` is set, `/api/status/lite` with that read-only
  Bearer token; and when `LOCALAI_WORKSHOP_CODE_TOKEN` is set, `/api/portal-code` (below) (`LOCALAI_WORKSHOP_URL`, private addresses and `.local` names only). Both answers are rebuilt field by
  field. The token opens only that status route on the display; it lives in `stack.env`, is never sent to the browser,
  logged, stored or put in an error, and child processes don't get it. The display's portal and printer controls are
  linked to, never proxied, so Local AI never becomes a way to the printer controls
  ([Workshop display › Printer status](WORKSHOP-DISPLAY.md#printer-status-read-only-token)). Note: the display's current firmware has no sign-in at all
  (see [Workshop display › Current state](WORKSHOP-DISPLAY.md#current-state-18-oct-2026-the-portal-has-no-sign-in)); a fix is being prepared in that repo
  ([Workshop display](WORKSHOP-DISPLAY.md#why-the-portal-isnt-proxied)).
- **Workshop display sign-in code (a deliberate trade-off).** With `LOCALAI_WORKSHOP_CODE_TOKEN` set, Services ›
  Workshop display › **Show sign-in code** reads the display portal's current sign-in code
  (`POST /api/workshop/portal-code`) and shows it. Local AI has no sign-in of its own (see gaps), so **anyone who can
  use Local AI can read the portal code**, and with it sign in to the portal and use the printer controls. For this
  single-owner home setup that is accepted: the gate is who can reach Local AI at all (the home network and the
  owner's own Tailscale devices), the same gate that already stands in front of everything else here. If Local AI ever
  has other users, remove the key. What limits the exposure: the route is POST with the cross-site guard and the JSON
  check, so another website or a prefetch can't read it; the code is never logged, stored, cached (`no-store`) or put in
  a `GET` answer; each read adds an Activity entry ("Workshop sign-in code shown", without the code); the browser keeps it
  on screen for at most 60 s and never in storage or the URL; the key opens only that one route on the display and can
  be revoked there at once ([Workshop display › Sign-in code](WORKSHOP-DISPLAY.md#sign-in-code-on-the-services-card)).
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

## Sign-in (report only, dangerous routes refused)

Every API request that arrives through Caddy (it carries `X-Forwarded-For`) is checked for a paired device's cookie or
the Mac key (`app/signin.js`; design: `docs/superpowers/specs/2026-10-18-sign-in-design.md`). A request without either
is counted by caller (IP address, device type, last route), and **Health › Sign-in** lists them.

Most routes are still only reported. The routes that run code, write or list the workspace, fetch arbitrary URLs from
the container, stage or approve changes, decide approvals, or post and clear alerts are **refused** with
`401 {"error":"Sign in on this device first…","signIn":true}`: `/api/workbench/*`, `/api/computer/*`,
`/api/browser/fetch`, `/api/http-check`, `/api/repo/inspect`, `/api/changes*`, `/api/approvals/create|decide`,
`/api/display/approvals/decide` (the display's key still signs it in), `/api/engineering/start`,
`/api/issues/prepare-change`, `/api/improve/handoff`, `/api/powershell/*`, `/api/notifications/system|seed` and
`/api/signin/report/clear` (`GUARDED` in `app/signin.js`). Pair a browser under Build › Claude Code to use them.
`LOCALAI_SIGN_IN=required` in `stack.env` refuses every API route that isn't open.

Requests that did not come through Caddy (the host's own port 3080, the Docker network) and the routes a device needs
before it is paired (`/healthz`, `pair-request`, `pair-status`, `whoami`) are not checked; pages and static files never
are.

## Known gaps

| Gap | Effect | Where |
|---|---|---|
| GitHub access to this repo means code on the host | The auto-deploy runs `origin/main` and that commit's scripts as the host user. Enable branch protection on `main` with required CI and reviews, and protect the GitHub account. CI is path-filtered and docs-only PRs run none, so a required check that did not run will block those PRs. Whether branch protection is on cannot be checked from the repo | `deploy/Run-LocalAI-AutoDeploy.ps1`, `deploy/Deploy-LocalAI.ps1` |
| Ollama and n8n loopback binding is host configuration | If `OLLAMA_HOST` is unset or n8n is published on all interfaces, the model API or the n8n editor is open to the LAN without auth | [Network exposure](#network-exposure) |
| Most API routes are report-only | Without a paired device, anyone on the LAN or tailnet can still read conversations and projects and start runs. Code execution, workspace writes, changes and approvals are refused ([Sign-in](#sign-in-report-only-dangerous-routes-refused)); `LOCALAI_SIGN_IN=required` closes the rest | `app/signin.js` |
| Change requests run model-written patches | Only a paired device, the Mac key or the host can request one (`/api/changes*` is guarded). A `self` change copies `SELF_APP_ROOT` to `DATA_DIR/change-staging/<id>/app`, applies a model-written patch there and validates it by running `node --check` and starting the staged `server.js` inside the container. Shipping it only hands it to a Claude session as an Improve item; it reaches the live app only as a pull request the owner merges. A `workspace` change, once approved, writes its files into `WORKSPACE_ROOT` | `stageChangeByIdUnlocked`, `validateStagedChange`, `apiChangeRequestApply` in `app/server.js` |
| Chat device cookies paired over plain HTTP lack `Secure` | A device that paired on `http://<host>:3080` (or before this change) keeps a cookie its browser also sends over plain HTTP. Re-pair it on the HTTPS address to get a `Secure` cookie | `app/claude-chat.js` |
| Claude board endpoints are unauthenticated | Any LAN client can post events and findings, vote, and change finding status | `/api/claude/*` in `app/server.js` |
| Nightly backups go to OneDrive | A copy of the whole database leaves the PC | `deploy/Backup-LocalAI-Data.ps1` (`-OffsiteRoot`) |
| Volume backups hold secrets in plain archives | `C:\LocalAI\backups\volumes` contains Caddy's root key and n8n's credentials with their key; it stays on this PC's disk, and the script refuses a cloud-synced copy location (OneDrive, Dropbox, iCloud, Google Drive) | `deploy/Backup-LocalAI-Data.ps1` (`-VolumeRoot`, `-VolumeCopyRoot`) |
| `/go/n8n` and `/go/comfy` redirect to ports bound to loopback | They only work on the host itself | `redirectFor` in `app/server.js` |
