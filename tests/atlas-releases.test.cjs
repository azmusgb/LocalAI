'use strict';
// Step 10 (platform baseline 6.4): Atlas snapshots each live release's commit, from Pi Hub's release records.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAtlasReleaseTrigger, liveCommits } = require('../app/atlas-releases.js');

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40);
const records = (...rows) => ({ records: rows.map(([target, commit]) => ({ id: `release:${target}`, detail: { commit } })) });
const REPOS = ['localai', 'pi-hub', 'print-lab'];

function harness({ body, have = [], answers = [], clock = 1_000_000 } = {}) {
  const asked = [], fetched = [];
  let t = clock;
  const trigger = createAtlasReleaseTrigger({
    hubUrl: 'http://hub.test',
    fetchImpl: async (url) => { fetched.push(String(url)); if (body instanceof Error) throw body; return { ok: true, json: async () => body }; },
    snapshots: { list: () => ({ repos: REPOS, snapshots: have.map(([repo, commit]) => ({ repo, commit })) }) },
    requestSnapshot: async (repo, commit) => { asked.push([repo, commit]); return answers.length ? answers.shift() : { ok: true, status: 202 }; },
    now: () => t
  });
  return { trigger, asked, fetched, advance: (ms) => { t += ms; } };
}

test('maps release targets to repositories, once per commit, skipping repos Atlas does not keep', () => {
  const body = records(['pi-hub', A], ['localai', B], ['mac-watch', B], ['print-lab', C], ['firmware', D], ['netmon', D], ['x2d-bridge-mac', D]);
  assert.deepEqual(liveCommits(body, new Set(REPOS)).map((x) => [x.repo, x.commit]), [['pi-hub', A], ['localai', B], ['print-lab', C]]);
  assert.deepEqual(liveCommits({ records: [{ id: 'release:localai', detail: { commit: 'abc1234' } }, { id: 'printer', detail: {} }] }, new Set(REPOS)), []);
  assert.deepEqual(liveCommits(null, new Set(REPOS)), []);
});

test('the firmware release record maps to the smart display repository', () => {
  assert.deepEqual(liveCommits(records(['firmware', D]), new Set([...REPOS, 'bambuhelper-smart-display'])),
    [{ target: 'firmware', repo: 'bambuhelper-smart-display', commit: D }]);
  assert.deepEqual(liveCommits(records(['firmware', D]), new Set(REPOS)), []); // still skipped while Atlas keeps no such repo
});

test('asks for a snapshot of each live commit it has not got, from GET /api/records', async () => {
  const h = harness({ body: records(['pi-hub', A], ['localai', B], ['print-lab', C]), have: [['localai', B]] });
  assert.deepEqual(await h.trigger.tick(), [`pi-hub@${A}`, `print-lab@${C}`]);
  assert.deepEqual(h.fetched, ['http://hub.test/api/records']);
  assert.deepEqual(h.asked, [['pi-hub', A], ['print-lab', C]]);
});

test('does not ask again while a requested snapshot is pending; asks again after 30 minutes', async () => {
  const h = harness({ body: records(['pi-hub', A]) });
  await h.trigger.tick();
  await h.trigger.tick();
  assert.equal(h.asked.length, 1);
  h.advance(31 * 60 * 1000);
  await h.trigger.tick();
  assert.equal(h.asked.length, 2);
});

test('a refused request is retried next pass; a full queue (429) stops this pass', async () => {
  const h = harness({ body: records(['pi-hub', A], ['localai', B]), answers: [{ ok: false, status: 502 }, { ok: false, status: 429 }] });
  assert.deepEqual(await h.trigger.tick(), []);
  assert.deepEqual(h.asked, [['pi-hub', A], ['localai', B]]);
  assert.deepEqual(await h.trigger.tick(), [`pi-hub@${A}`, `localai@${B}`]);
});

test('Pi Hub unreachable, or off, asks for nothing and never throws', async () => {
  const h = harness({ body: new Error('ECONNREFUSED') });
  assert.deepEqual(await h.trigger.tick(), []);
  assert.equal(h.asked.length, 0);
  const off = createAtlasReleaseTrigger({ hubUrl: 'off', snapshots: { list: () => ({ repos: [], snapshots: [] }) }, requestSnapshot: async () => ({ ok: true }) });
  assert.deepEqual(await off.tick(), []);
  assert.equal(off.start(), null);
});

test('the Architecture page opens #architecture?repo=&commit= (Pi Hub Versions links there)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../app/public/architecture.js'), 'utf8');
  assert.match(src, /function fromHash\(\)/);
  assert.match(src, /addEventListener\('hashchange'/);
  const server = fs.readFileSync(path.resolve(__dirname, '../app/server.js'), 'utf8');
  assert.match(server, /require\('\.\/atlas-releases'\)\.createAtlasReleaseTrigger\(/);
});
