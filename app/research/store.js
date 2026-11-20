'use strict';

// Research intake store: sources, fetch attempts, documents and a small key/value meta table. The tables live in the
// appliance database and are created IF NOT EXISTS without a schema version bump (as the journal's are), so Safe
// Deploy's rollback to an older release still opens it. Every write is synchronous; nothing is awaited in a transaction.

const crypto = require('node:crypto');
const { redact, ftsQuery } = require('../journal');
const { checkUrl } = require('./net-guard');

const NAME_MAX = 120, TITLE_MAX = 300, TEXT_MAX = 20000, LIMIT_MAX = 200;
const SCHEDULE_MIN = 60, SCHEDULE_MAX = 10080, SCHEDULE_DEFAULT = 360;
const KEEP_DOCUMENTS = 2000, KEEP_FETCHES = 50, QUARANTINE_AFTER = 5, BACKOFF_CAP_MIN = 24 * 60;
const CODE_MAX = 40, PUBLISHED_MAX = 40;
const TOPICS_MAX = 20, TOPIC_MAX = 60;
const TRUST = ['official', 'primary', 'secondary', 'unrated'];
const SETTABLE_STATUS = ['active', 'paused', 'retired'];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS research_sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL UNIQUE, host TEXT NOT NULL,
    kind TEXT NOT NULL, trust TEXT NOT NULL, topics TEXT NOT NULL DEFAULT '[]', schedule_minutes INTEGER NOT NULL, status TEXT NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0, last_ok_at TEXT NOT NULL DEFAULT '', last_fetch_at TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '',
    next_due_at TEXT NOT NULL DEFAULT '', etag TEXT NOT NULL DEFAULT '', last_modified TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS research_fetches (seq INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, at TEXT NOT NULL, day TEXT NOT NULL,
    ok INTEGER NOT NULL, status INTEGER NOT NULL, code TEXT NOT NULL, reason TEXT NOT NULL, bytes INTEGER NOT NULL, added INTEGER NOT NULL,
    revised INTEGER NOT NULL, ms INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS research_fetches_source ON research_fetches (source_id, seq);
  CREATE INDEX IF NOT EXISTS research_fetches_day ON research_fetches (day);
  CREATE TABLE IF NOT EXISTS research_documents (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source_id TEXT NOT NULL, ref TEXT NOT NULL,
    revision INTEGER NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, published TEXT NOT NULL, fetched_at TEXT NOT NULL,
    hash TEXT NOT NULL, UNIQUE (ref, revision));
  CREATE INDEX IF NOT EXISTS research_documents_source ON research_documents (source_id, seq);
  CREATE VIRTUAL TABLE IF NOT EXISTS research_documents_fts USING fts5(title, text, content='research_documents', content_rowid='seq', tokenize='porter unicode61');
  CREATE TRIGGER IF NOT EXISTS research_documents_ai AFTER INSERT ON research_documents BEGIN
    INSERT INTO research_documents_fts(rowid, title, text) VALUES (new.seq, new.title, new.text); END;
  CREATE TRIGGER IF NOT EXISTS research_documents_ad AFTER DELETE ON research_documents BEGIN
    INSERT INTO research_documents_fts(research_documents_fts, rowid, title, text) VALUES ('delete', old.seq, old.title, old.text); END;
  CREATE TABLE IF NOT EXISTS research_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`;

function fail(status, message) { return Object.assign(new Error(message), { status }); }
const newId = prefix => `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

// The local date YYYY-MM-DD in a time zone, the way the journal's dayOf does it.
function localDay(ms, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(ms).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function checkName(name) {
  const v = String(name ?? '').trim();
  if (!v || v.length > NAME_MAX) throw fail(400, `name must be 1 to ${NAME_MAX} characters`);
  return v;
}
// -> { url (normalised href), host }
function checkSourceUrl(url) {
  let host;
  try { host = new URL(String(url)).hostname; } catch { throw fail(400, 'url is not a valid URL'); }
  try {
    const u = checkUrl(String(url), { allowHosts: [host] });
    return { url: u.href, host: u.hostname };
  } catch (error) { throw fail(400, error.code ? `url refused: ${error.code}` : 'url refused'); }
}
function checkTrust(trust) {
  if (!TRUST.includes(trust)) throw fail(400, `trust must be one of ${TRUST.join(', ')}`);
  return trust;
}
function checkSchedule(minutes) {
  if (!Number.isInteger(minutes) || minutes < SCHEDULE_MIN || minutes > SCHEDULE_MAX) throw fail(400, `scheduleMinutes must be ${SCHEDULE_MIN} to ${SCHEDULE_MAX}`);
  return minutes;
}
function checkTopics(topics) {
  if (!Array.isArray(topics) || topics.length > TOPICS_MAX || topics.some(t => typeof t !== 'string' || !t.trim() || t.length > TOPIC_MAX)) {
    throw fail(400, `topics must be up to ${TOPICS_MAX} non-empty strings of at most ${TOPIC_MAX} characters`);
  }
  return topics.map(t => t.trim());
}

function createResearchStore({ db, now = Date.now, timeZone = 'UTC' } = {}) {
  if (!db || typeof db.exec !== 'function') throw new TypeError('db is required');
  db.exec(SCHEMA);

  const nowIso = () => new Date(now()).toISOString();
  const st = {
    insertSource: db.prepare(`INSERT INTO research_sources (id, name, url, host, kind, trust, topics, schedule_minutes, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,'active',?)`),
    getSource: db.prepare('SELECT s.*, (SELECT count(*) FROM research_documents d WHERE d.source_id = s.id) AS documents FROM research_sources s WHERE s.id = ?'),
    listSources: db.prepare('SELECT s.*, (SELECT count(*) FROM research_documents d WHERE d.source_id = s.id) AS documents FROM research_sources s ORDER BY s.created_at, s.id'),
    dueSources: db.prepare(`SELECT s.*, (SELECT count(*) FROM research_documents d WHERE d.source_id = s.id) AS documents FROM research_sources s
      WHERE s.status = 'active' AND (s.next_due_at = '' OR s.next_due_at <= ?) ORDER BY s.next_due_at, s.created_at LIMIT ?`),
    insertFetch: db.prepare('INSERT INTO research_fetches (source_id, at, day, ok, status, code, reason, bytes, added, revised, ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
    // Keeps the newest 50 rows, and never deletes a row of today: the daily cap counts these rows.
    trimFetches: db.prepare(`DELETE FROM research_fetches WHERE source_id = ? AND day <> ? AND seq <= COALESCE((SELECT seq FROM research_fetches WHERE source_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?), 0)`),
    fetchesToday: db.prepare('SELECT count(*) AS n FROM research_fetches WHERE day = ?'),
    listFetches: db.prepare('SELECT * FROM research_fetches WHERE source_id = ? ORDER BY seq DESC LIMIT ?'),
    newest: db.prepare('SELECT revision, hash FROM research_documents WHERE ref = ? ORDER BY revision DESC LIMIT 1'),
    insertDoc: db.prepare('INSERT INTO research_documents (id, source_id, ref, revision, url, title, text, published, fetched_at, hash) VALUES (?,?,?,?,?,?,?,?,?,?)'),
    trimDocs: db.prepare(`DELETE FROM research_documents WHERE source_id = ? AND seq <= COALESCE((SELECT seq FROM research_documents WHERE source_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?), 0)`),
    docSeq: db.prepare('SELECT seq FROM research_documents WHERE id = ?'),
    getMeta: db.prepare('SELECT value FROM research_meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO research_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  };

  const iso = v => v || '';
  const hydrate = r => r && ({
    id: r.id, name: r.name, url: r.url, host: r.host, kind: r.kind, trust: r.trust, topics: JSON.parse(r.topics),
    scheduleMinutes: r.schedule_minutes, status: r.status, failures: r.failures, lastOkAt: iso(r.last_ok_at), lastFetchAt: iso(r.last_fetch_at),
    lastError: r.last_error, nextDueAt: iso(r.next_due_at), etag: r.etag, lastModified: r.last_modified, documents: r.documents, createdAt: r.created_at,
  });
  const hydrateDoc = r => ({ id: r.id, sourceId: r.source_id, ref: r.ref, url: r.url, title: r.title, text: r.text, published: r.published, fetchedAt: r.fetched_at, revision: r.revision, hash: r.hash });

  let depth = 0;
  function tx(fn) {
    const name = `research_tx_${depth++}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
    finally { depth--; }
  }
  const isUnique = error => /UNIQUE constraint failed: research_sources\.url/.test(String(error && error.message));

  const getSource = id => hydrate(st.getSource.get(String(id ?? ''))) || null;

  function addSource({ name, url, kind = 'feed', trust = 'unrated', topics = [], scheduleMinutes = SCHEDULE_DEFAULT } = {}) {
    const n = checkName(name), u = checkSourceUrl(url), t = checkTrust(trust), tp = checkTopics(topics), sch = checkSchedule(scheduleMinutes);
    if (kind !== 'feed') throw fail(400, "kind must be 'feed'");
    const id = newId('src');
    try { st.insertSource.run(id, n, u.url, u.host, kind, t, JSON.stringify(tp), sch, nowIso()); }
    catch (error) { if (isUnique(error)) throw fail(409, 'that URL is already a source'); throw error; }
    return getSource(id);
  }

  function updateSource(id, patch = {}) {
    const cur = getSource(id);
    if (!cur) return null;
    const p = patch && typeof patch === 'object' ? patch : {};
    const sets = [], args = [];
    const set = (col, v) => { sets.push(`${col} = ?`); args.push(v); };
    if ('name' in p) set('name', checkName(p.name));
    if ('url' in p) {
      const u = checkSourceUrl(p.url);
      if (u.url !== cur.url) { set('url', u.url); set('host', u.host); set('etag', ''); set('last_modified', ''); }
    }
    if ('trust' in p) set('trust', checkTrust(p.trust));
    if ('topics' in p) set('topics', JSON.stringify(checkTopics(p.topics)));
    if ('scheduleMinutes' in p) set('schedule_minutes', checkSchedule(p.scheduleMinutes));
    if ('status' in p) {
      if (!SETTABLE_STATUS.includes(p.status)) throw fail(400, `status must be one of ${SETTABLE_STATUS.join(', ')}`);
      set('status', p.status);
      if (p.status === 'active' && (cur.status === 'quarantined' || cur.failures >= QUARANTINE_AFTER)) { set('failures', 0); set('next_due_at', ''); }
    }
    if (sets.length) {
      try { db.prepare(`UPDATE research_sources SET ${sets.join(', ')} WHERE id = ?`).run(...args, cur.id); }
      catch (error) { if (isUnique(error)) throw fail(409, 'that URL is already a source'); throw error; }
    }
    return getSource(cur.id);
  }

  const listSources = () => st.listSources.all().map(hydrate);
  const dueSources = limit => st.dueSources.all(nowIso(), Math.max(0, Math.min(1000, Number.parseInt(limit, 10) || 0))).map(hydrate);

  function recordFetch(sourceId, { ok, status = 0, reason = '', code = '', bytes = 0, added = 0, revised = 0, etag, lastModified, ms = 0 } = {}) {
    const cur = getSource(sourceId);
    if (!cur) throw fail(404, 'unknown source');
    const at = nowIso(), num = v => (Number.isFinite(v) ? Math.trunc(v) : 0);
    return tx(() => {
      const day = localDay(now(), timeZone);
      st.insertFetch.run(cur.id, at, day, ok ? 1 : 0, num(status), String(code).slice(0, CODE_MAX), redact(reason, 300), num(bytes), num(added), num(revised), num(ms));
      st.trimFetches.run(cur.id, day, cur.id, KEEP_FETCHES);
      if (ok) {
        const sets = ['failures = 0', 'last_error = ?', 'last_ok_at = ?', 'last_fetch_at = ?', 'next_due_at = ?'];
        const args = ['', at, at, new Date(now() + cur.scheduleMinutes * 60000).toISOString()];
        if (typeof etag === 'string') { sets.push('etag = ?'); args.push(etag); }
        if (typeof lastModified === 'string') { sets.push('last_modified = ?'); args.push(lastModified); }
        db.prepare(`UPDATE research_sources SET ${sets.join(', ')} WHERE id = ?`).run(...args, cur.id);
      } else {
        const failures = cur.failures + 1;
        const backoff = Math.min(BACKOFF_CAP_MIN, cur.scheduleMinutes * 2 ** Math.min(failures, 20));
        const quarantine = failures >= QUARANTINE_AFTER && cur.status !== 'retired';
        db.prepare('UPDATE research_sources SET failures = ?, last_error = ?, last_fetch_at = ?, next_due_at = ?, status = ? WHERE id = ?')
          .run(failures, redact(reason, 300), at, new Date(now() + backoff * 60000).toISOString(), quarantine ? 'quarantined' : cur.status, cur.id);
      }
      return getSource(cur.id);
    });
  }

  function saveEntries(sourceId, entries) {
    const cur = getSource(sourceId);
    if (!cur) throw fail(404, 'unknown source');
    const list = Array.isArray(entries) ? entries : [];
    const at = nowIso();
    return tx(() => {
      let added = 0, revised = 0;
      for (const entry of list) {
        const eid = String(entry && entry.id ? entry.id : '');
        if (!eid) continue;
        const ref = `${cur.id}:${eid}`;
        const title = redact(entry.title, TITLE_MAX * 2).slice(0, TITLE_MAX), text = redact(entry.text, TEXT_MAX * 2).slice(0, TEXT_MAX);
        const hash = sha256(`${title}\n${text}`);
        const newest = st.newest.get(ref);
        if (newest && newest.hash === hash) continue;
        st.insertDoc.run(newId('doc'), cur.id, ref, newest ? newest.revision + 1 : 1, String(entry.url ?? '').slice(0, 2000), title, text, String(entry.published ?? '').slice(0, PUBLISHED_MAX), at, hash);
        if (newest) revised++; else added++;
      }
      st.trimDocs.run(cur.id, cur.id, KEEP_DOCUMENTS);
      return { added, revised };
    });
  }

  // before: a document id; returns documents saved earlier than it (the next page). An id that is gone gives [].
  function listDocuments({ sourceId, q, limit = 50, before } = {}) {
    const asked = Number.parseInt(limit, 10);
    const n = Math.max(1, Math.min(LIMIT_MAX, Number.isFinite(asked) ? asked : 50));
    const where = ['d.revision = (SELECT max(x.revision) FROM research_documents x WHERE x.ref = d.ref)'], args = [];
    let from = 'research_documents d';
    if (String(q ?? '').trim()) {
      const match = ftsQuery(q);
      if (!match) return [];
      from = 'research_documents_fts JOIN research_documents d ON d.seq = research_documents_fts.rowid';
      where.push('research_documents_fts MATCH ?'); args.push(match);
    }
    if (sourceId) { where.push('d.source_id = ?'); args.push(String(sourceId)); }
    if (before) {
      const row = st.docSeq.get(String(before));
      if (!row) return [];
      where.push('d.seq < ?'); args.push(row.seq);
    }
    return db.prepare(`SELECT d.* FROM ${from} WHERE ${where.join(' AND ')} ORDER BY d.seq DESC LIMIT ?`).all(...args, n).map(hydrateDoc);
  }

  const fetchesToday = () => st.fetchesToday.get(localDay(now(), timeZone)).n;
  const listFetches = (sourceId, limit = 20) => st.listFetches.all(String(sourceId ?? ''), Math.max(1, Math.min(KEEP_FETCHES, Number.parseInt(limit, 10) || 20)))
    .map(r => ({ at: r.at, day: r.day, ok: !!r.ok, status: r.status, code: r.code, reason: r.reason, bytes: r.bytes, added: r.added, revised: r.revised, ms: r.ms }));
  const getMeta = key => { const r = st.getMeta.get(String(key)); return r ? r.value : null; };
  const setMeta = (key, value) => { st.setMeta.run(String(key), String(value)); };

  return { addSource, updateSource, listSources, getSource, dueSources, recordFetch, saveEntries, listDocuments, fetchesToday, listFetches, getMeta, setMeta };
}

module.exports = { createResearchStore };
