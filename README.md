# LocalAI

LocalAI is a LAN-hosted Node.js appliance with a browser interface for local-model chat, projects, specialist-agent missions, and engineering workflows. Ollama supplies model inference. It also integrates with ComfyUI, n8n, and SearXNG when configured.

## Run locally

Use Node.js 22 or newer (CI uses 22). The application uses Node built-ins and has no npm runtime dependencies. From the repository root on macOS/Linux:

```sh
DATA_DIR="$PWD/data" SELF_APP_ROOT="$PWD/app" WORKSPACE_ROOT="$PWD/workspace" OLLAMA_URL=http://127.0.0.1:11434 node app/server.js
```

On PowerShell:

```powershell
$env:DATA_DIR = Join-Path $PWD 'data'
$env:SELF_APP_ROOT = Join-Path $PWD 'app'
$env:WORKSPACE_ROOT = Join-Path $PWD 'workspace'
$env:OLLAMA_URL = 'http://127.0.0.1:11434'
node app/server.js
```

Open http://localhost:3080. The server listens on all interfaces and is intended for a trusted LAN. Set `MODEL` to an installed Ollama model before inference; its default is `qwen3:4b-instruct-32k`. The interface and `/healthz` can run without Ollama, but model-backed operations require it. `/healthz` reports server liveness, not downstream service availability.

## Configuration

Set variables in your shell or service configuration; the server does not automatically load `.env` files.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3080` | HTTP port |
| `DATA_DIR` | `/data` | Persistent JSON stores; created at startup |
| `SELF_APP_ROOT` | `/app` | Application source for self-engineering workflows |
| `WORKSPACE_ROOT` | `/workspace` | Engineering workspace root |
| `OLLAMA_URL` | `http://host.docker.internal:11434` | Model service |
| `MODEL` | `qwen3:4b-instruct-32k` | Default model |
| `COMFY_URL` | `http://host.docker.internal:8188` | Image generation |
| `N8N_URL` | `http://local-ai-n8n:5678` | Automation |
| `PROXY_URL` | `http://local-ai-ollama-responses-proxy:8080` | Conversation compatibility |
| `SEARXNG_URL` | `http://local-ai-searxng:8080` | Search |

Additional deployment settings, including companion URLs, inference timeouts, report paths, and PowerShell bridge/UI tokens, are read in `app/server.js`. Keep credentials and generated data out of version control.

## Validate and test

Install development dependencies from the committed lockfile:

```sh
npm ci
npm test
npm run validate
```

`npm test` runs offline mission regression tests with fake model responses and temporary data. `npm run validate` requires PowerShell 7 (`pwsh`) and invokes the same candidate validator used during deployment: required files, recursive JavaScript syntax, textual lifecycle contracts, and sensitive-file checks. These structural checks complement the behavioral tests.

For browser acceptance, install Chromium, start a development server using a disposable `DATA_DIR`, then run:

```sh
npx playwright install chromium
npm run test:browser
```

The browser suite defaults to http://127.0.0.1:3080; set `LOCALAI_URL` to test another development server. It exercises desktop/mobile navigation, Agent World, and mission UI controls without requesting model inference. CI installs browser system dependencies, starts its own server, gates tests on readiness, and preserves server logs on failure.

## Deployment

See [the safe deployment guide](README-SAFE-DEPLOY.md) for candidate validation, promotion, and rollback. Deployment scripts target the existing Windows installation under `C:\LocalAI`; local development and validation do not deploy to that appliance.

## Repository layout

- `app/server.js`: HTTP server and appliance integrations.
- `app/agent-orchestrator.js`: routing, specialists, dependencies, fallback, and mission persistence.
- `app/public/`: browser application and styles.
- `deploy/`: validation, deployment, rollback, and scheduled deployment setup.
- `tests/`: offline mission tests, browser acceptance, and Windows deployment verification.
