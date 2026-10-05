# LocalAI

LocalAI is a LAN-hosted Node.js appliance with a browser interface for local-model chat, projects, specialist-agent missions, engineering workflows, automation, and local generative-media tooling. Ollama supplies model inference; ComfyUI, n8n, and SearXNG are integrated when configured.

## Requirements

- Node.js 22.13.0 or newer, including inside the appliance container. CI checks Node 22.13 and 24 on Windows/Linux.
- Ollama for model-backed features.
- PowerShell 7 (`pwsh`) for the deployment-candidate validator.
- Chromium installed through Playwright for browser acceptance tests.

The application server itself uses Node built-ins and has no npm runtime dependencies. The committed npm dependency is development-only Playwright 1.63.0 for deterministic browser testing.

## Run locally

From the repository root on macOS/Linux:

```sh
DATA_DIR="$PWD/data" \
SELF_APP_ROOT="$PWD/app" \
WORKSPACE_ROOT="$PWD/workspace" \
OLLAMA_URL=http://127.0.0.1:11434 \
node app/server.js
```

On PowerShell:

```powershell
$env:DATA_DIR = Join-Path $PWD 'data'
$env:SELF_APP_ROOT = Join-Path $PWD 'app'
$env:WORKSPACE_ROOT = Join-Path $PWD 'workspace'
$env:OLLAMA_URL = 'http://127.0.0.1:11434'
node app/server.js
```

Open `http://localhost:3080`.

The server listens on all interfaces and is intended for a trusted LAN. `/healthz` reports LocalAI server liveness; downstream availability is reported separately by the system/capability APIs and UI.

## Configuration

Set configuration in the shell, service, container, or deployment environment. The server does not automatically load `.env` files.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3080` | LocalAI HTTP port |
| `DATA_DIR` | `/data` | Persistent SQLite database, import backups and artifact references |
| `SELF_APP_ROOT` | `/app` | Application source used by engineering workflows |
| `WORKSPACE_ROOT` | `/workspace` | Mounted engineering workspace |
| `OLLAMA_URL` | `http://host.docker.internal:11434` | Ollama endpoint |
| `MODEL` | `qwen3:4b-instruct-32k` | Default local model |
| `COMFY_URL` | `http://host.docker.internal:8188` | ComfyUI endpoint |
| `N8N_URL` | `http://local-ai-n8n:5678` | n8n endpoint |
| `PROXY_URL` | `http://local-ai-ollama-responses-proxy:8080` | Conversation compatibility service |
| `SEARXNG_URL` | `http://local-ai-searxng:8080` | Web research endpoint |

Additional deployment settings, including companion URLs, inference timeouts, report paths, and PowerShell bridge/UI tokens, are defined in `app/server.js`. Never commit credentials, private keys, generated data, or local workspaces.

## Install development dependencies

Use the committed lockfile so local and CI installs resolve the same Playwright version:

```sh
npm ci
```

Install the Chromium browser once for local browser acceptance:

```sh
npx playwright install chromium
```

On Linux CI, use `npx playwright install --with-deps chromium` to install required OS libraries as well.

## Validate and test

Run the offline storage, HTTP and mission regression suite:

```sh
npm test
```

It covers migration, rollback, conflict detection, separate writer processes, restart durability, API compatibility, concurrent agent/automation results and the existing specialist dependency/fallback regressions. Model inference is mocked.

Run the deployment-candidate validator:

```sh
npm run validate
```

This invokes `deploy/Test-LocalAI-Candidate.ps1` and checks required files, JavaScript syntax, key runtime/UI contracts, sensitive-file exclusions, and native SQLite/API/agent regressions.

For browser acceptance, start LocalAI with a disposable development `DATA_DIR`, then run:

```sh
npm run test:browser
```

The browser suite exercises desktop/mobile navigation, Agent Operations / Agent World, and the System → Integrations experience. Set `LOCALAI_URL` to test a non-default development endpoint.

GitHub Actions performs the same locked dependency install, validator, offline regressions, server-readiness gate, and browser acceptance. Server diagnostics are uploaded when browser validation fails.

## Application state

`DATA_DIR/localai.db` is authoritative. First startup validates, backs up and imports existing JSON in one transaction. Original JSON is retained for recovery. See [`docs/STORAGE.md`](docs/STORAGE.md) for schema, conflict behavior, pagination, inspection, coherent backups and JSON rollback/re-upgrade.

## Integrations

LocalAI follows a local-first integration policy: one primary owner per capability, native services before cloud alternatives, and explicit trust boundaries for external tools.

See [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) for the maintained integration policy, including n8n, ComfyUI, Penpot, Obsidian, Hugging Face, and external fallback guidance.

## Deployment

See [`README-SAFE-DEPLOY.md`](README-SAFE-DEPLOY.md) for candidate validation, promotion, and rollback. Deployment scripts target the existing Windows LocalAI installation under `C:\LocalAI`; local development and validation do not deploy the appliance.

## Repository layout

- `app/server.js` — HTTP server, capability APIs, and appliance integrations.
- `app/storage.js` / `app/storage-cli.js` — SQLite repositories, migrations, backups and recovery commands.
- `app/agent-orchestrator.js` — specialist routing, dependencies, fallback, mission execution, and persistence.
- `app/public/` — browser application, responsive UX, Agent World, and Integration Hub.
- `deploy/` — candidate validation, deployment, rollback, and scheduled deployment tooling.
- `docs/` — maintained architecture and integration guidance.
- `tests/` — offline orchestration regressions and desktop/mobile Chromium acceptance.

