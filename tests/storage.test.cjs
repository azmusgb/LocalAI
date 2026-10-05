'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { Storage, COLLECTIONS, StorageConflict, inspectData, preflightData } = require('../app/storage');
const { main: cli } = require('../app/storage-cli');

function fixture(t, legacy = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-storage-'));
  for (const [filename, value] of Object.entries(legacy)) fs.writeFileSync(path.join(dataDir, filename), typeof value === 'string' ? value : JSON.stringify(value));
  const opened = [];
  t.after(() => { opened.forEach(store => store.close()); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, open: options => { const store = new Storage({ dataDir, ...options }); opened.push(store); return store; } };
}

test('imports every legacy collection exactly once, preserving contracts, order, orphan references and source bytes', t => {
  const legacy = {}, expected = {};
  for (const [collection, [, filename]] of Object.entries(COLLECTIONS)) {
    if (!filename) continue;
    expected[collection] = [{ id: collection + '-1', title: 'First', projectId: 'p', custom: { unknown: [false, 12] } }, { id: collection + '-2', title: 'Second', projectId: 'missing' }];
    if (collection === 'projects') expected[collection] = [{ id: 'p', name: 'Project' }];
    if (collection === 'conversations') expected[collection][0].messages = [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' }];
    if (collection === 'knowledge') expected[collection][0].chunks = ['alpha', 'beta'];
    if (collection === 'missions') Object.assign(expected[collection][0], { workers: [{ id: 'w', state: 'complete' }], timeline: [{ type: 'complete', at: '2026-10-05' }] });
    legacy[filename] = expected[collection];
  }
  legacy['status-state.json'] = { overall: 'HEALTHY', checkedAt: 'old' };
  const { open, dataDir } = fixture(t, legacy), storage = open();
  for (const [collection, value] of Object.entries(expected)) assert.deepEqual(storage.list(collection), value);
  assert.equal(storage.readSetting('status').overall, 'HEALTHY');
  const status = storage.status();
  assert.equal(status.journalMode, 'wal');
  assert.equal(status.migration.files, Object.keys(legacy).length);
  for (const filename of Object.keys(legacy)) assert.deepEqual(fs.readFileSync(path.join(dataDir, filename)), fs.readFileSync(path.join(status.migration.backupPath, filename)));
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2);
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks').get().n, 2);
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS n FROM mission_steps').get().n, 1);
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS n FROM mission_events').get().n, 1);
  assert.deepEqual(storage.db.prepare('PRAGMA foreign_key_check').all(), []);
  const rows = storage.list('library');
  storage.save('library', [], rows);
  storage.close();
  fs.writeFileSync(path.join(dataDir, 'projects.json'), '{invalid changed legacy');
  const reopened = open();
  assert.deepEqual(reopened.list('library'), [], 'legacy files cannot resurrect deleted records');
  assert.deepEqual(reopened.list('projects'), expected.projects, 'SQLite is authoritative after import');
});

test('bad JSON and duplicate ids abort the whole import; corrected sources can be retried', t => {
  const { open, dataDir } = fixture(t, { 'projects.json': [{ id: 'p' }], 'knowledge.json': '{bad' });
  assert.throws(() => open(), /Cannot import knowledge.json/);
  const db = new DatabaseSync(path.join(dataDir, 'localai.db'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM legacy_imports').get().n, 0);
  db.close();
  fs.writeFileSync(path.join(dataDir, 'knowledge.json'), '[{"id":"x"},{"id":"x"}]');
  assert.throws(() => open(), /duplicate id/);
  fs.writeFileSync(path.join(dataDir, 'knowledge.json'), '[{"id":"x","chunks":["text"]}]');
  assert.equal(open().count('projects'), 1);
});

test('empty initialization is durable and validates input and schema versions', t => {
  const { open, dataDir } = fixture(t), storage = open();
  assert.equal(storage.status().migration.files, 0);
  assert.throws(() => storage.upsert('projects', { name: 'No id' }), /string id/);
  assert.throws(() => storage.list('invented'), /Unknown/);
  assert.throws(() => storage.upsert('conversations', { id: 'c', messages: null }), /array/);
  assert.throws(() => storage.save('projects', []), /original full-read snapshot/);
  storage.close();
  const db = new DatabaseSync(path.join(dataDir, 'localai.db'));
  db.exec('PRAGMA user_version=999'); db.close();
  assert.throws(() => open(), /refusing to downgrade/);
});

test('stale collection writes preserve newer records, detect conflicts and cannot resurrect deletions', t => {
  const { open } = fixture(t), first = open(), second = open();
  first.upsert('agentRuns', { id: 'a', status: 'running' });
  const stale = first.list('agentRuns');
  second.upsert('agentRuns', { id: 'b', status: 'complete' });
  stale[0].status = 'complete';
  first.save('agentRuns', stale);
  assert.equal(second.count('agentRuns'), 2);
  assert.ok(second.list('agentRuns').every(item => item.status === 'complete'));
  const old = first.list('agentRuns');
  second.upsert('agentRuns', { id: 'a', status: 'cancelled' });
  old.find(item => item.id === 'b').status = 'error';
  first.save('agentRuns', old); // a was untouched in this snapshot.
  assert.equal(first.get('agentRuns', 'a').status, 'cancelled');
  old.find(item => item.id === 'a').status = 'error';
  assert.throws(() => first.save('agentRuns', old), StorageConflict);
  const beforeDelete = first.list('agentRuns'), newest = second.list('agentRuns');
  second.save('agentRuns', newest.filter(item => item.id !== 'b'), newest);
  beforeDelete.find(item => item.id === 'b').status = 'complete';
  assert.throws(() => first.save('agentRuns', beforeDelete), StorageConflict);
  assert.equal(first.get('agentRuns', 'b'), null);
});

test('transactions roll back parent and child writes together and reject async work', t => {
  const storage = fixture(t).open();
  assert.throws(() => storage.transaction(() => {
    storage.upsert('conversations', { id: 'c', messages: [{ role: 'user', content: 'test' }] });
    storage.upsert('knowledge', { id: 'k', chunks: ['abc'] });
    throw new Error('failure');
  }), /failure/);
  assert.equal(storage.count('conversations'), 0);
  assert.equal(storage.count('knowledge'), 0);
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
  assert.throws(() => storage.transaction(() => Promise.resolve()), /synchronous/);
  storage.upsert('conversations', { id: 'c', messages: [{ role: 'user', content: 'test' }] });
  const rows = storage.list('conversations'); storage.save('conversations', [], rows);
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
});

test('query pagination, project filtering, title escaping and full history work beyond old JSON caps', t => {
  const storage = fixture(t).open();
  storage.upsert('projects', { id: 'p' });
  storage.transaction(() => { for (let index = 0; index < 600; index++) storage.upsert('library', { id: 'a-' + index, title: 'Title ' + index, projectId: 'p' }); });
  assert.equal(storage.count('library', 'p'), 600);
  assert.deepEqual(storage.list('library', { projectId: 'p', limit: 2, offset: 1 }).map(item => item.id), ['a-598', 'a-597']);
  storage.upsert('library', { id: 'literal', title: '100%_complete' });
  assert.equal(storage.list('library', { search: '%_' }).length, 1);
  assert.throws(() => storage.list('library', { limit: 0 }), /limit/);
  assert.throws(() => storage.list('library', { offset: -1 }), /offset/);
  storage.upsert('knowledge', { id: 'orphan', projectId: 'later', chunks: ['Evidence'] });
  storage.upsert('projects', { id: 'later' });
  assert.equal(storage.db.prepare("SELECT project_id FROM knowledge_sources WHERE id='orphan'").get().project_id, 'later');
});

test('backup includes WAL writes, legacy export round trips every collection and downgrade permits re-upgrade', t => {
  const { open, dataDir } = fixture(t), storage = open();
  storage.upsert('projects', { id: 'p', name: 'Current project' });
  storage.upsert('conversations', { id: 'c', projectId: 'p', messages: [{ role: 'user', content: 'Durable' }] });
  storage.upsert('missions', { id: 'm', workers: [{ state: 'complete' }], timeline: [{ type: 'complete' }] });
  const backup = storage.backup(path.join(dataDir, 'backups', 'snapshot.db'));
  const db = new DatabaseSync(backup);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok'); db.close();
  assert.throws(() => storage.backup(backup), /new file/);
  assert.throws(() => storage.exportLegacy(dataDir), /new directory/);
  const exported = storage.exportLegacy(path.join(dataDir, 'export'));
  const imported = new Storage({ dataDir: exported });
  try { for (const collection of Object.keys(COLLECTIONS)) assert.deepEqual(imported.list(collection), storage.list(collection)); }
  finally { imported.close(); }
  storage.close();
  const result = cli(['downgrade-json', '--data-dir', dataDir, '--output', path.join(dataDir, 'downgrade')]);
  assert.equal(result.downgraded, true);
  assert.equal(fs.existsSync(path.join(dataDir, 'localai.db')), false);
  fs.writeFileSync(path.join(dataDir, 'projects.json'), '[{"id":"p","name":"Edited by old server"}]');
  assert.equal(open().get('projects', 'p').name, 'Edited by old server');
});

test('separate writer processes commit all records without lost writes', async t => {
  const { dataDir, open } = fixture(t); open().close();
  const worker = `const {Storage}=require(process.argv[1]);const s=new Storage({dataDir:process.argv[2]});for(let i=0;i<30;i++)s.upsert('activity',{id:process.argv[3]+'-'+i,title:'Concurrent'});s.close();`;
  const results = await Promise.all(['first', 'second', 'third'].map(prefix => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', worker, path.resolve(__dirname, '../app/storage.js'), dataDir, prefix]);
    let errors = ''; child.stderr.on('data', chunk => errors += chunk);
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(errors)));
  })));
  assert.equal(results.length, 3);
  assert.equal(open().count('activity'), 90);
});

test('inspection validates legacy JSON without importing, backing up or creating a database', t => {
  const { dataDir } = fixture(t, { 'projects.json': [{ id: 'p' }] });
  const before = fs.readdirSync(dataDir);
  const status = cli(['status', '--data-dir', dataDir]);
  assert.equal(status.engine, 'json');
  assert.equal(status.counts.projects, 1);
  assert.equal(cli(['check', '--data-dir', dataDir]).migrationPending, true);
  assert.deepEqual(fs.readdirSync(dataDir), before);
  assert.throws(() => inspectData(path.join(dataDir, 'missing')), /does not exist/);
  assert.equal(fs.existsSync(path.join(dataDir, 'missing')), false);
  fs.writeFileSync(path.join(dataDir, 'projects.json'), '{invalid');
  assert.throws(() => cli(['check', '--data-dir', dataDir]), /invalid JSON/);
  assert.deepEqual(fs.readdirSync(dataDir), before);
});

test('inspection opens existing SQLite read-only and cannot modify state or migrate schemas', t => {
  const { open, dataDir } = fixture(t), writer = open();
  writer.upsert('projects', { id: 'p', name: 'Live' });
  const inspector = open({ readOnly: true });
  assert.equal(inspector.get('projects', 'p').name, 'Live');
  assert.throws(() => inspector.upsert('projects', { id: 'new' }), /Read-only/);
  assert.throws(() => inspector.writeSetting('status', {}), /Read-only/);
  assert.equal(cli(['status', '--data-dir', dataDir]).counts.projects, 1);
  inspector.close(); writer.close();
  const db = new DatabaseSync(path.join(dataDir, 'localai.db'));
  db.exec('PRAGMA user_version=0'); db.close();
  assert.throws(() => inspectData(dataDir), /explicit migration/);
  const unchanged = new DatabaseSync(path.join(dataDir, 'localai.db'), { readOnly: true });
  assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 0); unchanged.close();
});

test('candidate preflight tests migration in disposable storage and leaves legacy data untouched on success/failure', t => {
  const { dataDir } = fixture(t, { 'projects.json': [{ id: 'p' }] });
  const before = fs.readFileSync(path.join(dataDir, 'projects.json'));
  const result = cli(['preflight', '--data-dir', dataDir]);
  assert.equal(result.sourceEngine, 'json');
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.counts.projects, 1);
  assert.equal(result.migrationTested, true);
  assert.deepEqual(fs.readdirSync(dataDir), ['projects.json']);
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'projects.json')), before);
  fs.writeFileSync(path.join(dataDir, 'knowledge.json'), '{invalid');
  assert.throws(() => preflightData(dataDir), /Cannot import knowledge.json/);
  assert.equal(fs.existsSync(path.join(dataDir, 'localai.db')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'backups')), false);
});

test('SQLite preflight includes current WAL commits and does not use stale JSON or change the source', t => {
  const { dataDir, open } = fixture(t), writer = open();
  writer.upsert('projects', { id: 'p', name: 'Live WAL commit' });
  const revision = writer.db.prepare("SELECT revision FROM projects WHERE id='p'").get().revision;
  fs.writeFileSync(path.join(dataDir, 'projects.json'), '{stale invalid JSON');
  const result = preflightData(dataDir);
  assert.equal(result.sourceEngine, 'sqlite');
  assert.equal(result.counts.projects, 1);
  assert.equal(writer.db.prepare("SELECT revision FROM projects WHERE id='p'").get().revision, revision);
  assert.equal(writer.get('projects', 'p').name, 'Live WAL commit');
  assert.equal(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8'), '{stale invalid JSON');
  writer.upsert('projects', { id: 'after', name: 'Writer remains usable' });
  assert.equal(writer.count('projects'), 2);
});
