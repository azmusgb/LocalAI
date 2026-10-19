'use strict';

// GridCraft (the Windows spreadsheet app, through the host bridge on :8787), ArtCraft and the Workshop display.
// Moved from server.js unchanged (the server split: docs/superpowers/specs/2026-10-18-server-split-design.md). ctx holds
// what this code uses from the rest of the server.
function createGridcraft(ctx) {
  const { GRIDCRAFT_RUN_TIMEOUT_MS, GRIDCRAFT_URL, inFlight, json, makeId, modelFetchWithTimeout, readBody, recordActivity, sameOriginJson, storage, workshop, workshopPrinter } = ctx;
  // Calls to the host bridge (GridCraft and ArtCraft) go over node:http (model-http.js), not the global fetch: undici
  // gives up when headers take more than 300 s, so a long GridCraft request died as "fetch failed" at five minutes
  // whatever its own deadline. Here the deadline passed in is the only one.
  function bridgeFetch(pathname, options, timeoutMs) {
    return modelFetchWithTimeout(`${GRIDCRAFT_URL}${pathname}`, options, timeoutMs);
  }
  const bridgeTimedOut = e => e?.code === 'MODEL_TIMEOUT' || e?.name === 'TimeoutError';
  // The bridge's JSON; a body cut off by the deadline is a time-out, anything else unreadable is the fallback.
  const bridgeJson = (r, fallback) => r.json().catch(e => { if (bridgeTimedOut(e)) throw e; return fallback; });
  // What the page shows when the bridge call itself failed: never undici's "fetch failed" or Ollama wording.
  function bridgeFailure(res, e, who = 'GridCraft', unavailable = 'GridCraft bridge unavailable') {
    if (bridgeTimedOut(e)) return json(res, 504, { ok: false, error: `${who} took too long to answer` });
    const code = e?.cause?.code || '';
    json(res, 502, { ok: false, error: `${unavailable}${code ? ` (${code})` : ''}` });
  }
  async function apiGridcraftHealth(req, res) {
    try {
      const r = await bridgeFetch('/health', { cache: 'no-store' }, 4000);
      const data = await bridgeJson(r, {});
      // Only what the UI shows: the bridge also reports host file paths.
      json(res, r.ok ? 200 : 502, { ok: r.ok && data.ok === true, gridcraftConnected: data.gridcraftConnected === true, ...(data.model ? { model: String(data.model) } : {}) });
    } catch (e) {
      bridgeFailure(res, e);
    }
  }
  // A request's record: what was asked, in which mode, and what it changed (the agent's journal), so the page can show the
  // changes and the owner can keep or discard a Review request later, also from another device.
  const GRIDCRAFT_RUN_PREFIX = 'gridcraft:run:';
  const GRIDCRAFT_MODES = new Set(['read', 'review', 'apply']);
  const GRIDCRAFT_KEEP_RUNS = 50;
  function gridcraftRunStatus(ok, mode, journal) {
    const changed = !!journal && ((journal.edits || []).length > 0 || (journal.changes || []).length > 0 || journal.undoSteps > 0);
    if (mode === 'review' && changed) return 'review'; // also after a failure: whatever it changed can still be discarded
    if (!ok) return 'failed';
    return mode === 'apply' && changed ? 'applied' : 'done';
  }
  function gridcraftRuns(limit = 30) { return storage.listSettings(GRIDCRAFT_RUN_PREFIX, { limit }); }
  function saveGridcraftRun(run) { storage.writeSetting(GRIDCRAFT_RUN_PREFIX + run.id, run); }
  async function apiGridcraftRun(req, res) {
    // Same rules the bridge applies to browsers: same-origin only, JSON only.
    if (!sameOriginJson(req, res)) return;
    let b;
    try { b = await readBody(req, 64 * 1024); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    const prompt = String(b.prompt || ''), mode = b.mode === undefined ? 'review' : String(b.mode);
    if (!GRIDCRAFT_MODES.has(mode)) return json(res, 400, { ok: false, error: 'mode must be read, review or apply' });
    const untrack = inFlight.track('gridcraft', 'GridCraft: ' + prompt);
    try {
      const r = await bridgeFetch('/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, mode }) }, GRIDCRAFT_RUN_TIMEOUT_MS);
      const data = await bridgeJson(r, { ok: false, error: `Bridge returned HTTP ${r.status}` });
      const ok = r.ok && data.ok === true, journal = data.journal && typeof data.journal === 'object' ? data.journal : null;
      // A request the bridge refused before running (busy, bad prompt) changed nothing and isn't worth a record.
      if (!ok && !journal && r.status !== 500 && r.status !== 504) return json(res, r.status, { ok: false, error: data.error, reason: data.reason });
      const now = new Date().toISOString();
      const run = {
        id: makeId('gc'), prompt: prompt.slice(0, 2000), mode, status: gridcraftRunStatus(ok, mode, journal),
        answer: ok ? String(data.answer || '') : '', error: ok ? '' : [data.error, data.reason].filter(Boolean).join(': '),
        edits: journal?.edits || [], changes: journal?.changes || [], undoSteps: Number(journal?.undoSteps) || 0,
        undoTop: Array.isArray(journal?.undoTop) ? journal.undoTop : [], saved: journal?.saved === true,
        durationSec: data.durationSec, createdAt: now, updatedAt: now
      };
      saveGridcraftRun(run);
      storage.pruneSettings(GRIDCRAFT_RUN_PREFIX, GRIDCRAFT_KEEP_RUNS);
      if (ok) recordActivity('gridcraft', 'GridCraft request', prompt.slice(0, 180), { durationSec: data.durationSec, mode });
      json(res, r.status, { ok, answer: run.answer, ...(ok ? {} : { error: data.error, reason: data.reason }), durationSec: data.durationSec, run });
    } catch (e) {
      bridgeFailure(res, e);
    } finally { untrack(); }
  }
  async function apiGridcraftRuns(req, res) { json(res, 200, { items: gridcraftRuns() }); }
  async function apiGridcraftWorkbook(req, res, urlObj) {
    const q = new URLSearchParams();
    for (const k of ['sheet', 'range']) { const v = urlObj.searchParams.get(k); if (v) q.set(k, v.slice(0, 200)); }
    try {
      const r = await bridgeFetch(`/workbook${q.size ? `?${q}` : ''}`, { cache: 'no-store' }, 65000);
      json(res, r.status, await bridgeJson(r, { ok: false, error: `Bridge returned HTTP ${r.status}` }));
    } catch (e) {
      bridgeFailure(res, e);
    }
  }
  // The workbook menu: files directly in the GridCraft folder on the host, by bare name. The bridge checks the name again
  // against the folder; this check keeps paths and odd names from ever reaching it.
  const GRIDCRAFT_BOOK = /^[^\\/:\0]{1,251}\.(xlsx|xlsm|xls|csv|ods)$/i;
  const gridcraftBookName = v => typeof v === 'string' && v.trim() && GRIDCRAFT_BOOK.test(v) && !v.includes('..') ? v : '';
  async function apiGridcraftWorkbooks(req, res) {
    try {
      const r = await bridgeFetch('/workbooks', { cache: 'no-store' }, 15000);
      const data = await bridgeJson(r, { ok: false, error: `Bridge returned HTTP ${r.status}` });
      if (!r.ok || data.ok !== true) return json(res, r.ok ? 502 : r.status, { ok: false, error: data.error || 'GridCraft did not list the workbooks' });
      const items = (Array.isArray(data.items) ? data.items : []).filter(x => gridcraftBookName(x?.name))
        .map(x => ({ name: x.name, size: Number(x.size) || 0, modified: String(x.modified || '') }));
      json(res, 200, { ok: true, items });
    } catch (e) {
      bridgeFailure(res, e);
    }
  }
  // What the running request is doing (the bridge reads it from the agent's log as it goes), for the page to show
  // while it waits: each step as {tool, text, failed}, in the owner's words. Only those fields are passed on.
  async function apiGridcraftProgress(req, res) {
    try {
      const r = await bridgeFetch('/progress', { cache: 'no-store' }, 4000);
      const data = await bridgeJson(r, {});
      if (!r.ok || data.ok !== true) return json(res, r.ok ? 502 : r.status, { ok: false, error: data.error || 'GridCraft did not say what it is doing' });
      const steps = (Array.isArray(data.steps) ? data.steps : []).slice(-40)
        .map(x => ({ tool: String(x?.tool || '').slice(0, 60), text: String(x?.text || '').slice(0, 160), ...(x?.failed ? { failed: true } : {}) }));
      json(res, 200, { ok: true, running: data.running === true, turn: Number(data.turn) || 0, steps });
    } catch (e) {
      bridgeFailure(res, e);
    }
  }
  async function apiGridcraftOpen(req, res) {
    if (!sameOriginJson(req, res)) return;
    let b;
    try { b = await readBody(req, 4096); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    const name = gridcraftBookName(b?.name);
    if (!name) return json(res, 400, { ok: false, error: 'Choose a .xlsx, .xlsm, .xls, .csv or .ods file from the GridCraft folder' });
    // Opening replaces the workbook, so a request waiting for review would lose its Keep and Discard.
    if (gridcraftRuns(GRIDCRAFT_KEEP_RUNS).some(x => x.status === 'review')) return json(res, 409, { ok: false, error: 'A request is waiting for review. Keep or discard its changes first, then open another workbook.' });
    try {
      const r = await bridgeFetch('/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }, 65000);
      const data = await bridgeJson(r, { ok: false, error: `Bridge returned HTTP ${r.status}` });
      if (!r.ok || data.ok !== true) return json(res, r.ok ? 502 : r.status, { ok: false, error: data.error || 'GridCraft did not open it' });
      recordActivity('gridcraft', 'GridCraft workbook opened', name);
      json(res, 200, { ok: true, file: name });
    } catch (e) {
      bridgeFailure(res, e);
    }
  }
  // A cell the owner changes by hand in the grid. It goes through the same safety as a Review request: the bridge's
  // set_cell op journals it (before -> after, undo steps) and never saves, and it becomes a "Direct edit" run that waits
  // for Keep or Discard. Edits made one after another join the newest Direct edit run while it waits for review, but only
  // when GridCraft's undo list shows nothing happened in between, so Discard still undoes exactly those steps.
  const GRIDCRAFT_CELL = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/;
  const GRIDCRAFT_SHEET_MAX = 100, GRIDCRAFT_INPUT_MAX = 8192;
  let gridcraftCellBusy = false;
  const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && b.length > 0 && b.every((x, i) => a[i] === x);
  function mergeCellEdits(edits, more) {
    const out = edits.map(e => ({ ...e }));
    for (const e of more) {
      // The same cell twice: keep the first before and the latest after, so the change reads from the original value.
      const prev = out.find(x => x.sheet === e.sheet && x.range === e.range && x.tool === 'set_cell' && x.before && e.after);
      if (prev) Object.assign(prev, { after: e.after, afterValues: e.afterValues });
      else out.push(e);
    }
    return out;
  }
  async function apiGridcraftCell(req, res) {
    if (!sameOriginJson(req, res)) return;
    let b;
    try { b = await readBody(req, 64 * 1024); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    const sheet = b?.sheet, cell = b?.cell, input = b?.input;
    if (typeof sheet !== 'string' || !sheet.trim() || sheet.length > GRIDCRAFT_SHEET_MAX || [...sheet].some(c => c.charCodeAt(0) < 32)) return json(res, 400, { ok: false, error: `sheet must be a sheet name of 1 to ${GRIDCRAFT_SHEET_MAX} characters` });
    if (typeof cell !== 'string' || !GRIDCRAFT_CELL.test(cell)) return json(res, 400, { ok: false, error: 'cell must look like B7' });
    if (typeof input !== 'string' || input.length > GRIDCRAFT_INPUT_MAX) return json(res, 400, { ok: false, error: `input must be text of at most ${GRIDCRAFT_INPUT_MAX} characters` });
    if (gridcraftCellBusy) return json(res, 409, { ok: false, error: 'Another cell change is still being made. Try again in a moment.' });
    gridcraftCellBusy = true;
    try {
      const started = Date.now();
      let r, data;
      try {
        r = await bridgeFetch('/cell', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sheet, cell, input }) }, 65000);
        data = await bridgeJson(r, { ok: false, error: `Bridge returned HTTP ${r.status}` });
      } catch (e) { return bridgeFailure(res, e); }
      if (!r.ok || data.ok !== true) return json(res, r.ok ? 502 : r.status, { ok: false, error: data.error || 'GridCraft did not change the cell' });
      const journal = data.journal && typeof data.journal === 'object' ? data.journal : {};
      const edits = Array.isArray(journal.edits) ? journal.edits : [], changes = Array.isArray(journal.changes) ? journal.changes : [];
      const steps = Number(journal.undoSteps) || 0, undoTop = Array.isArray(journal.undoTop) ? journal.undoTop : [];
      const now = new Date().toISOString(), where = `${sheet}!${cell}`;
      const last = gridcraftRuns(1)[0];
      const join = last?.kind === 'edit' && last.status === 'review' && sameList(data.undoBefore, last.undoTop);
      let run;
      if (join) {
        const cells = [...new Set([...(last.cells || []), where])];
        run = {
          ...last, cells, edits: mergeCellEdits(last.edits || [], edits), changes: [...(last.changes || []), ...changes],
          undoSteps: (Number(last.undoSteps) || 0) + steps, undoTop, prompt: gridcraftEditTitle(cells), answer: gridcraftEditAnswer(cells), updatedAt: now
        };
      } else {
        run = {
          id: makeId('gc'), kind: 'edit', cells: [where], prompt: gridcraftEditTitle([where]), mode: 'review', status: steps > 0 ? 'review' : 'done',
          answer: gridcraftEditAnswer([where]), error: '', edits, changes, undoSteps: steps, undoTop, saved: false,
          durationSec: Math.round((Date.now() - started) / 10) / 100, createdAt: now, updatedAt: now
        };
      }
      saveGridcraftRun(run);
      storage.pruneSettings(GRIDCRAFT_RUN_PREFIX, GRIDCRAFT_KEEP_RUNS);
      recordActivity('gridcraft', 'GridCraft cell changed by hand', where.slice(0, 180));
      json(res, 200, { ok: true, run });
    } finally { gridcraftCellBusy = false; }
  }
  function gridcraftEditTitle(cells) {
    const shown = cells.slice(-4).join(', ');
    return `Direct edit: ${cells.length > 4 ? `${cells.length} cells, last ${shown}` : shown}`.slice(0, 2000);
  }
  const gridcraftEditAnswer = cells => cells.length === 1 ? `You changed ${cells[0]} by hand.` : `You changed ${cells.length} cells by hand.`;
  async function apiGridcraftDecide(req, res, id, action) {
    if (!sameOriginJson(req, res)) return;
    const run = storage.readSetting(GRIDCRAFT_RUN_PREFIX + id, null);
    if (!run) return json(res, 404, { ok: false, error: 'No such request' });
    if (run.status !== 'review') return json(res, 409, { ok: false, error: 'This request is not waiting for review' });
    // GridCraft's undo is one line: only the newest request's changes are on top of it.
    if (action === 'discard' && gridcraftRuns(1)[0]?.id !== id) return json(res, 409, { ok: false, error: 'Only the latest request can be undone' });
    let r = { ok: true }, data = { ok: true };
    try {
      if (action === 'keep' || run.undoSteps > 0) {
        r = await bridgeFetch(`/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action === 'discard' ? { steps: run.undoSteps, undoTop: run.undoTop } : {}) }, 65000);
        data = await bridgeJson(r, { ok: false, error: `Bridge returned HTTP ${r.status}` });
      }
    } catch (e) { return bridgeFailure(res, e); }
    if (!r.ok || data.ok !== true) return json(res, r.ok ? 502 : r.status, { ok: false, error: data.error || 'GridCraft did not do it' });
    const now = new Date().toISOString();
    // Saving saves every change in the workbook, so every request waiting for review is kept.
    const decided = action === 'keep' ? gridcraftRuns(GRIDCRAFT_KEEP_RUNS).filter(x => x.status === 'review') : [run];
    for (const x of decided) saveGridcraftRun({ ...x, status: action === 'keep' ? 'kept' : 'discarded', updatedAt: now });
    recordActivity('gridcraft', action === 'keep' ? 'GridCraft changes kept' : 'GridCraft changes discarded', run.prompt.slice(0, 180));
    json(res, 200, { ok: true, dirty: data.dirty, runs: decided.map(x => x.id) });
  }
  // Services › ArtCraft: the GridCraft bridge reports whether ArtCraft is installed and open on the Windows computer, and
  // opens it (its fixed exe, no arguments). The page never talks to ArtCraft itself.
  async function apiArtcraftStatus(req, res) {
    try {
      const r = await bridgeFetch('/artcraft', { cache: 'no-store' }, 20000);
      const d = await bridgeJson(r, {});
      if (!r.ok || !d.ok) return json(res, 502, { ok: false, error: String(d.error || `Bridge returned HTTP ${r.status}`).slice(0, 300) });
      json(res, 200, { ok: true, installed: d.installed === true, running: d.running === true, version: typeof d.version === 'string' ? d.version.slice(0, 40) : null });
    } catch (e) {
      bridgeFailure(res, e, 'The Windows computer', 'Windows computer bridge unavailable');
    }
  }
  async function apiArtcraftOpen(req, res) {
    if (!sameOriginJson(req, res)) return;
    req.resume(); // nothing from the body is used
    try {
      const r = await bridgeFetch('/artcraft/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 20000);
      const d = await bridgeJson(r, {});
      if (!r.ok || !d.ok) return json(res, r.ok ? 502 : r.status, { ok: false, error: String(d.error || `Bridge returned HTTP ${r.status}`).slice(0, 300) });
      recordActivity('artcraft', 'ArtCraft opened', d.alreadyRunning ? 'It was already open' : 'Opened on the Windows computer');
      json(res, 200, { ok: true, alreadyRunning: d.alreadyRunning === true });
    } catch (e) {
      bridgeFailure(res, e, 'The Windows computer', 'Windows computer bridge unavailable');
    }
  }
  // Services › Workshop display: is the touchscreen beside the printer answering, is its sign-in on, where its own portal
  // is, and (with the read-only token) what the printer is doing. Read-only; the portal itself is never proxied
  // (app/workshop.js, docs/WORKSHOP-DISPLAY.md). ?part=printer (Home) answers from the poller's last read only, so it
  // never sends the display a request. printer is null when no token is set.
  async function apiWorkshopStatus(req, res, urlObj) {
    const printer = workshopPrinter.current();
    if (urlObj.searchParams.get('part') === 'printer') return json(res, 200, { printer });
    const status = await workshop.workshopStatus();
    if (printer?.access === 'ok') status.signIn = true; // the token only exists on firmware that has the sign-in
    // codeAccess: whether the card offers Show sign-in code (LOCALAI_WORKSHOP_CODE_TOKEN set); never the token itself.
    json(res, 200, { ...status, printer, codeAccess: Boolean(status.portalUrl && workshop.codeToken()) });
  }
  // Services › Workshop display › Show sign-in code: reads the display's current portal sign-in code with the code token,
  // on demand, and hands it to this one answer only. POST (with the same-origin and JSON checks every mutating route has),
  // so a prefetch, a link or another site can't fetch it, and no-store so no cache keeps it. Local AI has no sign-in of
  // its own, so whoever can use Local AI can read the code: the owner's accepted trade-off (docs/SECURITY.md). The audit
  // entry says a code was shown, never which one; nothing else is logged or stored.
  async function apiWorkshopPortalCode(req, res) {
    if (!sameOriginJson(req, res)) return;
    try { await readBody(req, 1024); } catch { /* the body carries nothing; an oversized one is just ignored */ }
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    const address = workshop.portalUrl();
    const r = await workshop.readPortalCode({ url: address });
    if (r.access !== 'ok') return send(r.access === 'not_set_up' ? 409 : r.access === 'busy' ? 503 : r.access === 'offline' ? 504 : 502, { reason: r.access, error: workshop.CODE_WORDS[r.access] });
    recordActivity('workshop', 'Workshop sign-in code shown', 'Services › Workshop display');
    send(200, { code: r.code, address });
  }
  return { apiArtcraftOpen, apiArtcraftStatus, apiGridcraftCell, apiGridcraftDecide, apiGridcraftHealth, apiGridcraftOpen, apiGridcraftProgress, apiGridcraftRun, apiGridcraftRuns, apiGridcraftWorkbook, apiGridcraftWorkbooks, apiWorkshopPortalCode, apiWorkshopStatus };
}

module.exports = { createGridcraft };
