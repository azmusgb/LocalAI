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
