# LocalAI

A private AI appliance for the home network. One Node.js server with a SQLite database runs in a Docker
container on a Windows PC and serves a browser app to every device on the LAN. Models run locally
(Ollama); images, automation, web search and spreadsheet work come from services on the same PC. Cloud
services are explicit fallbacks only ([Integrations](docs/INTEGRATIONS.md)); the one standing exception is
the nightly backup copy to OneDrive.

## What's in it

| Area | Pages |
|---|---|
| Home | Home, Inbox (alerts and approvals) |
| Workspace | Chat, Images, Library, Projects (with Sources and Memory) |
| Automate | Missions (specialist agents), Automations, n8n workflows, Browser & computer, Monitors |
| Build | Change requests, Issues and quality signals, Claude Code (progress board and chat), Files, Repository, PowerShell |
| System | Health, Models, Integrations, Runs, Audit log |

Page names come from `app/public/view-registry.js`. The page structure is being reorganized per the
[evolution roadmap](docs/superpowers/specs/2026-10-15-localai-evolution-design.md). GridCraft spreadsheets are under System › Spreadsheets.
On an iPhone or Apple Watch, one Siri Shortcut asks Local AI anything by voice ([Apple Watch and Siri](docs/APPLE-WATCH.md)).

## Where it runs

| Part | Where |
|---|---|
| App and API | container `local-ai-appliance` on the Windows host, `https://<host>` (Caddy on 443; port 3080 answers on the host only) |
| Models, images, spreadsheets | Ollama, ComfyUI and the GridCraft bridge on the host's loopback |
| Automation, web search | n8n and SearXNG containers |
| Deploys, backups | PowerShell scripts and scheduled tasks on the host (`deploy/`) |
| Claude Code chat bridge | the Mac (`host/claude-chat/`) |

See [Architecture](docs/ARCHITECTURE.md) for the full picture.

## Quick start (development)

Needs Node.js 22.13 or newer.

```sh
npm ci
mkdir -p data workspace
DATA_DIR="$PWD/data" WORKSPACE_ROOT="$PWD/workspace" SELF_APP_ROOT="$PWD/app" node app/server.js
```

Open `http://localhost:3080`, then run the tests with `npm test`. Environment variables, browser tests and
conventions are in [Development](docs/DEVELOPMENT.md).

## Changing the appliance

Branch, open a pull request, wait for CI, merge. The host deploys `main` by itself; how to confirm a release
went live is in [Deploy › The normal path](docs/DEPLOY.md#the-normal-path-merge-and-wait).

## Documentation

[docs/README.md](docs/README.md) lists every guide: operating the appliance, deploying, storage, security,
development, and the component guides (GridCraft, ComfyUI, PowerShell bridge, Claude chat).

## Repository layout

| Path | Contents |
|---|---|
| `app/` | Server (`server.js`), storage, run ledger, agent orchestrator, chat relay, image engines |
| `app/public/` | The browser app: `index.html`, `app.css`, `app.js`, `ui.js`, `view-registry.js`, `sw.js` |
| `deploy/` | Host scripts: deploy, rollback, auto-deploy task, backups, restore, HTTPS, host-only port, GridCraft bridge installer |
| `host/` | Code that runs outside the container: GridCraft bridge and agent, ComfyUI tasks, PowerShell runner, Mac chat bridge |
| `tests/` | `node:test` suites (`*.test.cjs`), Playwright scripts (`*-ui.mjs`), deploy contract tests |
| `scripts/` | Maintenance helpers |
| `docs/` | Guides and design records |
