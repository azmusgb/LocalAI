# Architecture

LocalAI is one Node.js process with a SQLite database, running in a Docker container on a Windows PC on the
home LAN. Everything heavy (models, image generation, spreadsheets, PowerShell) runs in separate services
on the same PC that the appliance calls over HTTP. A Mac running Claude Code reports to it and can chat
through it.

## The picture

```text
 LAN browsers and phones                                      Mac (Claude Code sessions)
   | https://<host> (443)                                       | outbound HTTPS only:
   |                                                            |  board events/findings, chat relay (Mac key)
   v                                                            v
 Windows host  ─────────────────────────────────────────────────────────────────────────────
  Docker Desktop
   local-ai-https  (Caddy, 0.0.0.0:80/443) ─────┐
                                                v
   local-ai-appliance   :3080  (127.0.0.1 only) app/server.js  +  /data/localai.db (volume)
                        :3090  (127.0.0.1 only: PowerShell Workbench)
        |  Docker network                                 |  host.docker.internal → host 127.0.0.1
        v                                                 v
   local-ai-n8n :5678 (published on 127.0.0.1)       Ollama            127.0.0.1:11434
   local-ai-searxng :8080                            ComfyUI           127.0.0.1:8188
   local-ai-ollama-responses-proxy :8080             GridCraft bridge  127.0.0.1:8787 → gridcraft_ai.py → GridCraft :7979

  Scheduled tasks: LocalAI Safe Deploy · LocalAI Nightly Backup · LocalAI ComfyUI ·
                   LocalAI GridCraft Bridge · Local AI PowerShell Host (polls :3080 with a bearer token)
```

## Components

| Component | Where | Code | Talks to |
|---|---|---|---|
| Appliance server | container `local-ai-appliance` | `app/server.js` (HTTP, all `/api/*` routes), `app/storage.js`, `app/run-ledger.js`, `app/agent-orchestrator.js`, `app/claude-chat.js`, `app/image-engines.js`, `app/model-pulls.js` | Everything below |
| Web app | served by the appliance from `app/public` | `index.html`, `app.css`, `app.js`, `ui.js`, `view-registry.js`, `sw.js`; `spreadsheets.js` (Projects › Spreadsheets, GridCraft) | Appliance `/api/*` only |
| Database | `/data/localai.db` in a Docker volume | `app/storage.js` | — ([Storage](STORAGE.md)) |
| Ollama | Windows host, `127.0.0.1:11434` | not in this repo | — |
| ComfyUI | Windows host, `127.0.0.1:8188` | `host/comfyui/` ([README](../host/comfyui/README.md)) | — |
| GridCraft bridge and agent | Windows host, `127.0.0.1:8787` | `host/gridcraft-bridge.py`, `host/gridcraft-agent/` ([GridCraft](GRIDCRAFT.md)) | Ollama, GridCraft `:7979` |
| PowerShell host runner | Windows host, scheduled task | `host/powershell-bridge/` ([README](../host/powershell-bridge/README.md)) | Appliance `:3080` (polls) |
| n8n, SearXNG, responses proxy | containers on the appliance's Docker network | not in this repo | — |
| HTTPS front | container `local-ai-https` | `deploy/caddy/Caddyfile`, `deploy/Install-LocalAI-HTTPS.ps1` | Appliance `:3080` |
| Deploy, backup, restore | Windows host, PowerShell | `deploy/*.ps1` ([Deploy](DEPLOY.md), [Operations](OPERATIONS.md)) | git, Docker, appliance `/healthz` |
| Claude chat bridge | Mac, per Claude Code session | `host/claude-chat/` ([Claude chat](CLAUDE-CHAT.md)) | Appliance `/api/claude/chat/*` |
| Claude board reporting | Mac, Claude Code hooks or sessions | not in this repo | Appliance `/api/claude/events`, `/findings`, `/priorities` |

The appliance also health-probes two optional services on the Mac (`MAC_AI_HOME_URL`, default
`http://10.0.0.92:3083`; `MAC_DSH_URL`, default `http://10.0.0.92:3084`). They never affect overall health.

## What is in the app

Navigation is defined once in `app/public/view-registry.js`: five domains, each with pages (a page with
`parent` is a tab of another page).

| Domain | Pages (tabs in parentheses) |
|---|---|
| Home | Home, Inbox (Alerts, Approvals) |
| Workspace | Chat, Images, Library, Projects (Projects, Sources, Memory) |
| Automate | Missions, Automations, n8n workflows, Browser & computer, Monitors |
| Build | Change requests, Issues (Issues, Quality signals), Claude Code, Files, Repository, PowerShell |
| System | Health, Models, Services, Runs, Audit log |

The page structure is being reorganized per the [evolution roadmap](superpowers/specs/2026-10-15-localai-evolution-design.md); this table is the current map.

GridCraft is the Projects › Spreadsheets page (`#spreadsheets`); the old `/gridcraft.html` sends you there. New installs hide the Build tools until they are used
(`developerHistory` in `GET /api/config`).

## Ports

| Port | Bound to | Serves |
|---|---|---|
| 3080 | all interfaces (container `PORT`) | The app and API |
| 3090 | `127.0.0.1` on the host (`LOCAL_UI_PORT`) | Same server; the only port where PowerShell Workbench APIs answer |
| 80, 443 | all interfaces, firewall: private networks only | Caddy: HTTPS, CA download, redirect |
| 11434 | `127.0.0.1` | Ollama |
| 8188 | `127.0.0.1` | ComfyUI |
| 8787 | `127.0.0.1` | GridCraft bridge (`/health`, `/run`) |
| 7979 | `127.0.0.1` | GridCraft control (MCP) |
| 5678 | `127.0.0.1` | n8n editor and API |

HTTPS is in place (Caddy, `deploy/Install-LocalAI-HTTPS.ps1`): browsers should use `https://<host IP>` or
`https://localai.home.arpa` once the device trusts the LocalAI CA; **System › Health › Secure connection** says
whether it does. Port 3080 stays open over plain HTTP for scripts, the deploy health checks and the Mac tools.

`host.docker.internal` is how the container reaches services bound to the host's loopback; Docker Desktop
forwards it. Nothing on the Mac listens for the appliance.

## Data flow, briefly

- **Chat** streams from Ollama through `POST /api/chat/stream`; conversations are saved to SQLite.
- **Images** build a ComfyUI graph (`app/image-engines.js`), queue it on ComfyUI and fetch the result through
  `/api/images/view`.
- **GridCraft** requests go browser → `/api/gridcraft/run` → bridge `:8787` → one `gridcraft_ai.py --once` run.
- **PowerShell** jobs are created and approved on `:3090`, signed in the browser, then pulled by the host runner
  from `/api/powershell/host/next` and verified before they run.
- **Runs** (chat, images, missions, automations, engineering) are recorded in one ledger, shown in **System › Runs**.
- **Deploys** come from the host pulling `origin/main`, never from the app.
- **Change requests** plan a patch with a local model. A `self` change is staged in a copy of `SELF_APP_ROOT`
  under `DATA_DIR/change-staging/<id>/app` and validated there (syntax, DOM ids, a smoke run of the staged
  server). Shipping it ("Ship as a pull request") hands its Improve item to Claude: a session opens a PR with the staged
  files, the owner merges, Safe Deploy installs it, and the session reports `POST /api/changes/deploy-result`
  `{id, status:"applied"}` so Improve shows it as Shipped. Nothing in the app writes to the running code. A `workspace` change, once approved,
  is copied into `WORKSPACE_ROOT` with backups of the files it replaces.
- **Claude Code** sessions post progress and findings to the board and read back the ranked list from
  `GET /api/claude/priorities`. The Claude Code page can also chat with a live session through the relay.

## Container layout

| Path in the container | Source on the host | Set by |
|---|---|---|
| `/app` | bind of `C:\LocalAI\appliance\app` | replaced by each deploy |
| `/data` (`DATA_DIR`) | Docker volume (`local-ai-appliance-data` on the current host) | persists across deploys |
| `/workspace` (`WORKSPACE_ROOT`) | a host folder or volume chosen in the container definition (not in this repo); **Files**, **Repository** and `workspace` change requests read and write it | container definition |
| `/reports/LocalAI-Certification-latest.txt` (`REPORT_PATH`) | optional certification report | container definition |

## Security boundaries

The LAN is the trust boundary: any device on it can use the app. The host's own tools stay behind the
appliance, on loopback, or behind host-side keys. Details and known gaps: [Security](SECURITY.md).

## Gaps

- The appliance container, n8n, SearXNG and the responses proxy are not created by anything in this repo.
  The deploy scripts assume `local-ai-appliance` exists with `/app` bound to `C:\LocalAI\appliance\app` and
  `/data` on a volume. `Enable-LocalAI-HostOnlyPort.ps1` is the only script that recreates it (copying
  the existing definition).
- Ollama and GridCraft are installed by hand.
- The responses proxy and n8n are only health-probed by the app (`app/server.js`, `getStatusAndRecordTransition`),
  yet both count toward overall health.
