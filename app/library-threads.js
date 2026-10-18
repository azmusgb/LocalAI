'use strict';
// One conversation, one Library item, and only once you keep it. Pure: no I/O. A conversation's item keeps its first message as its title and
// shows its latest answer; every turn's full answer stays readable under data.turns[runId] (the run view reads an
// answer too long for the run ledger from there).
const THREAD_KINDS = new Set(['conversation', 'research']);
const MAX_TURNS = 50;

const isThreadItem = it => !!it && THREAD_KINDS.has(it.kind);
const turnsOf = it => (it?.data?.turns && typeof it.data.turns === 'object' ? it.data.turns : {});
function capTurns(turns) {
  const keys = Object.keys(turns);
  if (keys.length <= MAX_TURNS) return turns;
  return Object.fromEntries(keys.slice(-MAX_TURNS).map(k => [k, turns[k]]));
}

// The item a new turn of `threadId` belongs to, updated with that turn; null when the thread has no item yet.
function continueThread(items, { threadId, runId, summary = '', meta = {}, data = {}, now }) {
  if (!threadId) return null;
  const found = (items || []).find(it => isThreadItem(it) && it.meta?.threadId === threadId);
  if (!found) return null;
  const turns = { ...turnsOf(found) };
  if (runId && typeof data.response === 'string') turns[runId] = data.response;
  return {
    ...found,
    summary: String(summary || '').slice(0, 1200),
    updatedAt: now,
    meta: { ...found.meta, ...meta, threadId, runId: runId || found.meta?.runId },
    data: { ...found.data, ...data, turns: capTurns(turns) }
  };
}

// A first turn's data with its answer filed under its run id.
function firstTurnData(data = {}, runId) {
  return runId && typeof data.response === 'string' ? { ...data, turns: { [runId]: data.response } } : data;
}

// One-time repair: per-turn duplicates of a conversation become one item. `threadOf(item)` names the item's thread
// (from meta.threadId, or its run's threadId). The oldest item keeps its id, title and pin; the newest gives the
// summary and latest answer; all turns' answers are kept. Returns the list without the merged-away items.
function mergeThreads(items, threadOf) {
  const groups = new Map();
  for (const it of items || []) {
    if (!isThreadItem(it)) continue;
    const t = threadOf(it);
    if (!t) continue;
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(it);
  }
  const replace = new Map(), drop = new Set();
  let merged = 0;
  for (const [threadId, group] of groups) {
    const byAge = [...group].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
    const oldest = byAge[0], newest = byAge[byAge.length - 1];
    const turns = {};
    for (const it of byAge) {
      Object.assign(turns, turnsOf(it));
      if (it.meta?.runId && typeof it.data?.response === 'string') turns[it.meta.runId] = it.data.response;
    }
    const keep = {
      ...oldest,
      summary: newest.summary,
      pinned: group.some(it => it.pinned),
      updatedAt: newest.updatedAt || newest.createdAt || oldest.createdAt,
      meta: { ...oldest.meta, ...newest.meta, threadId },
      data: { ...oldest.data, ...newest.data, turns: capTurns(turns) }
    };
    replace.set(oldest.id, keep);
    for (const it of byAge.slice(1)) { drop.add(it.id); merged++; }
  }
  return { items: (items || []).filter(it => !drop.has(it?.id)).map(it => replace.get(it?.id) || it), merged };
}

// Library holds only what you keep (owner decision, 18 Oct). Chats and research reach Library only through Keep (☆);
// images and other kinds still arrive by themselves. A chat or research item stays when it was kept, pinned, or is
// tied to a project (`tied(item)` checks its runs); everything else is an auto-saved item that belongs only in Work.
function staysInLibrary(it, tied = () => false) {
  if (!isThreadItem(it)) return true;
  return !!(it.kept || it.pinned || it.projectId || it.meta?.projectId || tied(it));
}
// One-time repair (repair:library-kept-v1): the items that stay, and the auto-saved ones that leave Library.
function splitKept(items, tied) {
  const keep = [], moved = [];
  for (const it of items || []) (staysInLibrary(it, tied) ? keep : moved).push(it);
  return { keep, moved };
}
// The run ids a thread item holds an answer for (its latest run and every filed turn).
const runIdsOf = it => [...new Set([it?.meta?.runId, ...Object.keys(turnsOf(it))].filter(Boolean))];

// Keep (☆): a conversation's Library item, built from its runs. `runs` is the thread oldest first; `answerOf(run)` is
// that turn's full answer. The title is the first message (D10); the summary and answer are the latest turn's.
function itemFromRuns(runs, { id, now, answerOf = r => r?.output?.text }) {
  const list = (runs || []).filter(Boolean);
  if (!list.length) return null;
  const first = list[0], last = list[list.length - 1];
  const turns = {};
  for (const r of list) { const a = answerOf(r); if (typeof a === 'string') turns[r.id] = a; }
  const response = typeof answerOf(last) === 'string' ? answerOf(last) : '';
  return {
    id, kind: last.type === 'research' ? 'research' : 'conversation',
    title: String(first.title || first.input?.prompt || (last.type === 'research' ? 'Research' : 'Conversation')),
    summary: String(last.summary || response).slice(0, 1200),
    createdAt: now, updatedAt: now, pinned: false, kept: true,
    meta: { ...(last.threadId ? { threadId: last.threadId } : {}), runId: last.id, ...(last.output?.model ? { model: last.output.model } : {}) },
    data: { prompt: String(last.input?.prompt || ''), response, sources: Array.isArray(last.output?.sources) ? last.output.sources : [], turns: capTurns(turns) }
  };
}

module.exports = { continueThread, firstTurnData, mergeThreads, staysInLibrary, splitKept, runIdsOf, itemFromRuns, isThreadItem, THREAD_KINDS };
