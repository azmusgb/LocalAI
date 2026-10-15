'use strict';

// SQLite owns application state. JSON files are read only by the one-time importer.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch (cause) { throw new Error('LocalAI storage requires Node.js 22.13 or newer with node:sqlite.', { cause }); }

const COLLECTIONS = Object.freeze({
  projects: ['projects', 'projects.json'],
  conversations: ['conversations', 'conversations.json'],
  knowledge: ['knowledge_sources', 'knowledge.json'],
  library: ['artifacts', 'library.json'],
  missions: ['missions', 'agent-missions.json'],
  agentRuns: ['agent_runs', 'agent-runs.json'],
  specialistRuns: ['specialist_agent_runs', 'specialist-agent-runs.json'],
  automations: ['automations', 'automations.json'],
  automationRuns: ['automation_runs', 'automation-runs.json'],
  activity: ['activities', 'activity.json'],
  notifications: ['notifications', 'notifications.json'],
  approvals: ['approvals', 'approvals.json'],
  changes: ['changes', 'changes.json'],
  memory: ['project_memory', 'project-memory.json'],
  monitors: ['monitors', 'monitors.json'],
  qualityEvents: ['quality_events', 'quality-events.json'],
  qualityScans: ['quality_scans', 'quality-scans.json'],
  issues: ['issues', 'issues.json'],
  engineeringRuns: ['engineering_runs', 'engineering-runs.json'],
  powerShellJobs: ['powershell_jobs', 'powershell-jobs.json'],
  deployments: ['deployments', null]
});
const CHILDREN = Object.freeze({
  conversations: { messages: 'messages' },
  knowledge: { chunks: 'knowledge_chunks' },
  missions: { workers: 'mission_steps', timeline: 'mission_events' }
});
const SCHEMA_VERSION = 1;
// The run ledger (app/run-ledger.js) keeps one settings row per run under this prefix; JSON exports carry
// them in RUNS_FILENAME and an import restores them as the legacy single-row ledger, which it migrates.
const RUN_KEY_PREFIX = 'unified-run/';
const RUN_LEDGER_KEY = 'unified-runs-v1';
const RUNS_FILENAME = 'unified-runs.json';
const IMPORT_KEY = 'legacy-json-import-v1';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const encode = value => JSON.stringify(value);
// Smallest string greater than every string starting with `prefix` (for index range scans).
const prefixEnd = prefix => prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);

function validateRecord(collection, record) {
  if (!isObject(record) || typeof record.id !== 'string' || !record.id.trim()) throw new TypeError(`${collection}: every record must have a nonempty string id`);
  for (const field of Object.keys(CHILDREN[collection] || {})) {
    if (Object.hasOwn(record, field) && !Array.isArray(record[field])) throw new TypeError(`${collection}/${record.id}: ${field} must be an array`);
  }
  // Round trip validates serializability and keeps the exact public JSON contract.
  return JSON.parse(encode(record));
}

function readLegacySources(dataDir) {
  const sources = [];
  for (const [collection, [, filename]] of Object.entries(COLLECTIONS)) {
    if (!filename) continue;
    const source = path.join(dataDir, filename);
    if (!fs.existsSync(source)) continue;
    const raw = fs.readFileSync(source);
    let items;
    try { items = JSON.parse(raw.toString('utf8')); }
    catch (cause) { throw new Error(`Cannot import ${filename}: invalid JSON; original file preserved.`, { cause }); }
    if (!Array.isArray(items)) throw new Error(`Cannot import ${filename}: expected an array; original file preserved.`);
    const ids = new Set();
    for (const item of items) {
      validateRecord(collection, item);
      if (ids.has(item.id)) throw new Error(`Cannot import ${filename}: duplicate id ${item.id}`);
      ids.add(item.id);
    }
    sources.push({ collection, filename, raw, items });
  }
  const runsPath = path.join(dataDir, RUNS_FILENAME);
  if (fs.existsSync(runsPath)) {
    const raw = fs.readFileSync(runsPath);
    let value;
    try { value = JSON.parse(raw.toString('utf8')); }
    catch (cause) { throw new Error(`Cannot import ${RUNS_FILENAME}: invalid JSON; original file preserved.`, { cause }); }
    if (!Array.isArray(value)) throw new Error(`Cannot import ${RUNS_FILENAME}: expected an array`);
    sources.push({ filename: RUNS_FILENAME, raw, value, setting: RUN_LEDGER_KEY });
  }
  const statusPath = path.join(dataDir, 'status-state.json');
  if (fs.existsSync(statusPath)) {
    const raw = fs.readFileSync(statusPath);
    let value;
    try { value = JSON.parse(raw.toString('utf8')); }
    catch (cause) { throw new Error('Cannot import status-state.json: invalid JSON; original file preserved.', { cause }); }
    if (!isObject(value)) throw new Error('Cannot import status-state.json: expected an object');
    sources.push({ filename: 'status-state.json', raw, value });
  }
  return sources;
}

class StorageConflict extends Error {
  constructor(collection, id) {
    super(`State changed while updating ${collection}/${id}; reload and retry.`);
    this.code = 'STORAGE_CONFLICT';
    this.statusCode = 409;
  }
}

class Storage {
  constructor({ dataDir, filename = 'localai.db', importLegacy = true, readOnly = false } = {}) {
    if (!dataDir) throw new TypeError('dataDir is required');
    this.dataDir = path.resolve(dataDir);
    this.filename = path.resolve(this.dataDir, filename);
    this.snapshots = new WeakMap();
    this.pendingSnapshots = new Map();
    this.depth = 0;
    this.closed = false;
    this.readOnly = readOnly;
    if (!readOnly) fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    this.db = new DatabaseSync(this.filename, { readOnly });
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > SCHEMA_VERSION) throw new Error(`Database schema ${version} is newer than this application (${SCHEMA_VERSION}); refusing to downgrade.`);
      if (readOnly) {
        if (version !== SCHEMA_VERSION) throw new Error(`Database schema ${version} needs explicit migration before inspection`);
      } else {
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
        this.migrate();
        if (importLegacy) this.importLegacy();
      }
      this.check();
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  table(collection) {
    if (!Object.hasOwn(COLLECTIONS, collection)) throw new TypeError(`Unknown state collection: ${collection}`);
    return COLLECTIONS[collection][0];
  }

  readTransaction(fn) {
    if (this.depth) return fn();
    this.db.exec('BEGIN');
    this.depth++;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.depth--; }
  }

  transaction(fn) {
    if (this.readOnly) throw new Error('Read-only storage cannot write or migrate');
    if (fn.constructor.name === 'AsyncFunction') throw new TypeError('Storage transactions must be synchronous');
    if (this.depth) {
      const result = fn();
      if (result && typeof result.then === 'function') throw new TypeError('Storage transactions must be synchronous');
      return result;
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') throw new TypeError('Storage transactions must be synchronous; await external work before opening a transaction.');
      this.db.exec('COMMIT');
      for (const [items, snapshot] of this.pendingSnapshots) this.snapshots.set(items, snapshot);
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally { this.pendingSnapshots.clear(); this.depth--; }
  }

  migrate() {
    this.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
      CREATE TABLE IF NOT EXISTS legacy_imports (
        filename TEXT PRIMARY KEY, sha256 TEXT NOT NULL, row_count INTEGER NOT NULL,
        imported_at TEXT NOT NULL, backup_path TEXT NOT NULL
      ) STRICT;`);
      if (this.db.prepare('PRAGMA user_version').get().user_version === SCHEMA_VERSION) return;
      for (const [collection, [table]] of Object.entries(COLLECTIONS)) {
        this.db.exec(`CREATE TABLE ${table} (
          id TEXT PRIMARY KEY, position INTEGER NOT NULL, project_id TEXT, project_ref TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          payload TEXT NOT NULL CHECK(json_valid(payload)), revision INTEGER NOT NULL DEFAULT 1,
          ${collection === 'projects' ? 'CHECK(project_id IS NULL)' : 'FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL'}
        ) STRICT;
        CREATE INDEX ${table}_order ON ${table}(position,id);
        CREATE INDEX ${table}_project ON ${table}(project_ref,position);
        CREATE INDEX ${table}_status ON ${table}(status,position);`);
      }
      for (const [collection, fields] of Object.entries(CHILDREN)) {
        for (const child of Object.values(fields)) {
          this.db.exec(`CREATE TABLE ${child} (
            parent_id TEXT NOT NULL REFERENCES ${this.table(collection)}(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
            PRIMARY KEY(parent_id,ordinal)
          ) STRICT;`);
        }
      }
      this.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(SCHEMA_VERSION, new Date().toISOString());
      this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    });
  }

  validateRecord(collection, record) { return validateRecord(collection, record); }

  hydrate(collection, row) {
    const item = JSON.parse(row.payload);
    for (const [field, table] of Object.entries(CHILDREN[collection] || {})) {
      if (Object.hasOwn(item, field)) item[field] = this.db.prepare(`SELECT payload FROM ${table} WHERE parent_id=? ORDER BY ordinal`).all(row.id).map(child => JSON.parse(child.payload));
    }
    return item;
  }

  get(collection, id) {
    const row = this.db.prepare(`SELECT * FROM ${this.table(collection)} WHERE id=?`).get(String(id));
    return row ? this.hydrate(collection, row) : null;
  }

  list(collection, { projectId, status, search, limit, offset = 0 } = {}) {
    const table = this.table(collection), where = [], params = [];
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('offset must be a nonnegative integer');
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)) throw new TypeError('limit must be between 1 and 1000');
    if (projectId !== undefined) { where.push('project_ref=?'); params.push(String(projectId)); }
    if (status !== undefined) { where.push('status=?'); params.push(String(status)); }
    if (search) { where.push("title LIKE ? ESCAPE '\\'"); params.push('%' + String(search).replace(/[\\%_]/g, '\\$&') + '%'); }
    // A single read transaction keeps parent and child reads at the same snapshot.
    const read = () => this.db.prepare(`SELECT * FROM ${table}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY position,id LIMIT ? OFFSET ?`)
      .all(...params, limit ?? -1, offset).map(row => this.hydrate(collection, row));
    let items;
    if (this.depth) items = read();
    else {
      this.db.exec('BEGIN');
      try { items = read(); this.db.exec('COMMIT'); }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    // Only unfiltered full reads can be saved as collection snapshots.
    if (projectId === undefined && status === undefined && !search && limit === undefined && offset === 0) {
      this.snapshots.set(items, { collection, records: new Map(items.map(item => [item.id, encode(item)])) });
    }
    return items;
  }

  count(collection, projectId) {
    return this.db.prepare(`SELECT COUNT(*) AS count FROM ${this.table(collection)}${projectId === undefined ? '' : ' WHERE project_ref=?'}`)
      .get(...(projectId === undefined ? [] : [String(projectId)])).count;
  }

  put(collection, record, position) {
    const value = this.validateRecord(collection, record), table = this.table(collection);
    const existing = this.db.prepare(`SELECT position FROM ${table} WHERE id=?`).get(value.id);
    const projectRef = value.projectId || value.meta?.projectId;
    const projectId = collection !== 'projects' && typeof projectRef === 'string' && this.db.prepare('SELECT id FROM projects WHERE id=?').get(projectRef) ? projectRef : null;
    const payload = { ...value };
    for (const field of Object.keys(CHILDREN[collection] || {})) if (Object.hasOwn(payload, field)) payload[field] = [];
    const order = existing?.position ?? position ?? this.db.prepare(`SELECT COALESCE(MIN(position),0)-1 AS position FROM ${table}`).get().position;
    this.db.prepare(`INSERT INTO ${table}(id,position,project_id,project_ref,title,status,created_at,updated_at,payload)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      project_id=excluded.project_id,project_ref=excluded.project_ref,title=excluded.title,status=excluded.status,created_at=excluded.created_at,
      updated_at=excluded.updated_at,payload=excluded.payload,revision=revision+1`).run(
      value.id, order, projectId, typeof projectRef === 'string' ? projectRef : '', String(value.title || value.name || value.goal || ''), String(value.status || value.state || ''),
      String(value.createdAt || value.startedAt || value.at || ''), String(value.updatedAt || value.finishedAt || value.at || value.createdAt || ''), encode(payload));
    for (const [field, child] of Object.entries(CHILDREN[collection] || {})) {
      this.db.prepare(`DELETE FROM ${child} WHERE parent_id=?`).run(value.id);
      const insert = this.db.prepare(`INSERT INTO ${child} VALUES (?,?,?)`);
      (value[field] || []).forEach((item, index) => insert.run(value.id, index, encode(item)));
    }
    // Link previously imported orphans when their project is created later.
    if (collection === 'projects') for (const [other, [otherTable]] of Object.entries(COLLECTIONS)) {
      // project_ref holds the same projectId/meta.projectId put() computed, and is indexed.
      if (other !== 'projects') this.db.prepare(`UPDATE ${otherTable} SET project_id=? WHERE project_ref=? AND project_id IS NULL`).run(value.id, value.id);
    }
    return value;
  }

  upsert(collection, record) { return this.transaction(() => this.put(collection, record)); }

  // Add a new record at the front without reading or rewriting the rest of the collection.
  prepend(collection, record, keep) {
    return this.transaction(() => {
      const value = this.put(collection, record);
      if (keep) this.prune(collection, keep);
      return value;
    });
  }

  // Keep the newest `keep` records (front of the ordering); child rows go with their parents.
  prune(collection, keep) {
    if (!Number.isSafeInteger(keep) || keep < 1) throw new TypeError('keep must be a positive integer');
    const table = this.table(collection);
    return this.transaction(() => this.db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} ORDER BY position,id LIMIT -1 OFFSET ?)`).run(keep).changes);
  }

  save(collection, items, previous = items) {
    const snapshot = this.pendingSnapshots.get(previous) || this.snapshots.get(previous);
    if (!Array.isArray(items) || !snapshot || snapshot.collection !== collection) throw new TypeError(`Saving ${collection} requires its original full-read snapshot; use upsert for individual records.`);
    const next = new Map();
    for (const item of items) {
      this.validateRecord(collection, item);
      if (next.has(item.id)) throw new TypeError(`${collection}: duplicate id ${item.id}`);
      next.set(item.id, encode(item));
    }
    this.transaction(() => {
      for (const [id, before] of snapshot.records) {
        const after = next.get(id);
        if (after === before) continue; // Never overwrite an untouched stale record.
        const current = this.get(collection, id);
        if (!current || encode(current) !== before) throw new StorageConflict(collection, id);
        if (after === undefined) this.db.prepare(`DELETE FROM ${this.table(collection)} WHERE id=?`).run(id);
        else this.put(collection, JSON.parse(after));
      }
      // Preserve the input ordering for newly added records.
      for (const item of [...items].reverse()) if (!snapshot.records.has(item.id)) {
        if (this.get(collection, item.id)) throw new StorageConflict(collection, item.id);
        this.put(collection, item);
      }
    });
    const updatedSnapshot = { collection, records: next };
    if (this.depth) this.pendingSnapshots.set(items, updatedSnapshot);
    else this.snapshots.set(items, updatedSnapshot);
    return items;
  }

  readSetting(key, fallback = {}) {
    const row = this.db.prepare('SELECT payload FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(row.payload) : fallback;
  }
  writeSetting(key, value) {
    if (this.readOnly) throw new Error('Read-only storage cannot write settings');
    this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload').run(key, encode(value));
  }
  deleteSetting(key) {
    if (this.readOnly) throw new Error('Read-only storage cannot write settings');
    this.db.prepare('DELETE FROM settings WHERE key=?').run(key);
  }

  // Settings whose keys share `prefix`, newest key first, through the primary-key index.
  // `where` filters on top-level JSON fields, e.g. { status: 'running' }.
  listSettings(prefix, { limit, where = {} } = {}) {
    const conditions = ['key >= ?', 'key < ?'], params = [prefix, prefixEnd(prefix)];
    for (const [field, value] of Object.entries(where)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new TypeError(`Invalid setting field: ${field}`);
      conditions.push(`json_extract(payload,'$.${field}')=?`); params.push(String(value));
    }
    return this.db.prepare(`SELECT payload FROM settings WHERE ${conditions.join(' AND ')} ORDER BY key DESC LIMIT ?`)
      .all(...params, limit ?? -1).map(row => JSON.parse(row.payload));
  }

  // Keep the `keep` highest keys under `prefix`.
  pruneSettings(prefix, keep) {
    if (this.readOnly) throw new Error('Read-only storage cannot write settings');
    return this.db.prepare(`DELETE FROM settings WHERE key >= ? AND key < ? AND key NOT IN
      (SELECT key FROM settings WHERE key >= ? AND key < ? ORDER BY key DESC LIMIT ?)`).run(prefix, prefixEnd(prefix), prefix, prefixEnd(prefix), keep).changes;
  }

  importLegacy() {
    this.transaction(() => {
      if (this.readSetting(IMPORT_KEY, null)) return;
      const sources = readLegacySources(this.dataDir);
      const backupPath = sources.length ? path.join(this.dataDir, 'backups', 'json-before-sqlite-' + randomUUID()) : null;
      if (backupPath) {
        fs.mkdirSync(backupPath, { recursive: true });
        for (const source of sources) fs.writeFileSync(path.join(backupPath, source.filename), source.raw, { flag: 'wx' });
      }
      for (const source of sources) {
        if (source.collection) source.items.forEach((item, index) => {
          if (this.get(source.collection, item.id)) throw new Error(`Import would overwrite existing ${source.collection}/${item.id}`);
          this.put(source.collection, item, index);
        });
        else this.writeSetting(source.setting || 'status', source.value);
        this.db.prepare('INSERT INTO legacy_imports VALUES (?,?,?,?,?)').run(source.filename,
          createHash('sha256').update(source.raw).digest('hex'), source.items?.length ?? 1,
          new Date().toISOString(), backupPath);
      }
      this.writeSetting(IMPORT_KEY, { completedAt: new Date().toISOString(), files: sources.length, backupPath });
    });
  }

  check() {
    const integrity = this.db.prepare('PRAGMA quick_check').all().map(row => row.quick_check);
    if (integrity.length !== 1 || integrity[0] !== 'ok') throw new Error('SQLite integrity check failed: ' + integrity.join('; '));
    if (this.db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('SQLite foreign key check failed');
    return true;
  }

  status() {
    return { engine: 'sqlite', schemaVersion: this.db.prepare('PRAGMA user_version').get().user_version,
      journalMode: this.db.prepare('PRAGMA journal_mode').get().journal_mode,
      migration: this.readSetting(IMPORT_KEY, null),
      counts: Object.fromEntries(Object.keys(COLLECTIONS).map(collection => [collection, this.count(collection)])) };
  }

  backup(destination) {
    const target = path.resolve(destination);
    if (target === this.filename || fs.existsSync(target)) throw new Error('Backup destination must be a new file');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // VACUUM INTO includes committed WAL pages in a coherent SQLite snapshot.
    this.db.prepare('VACUUM INTO ?').run(target);
    const fd = fs.openSync(target, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return target;
  }

  exportLegacy(destination) {
    const target = path.resolve(destination);
    if (target === this.dataDir || fs.existsSync(target)) throw new Error('Export destination must be a new directory outside the active data root');
    fs.mkdirSync(target, { recursive: true });
    // A deferred read transaction gives one consistent snapshot without blocking the app's writers.
    this.readTransaction(() => {
      for (const [collection, [, filename]] of Object.entries(COLLECTIONS)) if (filename) {
        fs.writeFileSync(path.join(target, filename), JSON.stringify(this.list(collection), null, 2), { flag: 'wx' });
      }
      fs.writeFileSync(path.join(target, 'status-state.json'), JSON.stringify(this.readSetting('status'), null, 2), { flag: 'wx' });
      fs.writeFileSync(path.join(target, RUNS_FILENAME), JSON.stringify(this.listSettings(RUN_KEY_PREFIX), null, 2), { flag: 'wx' });
    });
    return target;
  }

  close() {
    if (!this.closed) { this.db.close(); this.closed = true; }
  }
}

function inspectData(dataDir) {
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) throw new Error('DATA_DIR does not exist or is not a directory');
  const database = path.join(dataDir, 'localai.db');
  if (fs.existsSync(database)) {
    const storage = new Storage({ dataDir, readOnly: true });
    try { return { ok: true, ...storage.status() }; } finally { storage.close(); }
  }
  const sources = readLegacySources(dataDir);
  const counts = Object.fromEntries(Object.keys(COLLECTIONS).map(key => [key, 0]));
  for (const source of sources) if (source.collection) counts[source.collection] = source.items.length;
  return { ok: true, engine: 'json', schemaVersion: null, migrationPending: true, legacyFiles: sources.length, counts };
}

function preflightData(dataDir) {
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) throw new Error('DATA_DIR does not exist or is not a directory');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-preflight-'));
  const sourceDatabase = path.join(dataDir, 'localai.db');
  const sourceEngine = fs.existsSync(sourceDatabase) ? 'sqlite' : 'json';
  try {
    if (sourceEngine === 'sqlite') {
      // Open the source read-only and include WAL commits in the disposable copy.
      const source = new DatabaseSync(sourceDatabase, { readOnly: true });
      try { source.prepare('VACUUM INTO ?').run(path.join(temporary, 'localai.db')); }
      finally { source.close(); }
    }
    for (const filename of [...Object.values(COLLECTIONS).map(([, file]) => file).filter(Boolean), 'status-state.json']) {
      const source = path.join(dataDir, filename);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(temporary, filename));
    }
    const candidate = new Storage({ dataDir: temporary });
    try {
      const status = candidate.status();
      // Do not return ephemeral backup paths as usable recovery artifacts.
      return { ok: true, sourceEngine, engine: status.engine, schemaVersion: status.schemaVersion,
        journalMode: status.journalMode, counts: status.counts, migrationTested: true };
    } finally { candidate.close(); }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

module.exports = { Storage, StorageConflict, COLLECTIONS, SCHEMA_VERSION, inspectData, preflightData };
