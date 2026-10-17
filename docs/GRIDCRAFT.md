# GridCraft integration

GridCraft is a Windows spreadsheet app. LocalAI exposes it as **System › Spreadsheets**
(`http://<host>:3080/#spreadsheets`, `app/public/spreadsheets.js`), where you type a request and a local model
works on the open workbook, and see the workbook itself: the **Workbook** card under the request box shows its sheets
as a read-only grid and opens other workbooks from `Documents\GridCraft`. It works on phones too. The old `/gridcraft.html` address sends you there.

The page is part of LocalAI. The page calls the appliance (`/api/gridcraft/health`, `/api/gridcraft/run`, and for the Workbook card `/api/gridcraft/workbook`, `/range`, `/workbooks`, `/open`), and the appliance forwards to a small Windows-host bridge on `127.0.0.1:8787`, which runs the GridCraft Python agent kept in this repo at `host/gridcraft-agent/`. That agent continues to own Ollama tool calling and GridCraft MCP control.

## Architecture

```text
Browser / VPN client
    |
    v
LocalAI :3080 #spreadsheets  ->  /api/gridcraft/*
    |
    v  (host.docker.internal, which Docker Desktop forwards to the host's loopback)
Windows GridCraft bridge 127.0.0.1:8787  (not reachable from the LAN)
    |
    v
C:\LocalAI\repo\host\gridcraft-agent\gridcraft_ai.py
    |
    +--> Ollama :11434
    |
    +--> GridCraft MCP/control :7979
    |
    v
Saved .xlsx workbook
```

The production LocalAI container does not launch or own the GridCraft GUI. The host bridge keeps the Windows-only boundary explicit.

## Install on the Windows host

Prerequisites:

- LocalAI repository checked out at `C:\LocalAI\repo`.
- Windows Python 3.12 (`py -3.12`). The installer creates the agent's virtual environment in `%USERPROFILE%\gridcraft-local-ai\.venv` and installs `host/gridcraft-agent/requirements.txt`.
- Ollama running on the host.
- GridCraft is installed under `C:\Program Files\GridCraft`.

Install and start the bridge from an **elevated** PowerShell (Run as administrator); the installer refuses to run otherwise:

```powershell
Set-Location C:\LocalAI\repo
.\deploy\Install-GridCraft-Bridge.ps1
```

Verify:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

Then open System › Spreadsheets (`http://<host>:3080/#spreadsheets`).

## Bridge configuration

`deploy\Install-GridCraft-Bridge.ps1` parameters: `-RepoRoot` (`C:\LocalAI\repo`), `-AgentDir`
(`%USERPROFILE%\gridcraft-local-ai`), `-Workbook` (`%USERPROFILE%\Documents\GridCraft\Quarterly-Sales-Dashboard.xlsx`),
`-Model` (`qwen3:4b-instruct`), `-Port` (`8787`), `-AllowedOrigins`, `-Uninstall`.

It:

1. creates the virtual environment `%USERPROFILE%\gridcraft-local-ai\.venv` with `py -3.12` if missing and
   installs `host/gridcraft-agent/requirements.txt`;
2. writes `%USERPROFILE%\gridcraft-local-ai\gridcraft-bridge.env.ps1`, which sets the variables below and
   starts `host/gridcraft-bridge.py`;
3. registers the scheduled task `LocalAI GridCraft Bridge` (at logon, highest privileges, restarts up to 3 times);
4. removes the inbound `8787` firewall rule older installs created;
5. starts the task and waits for `/health`.

Browsers never call the bridge directly; the appliance does, without an `Origin` header. CORS still applies
to anything that calls it from a browser. The installer allows port 3080 on `127.0.0.1`, `localhost`, the
machine name and every local IPv4 address; override with
`-AllowedOrigins 'http://10.0.0.21:3080','http://myhost:3080'`.

Bridge environment (`host/gridcraft-bridge.py`):

| Variable | Default | Purpose |
|---|---|---|
| `GRIDCRAFT_BRIDGE_HOST` | `127.0.0.1` | Listen address |
| `GRIDCRAFT_BRIDGE_PORT` | `8787` | Listen port |
| `GRIDCRAFT_CONTROL_PORT` | `7979` | GridCraft control port the bridge checks and launches GridCraft with |
| `GRIDCRAFT_MODEL` | `qwen3:4b-instruct` | Model passed to the agent |
| `GRIDCRAFT_AGENT_DIR` | `%USERPROFILE%\gridcraft-local-ai` | Virtual environment and settings |
| `GRIDCRAFT_AGENT_PYTHON` | `<agent dir>\.venv\Scripts\python.exe` | Python that runs the agent |
| `GRIDCRAFT_AGENT_SCRIPT` | `host/gridcraft-agent/gridcraft_ai.py` next to the bridge | The agent |
| `GRIDCRAFT_EXE` | `C:\Program Files\GridCraft\gridcraft.exe` | GridCraft executable launched when not running |
| `GRIDCRAFT_WORKBOOK` | `%USERPROFILE%\Documents\GridCraft\Quarterly-Sales-Dashboard.xlsx` | Workbook opened at launch |
| `GRIDCRAFT_RUN_TIMEOUT` | `300` (seconds) | Per-request limit; a request first waits up to `GRIDCRAFT_TOOL_TIMEOUT` for a workbook read to finish, and the appliance waits 360 s |
| `GRIDCRAFT_TOOL_TIMEOUT` | `30` (seconds) | Limit for one workbook read or open (Workbook card) |
| `GRIDCRAFT_WORKBOOKS_DIR` | `%USERPROFILE%\Documents\GridCraft` | Folder the Workbook card lists and opens workbooks from |
| `GRIDCRAFT_ALLOWED_ORIGINS` | `http://10.0.0.21:3080,http://127.0.0.1:3080,http://localhost:3080` | CORS allow-list |
| `GRIDCRAFT_BRIDGE_LOG` | unset (stdout) | Log file, rotated at 2 MB × 3; the installer sets `gridcraft-bridge.log` |

Startup crashes land in `gridcraft-bridge.crash.log` next to the log.

## Runtime behavior

`GET /health` reports bridge readiness and whether GridCraft's control port is already reachable. The
appliance proxies it as `GET /api/gridcraft/health`.

`POST /run` (appliance: `POST /api/gridcraft/run`) takes JSON:

```json
{"prompt":"Inspect the workbook and summarize each sheet."}
```

Prompts are limited to 20,000 characters. One request runs at a time; a second gets HTTP 409. If GridCraft is
not listening, the bridge launches it with `WGPU_BACKEND=vulkan` and the configured workbook (or GridCraft's
`sales` sample if the workbook does not exist), then runs the
agent once with `--once`. The agent's model choice, including the switch to the 32k-context model for long
requests, is described in the [agent README](../host/gridcraft-agent/README.md).

## Workbook view

The Workbook card on System › Spreadsheets reads the workbook without a model. For each read the bridge runs the agent
once with `--tool <name> --args <json>`, which makes one GridCraft MCP call and prints the result as JSON. Only three
tools are callable this way: `inspect_workbook`, `read_range` and `open_workbook`.

| Bridge | Appliance | What it does |
|---|---|---|
| `GET /workbook` | `GET /api/gridcraft/workbook` | Title, file name (never the full path), unsaved-changes flag, active sheet, and each sheet's name, used range and cell count |
| `GET /range?sheet=&range=` | `GET /api/gridcraft/range` | `read_range` with `formatted: true` (values as GridCraft displays them). The range is clipped to 200 rows × 30 columns from its top-left cell before the call; `truncated` says so. The appliance forwards only `sheet` (≤ 100 characters) and an A1 `range`, and answers 400 to anything else |
| `GET /workbooks` | `GET /api/gridcraft/workbooks` | Name, size and modified time of each `.xlsx`, `.xlsm`, `.xls`, `.csv`, `.ods` file directly in `GRIDCRAFT_WORKBOOKS_DIR` (no subfolders, no `~$` lock files) |
| `POST /open {"name"}` | `POST /api/gridcraft/open` | Opens that file from `GRIDCRAFT_WORKBOOKS_DIR` in GridCraft (starting GridCraft if needed). The name must be a plain file name with one of those extensions: no folders, no `..`. Same Origin and JSON rules as `/run` |

Reads share the request lock with `/run`: while a request runs they answer 409 "GridCraft is busy with a request",
and a request waits for a read in progress. Reads don't start GridCraft; if it isn't running they answer 503 with
`code: "not_running"`. Failures are logged with the agent's last error line.

## Security boundary

The bridge listens on the host's loopback only, so the LAN reaches it only through the appliance. Browser CORS is restricted to the configured LocalAI origins. The scheduled task runs with highest privileges, and so does the agent it starts (see [Security › Known gaps](SECURITY.md#known-gaps)).

## Remove

```powershell
.\deploy\Install-GridCraft-Bridge.ps1 -Uninstall
```
