'use strict';

// One-time import of past work into the journal (docs/superpowers/specs/2026-10-23-memory-core-design.md §3).
// Resumable (its progress is a setting) and idempotent (every entry has a stable ref), so a restart mid-import just
// continues. It yields between batches so the server stays responsive.

const { runEntry } = require('./journal-recorders');

const IMPORT_KEY = 'journal-import-v1';
const STAGES = ['runs', 'conversations', 'library', 'missions', 'approvals', 'changes', 'activity'];
// Activity that runs, approvals and changes already cover.
const ACTIVITY_COVERED = new Set(['image', 'chat', 'research', 'approval', 'change', 'mission', 'agent', 'run']);
const str = v => (typeof v === 'string' ? v.trim() : '');
const when = x => x?.finishedAt || x?.appliedAt || x?.updatedAt || x?.createdAt || x?.at || x?.startedAt;
const titleOf = x => str(x?.title) || str(x?.name) || str(x?.goal);
const textOf = x => str(x?.summary) || str(x?.answer) || str(x?.detail) || str(x?.content) || str(x?.text);

async function importAll({ storage, journal, runLedger, batch = 200, pause = () => new Promise(r => setImmediate(r)) }) {
  const progress = storage.readSetting(IMPORT_KEY, null) || { done: false, stage: STAGES[0], offset: 0 };
  if (progress.done) return { added: 0, done: true };
  let added = 0;
  const add = entry => { if (entry && journal.record(entry)) added++; };
  // A chat or mission that a run entry already holds (within a day, same opening words) is not imported again.
  const norm = t => String(t || '').replace(/\s+/g, ' ').replace(/…$/, '').trim().toLowerCase();
  const runHas = (at, title) => {
    const t = Date.parse(at), head = norm(title);
    if (!Number.isFinite(t) || !head) return false;
    return journal.search({ sources: ['run'], from: new Date(t - 86400000).toISOString(), to: new Date(t + 86400000).toISOString(), limit: 200 })
      .items.some(x => { const r = norm(x.title); return !!r && (head.startsWith(r) || r.startsWith(head)); });
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
    activity: x => (ACTIVITY_COVERED.has(x.type) ? null
      : { at: when(x), source: 'activity', kind: str(x.type) || 'activity', title: titleOf(x), body: str(x.detail), ref: `activity:${x.id}`, meta: {} })
  };
  const collection = { conversations: 'conversations', library: 'library', missions: 'missions', approvals: 'approvals', changes: 'changes', activity: 'activity' };

  for (let s = Math.max(0, STAGES.indexOf(progress.stage)); s < STAGES.length; s++) {
    const stage = STAGES[s];
    let offset = stage === progress.stage ? progress.offset || 0 : 0;
    // Runs come from the ledger (oldest last); everything else pages through its collection.
    const all = stage === 'runs' ? runLedger.list({ all: true }) : null;
    for (;;) {
      const items = all ? all.slice(offset, offset + batch) : storage.list(collection[stage], { limit: batch, offset });
      if (!items.length) break;
      storage.transaction(() => { for (const item of items) [].concat(builders[stage](item) || []).forEach(add); });
      offset += items.length;
      storage.writeSetting(IMPORT_KEY, { done: false, stage, offset });
      await pause();
      if (items.length < batch) break;
    }
  }
  storage.writeSetting(IMPORT_KEY, { done: true, stage: null, offset: 0, finishedAt: new Date().toISOString(), added });
  return { added, done: true };
}

module.exports = { importAll, IMPORT_KEY, STAGES };
