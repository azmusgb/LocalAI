# Plan: GridCraft review integrity

From the GridCraft critique of 2026-10-20 (Claude board findings `gc-*`). The owner said "proceed" to fixing the four
items where workbook data was at risk. One PR: all four touch the same journal, bridge and run record, and separate
PRs on those lines would conflict with each other.

## 1. Discard undoes only the request's own steps

Discard checked that GridCraft's newest 5 undo labels were unchanged. The labels are generic ("Enter Cell"), so a cell
typed in GridCraft after a request could leave them the same, and Discard would undo the owner's edit instead.

- The journal adds a `fingerprint` (hash of every sheet's cells as typed plus the visible undo list) when the request
  left something to undo. Discard sends it; the ops helper refuses (409) when the workbook's fingerprint differs.
  Workbooks over 50,000 cells get none and keep the label check alone.
- A Direct edit joins the previous one only when the cell edit's `fingerprintBefore` equals the previous record's
  `fingerprint`.

## 2. A stopped request still leaves a record

The agent printed its journal only when it exited, the bridge killed it at 300 s, and the appliance stored the record
only after the bridge answered, so a slow or interrupted request could leave unsaved changes nobody could see or
discard.

- The agent stops itself between tool calls 30 s before the bridge's limit (`--time-limit`), so the common case (a
  slow model) ends with a full journal and the request waits for review.
- The agent prints each write as it starts and as it is recorded (`[journal-entry]`); after a hard kill the bridge
  rebuilds the journal from them, adds the workbook's current undo list and fingerprint (`state` op), and marks it
  `uncertain` if a write never finished. Discard refuses an uncertain request.
- The appliance records a request when it starts (`running`), removes it if the bridge refused it, marks it failed
  if the bridge never answered, and marks any still `running` at start-up as cut short by a restart.

## 3. Requests can't reach files through execute_command

Review blocked `save_workbook`, `open_workbook` and `new_workbook` by name, but `execute_command` runs any GridCraft
command. The journal now refuses a command that names a file action (save, open, close, new, export, quit and similar,
or a `file.`/`app.`/`window.`/`workbook.` command) in every mode. GridCraft's command list was not probed for this
change (SSH to the host was refused on 2026-10-20); check `--list-tools` / `list_commands` on the host and widen the
words if a file command slips through.

## 4. Apply never leaves changes unsaved

Apply relied on the model choosing to save. Now the agent saves after an Apply request that finished with changes
and no save. An Apply request that failed or was stopped with unsaved changes waits for Keep or Discard like a Review
request. Opening another workbook is refused while the open one has unsaved changes.

## Later (from the same critique)

- One persistent GridCraft MCP connection in the bridge for grid views and cell edits.
- Drop "calculate" and "make" from the agent's action words, and skip the completion check for read-style questions.
- Send each tool result to the model once, capped in size.
