# GridCraft local agent

Windows agent that connects Ollama (OpenAI-compatible API) to GridCraft over MCP, driving the visible
GridCraft desktop workbook through its control channel (`--control 7979`).

The LocalAI GridCraft bridge (`host/gridcraft-bridge.py`) runs this script once per request with
`--model qwen3:4b-instruct --once=<prompt>`. `deploy/Install-GridCraft-Bridge.ps1` creates its virtual
environment in `%USERPROFILE%\gridcraft-local-ai\.venv` and installs `requirements.txt`
(`mcp[cli]` 2.x, `openai` 2.x). The bridge, page and installer are described in
[GridCraft](../../docs/GRIDCRAFT.md).

## Prerequisites

- Windows Python 3.12 (`py -3.12 --version`)
- Ollama running on Windows
- GridCraft installed at `C:\Program Files\GridCraft`

## Desktop launcher

`Start-GridCraft-AI.ps1` checks Ollama and the model, starts GridCraft with its control channel if needed,
then opens the agent's interactive prompt. Parameters: `-Model` (`qwen3:4b-instruct`), `-Port` (`7979`),
`-Workbook`, `-AgentDir`, `-NoOpenWorkbook`. Create the desktop shortcut for it with:

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

| Option | Environment variable | Default | Purpose |
|---|---|---|---|
| `--model` | `OLLAMA_MODEL` | `qwen3:4b-instruct-32k` | Model (the bridge passes `qwen3:4b-instruct`) |
| `--long-model` | `OLLAMA_LONG_MODEL` | `qwen3:4b-instruct-32k` | Model to switch to for long requests; empty disables |
| `--long-context-at` | `OLLAMA_LONG_CONTEXT_AT` | `3500` | Prompt tokens at which to switch |
| `--base-url` | `OLLAMA_BASE_URL` | `http://127.0.0.1:11434/v1` | Ollama's OpenAI-compatible API |
| `--port` | `GRIDCRAFT_PORT` | `7979` | GridCraft control port |
| `--gridcraft-cli` | `GRIDCRAFT_CLI` | `C:\Program Files\GridCraft\gridcraft-cli.exe` | GridCraft CLI that serves MCP |
| `--headless` | | off | Use GridCraft's in-process engine instead of the open GUI |
| `--workbook`, `--sample` | | | Workbook path or sample name, headless mode only |
| `--once` | | | Run one request and exit |
| `--list-tools` | | | Print the MCP tools offered to the model and exit |
| `--all-tools` | | off | Offer every GridCraft tool instead of the compact core set |
| `--tool`, `--args` | | | Call one MCP tool with a JSON object of arguments, print `{"ok","result"}` as JSON and exit; no model. The bridge uses it for the Spreadsheets workbook view |

Long workbooks: the bridge runs the fast `qwen3:4b-instruct` (4096-token window). When a request's prompt
reaches 3500 tokens, the agent redoes that turn on `qwen3:4b-instruct-32k` and stays on it for the rest of the
request, so Ollama never silently drops the start of the conversation. If the 32k model isn't installed, the
agent says so and keeps the fast one.
