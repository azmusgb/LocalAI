'use strict';

// Delete with Undo. A delete takes things out of their stores at once (so no list has to skip them) and keeps a copy
// in one trash record: Undo puts the copy back, and after a day the record is dropped for good.
// What one delete can cover: a Work row (its whole thread of runs, and what Library keeps of it), a Library item (its
// runs stay in Work), a project (its work moves to no project). Image files stay in ComfyUI's output folder on the
// host: Local AI only forgets them.

const { RUN_KEY_PREFIX } = require('./run-ledger');
const { runIdsOf } = require('./library-threads');

const TRASH_PREFIX = 'trash/';
const KEEP_MS = 24 * 60 * 60 * 1000;
const ACTIVE = new Set(['queued', 'running', 'streaming', 'awaiting_approval']);
const PROJECT_COLLECTIONS = ['conversations', 'knowledge', 'memory'];
const KINDS = new Set(['thread', 'library', 'project']);

// Where an item sat: its index and the ids either side, so Undo can put it back between the same neighbours.
function placed(items, index) { return { index, item: items[index], prev: items[index - 1]?.id ?? null, after: items[index + 1]?.id ?? null }; }

function fail(status, message) { return Object.assign(new Error(message), { status }); }

class Trash {
  // settings: readSetting/writeSetting/deleteSetting/listSettings. ledger: the RunLedger. collections: get(name) → array,
  // set(name, items, previous). beforeLibraryRemove(item): lets the server keep a conversation's long answers in Work.
  constructor({ settings, ledger, collections, now = () => Date.now(), beforeLibraryRemove = () => {} }) {
    Object.assign(this, { settings, ledger, collections, now, beforeLibraryRemove });
  }

  rawRun(id) { return this.settings.readSetting(RUN_KEY_PREFIX + id, null); }

  // refs: [{kind, id}]. Checks everything first, so a refused delete changes nothing.
  delete(refs) {
    if (!Array.isArray(refs) || !refs.length || refs.length > 200) throw fail(400, 'Say what to delete (1 to 200 items)');
    const runs = new Map(), libraryIds = new Set(), projectIds = new Set();
    for (const ref of refs) {
      const kind = String(ref?.kind || ''), id = String(ref?.id || '');
      if (!KINDS.has(kind) || !id) throw fail(400, 'Each item needs a kind (thread, library or project) and an id');
      if (kind === 'thread') {
        if (id.startsWith('legacy-')) throw fail(409, 'This older item is managed by its own page and cannot be deleted here');
        const found = this.ledger.list({ threadId: id, all: true });
        const own = found.length ? found : [this.ledger.get(id)].filter(Boolean);
        if (!own.length) throw fail(404, 'Nothing to delete: it may already be gone');
        const live = own.find(r => ACTIVE.has(r.status));
        if (live) throw fail(409, `“${live.title || 'This item'}” isn't finished yet. Stop it first, then delete it.`);
        for (const r of own) runs.set(r.id, r);
      } else if (kind === 'library') {
        if (!this.collections.get('library').some(x => x?.id === id)) throw fail(404, 'Nothing to delete: it may already be gone');
        libraryIds.add(id);
      } else {
        if (!this.collections.get('projects').some(x => x?.id === id)) throw fail(404, 'That project is already gone');
        projectIds.add(id);
      }
    }

    const record = { id: this.newId(), createdAt: this.now(), runs: [], library: [], projects: [], moves: [] };

    // Library items that belong to the deleted runs go with them.
    if (runs.size) {
      const threads = new Set([...runs.values()].map(r => r.threadId || r.id));
      const artifacts = new Set([...runs.values()].flatMap(r => r.artifactIds || []));
      for (const it of this.collections.get('library')) {
        const meta = it?.meta || {};
        if (threads.has(meta.threadId) || runs.has(meta.runId) || artifacts.has(it?.id) || runIdsOf(it).some(x => runs.has(x))) libraryIds.add(it.id);
      }
    }

    if (libraryIds.size) {
      const items = this.collections.get('library');
      items.forEach((it, index) => { if (libraryIds.has(it?.id)) record.library.push(placed(items, index)); });
      for (const { item } of record.library) if (!runs.size) this.beforeLibraryRemove(item);
      this.collections.set('library', items.filter(it => !libraryIds.has(it?.id)), items);
    }

    for (const id of runs.keys()) {
      const raw = this.rawRun(id);
      if (!raw) continue;
      record.runs.push(raw);
      this.settings.deleteSetting(RUN_KEY_PREFIX + id);
    }

    if (projectIds.size) {
      const projects = this.collections.get('projects');
      projects.forEach((it, index) => { if (projectIds.has(it?.id)) record.projects.push(placed(projects, index)); });
      this.collections.set('projects', projects.filter(it => !projectIds.has(it?.id)), projects);
      // Its runs and the things filed under it stay, under no project.
      for (const pid of projectIds) {
        for (const r of this.ledger.list({ projectId: pid, all: true })) {
          const raw = this.rawRun(r.id);
          if (!raw) continue;
          record.moves.push({ store: 'runs', id: r.id, projectId: pid });
          this.settings.writeSetting(RUN_KEY_PREFIX + r.id, { ...raw, projectId: null });
        }
        for (const name of PROJECT_COLLECTIONS) {
          const items = this.collections.get(name);
          let moved = false;
          const next = items.map(it => {
            if (it?.projectId !== pid) return it;
            moved = true; record.moves.push({ store: name, id: it.id, projectId: pid });
            return { ...it, projectId: null };
          });
          if (moved) this.collections.set(name, next, items);
        }
      }
    }

    this.settings.writeSetting(TRASH_PREFIX + record.id, record);
    return { trashId: record.id, deleted: { runs: record.runs.length, library: record.library.length, projects: record.projects.length } };
  }

  restore(trashId) {
    const key = TRASH_PREFIX + String(trashId || '');
    const record = this.settings.readSetting(key, null);
    if (!record) throw fail(404, 'Too late to undo: it was deleted for good, or already put back');
    for (const raw of record.runs) this.settings.writeSetting(RUN_KEY_PREFIX + raw.id, raw);
    const putBack = (name, saved) => {
      if (!saved.length) return;
      const items = this.collections.get(name), next = [...items];
      // Back beside the neighbours it had (things added since stay where they are), else at its old place.
      for (const { index, item, prev, after } of [...saved].sort((a, b) => a.index - b.index)) {
        if (next.some(x => x?.id === item.id)) continue;
        const p = prev ? next.findIndex(x => x?.id === prev) : -1, n = after ? next.findIndex(x => x?.id === after) : -1;
        next.splice(p >= 0 ? p + 1 : n >= 0 ? n : Math.min(index, next.length), 0, item);
      }
      this.collections.set(name, next, items);
    };
    putBack('library', record.library);
    putBack('projects', record.projects);
    for (const move of record.moves) {
      if (move.store === 'runs') {
        const raw = this.rawRun(move.id);
        if (raw && !raw.projectId) this.settings.writeSetting(RUN_KEY_PREFIX + move.id, { ...raw, projectId: move.projectId });
      }
    }
    for (const name of PROJECT_COLLECTIONS) {
      const mine = new Map(record.moves.filter(m => m.store === name).map(m => [m.id, m.projectId]));
      if (!mine.size) continue;
      const items = this.collections.get(name);
      this.collections.set(name, items.map(it => (mine.has(it?.id) && !it.projectId ? { ...it, projectId: mine.get(it.id) } : it)), items);
    }
    this.settings.deleteSetting(key);
    return { restored: { runs: record.runs.length, library: record.library.length, projects: record.projects.length } };
  }

  // Drops trash older than a day. Returns how many records went.
  purge() {
    const cutoff = this.now() - KEEP_MS;
    let n = 0;
    for (const record of this.settings.listSettings(TRASH_PREFIX)) {
      if (record && record.createdAt < cutoff) { this.settings.deleteSetting(TRASH_PREFIX + record.id); n++; }
    }
    return n;
  }

  newId() { return `${String(this.now()).padStart(15, '0')}-${Math.random().toString(16).slice(2, 10)}`; }
}

module.exports = { Trash, KEEP_MS, TRASH_PREFIX };
