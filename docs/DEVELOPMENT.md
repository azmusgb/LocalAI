# Development

How to run LocalAI on your own machine, test it, and change it without breaking the deploy. For how the parts
fit together see [Architecture](ARCHITECTURE.md).

## Requirements

- Node.js 22.13.0 or newer (`node:sqlite`; `engines` in `package.json`). There is no build step and no npm
  runtime dependency; the only dev dependency is Playwright 1.63.0.
- Chromium for Playwright, for the browser tests.
- PowerShell 7 (`pwsh`) to run the deploy validator and the deploy contract tests.
- Python 3 to syntax-check the GridCraft bridge and agent (CI does).
- Ollama only if you want real model replies; the server and every test run without it.

```sh
npm ci
npx playwright install chromium            # Linux CI: npx playwright install --with-deps chromium
```

## Run the server locally

The server reads only environment variables; it does not load `.env` files. Use throwaway directories:

```sh
mkdir -p data workspace
DATA_DIR="$PWD/data" WORKSPACE_ROOT="$PWD/workspace" SELF_APP_ROOT="$PWD/app" \
OLLAMA_URL=http://127.0.0.1:11434 node app/server.js
```

```powershell
$env:DATA_DIR = "$PWD\data"; $env:WORKSPACE_ROOT = "$PWD\workspace"; $env:SELF_APP_ROOT = "$PWD\app"
$env:OLLAMA_URL = 'http://127.0.0.1:11434'
node app/server.js
```

Open `http://localhost:3080`. `data/` and `workspace/` are git-ignored. Without the companions, Health shows
them down; that is expected.

### Environment variables

All read at startup in `app/server.js` unless noted.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3080` | Main HTTP port (listens on `0.0.0.0`) |
| `LOCAL_UI_PORT` | unset | Second, host-only listener; PowerShell Workbench APIs answer only there when set |
| `DATA_DIR` | `/data` | SQLite database and backups |
| `WORKSPACE_ROOT` | `/workspace` | Root for **Files** and **Repository** |
| `SELF_APP_ROOT` | `/app` | Application source that change requests target |
| `APP_VERSION` | `1.18` | Reported version; also gates features (below) |
| `MODEL` | `qwen3:4b-instruct-32k` | Default chat model, protected from deletion |
| `OLLAMA_URL` | `http://host.docker.internal:11434` | Ollama |
| `COMFY_URL` | `http://host.docker.internal:8188` | ComfyUI |
| `GRIDCRAFT_URL` | `http://host.docker.internal:8787` | GridCraft bridge |
| `GRIDCRAFT_MODEL` | `qwen3:4b-instruct` | The bridge's model, protected from deletion |
| `IMAGE_PROMPT_MODEL` | `GRIDCRAFT_MODEL`, else `qwen3:4b-instruct` | Model that helps write image prompts |
| `PROTECTED_MODELS` | empty | Extra comma-separated models that cannot be deleted |
| `N8N_URL` | `http://local-ai-n8n:5678` | n8n (health probe) |
| `PROXY_URL` | `http://local-ai-ollama-responses-proxy:8080` | Responses proxy (health probe) |
| `SEARXNG_URL` | `http://local-ai-searxng:8080` | Web research |
| `MAC_AI_HOME_URL` | `http://10.0.0.16:3083` | Optional Mac companion (health probe) |
| `MAC_DSH_URL` | `http://10.0.0.16:3084` | Optional Mac developer assistant (health probe) |
| `REPORT_PATH` | `/reports/LocalAI-Certification-latest.txt` | Certification report shown in the app |
| `CHAT_MODEL_TIMEOUT_MS` | `180000` (30 s–15 min) | Chat model timeout |
| `ENGINEERING_MODEL_TIMEOUT_MS` | `600000` (1–30 min) | Change request model timeout |
| `CAPABILITY_CACHE_MS` | `30000` (5 s–5 min) | Capability snapshot cache |
| `HEALTH_SETTLE_MS` | `120000` | How long a health change must hold before it is recorded |
| `POWERSHELL_BRIDGE_TOKEN` | empty | Bearer token for the host runner; empty disables it |
| `POWERSHELL_UI_TOKEN` | empty | Workbench UI token; empty locks the Workbench |
| `LOCALAI_CHAT_ONLINE_MS` | `45000` | Chat session counts as online this long after a poll (`app/claude-chat.js`) |
| `LOCALAI_CHAT_LEASE_MS` | `60000` | Inbox message reservation (`app/claude-chat.js`) |
| `LOCALAI_CHAT_PAIR_TTL_MS` | `600000` | Pairing code lifetime (`app/claude-chat.js`) |

Features are gated by the minor version in `APP_VERSION` (`requireFeature` in `app/server.js`; the
PowerShell Workbench needs 1.17). Leave it unset unless you mean to turn features off; a 2.x version enables all.

## Tests

| Command | What runs | Needs |
|---|---|---|
| `npm test` | Every `tests/*.test.cjs` with `node --test`: storage, API, runs, orchestrator, chat relay, Mac bridge/hook/CLI/installer, security and front-end contracts | Node only; tests start their own servers on free ports |
| `npm run test:browser` | Ten Playwright scripts (`tests/*-ui.mjs`, listed in `package.json`) | A running server at `LOCALAI_URL` (default `http://127.0.0.1:3080`) |
| `pwsh -NoProfile -File deploy/Test-LocalAI-Candidate.ps1 -CandidateRoot . -LocalNode` | The deploy validator, as CI runs it | `pwsh` |
| `pwsh -NoProfile -File tests/Test-LocalAI-DeployContracts.ps1` | Deploy and rollback scripts against mocked Docker, git and robocopy | `pwsh`; CI runs it on Windows only |

Browser tests against a disposable server on a spare port:

```sh
d=$(mktemp -d); DATA_DIR=$d WORKSPACE_ROOT=$d PORT=3180 node app/server.js > "$d/server.log" 2>&1 & pid=$!
until curl -fs http://127.0.0.1:3180/healthz >/dev/null; do sleep 1; done
LOCALAI_URL=http://127.0.0.1:3180 npm run test:browser
kill $pid
```

Use a fresh `DATA_DIR`: the scripts write data (for example Claude board findings and paired chat devices). `tests/claude-chat-ui.mjs`
ignores `LOCALAI_URL` and starts its own server. Run one script on its own with `node tests/<name>-ui.mjs`.

`npm run validate` runs the validator **without** `-LocalNode`, which runs the native tests inside the
`local-ai-appliance` Docker image; it only works on the appliance host. Use the `-LocalNode` form above elsewhere.

A new `tests/*.test.cjs` file is picked up by `npm test` (and CI) automatically. A new browser script must be
added to `test:browser` in `package.json`, and to the syntax and required-file lists in
`.github/workflows/validate.yml`.

## CI

`.github/workflows/validate.yml` runs on every pull request and on pushes to `main`:

| Job | Runs on | Steps |
|---|---|---|
| `validate` | Ubuntu, Node 22 | `npm ci`; `node --check` on server, front-end and test files; `npm test`; Python and PowerShell syntax; required files; no private keys under `app/`; `Test-LocalAI-Candidate.ps1 -LocalNode`; Chromium; start the server (`DATA_DIR=/tmp/localai-data PORT=3080`) and `npm run test:browser`. The server log is uploaded on failure |
| `storage-compatibility` | Ubuntu and Windows × Node 22.13.0 and 24 | `release`, `storage`, `storage-api`, `agent-orchestrator` and `run-ledger` tests |
| `deployment-contracts` | Windows | `tests/Test-LocalAI-DeployContracts.ps1` on PowerShell 7 and Windows PowerShell 5.1 |

## Front-end structure

No bundler, no framework. `app/public/index.html` holds every page as `<section id="<view id>" class="view">`
and loads three scripts: `view-registry.js`, `app.js` (an ES module), then `ui.js` (deferred).

| File | Role |
|---|---|
| `view-registry.js` | The single list of domains, pages, tabs, labels, descriptions and retired ids (`ALIASES`). The rail, phone menu, breadcrumb, command palette and page headings read it. `tests/view-registry.test.cjs` checks it against `index.html` |
| `app.js` | Core app: state, chat, images, library, status, routing between views |
| `ui.js` | Hand-maintained bundle of former separate scripts. Each section starts with `// ==== <name>.js ====` and is its own scope, in load order: `ui-kit`, `agent-specialists`, `mobile-overhaul`, `ux-architecture-v2`, `agent-world-city`, `claude-board`, `claude-chat`, `integration-hub-v2`, `execution-runtime`, `first-run`, `secure-connection` |
| `app.css` | One stylesheet in cascade order; sections start with `/* ==== <name> ==== */`. The `design-system.css` section comes after the older sections and maps their tokens (`--panel…`, `--ux-…`, `--aw-…`) onto `--ds-*` tokens; feature sections added since follow it |
| `sw.js` | Service worker. Shell files are always revalidated (ETag), so a deploy shows on the next load. Add new shell files to `SHELL` and change `CACHE` |
| `gridcraft.html`, `gridcraft.js`, `gridcraft.css` | The separate GridCraft page |

`scripts/design-system-overrides.py app/public` regenerates the block at the end of the design-system section
of `app.css` that raises small text to 11 px and turns all-caps labels into sentence case; see its docstring.

Use `--ds-*` tokens for new styles and the `LocalAIKit` helpers (`ui-kit` section) for icons and status badges.

## Conventions

- **Element ids, route paths and some function names are contracts.** `deploy/Test-LocalAI-Candidate.ps1`
  searches `server.js`, `app.js`, `ui.js`, `app.css`, `index.html` and `agent-orchestrator.js` for fixed
  strings, and the Playwright tests select by id. Renaming one fails CI and the deploy; change the test in the
  same PR.
- **A page is added in three places:** a `VIEWS` entry in `view-registry.js`, a `<section id>` in
  `index.html`, and its loader. Retiring an id means adding it to `ALIASES`.
- **`ui.js` is edited in place.** There is no source tree to rebuild it from. Keep each section's scope
  closed, and put new code in the section it belongs to.
- **Required files** are listed in both `deploy/Test-LocalAI-Candidate.ps1` and `.github/workflows/validate.yml`.
- **No secrets in the repo or the container image.** See [Security](SECURITY.md).
- **Host scripts must run on Windows PowerShell 5.1**, which is what scheduled tasks start: send UTF-8 bytes
  rather than strings in `Invoke-RestMethod` bodies, set `[Console]::OutputEncoding` to UTF-8 before reading
  git output, and do not wrap native commands such as `git` in `$ErrorActionPreference = 'Stop'` (their stderr
  becomes a terminating error).
- **Workflow:** branch, pull request, CI green, merge; then follow
  [Deploy › The normal path](DEPLOY.md#the-normal-path-merge-and-wait).
- Design specs and plans for larger changes go in `docs/superpowers/specs/` and `docs/superpowers/plans/`.
