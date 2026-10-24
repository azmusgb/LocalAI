'use strict';

// The journal: one durable, searchable record of what happens (docs/superpowers/specs/2026-10-23-memory-core-design.md).
// Its tables live in the appliance database but are created IF NOT EXISTS without a schema version bump, so Safe
// Deploy's rollback to an older release still opens the database (an older app ignores them). record() never throws.

const TITLE_MAX = 200, BODY_MAX = 4000, LIMIT_MAX = 200;
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS journal (
    seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, day TEXT NOT NULL, source TEXT NOT NULL,
    kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT, ref TEXT NOT NULL UNIQUE,
    meta TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(meta))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS journal_day ON journal(day);
  CREATE INDEX IF NOT EXISTS journal_source_at ON journal(source, at);
  CREATE INDEX IF NOT EXISTS journal_at ON journal(at);
  CREATE TABLE IF NOT EXISTS journal_deleted (ref TEXT PRIMARY KEY) STRICT;
  CREATE VIRTUAL TABLE IF NOT EXISTS journal_fts USING fts5(title, body, content='journal', content_rowid='seq',
    tokenize='porter unicode61 remove_diacritics 2');
  CREATE TRIGGER IF NOT EXISTS journal_ai AFTER INSERT ON journal BEGIN
    INSERT INTO journal_fts(rowid, title, body) VALUES (new.seq, new.title, new.body); END;
  CREATE TRIGGER IF NOT EXISTS journal_ad AFTER DELETE ON journal BEGIN
    INSERT INTO journal_fts(journal_fts, rowid, title, body) VALUES ('delete', old.seq, old.title, old.body); END;`;

// Secrets never reach the journal: private key blocks, long hex (keys, tokens), well-known token shapes, bearer
// tokens and name=value / "name": "value" pairs whose name ends in key, token, password, secret or similar.
function redact(text) {
  return String(text ?? '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted]')
    .replace(/\b[0-9a-f]{40,}\b/gi, '[redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[abpr]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+)/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/([\w-]*(?:api[_-]?key|key|token|password|passwd|secret)["']?)(\s*[=:]\s*)["']?[^\s"',;}]+/gi, '$1$2[redacted]');
}

const STOP = new Set('what when where which who whom how did does do i me my mine the a an of to in on at for from was were is are be been have has had long many much any anything something that this it its and or not did'.split(' '));
// Plain words only, each quoted (so FTS operators and punctuation are never syntax), the last as a prefix. '' = no match.
function ftsQuery(text) {
  const words = (String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => !STOP.has(w));
  if (!words.length) return '';
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? '*' : ''}`).join(' ');
}

// ---- local days in a time zone ----
function zoneParts(ms, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(ms).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}
function offsetMs(ms, timeZone) {
  const p = zoneParts(ms, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
// UTC instant of local midnight on a civil day (month may overflow; Date.UTC normalises it).
function localMidnight(y, m, d, timeZone) {
  const guess = Date.UTC(y, m - 1, d);
  let at = guess - offsetMs(guess, timeZone);
  at = guess - offsetMs(at, timeZone); // DST: use the offset in force at the result
  return new Date(at).toISOString();
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DATE_WORDS = new RegExp(String.raw`\s*\b(?:(?:on|in|during|from|for)\s+)?(?:(?:last|this)\s+(?:week|month)|today|yesterday|(?:last\s+)?(?:${DAYS.join('|')})|(?:${MONTHS.join('|')}))\b`, 'i');

function createJournal({ db, now = Date.now, timeZone = 'UTC', log = console.error } = {}) {
  if (!db || typeof db.exec !== 'function') throw new TypeError('db is required');
  db.exec(SCHEMA);
  const insert = db.prepare('INSERT INTO journal (id, at, day, source, kind, title, body, link, ref, meta) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(ref) DO NOTHING');
  const tomb = db.prepare('SELECT 1 FROM journal_deleted WHERE ref = ?');
  let lastMs = 0, seq = 0, lastLog = 0;

  const dayOf = iso => { const p = zoneParts(Date.parse(iso), timeZone); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
  const hydrate = row => row && ({ id: row.id, at: row.at, day: row.day, source: row.source, kind: row.kind, title: row.title, body: row.body, link: row.link || null, meta: JSON.parse(row.meta) });
  const nextId = () => {
    const ms = Math.max(now(), lastMs); seq = ms === lastMs ? seq + 1 : 0; lastMs = ms;
    return `j-${ms}-${seq.toString(36).padStart(3, '0')}`;
  };

  function record(entry) {
    try {
      const e = entry || {};
      const ref = String(e.ref || '').slice(0, 300), source = String(e.source || '').slice(0, 40), kind = String(e.kind || '').slice(0, 40);
      if (!ref || !source || !kind) return null;
      if (tomb.get(ref)) return null;
      const atMs = Date.parse(e.at);
      const at = new Date(Number.isFinite(atMs) ? atMs : now()).toISOString();
      const title = redact(String(e.title ?? '').replace(/\s+/g, ' ').trim()).slice(0, TITLE_MAX) || 'Untitled';
      const body = redact(e.body).slice(0, BODY_MAX);
      const link = typeof e.link === 'string' && e.link ? e.link.slice(0, 300) : null;
      let meta = '{}';
      try { meta = JSON.stringify(e.meta && typeof e.meta === 'object' ? e.meta : {}); if (meta.length > 8192) meta = '{}'; } catch {}
      const id = nextId();
      return insert.run(id, at, dayOf(at), source, kind, title, body, link, ref, meta).changes ? { id } : null;
    } catch (error) {
      if (now() - lastLog > 60000) { lastLog = now(); log(`${new Date().toISOString()} Journal record failed:`, error); }
      return null;
    }
  }

  function remove(id) {
    const row = db.prepare('SELECT ref FROM journal WHERE id = ?').get(String(id || ''));
    if (!row) return false;
    db.exec('SAVEPOINT journal_remove');
    try {
      db.prepare('INSERT OR IGNORE INTO journal_deleted (ref) VALUES (?)').run(row.ref);
      db.prepare('DELETE FROM journal WHERE id = ?').run(String(id));
      db.exec('RELEASE journal_remove');
    } catch (error) { db.exec('ROLLBACK TO journal_remove; RELEASE journal_remove'); throw error; }
    return true;
  }

  function search({ q = '', from = null, to = null, sources = [], limit = 50, before = null } = {}) {
    const n = Math.max(1, Math.min(LIMIT_MAX, Number.parseInt(limit, 10) || 50));
    const where = [], args = [];
    const iso = v => { const t = Date.parse(v); return v && Number.isFinite(t) ? new Date(t).toISOString() : null; };
    if (iso(from)) { where.push('j.at >= ?'); args.push(iso(from)); }
    if (iso(to)) { where.push('j.at < ?'); args.push(iso(to)); }
    if (iso(before)) { where.push('j.at < ?'); args.push(iso(before)); }
    const src = (Array.isArray(sources) ? sources : []).map(String).filter(Boolean).slice(0, 10);
    if (src.length) { where.push(`j.source IN (${src.map(() => '?').join(',')})`); args.push(...src); }
    let rows;
    if (String(q || '').trim()) {
      const match = ftsQuery(q);
      if (!match) return { items: [], next: null };
      rows = db.prepare(`SELECT j.* FROM journal_fts JOIN journal j ON j.seq = journal_fts.rowid
        WHERE journal_fts MATCH ? ${where.length ? 'AND ' + where.join(' AND ') : ''}
        ORDER BY bm25(journal_fts) - (julianday(j.at) - julianday(?)) * 0.02, j.seq DESC LIMIT ?`)
        .all(match, ...args, new Date(now()).toISOString(), n);
      return { items: rows.map(hydrate), next: null };
    }
    rows = db.prepare(`SELECT j.* FROM journal j ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY j.at DESC, j.seq DESC LIMIT ?`).all(...args, n + 1);
    const items = rows.slice(0, n).map(hydrate);
    return { items, next: rows.length > n ? items[items.length - 1].at : null };
  }

  // Date words in a question → a [from, to) window in local time, and the question without them.
  function window(text) {
    const said = String(text ?? '');
    const m = said.match(DATE_WORDS);
    if (!m) return { from: null, to: null, rest: said.trim() };
    const word = m[0].trim().toLowerCase().replace(/^(?:on|in|during|from|for)\s+/, '');
    const t = zoneParts(now(), timeZone);
    const today = Date.UTC(t.y, t.m - 1, t.d), DAY = 86400000;
    const civil = ms => { const d = new Date(ms); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]; };
    const at = ms => localMidnight(...civil(ms), timeZone);
    const weekday = (new Date(today).getUTCDay() + 6) % 7; // Monday = 0
    let from, to;
    if (word === 'today') { from = today; to = today + DAY; }
    else if (word === 'yesterday') { from = today - DAY; to = today; }
    else if (word === 'this week') { from = today - weekday * DAY; to = today + DAY; }
    else if (word === 'last week') { from = today - (weekday + 7) * DAY; to = today - weekday * DAY; }
    else if (word === 'this month' || word === 'last month') {
      const back = word === 'last month' ? 1 : 0;
      from = Date.UTC(t.y, t.m - 1 - back, 1); to = word === 'this month' ? today + DAY : Date.UTC(t.y, t.m - 1, 1);
    } else if (MONTHS.includes(word)) {
      const mi = MONTHS.indexOf(word), y = mi + 1 > t.m ? t.y - 1 : t.y;
      from = Date.UTC(y, mi, 1); to = Date.UTC(y, mi + 1, 1);
    } else {
      const target = DAYS.indexOf(word.replace(/^last\s+/, ''));
      const back = ((weekday - target + 7) % 7) || 7;
      from = today - back * DAY; to = from + DAY;
    }
    const rest = (said.slice(0, m.index) + ' ' + said.slice(m.index + m[0].length)).replace(/\s+/g, ' ').replace(/\s+([?.!,])/g, '$1').trim();
    return { from: at(from), to: at(to), rest };
  }

  const get = id => hydrate(db.prepare('SELECT * FROM journal WHERE id = ?').get(String(id || '')));
  const countSince = iso => db.prepare('SELECT count(*) AS n FROM journal WHERE at >= ?').get(String(iso)).n;
  return { record, remove, search, get, countSince, dayOf, window };
}

module.exports = { createJournal, redact, ftsQuery };
