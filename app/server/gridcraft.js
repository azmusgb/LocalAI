'use strict';

// GridCraft (the Windows spreadsheet app, through the host bridge on :8787), ArtCraft and the Workshop display.
// Moved from server.js unchanged (the server split: docs/superpowers/specs/2026-10-18-server-split-design.md). ctx holds
// what this code uses from the rest of the server.
function createGridcraft(ctx) {
  const { GRIDCRAFT_RUN_TIMEOUT_MS, GRIDCRAFT_URL, inFlight, json, makeId, modelFetchWithTimeout, readBody, recordActivity, sameOriginJson, storage, workshop, workshopCode, workshopPrinter } = ctx;
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
  // For Agent World (GET /api/world, app/world.js caches it 15 s): bridge is whether the host bridge answered ok, excel
  // whether GridCraft (Excel) is open there, null when the bridge didn't say. Never throws; nothing else is passed on.
  async function bridgeHealth() {
    try {
      const r = await bridgeFetch('/health', { cache: 'no-store' }, 4000);
      const data = await bridgeJson(r, {});
      const ok = r.ok && data?.ok === true;
      return { bridge: ok, excel: ok ? data.gridcraftConnected === true : null };
    } catch {
      return { bridge: false, excel: null };
    }
  }
  // For the contract reads (app/server/contract.js): the bridge's health and ArtCraft's status, each throwing with the
  // reason when the bridge did not answer, answered an error or sent something unreadable, so the caller can tell a failed
  // read from a bridge that answered "not connected". Same calls and fields as the two routes above, shorter deadlines.
  const bridgeReadError = (e, who) => bridgeTimedOut(e) ? new Error(`${who} took too long to answer`) : new Error(`${who} unavailable${e?.cause?.code ? ` (${e.cause.code})` : ''}`);
  async function bridgeRead(pathname, who, timeoutMs) {
    let r, data;
    try { r = await bridgeFetch(pathname, { cache: 'no-store' }, timeoutMs); data = await bridgeJson(r, null); } catch (e) { throw bridgeReadError(e, who); }
    if (!r.ok) throw new Error(`${who} answered HTTP ${r.status}`);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${who} answered with something unreadable`);
    return data;
  }
  async function gridcraftHealthRead(timeoutMs = 4000) {
    const data = await bridgeRead('/health', 'GridCraft bridge', timeoutMs);
    return { ok: data.ok === true, gridcraftConnected: data.gridcraftConnected === true, ...(data.model ? { model: String(data.model) } : {}) };
  }
  async function artcraftStatusRead(timeoutMs = 5000) {
    const d = await bridgeRead('/artcraft', 'Windows computer bridge', timeoutMs);
    if (!d.ok) throw new Error(String(d.error || 'The bridge did not report ArtCraft').slice(0, 300));
    return { ok: true, installed: d.installed === true, running: d.running === true, version: typeof d.version === 'string' ? d.version.slice(0, 40) : null };
  }
  // A request's record: what was asked, in which mode, and what it changed (the agent's journal), so the page can show the
  // changes and the owner can keep or discard a Review request later, also from another device.
  const GRIDCRAFT_RUN_PREFIX = 'gridcraft:run:';
  const GRIDCRAFT_MODES = new Set(['read', 'review', 'apply']);
  const GRIDCRAFT_KEEP_RUNS = 50;
  function gridcraftRunStatus(ok, mode, journal) {
    const changed = !!journal && ((journal.edits || []).length > 0 || (journal.changes || []).length > 0 || journal.undoSteps > 0 || journal.uncertain === true);
    if (mode === 'review' && changed) return 'review'; // also after a failure: whatever it changed can still be discarded
    // Apply saves when it finishes; changes it left unsaved (it failed or was stopped, or the save failed) wait for
    // Keep or Discard like a Review request's, instead of sitting in GridCraft for a later Keep or Open to sweep up.
    if (mode === 'apply' && changed && journal.saved !== true) return 'review';
    if (!ok) return 'failed';
    return mode === 'apply' && changed ? 'applied' : 'done';
  }
  function gridcraftRuns(limit = 30) { return storage.listSettings(GRIDCRAFT_RUN_PREFIX, { limit }); }
  function saveGridcraftRun(run) { storage.writeSetting(GRIDCRAFT_RUN_PREFIX + run.id, run); }
  // A request is recorded when it starts, so one cut short by a LocalAI restart still shows; at start-up any record
  // still running is one of those. Its changes, if any, are in GridCraft without a journal, so it can't be discarded.
  const GRIDCRAFT_LOST = 'LocalAI restarted while this request ran, so what it changed is unknown. Look at the workbook before you keep anything.';
  try {
    for (const run of storage.listSettings(GRIDCRAFT_RUN_PREFIX, { where: { status: 'running' } })) saveGridcraftRun({ ...run, status: 'failed', error: GRIDCRAFT_LOST, updatedAt: new Date().toISOString() });
  } catch { /* read-only storage: nothing to tidy */ }
  async function apiGridcraftRun(req, res) {
    // Same rules the bridge applies to browsers: same-origin only, JSON only.
    if (!sameOriginJson(req, res)) return;
    let b;
    try { b = await readBody(req, 64 * 1024); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    const prompt = String(b.prompt || ''), mode = b.mode === undefined ? 'review' : String(b.mode);
    if (!GRIDCRAFT_MODES.has(mode)) return json(res, 400, { ok: false, error: 'mode must be read, review or apply' });
    const untrack = inFlight.track('gridcraft', 'GridCraft: ' + prompt);
    const started = new Date().toISOString();
    const pending = { id: makeId('gc'), prompt: prompt.slice(0, 2000), mode, status: 'running', answer: '', error: '', edits: [], changes: [], undoSteps: 0, undoTop: [], saved: false, createdAt: started, updatedAt: started };
    saveGridcraftRun(pending);
    let recorded = false;
    try {
      const r = await bridgeFetch('/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, mode }) }, GRIDCRAFT_RUN_TIMEOUT_MS);
      const data = await bridgeJson(r, { ok: false, error: `Bridge returned HTTP ${r.status}` });
      const ok = r.ok && data.ok === true, journal = data.journal && typeof data.journal === 'object' ? data.journal : null;
      // A request the bridge refused before running (busy, bad prompt) changed nothing and isn't worth a record.
      if (!ok && !journal && r.status !== 500 && r.status !== 504) {
        storage.deleteSetting(GRIDCRAFT_RUN_PREFIX + pending.id); recorded = true;
        return json(res, r.status, { ok: false, error: data.error, reason: data.reason });
      }
      const run = {
        ...pending, status: gridcraftRunStatus(ok, mode, journal),
        answer: ok ? String(data.answer || '') : '', error: ok ? '' : [data.error, data.reason].filter(Boolean).join(': '),
        edits: journal?.edits || [], changes: journal?.changes || [], undoSteps: Number(journal?.undoSteps) || 0,
        undoTop: Array.isArray(journal?.undoTop) ? journal.undoTop : [], saved: journal?.saved === true,
        ...(typeof journal?.fingerprint === 'string' ? { fingerprint: journal.fingerprint } : {}),
        ...(journal?.uncertain === true ? { uncertain: true } : {}),
        durationSec: data.durationSec, updatedAt: new Date().toISOString()
      };
      saveGridcraftRun(run); recorded = true;
      storage.pruneSettings(GRIDCRAFT_RUN_PREFIX, GRIDCRAFT_KEEP_RUNS);
      if (ok) recordActivity('gridcraft', 'GridCraft request', prompt.slice(0, 180), { durationSec: data.durationSec, mode });
      json(res, r.status, { ok, answer: run.answer, ...(ok ? {} : { error: data.error, reason: data.reason }), durationSec: data.durationSec, run });
    } catch (e) {
      // The bridge wasn't there at all: the request never ran, so it leaves no record.
      if (e?.code === 'MODEL_UNREACHABLE') { storage.deleteSetting(GRIDCRAFT_RUN_PREFIX + pending.id); recorded = true; }
      bridgeFailure(res, e);
    } finally {
      // The bridge never answered (time-out, connection lost): the request may still have changed the workbook.
      if (!recorded) saveGridcraftRun({ ...pending, status: 'failed', error: 'GridCraft did not answer, so what this request changed is unknown. Look at the workbook before you keep anything.', updatedAt: new Date().toISOString() });
      untrack();
    }
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
  const gridcraftBookName = v => typeof v === 'string' && v.trim() && GRIDCRAFT_BOOK.test(v) && !v.includes('..') && !v.startsWith('~$') && ![...v].some(c => c.charCodeAt(0) < 32) ? v : '';
  const gridcraftXlsxName = v => { const n = gridcraftBookName(v); return n && /\.xlsx$/i.test(n) && n.trim().length > 5 ? n : ''; };
  const GRIDCRAFT_MAX_UPLOAD = 10 * 1024 * 1024;
  const GRIDCRAFT_MIME = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
    xls: 'application/vnd.ms-excel',
    csv: 'text/csv; charset=utf-8',
    ods: 'application/vnd.oasis.opendocument.spreadsheet'
  };
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
  async function apiGridcraftNew(req, res) {
    if (!sameOriginJson(req, res)) return;
    let b;
    try { b = await readBody(req, 4096); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    const raw = typeof b?.name === 'string' ? b.name.trim() : '';
    const candidate = raw && !/\.[a-z0-9]+$/i.test(raw) ? `${raw}.xlsx` : raw;
    const name = gridcraftXlsxName(candidate);
    if (!name) return json(res, 400, { ok: false, error: 'Enter a .xlsx file name like Budget-2027.xlsx' });
    if (gridcraftRuns(GRIDCRAFT_KEEP_RUNS).some(x => x.status === 'review')) return json(res, 409, { ok: false, error: 'A request is waiting for review. Keep or discard its changes first, then start a new workbook.' });
    try {
      const r = await bridgeFetch('/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }, 65000);
      const data = await bridgeJson(r, { ok: false, error: `Bridge returned HTTP ${r.status}` });
      if (!r.ok || data.ok !== true) return json(res, r.ok ? 502 : r.status, { ok: false, error: data.error || 'GridCraft did not create the workbook' });
      recordActivity('gridcraft', 'GridCraft workbook created', name);
      json(res, 200, { ok: true, file: name });
    } catch (e) {
      bridgeFailure(res, e);
    }
  }
  async function apiGridcraftUpload(req, res) {
    if (!sameOriginJson(req, res)) return;
    let b;
    try { b = await readBody(req, 15 * 1024 * 1024); } catch (e) { return json(res, /too large/i.test(e.message) ? 413 : 400, { ok: false, error: /too large/i.test(e.message) ? 'Workbook files can be at most 10 MB' : e.message }); }
    const name = gridcraftXlsxName(b?.name);
    if (!name) return json(res, 400, { ok: false, error: 'Choose a .xlsx workbook file to upload' });
    const raw = typeof b?.data === 'string' ? b.data.trim() : '';
    if (!raw || !/^[A-Za-z0-9+/=\s]+$/.test(raw)) return json(res, 400, { ok: false, error: 'Choose a .xlsx workbook file to upload' });
    const buf = Buffer.from(raw, 'base64');
    if (buf.length > GRIDCRAFT_MAX_UPLOAD) return json(res, 413, { ok: false, error: 'Workbook files can be at most 10 MB' });
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) return json(res, 400, { ok: false, error: 'Only .xlsx workbook files can be uploaded' });
    if (gridcraftRuns(GRIDCRAFT_KEEP_RUNS).some(x => x.status === 'review')) return json(res, 409, { ok: false, error: 'A request is waiting for review. Keep or discard its changes first, then upload a workbook.' });
    try {
      const r = await bridgeFetch('/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, data: buf.toString('base64') }) }, 65000);
      const data = await bridgeJson(r, { ok: false, error: `Bridge returned HTTP ${r.status}` });
      if (!r.ok || data.ok !== true) return json(res, r.ok ? 502 : r.status, { ok: false, error: data.error || 'GridCraft did not open the uploaded workbook' });
      recordActivity('gridcraft', 'GridCraft workbook uploaded', name);
      json(res, 200, { ok: true, file: name, size: buf.length });
    } catch (e) {
      bridgeFailure(res, e);
    }
  }
  async function apiGridcraftDownload(req, res, urlObj) {
    const wanted = urlObj.searchParams.get('name');
    if (wanted !== null && !gridcraftBookName(wanted)) return json(res, 400, { ok: false, error: 'Choose a workbook file from the GridCraft folder' });
    const q = wanted ? `?name=${encodeURIComponent(wanted)}` : '';
    try {
      const r = await bridgeFetch(`/download${q}`, { cache: 'no-store' }, 65000);
      const data = await bridgeJson(r, { ok: false, error: `Bridge returned HTTP ${r.status}` });
      if (!r.ok || data.ok !== true) return json(res, r.ok ? 502 : r.status, { ok: false, error: data.error || 'GridCraft did not send the workbook' });
      const file = gridcraftBookName(data.file || wanted || '');
      if (!file || typeof data.data !== 'string') return json(res, 502, { ok: false, error: 'GridCraft did not send a valid workbook file' });
      const buf = Buffer.from(data.data, 'base64');
      const ext = file.split('.').pop().toLowerCase();
      res.writeHead(200, {
        'Content-Type': GRIDCRAFT_MIME[ext] || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${file.replace(/["\\]/g, '_')}"`,
        'Content-Length': String(buf.length),
        'Cache-Control': 'no-store'
      });
      res.end(buf);
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
      // The undo labels are generic, so a cell typed in GridCraft between the two edits can leave them as they were:
      // the fingerprint of every cell before this edit must also be the one the last edit left.
      const samePrint = !last?.fingerprint || !data.fingerprintBefore || data.fingerprintBefore === last.fingerprint;
      const join = last?.kind === 'edit' && last.status === 'review' && sameList(data.undoBefore, last.undoTop) && samePrint;
      const prints = typeof journal.fingerprint === 'string' ? { fingerprint: journal.fingerprint } : {};
      let run;
      if (join) {
        const cells = [...new Set([...(last.cells || []), where])];
        run = {
          ...last, cells, edits: mergeCellEdits(last.edits || [], edits), changes: [...(last.changes || []), ...changes],
          undoSteps: (Number(last.undoSteps) || 0) + steps, undoTop, ...prints, prompt: gridcraftEditTitle(cells), answer: gridcraftEditAnswer(cells), updatedAt: now
        };
        if (!prints.fingerprint) delete run.fingerprint;
      } else {
        run = {
          id: makeId('gc'), kind: 'edit', cells: [where], prompt: gridcraftEditTitle([where]), mode: 'review', status: steps > 0 ? 'review' : 'done',
          answer: gridcraftEditAnswer([where]), error: '', edits, changes, undoSteps: steps, undoTop, ...prints, saved: false,
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
    if (action === 'discard' && run.uncertain) return json(res, 409, { ok: false, error: 'This request was stopped in the middle of a change, so Discard can\'t tell exactly what to undo. Keep saves it as it is; to throw it away, close the workbook in GridCraft without saving.' });
    let r = { ok: true }, data = { ok: true };
    try {
      if (action === 'keep' || run.undoSteps > 0) {
        r = await bridgeFetch(`/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action === 'discard' ? { steps: run.undoSteps, undoTop: run.undoTop, ...(run.fingerprint ? { fingerprint: run.fingerprint } : {}) } : {}) }, 65000);
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
  async function workshopStatusRead() {
    const printer = workshopPrinter.current();
    const status = await workshop.workshopStatus();
    if (printer?.access === 'ok') status.signIn = true; // the token only exists on firmware that has the sign-in
    const cam = await workshop.cameraStatus();
    // codeAccess: whether the card offers Show sign-in code (LOCALAI_WORKSHOP_CODE_TOKEN set); never the token itself.
    return {
      ...status,
      printer,
      codeAccess: Boolean(status.portalUrl && workshop.codeToken()),
      camera: { available: cam.available, reason: cam.reason, endpoint: '/api/workshop/camera' }
    };
  }
  async function apiWorkshopStatus(req, res, urlObj) {
    if (urlObj.searchParams.get('part') === 'printer') return json(res, 200, { printer: workshopPrinter.current() });
    json(res, 200, await workshopStatusRead());
  }

  // Services › Workshop display › Camera: stream live JPEG frames from the Pi / Mac chamber camera bridge
  async function apiWorkshopCamera(req, res) {
    const frame = await workshop.fetchCameraFrame();
    if (!frame.ok) {
      res.writeHead(503, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Retry-After': '5'
      });
      return res.end(JSON.stringify({ error: 'Chamber camera frame unavailable' }));
    }
    res.writeHead(200, {
      'Content-Type': frame.contentType || 'image/jpeg',
      'Content-Length': String(frame.buffer.length),
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'X-Camera-Source': frame.source
    });
    res.end(frame.buffer);
  }
  // Services › Workshop display › Show sign-in code: reads the display's current portal sign-in code with the code token,
  // on demand (through workshopCode: one request at a time, at most one every 5 s, none for minutes after a 401 or 429),
  // and hands it to the answer only. POST (with the same-origin and JSON checks every mutating route has),
  // so a prefetch, a link or another site can't fetch it, and no-store so no cache keeps it. Local AI has no sign-in of
  // its own, so whoever can use Local AI can read the code: the owner's accepted trade-off (docs/SECURITY.md). The audit
  // entry says a code was shown, never which one; nothing else is logged or stored.
  async function apiWorkshopPortalCode(req, res) {
    if (!sameOriginJson(req, res)) return;
    try { await readBody(req, 1024); } catch { /* the body carries nothing; an oversized one is just ignored */ }
    const send = (status, value, extra = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(value)); };
    const address = workshop.portalUrl();
    const r = await workshopCode({ url: address });
    if (r.access !== 'ok') return send(r.access === 'not_set_up' ? 409 : r.access === 'busy' ? 503 : r.access === 'offline' ? 504 : 502, { reason: r.access, error: workshop.CODE_WORDS[r.access] }, r.retryAfterMs ? { 'Retry-After': String(Math.ceil(r.retryAfterMs / 1000)) } : {});
    recordActivity('workshop', 'Workshop sign-in code shown', 'Services › Workshop display');
    send(200, { code: r.code, address });
  }
  return { artcraftStatusRead, bridgeHealth, gridcraftHealthRead, gridcraftRuns, workshopStatusRead, apiArtcraftOpen, apiArtcraftStatus, apiGridcraftCell, apiGridcraftDecide, apiGridcraftDownload, apiGridcraftHealth, apiGridcraftNew, apiGridcraftOpen, apiGridcraftProgress, apiGridcraftRun, apiGridcraftRuns, apiGridcraftUpload, apiGridcraftWorkbook, apiGridcraftWorkbooks, apiWorkshopCamera, apiWorkshopPortalCode, apiWorkshopStatus };
}

module.exports = { createGridcraft };
