# Plan: GridCraft roadmap

The owner said "go" on 2026-10-19 to this order. Each item is one PR with tests and local CI. Each item builds on what
is there now: the workbook grid, Read only / Review / Apply, Keep and Discard, opening workbooks, editing cells by
hand, answers that state their numbers, and requests up to five minutes (`docs/GRIDCRAFT.md`).

## Now

1. **Live progress while a request runs.** The bridge reads the agent's log lines (`[agent] tool call: …`) as they
   arrive and answers `GET /progress`. The appliance proxies it as `/api/gridcraft/progress`, words only. The page
   lists the newest steps under "GridCraft is working on it". This PR also carries this plan.
2. **Spreadsheet requests in Work.** Each request becomes a run in the run ledger, kind `spreadsheet`, instead of only
   a `gridcraft:run:<id>` settings row. It then shows in Work's timeline. A request waiting for review shows in Needs
   you and reaches the phone, and Keep and Discard work from there too. The Spreadsheets page's history reads the same
   runs. Existing rows are migrated once.
3. **The bridge runs without administrator rights.** The `LocalAI GridCraft Bridge` task changes from `-RunLevel Highest`
   to limited. The installer checks that GridCraft still launches and the control port answers, and the Known gaps
   entry in `docs/SECURITY.md` goes.

## Next

4. **Measure before changing the model.** About 20 real spreadsheet tasks with known answers (the owner names the
   kinds of task), scored automatically against `qwen3:4b-instruct` and one or two larger models the PC can run.
   Switch only on a clear gain.
5. **Larger sheets.** Scroll or page beyond 100 rows × 40 columns, and "Go to" a range or cell.
6. **Workbook files.** New workbook, upload an `.xlsx` from the phone, and download a copy.

## Later

7. Charts in the grid, scheduled spreadsheet automations (for example a weekly refresh that waits for review), and
   discarding more than the newest change.
