'use strict';

// Activity and Library: the activity log, Library items, ☆ Keep, long answers kept whole, and which failed runs the
// owner has seen. Moved from server.js unchanged (the server split: docs/superpowers/specs/2026-10-18-server-split-design.md).
// ctx holds what this code uses from the rest of the server.
const { titleFromText } = require('../prompt-title');
function createLibrary(ctx) {
  const { ACTIVITY_STORE, LIBRARY_STORE, cleanRunId, imageEngines, json, libraryThreads, nowIso, prependRecord, readBody, readState, runLedger, storage, storageError, writeState } = ctx;
  function activityStore() {
    const value = readState(ACTIVITY_STORE, []);
    return Array.isArray(value) ? value : [];
  }

  function recordActivity(type, title, detail = '', meta = {}) {
    const item = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      type,
      title,
      detail,
      at: new Date().toISOString(),
      meta
    };
    prependRecord(ACTIVITY_STORE, item);
    return item;
  }

  function libraryStore() {
    const value = readState(LIBRARY_STORE, []);
    return Array.isArray(value) ? value : [];
  }

  function recordArtifact(kind, title, summary = '', meta = {}, data = {}) {
    const item = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 9)}`,
      kind: String(kind || 'artifact'),
      title: titleFromText(title, 'Untitled artifact'),
      summary: String(summary || '').slice(0, 1200),
      createdAt: new Date().toISOString(),
      pinned: false,
      meta: meta && typeof meta === 'object' ? meta : {},
      data: data && typeof data === 'object' ? data : {}
    };
    prependRecord(LIBRARY_STORE, item);
    return item;
  }

  // A chat or research turn reaches Library only once its conversation is kept (☆ Keep; owner decision, 18 Oct). A
  // later turn of a kept conversation updates its item in place (title stays the first message; summary becomes the
  // latest answer). Any other turn stays in Work only, and this returns null.
  function recordTurnArtifact(summary, meta, data, execution) {
    const threadId = execution?.threadId || '', runId = execution?.id || '';
    if (!threadId) return null;
    const next = libraryThreads.continueThread(libraryStore(), { threadId, runId, summary, meta, data, now: new Date().toISOString() });
    return next ? storage.upsert(LIBRARY_STORE, next) : null;
  }

  // An answer too long for the run ledger (its output is cut to a preview) is kept whole under answer/<runId>, so the run
  // view shows it whether or not its conversation is in Library. Only the newest MAX_LONG_ANSWERS are kept.
  const ANSWER_PREFIX = 'answer/', MAX_LONG_ANSWERS = 500;
  function keepLongAnswer(runId, text) {
    if (!runId || typeof text !== 'string' || !runLedger.get(runId)?.output?.truncated) return false;
    if (typeof storage.readSetting(ANSWER_PREFIX + runId, null)?.text === 'string') return true;
    storage.writeSetting(ANSWER_PREFIX + runId, { runId, text });
    storage.pruneSettings(ANSWER_PREFIX, MAX_LONG_ANSWERS);
    return true;
  }
  // A Library item leaving Library (un-keep, delete, the one-time repair) leaves its long answers with their runs.
  function keepItemAnswers(item) {
    for (const runId of libraryThreads.runIdsOf(item)) {
      const text = item?.data?.turns?.[runId] ?? (item?.meta?.runId === runId ? item?.data?.response : undefined);
      keepLongAnswer(runId, text);
    }
  }
  function fullAnswer(runId, items = null) {
    const saved = storage.readSetting(ANSWER_PREFIX + runId, null);
    if (typeof saved?.text === 'string') return saved.text;
    for (const it of items || libraryStore()) {
      const t = it?.data?.turns?.[runId] ?? (it?.meta?.runId === runId ? it?.data?.response : undefined);
      if (typeof t === 'string') return t;
    }
    return null;
  }

  // Keep (☆) a chat or research run: its whole conversation becomes one Library item (or the item it already has is
  // marked kept). Un-keep takes the conversation out of Library; its runs stay in Work. Returns {kept, item} or {error}.
  const KEEPABLE = new Set(['chat', 'research']);
  function libraryItemsOfRun(run, items) {
    return items.filter(it => libraryThreads.isThreadItem(it) && ((run.threadId && it.meta?.threadId === run.threadId) || libraryThreads.runIdsOf(it).includes(run.id)));
  }
  // Best's quick preview stays out of Library until it is kept: Keep adds its picture, un-keep removes it again.
  function setPreviewKept(run, kept) {
    const items = libraryStore(), mine = it => it?.kind === 'image' && it.meta?.runId === run.id;
    const found = items.filter(mine);
    if (!kept) {
      if (found.length) writeState(LIBRARY_STORE, items.filter(it => !mine(it)), items);
      return { kept: false, item: null };
    }
    if (found.length) return { kept: true, item: found[0] };
    const o = run.output || {}, prompt = run.input?.prompt || run.title || '';
    const style = imageEngines.STYLES[o.style] && o.style !== 'none' ? ` · ${imageEngines.STYLES[o.style].label}` : '';
    let item = null;
    for (const im of [...(o.images || [])].reverse()) {
      item = recordArtifact('image', prompt, `${o.width} × ${o.height} · ${o.engineLabel || 'Best'} preview${style}`,
        { engine: o.engine, engineLabel: o.engineLabel, family: o.family, style: o.style, width: o.width, height: o.height, steps: o.steps, cfg: o.cfg, preview: true, imageUrl: im.imageUrl, seed: im.seed, runId: run.id },
        { prompt, imageUrl: im.imageUrl });
    }
    return item ? { kept: true, item } : { status: 409, error: 'This preview has no picture to keep' };
  }
  function setRunKept(runId, kept) {
    const run = runLedger.get(runId);
    if (!run) return { status: 404, error: 'Run not found' };
    if (run.type === 'image' && run.meta?.preview === true) return setPreviewKept(run, kept);
    if (!KEEPABLE.has(run.type)) return { status: 409, error: 'Only chats, research and image previews are kept this way' };
    const items = libraryStore(), found = libraryItemsOfRun(run, items);
    if (!kept) {
      if (!found.length) return { kept: false, item: null };
      for (const it of found) keepItemAnswers(it);
      const drop = new Set(found.map(it => it.id));
      writeState(LIBRARY_STORE, items.filter(it => !drop.has(it?.id)), items);
      return { kept: false, item: null };
    }
    if (found.length) return { kept: true, item: found[0].kept ? found[0] : storage.upsert(LIBRARY_STORE, { ...found[0], kept: true }) };
    const runs = run.threadId ? runLedger.list({ threadId: run.threadId, limit: 500 }) : [run];
    runs.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
    const answered = runs.filter(r => r.output);
    const answerOf = r => (r?.output?.truncated ? fullAnswer(r.id, items) : r?.output?.text);
    const item = libraryThreads.itemFromRuns(answered.length ? answered : runs, { id: `${Date.now()}-${Math.random().toString(16).slice(2, 9)}`, now: nowIso(), answerOf });
    item.title = titleFromText(item.title, 'Conversation');
    prependRecord(LIBRARY_STORE, item);
    return { kept: true, item };
  }
  // Which runs are in Library: for chat and research rows, `kept` says whether ☆ Keep is on.
  function keptMarker() {
    const threads = new Set(), runs = new Set();
    for (const it of libraryStore()) {
      if (!libraryThreads.isThreadItem(it)) continue;
      if (it.meta?.threadId) threads.add(it.meta.threadId);
      for (const id of libraryThreads.runIdsOf(it)) runs.add(id);
    }
    return x => (KEEPABLE.has(x?.type) ? { ...x, kept: (!!x.threadId && threads.has(x.threadId)) || runs.has(x.id) } : x);
  }

  // Failed runs the owner has opened, on any device (id -> when), so Home's Needs you lets them go everywhere at once
  // (app/public/needs-you.js). One settings record; the newest SEEN_MAX are kept, which covers far more than a day's runs.
  const SEEN_KEY = 'needs-you/seen', SEEN_MAX = 1000;
  const seenRuns = () => { const v = storage.readSetting(SEEN_KEY, null); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
  const withSeen = seen => x => (seen[x?.id] ? { ...x, seenAt: seen[x.id] } : x);
  async function apiRunsSeen(req, res) {
    try {
      const b = await readBody(req), ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
      if (!ids.length || ids.length > 200 || ids.some(id => !(cleanRunId(id) || (/^legacy-[a-z]+:[\w.-]{1,160}$/.test(id))))) return json(res, 400, { error: 'Say which runs (1 to 200 run ids)' });
      const at = nowIso(), seen = seenRuns();
      for (const id of ids) if (!seen[id]) seen[id] = at;
      const kept = Object.entries(seen).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, SEEN_MAX);
      storage.writeSetting(SEEN_KEY, Object.fromEntries(kept));
      json(res, 200, { seen: ids.length });
    } catch (e) { storageError(res, e, 400); }
  }

  function updateArtifact(id, patch = {}) {
    const items = libraryStore();
    const index = items.findIndex(x => x && x.id === id);
    if (index < 0) return null;
    if (typeof patch.pinned === 'boolean') items[index].pinned = patch.pinned;
    if (typeof patch.title === 'string' && patch.title.trim()) items[index].title = titleFromText(patch.title);
    writeState(LIBRARY_STORE, items);
    return items[index];
  }

  function deleteArtifact(id) {
    const items = libraryStore();
    const next = items.filter(x => x && x.id !== id);
    if (next.length === items.length) return false;
    keepItemAnswers(items.find(x => x && x.id === id));   // a conversation's runs stay in Work, with their long answers
    writeState(LIBRARY_STORE, next, items);
    return true;
  }


  function migrateLegacyActivityToLibrary() {
    const items = libraryStore();
    const seen = new Set(items.map(x => x?.meta?.imageUrl).filter(Boolean));
    let changed = false;
    for (const a of activityStore()) {
      // Only v1.1 activity: an image made since has a run (a preview kept out of Library, an image deleted from it) and
      // must not come back on the next start.
      if (a?.type !== 'image' || !a?.meta?.imageUrl || a.meta.runId || a.meta.preview || seen.has(a.meta.imageUrl)) continue;
      items.push({
        id: `migrated-${a.id || Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
        kind: 'image',
        title: titleFromText(a.detail || 'Generated image'),
        summary: 'Imported from v1.1 image activity',
        createdAt: a.at || new Date().toISOString(),
        pinned: false,
        meta: { ...a.meta, migratedFromActivity: true },
        data: { prompt: a.detail || '', imageUrl: a.meta.imageUrl }
      });
      seen.add(a.meta.imageUrl);
      changed = true;
    }
    if (changed) {
      items.sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      writeState(LIBRARY_STORE, items);
    }
  }

  function sanitizeMessages(messages) {
    return (Array.isArray(messages) ? messages.slice(-16) : [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: m.content.slice(0, 26000) }));
  }

  async function apiActivity(req, res) {
    const items = activityStore();
    json(res, 200, { items: items.slice(0, 100) });
  }

  async function apiActivityClear(req, res) {
    const items = activityStore();
    const kept = items.filter(x => x && (x.type === 'system' || x.type === 'recovery'));
    writeState(ACTIVITY_STORE, kept, items);
    recordActivity('system', 'User activity cleared', 'User-generated activity was cleared; system and recovery audit events were preserved.');
    json(res, 200, { ok: true, preserved: kept.length });
  }

  async function apiLibrary(req, res) {
    const items = libraryStore();
    const counts = items.reduce((acc, item) => {
      const key = item?.kind || 'artifact';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    json(res, 200, { items: items.slice(0, 250), counts, total: items.length });
  }

  async function apiLibraryUpdate(req, res) {
    try {
      const body = await readBody(req);
      const id = String(body.id || '');
      if (!id) return json(res, 400, { error: 'id is required' });
      const item = updateArtifact(id, body);
      if (!item) return json(res, 404, { error: 'Artifact not found' });
      json(res, 200, { ok: true, item });
    } catch (e) {
      storageError(res,e,400);
    }
  }

  async function apiLibraryDelete(req, res) {
    try {
      const body = await readBody(req);
      const id = String(body.id || '');
      if (!id) return json(res, 400, { error: 'id is required' });
      const deleted = deleteArtifact(id);
      if (!deleted) return json(res, 404, { error: 'Artifact not found' });
      recordActivity('system', 'Library item removed', 'An artifact was removed from the workspace library.');
      json(res, 200, { ok: true });
    } catch (e) {
      storageError(res,e,400);
    }
  }

  // ☆ Keep / un-keep a chat or research run: {runId, kept}. Un-keep takes it out of Library only; it stays in Work.
  async function apiLibraryKeep(req, res) {
    try {
      const body = await readBody(req);
      const runId = String(body.runId || '');
      if (!cleanRunId(runId)) return json(res, 400, { error: 'runId is required' });
      if (typeof body.kept !== 'boolean') return json(res, 400, { error: 'kept must be true or false' });
      const out = setRunKept(runId, body.kept);
      if (out.error) return json(res, out.status, { error: out.error });
      json(res, 200, { ok: true, kept: out.kept, item: out.item });
    } catch (e) {
      storageError(res, e, 400);
    }
  }

  // Full answers too long for the run ledger: ?ids=run-a,run-b → {answers: {runId: text}} (a missing one is left out).
  async function apiRunAnswers(req, res, urlObj) {
    const ids = String(urlObj.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 100);
    if (!ids.length || ids.some(id => !cleanRunId(id))) return json(res, 400, { error: 'ids must be run ids' });
    const items = libraryStore(), answers = {};
    for (const id of ids) { const text = fullAnswer(id, items); if (typeof text === 'string') answers[id] = text; }
    json(res, 200, { answers });
  }

  async function apiWorkspace(req, res) {
    const activity = activityStore();
    const library = libraryStore();
    const byKind = library.reduce((acc, item) => {
      const key = item?.kind || 'artifact';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    json(res, 200, {
      activity: activity.slice(0, 8),
      recent: library.slice(0, 8),
      pinned: library.filter(x => x?.pinned).slice(0, 6),
      totals: { activity: activity.length, library: library.length, byKind }
    });
  }
  return { activityStore, apiActivity, apiActivityClear, apiLibrary, apiLibraryDelete, apiLibraryKeep, apiLibraryUpdate, apiRunAnswers, apiRunsSeen, apiWorkspace, keepItemAnswers, keepLongAnswer, keptMarker, libraryStore, migrateLegacyActivityToLibrary, recordActivity, recordArtifact, recordTurnArtifact, sanitizeMessages, seenRuns, titleFromText, withSeen };
}

module.exports = { createLibrary };
