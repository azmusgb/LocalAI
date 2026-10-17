# Spreadsheets shows the workbook itself

Owner: "don't see a way for user to view the actual spreadsheets". System › Spreadsheets only took requests and
showed the model's answer; the workbook itself stayed on the Windows computer's screen.

## What changes

A **Workbook** card under the ask card shows the workbook open in GridCraft, read-only:

- a picker of the workbooks in `Documents\GridCraft` (changing it opens that file in GridCraft, then reloads);
- the title, and an "Unsaved changes" pill when GridCraft says the workbook is dirty;
- sheet tabs (`role=tablist`, arrow keys move between them);
- a real `<table>` with column letters and row numbers as headers, sticky header row and first column, scrolling
  sideways inside the card only (the page never scrolls sideways on a phone); numbers right-aligned, errors in red,
  empty cells blank; "Showing the first 200 rows and 30 columns" when the sheet is bigger;
- Refresh, and an automatic reload after each successful Run.

No model is involved: reading is direct MCP tool calls.

## How it reads

1. **Agent** (`host/gridcraft-agent/gridcraft_ai.py`): `--tool NAME --args JSON` connects to GridCraft MCP, calls that
   one tool, prints `{"ok":…, "result":…}` as JSON and exits. No Ollama check.
2. **Bridge** (`host/gridcraft-bridge.py`), each call through the agent's `--tool` mode, sharing `run_lock` with
   `/run` (409 "GridCraft is busy with a request" while one runs), 30 s timeout, failures logged with
   `failure_reason`:
   - `GET /workbook` → `inspect_workbook`, with the absolute path reduced to the file name.
   - `GET /range?sheet=&range=` → `read_range` (`formatted: true`); the range is clipped to 200 rows × 30 columns
     before the call and the result is clipped again; `truncated` says so.
   - `GET /workbooks` → name, size, modified of each workbook file in `Documents\GridCraft` (no recursion).
   - `POST /open {"name"}` → `open_workbook` with the folder path joined in the bridge. The name must be a plain file
     name (no separators, no `..`) ending in `.xlsx/.xlsm/.xls/.csv/.ods` and must exist. Same Origin and
     Content-Type rules as `/run`.
   Only `inspect_workbook`, `read_range` and `open_workbook` are callable this way.
3. **Appliance** (`app/server.js`): `GET /api/gridcraft/workbook`, `GET /api/gridcraft/range` (only `sheet` ≤ 100
   characters and an A1 `range` are forwarded; anything else is a 400), `GET /api/gridcraft/workbooks`,
   `POST /api/gridcraft/open` (same-origin, JSON). No host paths reach the browser.

## Not in scope

Editing cells from the grid (requests still go through the ask box), charts, formulas view.
