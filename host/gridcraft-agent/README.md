# GridCraft local agent

Windows agent that connects Ollama (OpenAI-compatible API) to GridCraft over MCP,
driving the visible GridCraft desktop workbook through its control channel (`--control 7979`).

The LocalAI GridCraft bridge (`host/gridcraft-bridge.py`) runs this script once per request
with `--once`. `deploy/Install-GridCraft-Bridge.ps1` creates its virtual environment in
`%USERPROFILE%\gridcraft-local-ai\.venv` and installs `requirements.txt`; see `docs/GRIDCRAFT.md`.

## Prerequisites

- Windows Python 3.12 (`py -3.12 --version`)
- Ollama running on Windows
- GridCraft installed at `C:\Program Files\GridCraft`

## Desktop launcher

`Start-GridCraft-AI.ps1` checks Ollama and the model, starts GridCraft with its control channel if
needed, then opens the agent's interactive prompt. Create the desktop shortcut for it with:

```powershell
C:\LocalAI\repo\host\gridcraft-agent\Install-GridCraft-Shortcut.ps1
```

## Run by hand

```powershell
$py = "$env:USERPROFILE\gridcraft-local-ai\.venv\Scripts\python.exe"
& $py C:\LocalAI\repo\host\gridcraft-agent\gridcraft_ai.py                 # interactive
& $py C:\LocalAI\repo\host\gridcraft-agent\gridcraft_ai.py --list-tools
& $py C:\LocalAI\repo\host\gridcraft-agent\gridcraft_ai.py --once "Inspect the current workbook and summarize what is in it."
& $py C:\LocalAI\repo\host\gridcraft-agent\gridcraft_ai.py --headless --sample sales
```

Options: `--model <ollama model>`, `--base-url http://127.0.0.1:11434/v1`, `--port 7979`.

Long workbooks: the bridge runs the fast `qwen3:4b-instruct` (4096-token window). When a request's prompt reaches
3500 tokens, the agent redoes that turn on `qwen3:4b-instruct-32k` and stays on it for the rest of the request, so
Ollama never silently drops the start of the conversation. Override with `--long-model` / `OLLAMA_LONG_MODEL`
(empty disables) and `--long-context-at` / `OLLAMA_LONG_CONTEXT_AT`. If the 32k model isn't installed, the agent says so and
keeps the fast one.
