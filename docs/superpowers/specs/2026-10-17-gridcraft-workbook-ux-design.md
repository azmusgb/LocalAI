# GridCraft workbook view, edit review and permissions

Date: 2026-10-17. Status: approved by the owner in chat ("do it and apply") after the in-chat design.

## Why

System › Spreadsheets is a prompt box that returns one paragraph. The owner cannot see the workbook, cannot see what
a request read or changed, and every request may write and save. The goal is a page where the owner:

1. **sees the workbook**: sheets, cells, formulas, without walking to the Windows computer;
2. **sees every edit** a request made, cell by cell, before → after;
3. **controls access**: what a request may do (read only, change for review, change and save), and can keep or
   throw away a reviewed change.

LocalAI has one user, so "access" means what the agent is allowed to do, not user accounts.

## Facts this design rests on (probed on the host, 2026-10-17)

- GridCraft MCP exposes `inspect_workbook` (path, title, dirty, sheets with `usedRange`/cells/tables/charts, `undo`
  and `redo` lists of step labels), `read_range` (`values` as rows; `formulas:true` gives formula text,
  `formatted:true` display text; `{error}` objects for error cells), `write_range`, `set_cell`, `format_range`
  (result lists `applied` commands, one undo step each), `execute_command`, `undo {steps}`, `save_workbook`.
- `inspect_workbook.undo` is newest first and shows only the latest 20 labels, but `undo {steps:29}` reverted all 29
  steps: real undo depth is larger than the list.
- A bad sheet name is an `is_error` result (`no sheet named …`), not an exception.

## Permission modes

Chosen per request in the page; default **Review**.

| Mode | Tools the model gets | Saves? | Run ends as |
|---|---|---|---|
| Read only | `inspect_workbook`, `read_range`, `get_cell`, `evaluate_formula`, `list_functions` | never | `done` |
| Review | core tools minus `save_workbook`, `open_workbook`, `new_workbook` | never; Keep saves | `review` |
| Apply | today's core tools | the agent may save | `applied` |

Read only drops `execute_command` because it can run any command. A tool call outside the mode's list is refused
by the agent itself (never forwarded to GridCraft), so a model that names an unlisted tool still cannot write.
The completion check's "call save_workbook" sentence is only sent in Apply mode.

## Edit journal (agent)

`gridcraft_ai.py --mode read|review|apply` wraps every forwarded write tool:

- `set_cell` / `write_range`: before the call, `read_range` the target (sheet-qualified, `formulas:true`); after a
  successful call, read it again (values with formulas, and computed values). Records
  `{tool, sheet, range, before[][], after[][]}`. A `write_range` target's size comes from `values`.
- Anything else that changes the workbook (`format_range`, `execute_command`, `sort_range`, `create_table`, …):
  records `{tool, sheet?, range?, summary}` from its arguments, no cell diff.
- **Undo steps** are counted per successful call: `set_cell`/`write_range` 1, `format_range` `len(applied)`, other
  write tools: the drop in the visible undo list compared before/after that call (inspect is cheap), at least 1 if
  the newest label changed. The run's total is `undoSteps`.
- After the run, `undoTop` = the first 5 labels of `inspect_workbook.undo`, so Discard can prove nothing else
  happened since.
- Journal limits: at most 2,000 cells of before/after per run; larger edits keep their range and `truncated:true`.
- The agent prints one `[journal] {json}` line to stderr at the end of every `--once` run, also when the run fails
  (a failed review run may already have changed cells, and the owner must be able to discard them).

## Bridge (host/gridcraft-bridge.py)

New, alongside `/health` and `/run`:

- `POST /run {prompt, mode}`: passes `--mode`; response adds `journal` (parsed from stderr; the `[journal]` line is
  never shown as a failure reason).
- `GET /workbook?sheet=&range=`: `inspect_workbook` summary (title, file name, dirty, sheets: name, usedRange,
  cells, tables/charts counts) plus a window of the chosen sheet (default the active sheet's used range) as
  `values` (display text), `formulas`, `raw` (computed), capped at 100 rows × 40 columns; `truncated` says so.
- `POST /keep`: `save_workbook` (no path).
- `POST /discard {steps, undoTop}`: refuses with 409 unless the current `undo` list starts with `undoTop`; then
  `undo {steps}` and reports the new dirty flag.

These four run through a small ops helper in the agent's directory (`host/gridcraft-agent/gridcraft_ops.py`,
spawned like the agent, JSON in/out) so the bridge keeps its stdlib-only, one-request-at-a-time design. `/workbook`
does not take the run lock (reads are safe while a run works); `/keep` and `/discard` do (409 while a run is going).

## Appliance (app/server.js)

- Runs are stored as settings rows `gridcraft:run:<id>`: `{id, prompt, mode, status, answer, error, edits,
  changes, undoSteps, undoTop, durationSec, createdAt, updatedAt}`; at most 50 kept (oldest removed).
- `POST /api/gridcraft/run {prompt, mode}` forwards and records; `mode` defaults to `review`, anything unknown is
  400. Status: `done` (read only), `review` (review with changes), `done` (review with no changes), `applied`,
  `failed` (but a failed review run with changes is `review`).
- `GET /api/gridcraft/runs` (newest first, 30), `GET /api/gridcraft/workbook` (proxy, host paths reduced to the file
  name).
- `POST /api/gridcraft/runs/:id/keep`: bridge `/keep`; every run in `review` becomes `kept` (saving saves them all).
- `POST /api/gridcraft/runs/:id/discard`: only the newest run, only in `review`; bridge `/discard` with its
  `undoSteps`/`undoTop`; becomes `discarded`. A 409 from the bridge is passed through with its reason ("Someone
  changed the workbook in GridCraft after this request, so undoing it could remove their work.").
- Same-origin + JSON rules as `/run` for every POST.

## Page (System › Spreadsheets)

Desktop: two columns, workbook left (wide), request + changes right. Phone: one column, workbook first.

- **Header**: workbook title, "Unsaved changes" pill when dirty, GridCraft status pill (existing `#sheetsStatus`).
- **Workbook card**: sheet tabs (with cell counts), a scrollable grid with sticky column letters and row numbers,
  showing display values; a "Formulas" toggle shows formula text. Cells changed by the latest unreviewed run are
  highlighted; a formula cell has a small corner mark. Selecting a cell fills a detail strip: address, value,
  formula, and before → after when changed, plus **Ask about this cell**, which inserts `Sheet!A1` into the prompt.
  Refresh button; the grid reloads after every run, keep and discard.
- **Request card**: prompt, examples, the mode switch (Read only / Review / Apply, with a one-line explanation of
  the chosen one), Run. Live elapsed time while working (existing).
- **Answer + changes**: the answer; then, when a run changed cells, "Changes" grouped by sheet, each change a small
  before → after table (formula text when either side is a formula), and other changes as one line each. In
  `review`: **Keep changes** (saves the workbook) and **Discard** (undoes them). Discard on an older run is not
  offered; its row says "Only the latest request can be undone."
- **History**: last runs with mode, status badge (Saved / Waiting for review / Kept / Discarded / Read only /
  Failed), time; opening one shows its answer and changes.

Accessibility: grid is a `role="grid"` table with `aria-selected` cell, arrow keys move the selection, Enter opens
the detail; the mode switch is a radio group; status changes are announced through the existing live region.

## Not in this work

Streaming tool-call progress, editing cells by hand in the grid, multiple user accounts, charts in the grid.

## Testing

- Python (via `node --test` like `gridcraft-bridge.test.cjs`): mode tool filtering and refusal, undo-step counting,
  journal parsing and failure-reason skipping, discard's undoTop check — with a fake MCP client.
- Proxy (`gridcraft-proxy.test.cjs`): mode forwarding and validation, run records and statuses, keep marks all
  reviews kept, discard only newest/review, 409 passthrough, host paths stripped from `/workbook`.
- Browser (`spreadsheets-ui.mjs`, stubbed API, computer and phone): grid renders, tabs switch, formula toggle,
  changed-cell highlight and detail, mode sent, Keep/Discard flow, no sideways page scroll.
- On the host after deploy: one read-only and one review run against the real workbook, then Discard, then check the
  workbook is unchanged.
