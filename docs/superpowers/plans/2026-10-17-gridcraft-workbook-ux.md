# Plan: GridCraft workbook view, edit review and permissions

Spec: `docs/superpowers/specs/2026-10-17-gridcraft-workbook-ux-design.md`. One PR (`feat/gridcraft-workbook-ux`), one
commit per task, so the squash merge cannot strand half of it.

1. **Agent modes + journal** (`host/gridcraft-agent/gridcraft_ai.py`, new `gridcraft_journal.py` with the pure logic:
   mode tool sets, refusal, target extent, undo-step counting, journal limits). Test:
   `tests/gridcraft-journal.test.cjs` drives it with a fake MCP client through `python3 -I`.
2. **Ops helper** (`host/gridcraft-agent/gridcraft_ops.py`: `workbook`, `keep`, `discard`), reusing the journal
   module's pure functions (window clamp, undoTop check). Tested with the same fake client.
3. **Bridge** (`host/gridcraft-bridge.py`): `mode`, journal from stderr, failure reason skips `[journal]`,
   `/workbook`, `/keep`, `/discard` through the ops helper. Extend `tests/gridcraft-bridge.test.cjs`.
4. **Appliance** (`app/server.js`): run records, `/runs`, `/workbook`, keep, discard. Extend
   `tests/gridcraft-proxy.test.cjs`.
5. **Page** (`index.html` section, `spreadsheets.js`, `app.css`): workbook grid, detail, mode switch, changes,
   keep/discard, history. Raise the shell budget with the reason. Extend `tests/spreadsheets-ui.mjs`.
6. **Docs**: `docs/GRIDCRAFT.md` (modes, endpoints, review flow), `docs/USER-GUIDE.md` Spreadsheets section.
7. **Verify**: `npm test`, lint, the browser suites on a fresh server, local CI on the PR; after the owner merges and
   the deploy lands, restart the `LocalAI GridCraft Bridge` task (it loads Python at start) and run the host check
   from the spec.
