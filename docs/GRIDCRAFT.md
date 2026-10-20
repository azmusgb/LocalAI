# GridCraft integration

GridCraft is a Windows spreadsheet app. LocalAI exposes it as **Projects › Spreadsheets**
(`https://<host>/#spreadsheets`, `app/public/spreadsheets.js`), where you type a request and a local model
works on the open workbook. It works on phones too. The old `/gridcraft.html` address sends you there.

The page is part of LocalAI. The page calls the appliance (`/api/gridcraft/health`, `/api/gridcraft/run`), and the appliance forwards to a small Windows-host bridge on `127.0.0.1:8787`, which runs the GridCraft Python agent kept in this repo at `host/gridcraft-agent/`. That agent continues to own Ollama tool calling and GridCraft MCP control.

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

Install and start the bridge from an **elevated** PowerShell (Run as administrator); the installer refuses to run otherwise. The task it registers runs with your normal rights:

```powershell
Set-Location C:\LocalAI\repo
.\deploy\Install-GridCraft-Bridge.ps1
```

Verify:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

Then open Projects › Spreadsheets (`https://<host>/#spreadsheets`).

## Bridge configuration

`deploy\Install-GridCraft-Bridge.ps1` parameters: `-RepoRoot` (`C:\LocalAI\repo`), `-AgentDir`
(`%USERPROFILE%\gridcraft-local-ai`), `-Workbook` (`%USERPROFILE%\Documents\GridCraft\Quarterly-Sales-Dashboard.xlsx`),
`-Model` (`qwen3:4b-instruct`), `-Port` (`8787`), `-AllowedOrigins`, `-Uninstall`.

It:

1. creates the virtual environment `%USERPROFILE%\gridcraft-local-ai\.venv` with `py -3.12` if missing and
   installs `host/gridcraft-agent/requirements.txt`;
2. writes `%USERPROFILE%\gridcraft-local-ai\gridcraft-bridge.env.ps1`, which sets the variables below and
   starts `host/gridcraft-bridge.py`;
3. registers the scheduled task `LocalAI GridCraft Bridge` (at logon, with the user's normal rights, not elevated; restarts up to 3 times);
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
| `GRIDCRAFT_WORKBOOKS_DIR` | the folder of `GRIDCRAFT_WORKBOOK` | Folder the Spreadsheets workbook menu lists and opens from (no subfolders) |
| `GRIDCRAFT_RUN_TIMEOUT` | `300` (seconds) | Per-request limit; the agent stops itself 30 s before it (`--time-limit`), the appliance waits 330 s |
| `GRIDCRAFT_ALLOWED_ORIGINS` | `http://10.0.0.21:3080,http://127.0.0.1:3080,http://localhost:3080` | CORS allow-list |
| `GRIDCRAFT_OPS_SESSION` | `1` | `0` runs every op (below) as its own process instead of on one kept GridCraft connection |
| `GRIDCRAFT_BRIDGE_RELOAD` | `1` | The bridge checks its code (`gridcraft-bridge.py`, `gridcraft_ops.py`, `gridcraft_journal.py`) every `GRIDCRAFT_BRIDGE_RELOAD_EVERY` seconds (60) and, once a deploy changed it and no request is running, starts its new version itself; `0` turns that off |
| `GRIDCRAFT_BRIDGE_LOG` | unset (stdout) | Log file, rotated at 2 MB × 3; the installer sets `gridcraft-bridge.log` |

Startup crashes land in `gridcraft-bridge.crash.log` next to the log.

## Runtime behavior

`GET /health` reports bridge readiness and whether GridCraft's control port is already reachable. The
appliance proxies it as `GET /api/gridcraft/health`.

`POST /run` (appliance: `POST /api/gridcraft/run`) takes JSON:

```json
{"prompt":"Inspect the workbook and summarize each sheet.","mode":"review"}
```

`mode` says what the request may do (the bridge defaults to `apply`, what it always did; the appliance defaults to
`review`):

| Mode | The model gets | Saves |
|---|---|---|
| `read` | `inspect_workbook`, `read_range`, `get_cell`, `evaluate_formula`, `list_functions` | never |
| `review` | the core tools without `save_workbook`, `open_workbook`, `new_workbook` | never; the owner keeps or discards |
| `apply` | the core tools | when it finishes: the agent saves if the model didn't. Changes a failed or stopped request left unsaved wait for Keep or Discard |

The agent refuses any other tool itself (`host/gridcraft-agent/gridcraft_journal.py`). In every mode it also refuses
`save_workbook` with a `path` (saving elsewhere), and an `execute_command` that reaches past the open workbook: the
`file.`, `app.`, `window.` and `automate.` commands, opening links, importing or refreshing outside data, pictures from
files, the PC's clipboard, undo and redo (the journal counts undo steps), window and protection commands, and any
command whose name has a file word in it (`save`, `open`, `export`, `print`, `script`, `macro` …). The list comes from
GridCraft's `list_commands` on the host (20 Oct 2026); `gridcraft_journal.BLOCKED_COMMANDS` holds it. A request stays
on the open workbook and saves only through `save_workbook`. It records what each write
changed: `set_cell` and `write_range` cell by cell (before, after, computed after; 2,000 cells per request), other
writes as one line, and the number of GridCraft undo steps the request made. It prints that journal as one
`[journal] {...}` line on stderr, also when the request fails, and `/run` returns it as `journal`. A request that left
something to undo also gets a `fingerprint`: a hash of every sheet's cells and the visible undo list (none for a
workbook over 50,000 cells).

**Stopping a request.** The agent stops itself between tool calls at its time limit, so it still prints its journal. In
case it is stuck in GridCraft itself, it also prints each write as it starts and as it is recorded
(`[journal-entry] {...}` lines); when the bridge has to kill it at `GRIDCRAFT_RUN_TIMEOUT`, `/run` answers 504 with the
journal built from those lines (`partial: true`) and the workbook's undo list and fingerprint as they are now. A write
that started and never got its record makes it `uncertain: true`: Discard then refuses, since it can't know how many
steps to undo.

Answers state the values they found. The model is told to compute totals, averages and counts with
`evaluate_formula` (for example `=SUM(Sales!D2:D17)`), which every mode offers, instead of writing a formula into the
workbook. When a request that changed nothing read values (`read_range`, `get_cell`, `evaluate_formula`) but the
answer states none of them, or only says it "verified" or "addressed" the request, the agent
(`host/gridcraft-agent/gridcraft_answer.py`) asks the model once more without tools, giving it the values read; if
that answer still has none, it appends `Values read: …` from the tool results.

While a request runs, the bridge reads the agent's log lines as they arrive (`[agent] model turn 2 ...`, `[agent] tool
call: read_range {...}`) and `GET /progress` returns them as steps in words: `{running, startedAt, turn, steps:[{tool,
text, at, failed?}]}`, for example "Reading Sales!A1:D17", "Calculating =SUM(Sales!D2:D17)", "Changing Sales!B7". A
tool result marked `ERROR` marks its step failed. Only the newest request is kept (its newest 40 steps), and its steps
stay until the next request starts. The Spreadsheets page polls it every 1.5 s while a request runs and lists the
newest six steps under "GridCraft is working on it".

Without a model, through `host/gridcraft-agent/gridcraft_ops.py`. The bridge keeps one GridCraft connection open for
these (`gridcraft_ops.Session`, closed after 2 idle minutes or a failed call), so a grid view or cell edit no longer
starts a Python process and a `gridcraft-cli` process each time. When that connection fails before an op changed
anything, the op runs again as its own process, as before; when it fails after a change, the op answers 502 and is
never run twice. A bridge Python without the agent's packages, or `GRIDCRAFT_OPS_SESSION=0`, uses a process per op.

- `GET /workbook?sheet=&range=`: title, file name (never the host path), unsaved flag, sheets, and up to 100 rows by 40
  columns of the chosen sheet as display text (`values`), formulas (`formulas`) and computed values (`raw`).
- `POST /keep`: saves the workbook.
- `POST /discard {"steps":N,"undoTop":[...],"fingerprint":"..."}`: undoes `N` steps, but only if GridCraft's newest
  undo labels still equal `undoTop` and, when given, the workbook's fingerprint still equals `fingerprint` (otherwise
  409: something else changed the workbook since). The labels alone are generic ("Enter Cell"), so a cell typed in
  GridCraft after the request could leave them unchanged.
- `GET /workbooks`: the `.xlsx .xlsm .xls .csv .ods` files directly in `GRIDCRAFT_WORKBOOKS_DIR` (name, size, modified;
  never a path). Doesn't need GridCraft running.
- `POST /open {"name":"Budget.xlsx"}`: opens that file from the folder (GridCraft `open_workbook`), replacing the open
  workbook. Only a bare file name: a path separator, `:`, `..` or another extension gets 400, a file not in the folder
  404, and 409 while the open workbook has unsaved changes.
- `POST /cell {"sheet":"Sales","cell":"B7","input":"=B5*2"}`: the `set_cell` op, a cell changed by hand in the grid. It
  checks the input (cell `^[A-Z]{1,3}[1-9][0-9]{0,6}$`, sheet name 1 to 100 characters without control characters,
  input text up to 8,192 characters, empty clears the cell; otherwise 400, an unknown sheet 404), then calls GridCraft
  MCP `set_cell {cell:"Sales!B7", input}` (a sheet name that needs it is quoted: `'Q1 Sales'!B7`) through the same
  journal as a Review request. It never saves. It returns `journal` (the before → after edit, `undoSteps`, `undoTop`)
  and `undoBefore`, the newest 5 undo labels before the edit, and `fingerprintBefore`, the workbook's fingerprint before it.

Keep, discard, open and cell edits wait for no running request (409; open says "GridCraft is busy with a request", a
cell edit "GridCraft is busy with a request. Change the cell when it finishes."). The appliance
stores each request as a settings row `gridcraft:run:<id>` (50 kept) from the moment it starts (status `running`), so
a request is never lost: one the bridge refused is removed, one the bridge never answered ends `failed` ("what this
request changed is unknown"), and one still `running` when LocalAI starts ends `failed` ("LocalAI restarted while this
request ran"). It adds these routes:

| Appliance route | Bridge | Notes |
|---|---|---|
| `GET /api/gridcraft/health` | `GET /health` | ready and connected flags and the model only |
| `POST /api/gridcraft/run` | `POST /run` | records the request and its journal |
| `GET /api/gridcraft/runs` | | the recorded requests, newest first |
| `GET /api/gridcraft/workbook` | `GET /workbook` | `sheet` and `range` only |
| `POST /api/gridcraft/runs/<id>/keep` | `POST /keep` | marks every request waiting for review kept, since saving saves them all |
| `POST /api/gridcraft/runs/<id>/discard` | `POST /discard` | the newest request only |
| `GET /api/gridcraft/workbooks` | `GET /workbooks` | names, sizes and dates only |
| `GET /api/gridcraft/progress` | `GET /progress` | `running`, `turn` and each step's `tool`, `text` and `failed` only |
| `POST /api/gridcraft/open` | `POST /open` | checks the name the same way; 409 while any request waits for review, since opening another workbook would leave its Keep and Discard meaning nothing |
| `POST /api/gridcraft/cell` | `POST /cell` | `{sheet, cell, input}`, checked the same way (400) before it reaches the bridge; records a Direct edit (below) |

**Direct edits.** A cell changed by hand becomes a request record with `kind: "edit"`, mode `review`, status `review`
("Waiting for review"), titled `Direct edit: Sales!B7`, with its journal entry and undo step count, whatever mode the
page is in. Keep and Discard work on it exactly as on a Review request. An edit joins the newest record instead when
that record is a Direct edit still waiting for review and the bridge's `undoBefore` equals its `undoTop` (nothing else
changed the workbook in between) and, when both are known, its `fingerprintBefore` equals that record's
`fingerprint`: its steps add up, `undoTop` becomes the newest, and a cell changed twice keeps its
first before. Otherwise the edit starts a record of its own, and as always only the newest can be discarded. One cell
edit at a time (409 "Another cell change is still being made"); while a request runs, the bridge's 409 is passed on.

**In Work.** Every request record is also a Work run (`app/server/runs.js`, id `legacy-gridcraft:<id>`, type
`spreadsheet`, the Spreadsheets icon), from the same `gridcraft:run:*` rows, so nothing is copied. A running
request is `running`. A request waiting for review is `awaiting_approval`: Work shows it as Ready to review, with a Review button, and Home's Needs you lists it.
Kept, applied and no-change requests are `completed`, discarded ones `cancelled`, and failed ones `failed`. Opening one,
from Work, Needs you or a `#run/legacy-gridcraft:…` link, goes to Spreadsheets, where Keep and Discard are. Like other
runs managed on their own page, it can't be deleted, filed or retried from Work.

POSTs follow the same rules as the bridge: same origin only (403) and `Content-Type: application/json` (415).

Prompts are limited to 20,000 characters. One request runs at a time; a second gets HTTP 409. If GridCraft is
not listening, the bridge launches it with `WGPU_BACKEND=vulkan` and the configured workbook (or GridCraft's
`sales` sample if the workbook does not exist), then runs the
agent once with `--once`. The agent's model choice, including the switch to the 32k-context model for long
requests, is described in the [agent README](../host/gridcraft-agent/README.md).

Deploys update `C:\LocalAI\repo` and never restart the bridge. The agent and the ops helper run from the repo for
each request, so they change with the deploy; the bridge itself restarts on its own (above) since 20 Oct 2026. A
bridge started before then needs one restart to get that: sign out and in on the PC, or re-run the installer.
`GET /health` reports `code` (a hash of the bridge's code) and `startedAt`.

## Security boundary

The bridge listens on the host's loopback only, so the LAN reaches it only through the appliance. Browser CORS is restricted to the configured LocalAI origins. The scheduled task runs with the signed-in user's normal rights (`-RunLevel Limited`), and so do the agent and GridCraft it starts. A bridge installed before 19 Oct 2026 ran elevated: re-run the installer to switch it.

## Remove

```powershell
.\deploy\Install-GridCraft-Bridge.ps1 -Uninstall
```
