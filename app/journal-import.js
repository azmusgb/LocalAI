'use strict';

// One-time import of past work into the journal (docs/superpowers/specs/2026-10-23-memory-core-design.md §3).
// Resumable (its progress is a setting) and idempotent (every entry has a stable ref), so a restart mid-import just
// continues. It yields between batches so the server stays responsive.

const { runEntry } = require('./journal-recorders');

const IMPORT_KEY = 'journal-import-v1';
const STAGES = ['runs', 'conversations', 'library', 'missions', 'approvals', 'changes', 'activity'];
// Activity left out: what runs, approvals and changes already cover, and boot/health noise (spec non-goals).
const ACTIVITY_SKIPPED = new Set(['image', 'chat', 'research', 'approval', 'change', 'mission', 'agent', 'run', 'system', 'health', 'monitor', 'watchdog', 'status']);
// Host commands are kept by title only.
const ACTIVITY_TITLE_ONLY = new Set(['workbench', 'powershell']);
const str = v => (typeof v === 'string' ? v.trim() : '');
const when = x => x?.finishedAt || x?.appliedAt || x?.updatedAt || x?.createdAt || x?.at || x?.startedAt;
const titleOf = x => str(x?.title) || str(x?.name) || str(x?.goal);
const textOf = x => str(x?.summary) || str(x?.answer) || str(x?.detail) || str(x?.content) || str(x?.text);

async function importAll({ storage, journal, runLedger, batch = 200, pause = () => new Promise(r => setImmediate(r)) }) {
  const progress = storage.readSetting(IMPORT_KEY, null) || { done: false, stage: STAGES[0], offset: 0 };
  if (progress.done) return { added: 0, done: true };
  let added = 0;
  const cap = Math.max(1, Math.floor(Number(batch)) || 200);
  const add = entry => { if (entry && journal.record(entry)) added++; };
  // A chat or mission that a run entry already holds (within a day, same opening words) is not imported again. The
  // run titles are indexed once by UTC day, so each check is a few comparisons, not a query.
  const norm = t => String(t || '').replace(/\s+/g, ' ').replace(/…$/, '').trim().toLowerCase();
  let runIndex = null;
  const runHas = (at, title) => {
    const t = Date.parse(at), head = norm(title);
    if (!Number.isFinite(t) || !head) return false;
    if (!runIndex) {
      runIndex = new Map();
      for (const r of journal.runTitles()) {
        const day = String(r.at).slice(0, 10);
        if (!runIndex.has(day)) runIndex.set(day, []);
        runIndex.get(day).push({ t: Date.parse(r.at), title: norm(r.title) });
      }
    }
    const same = r => r.title === head || (Math.min(r.title.length, head.length) >= 12 && (head.startsWith(r.title) || r.title.startsWith(head)));
    for (const d of [-1, 0, 1]) {
      const list = runIndex.get(new Date(t + d * 86400000).toISOString().slice(0, 10)) || [];
      if (list.some(r => Math.abs(r.t - t) <= 86400000 && same(r))) return true;
    }
    return false;
  };
  const builders = {
    runs: r => runEntry(r),
    conversations: c => {
      const msgs = Array.isArray(c.messages) ? c.messages : [];
      const out = [];
      for (let i = 0, n = 0; i < msgs.length; i++) {
        if (msgs[i]?.role !== 'user') continue;
        const q = str(msgs[i].content), a = msgs[i + 1]?.role === 'assistant' ? str(msgs[i + 1].content) : '';
        const at = msgs[i].createdAt || msgs[i].at || c.createdAt;
        if (q && !runHas(at, q)) out.push({ at, source: 'chat', kind: 'chat', title: q, body: a, ref: `chat:${c.id}:${n}`, meta: { conversationId: c.id } });
        n++;
      }
      return out;
    },
    library: x => ({ at: when(x), source: 'library', kind: str(x.kind) || 'item', title: titleOf(x), body: textOf(x), ref: `library:${x.id}`, meta: { artifactId: x.id } }),
    missions: m => (titleOf(m) && !runHas(when(m), titleOf(m))
      ? { at: when(m), source: 'mission', kind: str(m.status) || 'mission', title: titleOf(m), body: textOf(m), ref: `mission:${m.id}`, meta: { missionId: m.id } } : null),
    approvals: a => (['approved', 'rejected'].includes(a.status)
      ? { at: when(a), source: 'approval', kind: a.status, title: titleOf(a), body: str(a.detail), ref: `approval:${a.id}:${a.status}`, meta: { approvalId: a.id } } : null),
    changes: c => (['applied', 'deployed', 'shipped'].includes(c.status)
      ? { at: when(c), source: 'change', kind: c.status, title: titleOf(c) || str(c.summary), body: str(c.summary), ref: `change:${c.id}:${c.status}`, meta: { changeId: c.id } } : null),
    activity: x => (ACTIVITY_SKIPPED.has(x.type) ? null
      : { at: when(x), source: 'activity', kind: str(x.type) || 'activity', title: titleOf(x), body: ACTIVITY_TITLE_ONLY.has(x.type) ? '' : str(x.detail), ref: `activity:${x.id}`, meta: {} })
  };
  const collection = { conversations: 'conversations', library: 'library', missions: 'missions', approvals: 'approvals', changes: 'changes', activity: 'activity' };

  for (let s = Math.max(0, STAGES.indexOf(progress.stage)); s < STAGES.length; s++) {
    const stage = STAGES[s];
    let offset = stage === progress.stage ? progress.offset || 0 : 0;
    // A conversation holds many turns, so fewer of them go in one transaction.
    const size = stage === 'conversations' ? Math.max(1, Math.floor(cap / 20)) : cap;
    // Runs come from the ledger (oldest last); everything else pages through its collection.
    const all = stage === 'runs' ? runLedger.list({ all: true }) : null;
    for (;;) {
      const items = all ? all.slice(offset, offset + size) : storage.list(collection[stage], { limit: size, offset });
      if (!items.length) break;
      // One transaction holds at most `batch` entries, with a pause between them: a long chat yields many entries, and
      // sizing the transaction by conversations alone let one batch write thousands at once.
      const entries = [];
      for (const item of items) for (const entry of [].concat(builders[stage](item) || [])) entries.push(entry);
      for (let i = 0; i < entries.length; i += cap) {
        if (i) await pause();
        const chunk = entries.slice(i, i + cap);
        storage.transaction(() => { chunk.forEach(add); });
      }
      offset += items.length;
      storage.writeSetting(IMPORT_KEY, { done: false, stage, offset });
      await pause();
      if (items.length < size) break;
    }
  }
  storage.writeSetting(IMPORT_KEY, { done: true, stage: null, offset: 0, finishedAt: new Date().toISOString(), added });
  return { added, done: true };
}

module.exports = { importAll, IMPORT_KEY, STAGES };
