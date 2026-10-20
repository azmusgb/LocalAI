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
command (about 340, listed with `list_commands` on the host on 2026-10-20). The journal now refuses, in every mode, the
`file.`/`app.`/`window.`/`automate.` areas, the single commands that open links, import or refresh outside data, insert
pictures, use the clipboard, undo or redo, or touch windows and protection, and any command whose name has a file word.
`save_workbook` with a `path` (save elsewhere) is refused too.

## 4. Apply never leaves changes unsaved

Apply relied on the model choosing to save. Now the agent saves after an Apply request that finished with changes
and no save. An Apply request that failed or was stopped with unsaved changes waits for Keep or Discard like a Review
request. Opening another workbook is refused while the open one has unsaved changes.

## Next PR (from the same critique)

5. **One kept GridCraft connection for ops.** `gridcraft_ops.Session` keeps one MCP connection in the bridge for grid
   views, cell edits, Keep, Discard and Open. An op whose connection broke before it changed anything runs again as
   its own process; one that broke after a change answers 502 and never runs twice.
6. **Questions skip the change check.** "calculate" is no longer an action word, and a request that opens like a
   question ("What…", "How many…") gets no ACTION COMPLETION CHECK turn. "make" stays: "make a chart" is a change.
7. **Tool results reach the model once, cut to size.** The structured copy only, at most 6,000 characters with a note
   to read less; the answer check still reads the full result.
