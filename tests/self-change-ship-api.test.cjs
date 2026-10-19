'use strict';

// Changes to Local AI itself ship as a pull request: approving one hands its Improve item to Claude instead of
// queueing it for a host updater that doesn't exist.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../app/storage');
const { spawnAppServer } = require('./spawn-server.cjs');

const APP = path.resolve(__dirname, '../app');

// Starts a server on its own data folder. `seed(storage)` runs first; `release` runs a copy of app/ with a release.json.
async function startServer(t, { seed, release, ollama } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-improve-'));
  if (seed) { const storage = new Storage({ dataDir }); seed(storage); storage.close?.(); }
  let appDir = APP;
  if (release) {
    appDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'localai-app-')), 'app');
    fs.cpSync(APP, appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'release.json'), JSON.stringify(release));
  }
  const { child, ready } = spawnAppServer({ appDir, env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: ollama || 'http://127.0.0.1:9' } });
  t.after(() => { child.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); if (release) fs.rmSync(path.dirname(appDir), { recursive: true, force: true }); });
  return ready;
}
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));

const change = (id, status, extra = {}) => ({ id, target: 'self', root: 'app', request: `Make ${id} better\nmore`, summary: 'Proposed change', files: [{ path: 'public/x.js' }], status, createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z', ...extra });
const getChange = async (base, id) => (await (await fetch(base + '/api/changes')).json()).items.find(c => c.id === id);
const findingFor = async (base, changeId) => { const b = await (await fetch(base + '/api/claude/board')).json(); return (b.findings || b.items || []).find(f => f.changeId === changeId); };
const handedNotices = async base => (await (await fetch(base + '/api/notifications')).json()).items.filter(n => n.title === 'Handed to Claude to ship').length;

test('approving a self change hands it to Claude to ship as a pull request', { timeout: 30000 }, async t => {
  const base = await startServer(t, { seed: s => {
    s.put('changes', change('chg-a', 'approved'), 0);
    s.writeSetting('claude-finding/idea-a', { id: 'idea-a', sessionId: 'owner', title: 'Make it better', category: 'idea', severity: 'medium', status: 'approved', source: 'idea', changeId: 'chg-a', votes: { up: 0, down: 0 }, priorityBoost: 0, createdAt: '2026-10-15T00:00:00.000Z' });
  } });
  const r = await post(base, '/api/changes/request-apply', { id: 'chg-a' });
  assert.equal(r.status, 200);
  assert.equal(r.body.shipVia, 'pr');
  assert.equal(r.body.improveItemId, 'idea-a');
  const c = await getChange(base, 'chg-a');
  assert.equal(c.status, 'approved', 'no longer apply_requested');
  assert.equal(c.shipVia, 'pr');
  const f = await findingFor(base, 'chg-a');
  assert.equal(f.handedToClaude, true);
  assert.match(f.fix, /chg-a/);
  assert.match(f.fix, /\/api\/changes\/deploy-result/);
  // A second request changes nothing and doesn't notify again.
  assert.equal((await post(base, '/api/changes/request-apply', { id: 'chg-a' })).status, 200);
  assert.equal(await handedNotices(base), 1);
  // The session reports the deploy; Improve moves the item to Shipped.
  assert.equal((await post(base, '/api/changes/deploy-result', { id: 'chg-a', status: 'applied' })).status, 200);
  const shipped = (await (await fetch(base + '/api/claude/board')).json());
  const item = (shipped.findings || shipped.items).find(x => x.id === 'idea-a');
  assert.equal(item.status, 'fixed');
});

test('an approved self change with no Improve item gets one, titled from its request', { timeout: 30000 }, async t => {
  const base = await startServer(t, { seed: s => s.put('changes', change('chg-b', 'approved'), 0) });
  const r = await post(base, '/api/changes/request-apply', { id: 'chg-b' });
  assert.equal(r.body.improveItemId, 'idea-change-chg-b');
  const f = await findingFor(base, 'chg-b');
  assert.equal(f.title, 'Make chg-b better');
  assert.equal(f.handedToClaude, true);
});

test('changes left waiting for the old host updater are handed over at start-up', { timeout: 30000 }, async t => {
  const base = await startServer(t, { seed: s => s.put('changes', change('chg-q', 'apply_requested'), 0) });
  const c = await getChange(base, 'chg-q');
  assert.equal(c.status, 'approved');
  assert.equal(c.shipVia, 'pr');
  assert.equal((await findingFor(base, 'chg-q')).handedToClaude, true);
});

// Closing an Improve item ends its unfinished change, so it stops counting on Home and in "What needs me".
const seedItemFor = (s, id, changeId, status) => s.writeSetting('claude-finding/' + id, { id, sessionId: 'owner', title: 'Item ' + id, category: 'idea', severity: 'medium', status, source: 'idea', changeId, votes: { up: 0, down: 0 }, priorityBoost: 0, createdAt: '2026-10-15T00:00:00.000Z' });

test('deciding an item fixed retires its planned change; a change being shipped is left alone', { timeout: 30000 }, async t => {
  const base = await startServer(t, { seed: s => {
    s.put('changes', change('chg-p', 'planned'), 0); seedItemFor(s, 'idea-p', 'chg-p', 'approved');
    s.put('changes', change('chg-s', 'approved', { shipVia: 'pr' }), 1); seedItemFor(s, 'idea-s', 'chg-s', 'approved');
  } });
  assert.equal((await post(base, '/api/claude/findings/decision', { id: 'idea-p', status: 'fixed', note: 'Done elsewhere' })).status, 200);
  assert.equal((await getChange(base, 'chg-p')).status, 'rejected');
  assert.equal((await post(base, '/api/claude/findings/decision', { id: 'idea-s', status: 'fixed' })).status, 200);
  assert.equal((await getChange(base, 'chg-s')).status, 'approved');
  assert.equal((await (await fetch(base + '/api/capabilities')).json()).changes.pending, 1);
});

test('changes whose items were closed before are retired at start-up', { timeout: 30000 }, async t => {
  const base = await startServer(t, { seed: s => {
    s.put('changes', change('chg-o', 'planned'), 0); seedItemFor(s, 'idea-o', 'chg-o', 'fixed');
    s.put('changes', change('chg-k', 'planned'), 1); seedItemFor(s, 'idea-k', 'chg-k', 'approved');
  } });
  assert.equal((await getChange(base, 'chg-o')).status, 'rejected');
  assert.equal((await getChange(base, 'chg-k')).status, 'planned', 'an open item keeps its change');
});

// "What needs me?" says what Home's Needs you lists (tests/glance-needs.test.cjs); change requests live in Improve, not
// there, so neither one being shipped nor one that failed to stage is spoken as needing you.
test('what needs me leaves out change requests, as Home does: one being shipped as a pull request or one that failed', { timeout: 30000 }, async t => {
  const base = await startServer(t, { seed: s => {
    s.put('changes', change('chg-ship', 'approved', { shipVia: 'pr' }), 0); seedItemFor(s, 'idea-ship', 'chg-ship', 'approved');
    s.put('changes', change('chg-fail', 'patch_failed'), 1); seedItemFor(s, 'idea-fail', 'chg-fail', 'approved');
  } });
  const spoken = await (await fetch(base + '/api/glance/ask?q=' + encodeURIComponent('what needs me'))).text();
  assert.doesNotMatch(spoken, /Item idea-fail/);
  assert.doesNotMatch(spoken, /Item idea-ship/);
  assert.match(spoken, /need/);
});

test('a bad record does not stop the appliance starting', { timeout: 30000 }, async t => {
  const base = await startServer(t, { seed: s => {
    s.put('changes', { id: 'chg-bad', target: 'self', status: 'apply_requested' }, 0);
    s.writeSetting('claude-finding/idea-bad', { id: 'idea-bad', status: 'fixed', changeId: 'chg-bad' });
  } });
  assert.equal((await fetch(base + '/healthz')).status, 200);
});

// Work's old runs: garbled encoding and markdown bold are cleaned once at start-up; the run keeps its place in time.
test('old runs with garbled text or markdown bold are cleaned at start-up, keeping their dates', { timeout: 30000 }, async t => {
  const { RunLedger } = require('../app/run-ledger');
  let id, createdAt;
  const base = await startServer(t, { seed: s => {
    const ledger = new RunLedger({ storage: s });
    const r = ledger.create({ type: 'agent', title: '**Dev Design & Specification**', summary: 'An idÃƒÂ©e' });
    ledger.complete(r.id, { summary: 'An idÃƒÂ©e' }); id = r.id; createdAt = ledger.get(r.id).createdAt;
  } });
  const run = (await (await fetch(`${base}/api/runs?id=${id}`)).json()).item;
  assert.equal(run.title, 'Dev Design & Specification');
  assert.equal(run.summary, 'An idée');
  assert.equal(run.createdAt, createdAt);
});

// Work's old image runs: the summary put the count before the size ("1 704 × 1024 image…"), so the count read as a
// width. Repaired once at start-up; modern summaries and the run's dates are untouched.
test('old image-run summaries are rewritten at start-up, keeping their dates', { timeout: 30000 }, async t => {
  const { RunLedger } = require('../app/run-ledger');
  const seeded = {};
  const base = await startServer(t, { seed: s => {
    const ledger = new RunLedger({ storage: s });
    for (const [key, summary] of [['one', '1 704 × 1024 image edited with Quality (X)'], ['many', '3 1024 × 680 images edited with Quality (X)'], ['modern', 'Image edited with Quality (X) · 704 × 1024']]) {
      const r = ledger.create({ type: 'image', title: 'A picture', summary });
      ledger.complete(r.id, { summary });
      const saved = ledger.get(r.id);
      seeded[key] = { id: r.id, createdAt: saved.createdAt, finishedAt: saved.finishedAt };
    }
  } });
  const fetchRun = async id => (await (await fetch(`${base}/api/runs?id=${id}`)).json()).item;
  assert.equal((await fetchRun(seeded.one.id)).summary, '704 × 1024 image, edited with Quality (X)');
  assert.equal((await fetchRun(seeded.many.id)).summary, '3 images, 1024 × 680, edited with Quality (X)');
  assert.equal((await fetchRun(seeded.modern.id)).summary, 'Image edited with Quality (X) · 704 × 1024');
  for (const k of ['one', 'many', 'modern']) {
    const run = await fetchRun(seeded[k].id);
    assert.equal(run.createdAt, seeded[k].createdAt, `${k} createdAt`);
    assert.equal(run.finishedAt, seeded[k].finishedAt, `${k} finishedAt`);
  }
});
