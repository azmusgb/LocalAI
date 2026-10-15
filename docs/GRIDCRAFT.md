# GridCraft integration

GridCraft is exposed inside LocalAI as a same-appliance browser workspace at:

`http://10.0.0.21:3080/gridcraft.html`

The browser page remains part of LocalAI. Execution is delegated to a small Windows-host bridge on port `8787`, which calls the existing `gridcraft-local-ai` Python agent. That agent continues to own Ollama tool calling and GridCraft MCP control.

## Architecture

```text
Browser / VPN client
    |
    v
LocalAI :3080 /gridcraft.html
    |
    v
Windows GridCraft bridge :8787
    |
    v
C:\Users\<user>\gridcraft-local-ai\gridcraft_ai.py
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
- Existing GridCraft local agent at `%USERPROFILE%\gridcraft-local-ai`.
- Its Python virtual environment exists under `.venv`.
- GridCraft is installed under `C:\Program Files\GridCraft`.

Install and start the bridge:

```powershell
Set-Location C:\LocalAI\repo
.\deploy\Install-GridCraft-Bridge.ps1
```

Verify:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

Then open:

`http://10.0.0.21:3080/gridcraft.html`

## Bridge configuration

The installer writes `%USERPROFILE%\gridcraft-local-ai\gridcraft-bridge.env.ps1` and installs the scheduled task `LocalAI GridCraft Bridge` at user logon.

Supported environment variables:

- `GRIDCRAFT_AGENT_DIR`
- `GRIDCRAFT_AGENT_PYTHON`
- `GRIDCRAFT_AGENT_SCRIPT`
- `GRIDCRAFT_WORKBOOK`
- `GRIDCRAFT_MODEL`
- `GRIDCRAFT_BRIDGE_HOST`
- `GRIDCRAFT_BRIDGE_PORT`
- `GRIDCRAFT_CONTROL_PORT`
- `GRIDCRAFT_RUN_TIMEOUT`
- `GRIDCRAFT_ALLOWED_ORIGINS`

The default model is `qwen3:4b-instruct`, bridge port is `8787`, and GridCraft control port is `7979`.

## Runtime behavior

`GET /health` reports bridge readiness and whether GridCraft control port `7979` is already reachable.

`POST /run` accepts:

```json
{"prompt":"Inspect the workbook and summarize each sheet."}
```

Only one workbook request is executed at a time. If GridCraft is not listening, the bridge attempts to launch it with `WGPU_BACKEND=vulkan` and the configured workbook. The request then runs through the existing local agent with `--once`.

## Security boundary

This is intended for the same trusted LAN/VPN boundary as LocalAI itself. Browser CORS is restricted to the configured LocalAI origins. The bridge should not be port-forwarded to the public Internet.

## Remove

```powershell
.\deploy\Install-GridCraft-Bridge.ps1 -Uninstall
```
