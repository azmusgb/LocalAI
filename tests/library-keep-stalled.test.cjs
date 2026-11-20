'use strict';
// ☆ Keep files a conversation's answers (app/server/library.js setRunKept). A turn that stalled keeps what arrived on its
// run (output {text, stalled: true}, app/server/chat.js) so the run view can show it as cut off; that text is not an
// answer, so Keep never files it as a turn, the item's summary or its response. Nor does it file a turn that failed or
// was cancelled.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../app/storage');
const { RunLedger } = require('../app/run-ledger');
const { spawnAppServer } = require('./spawn-server.cjs');

const off = 'http://127.0.0.1:9';
const ENV = { OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off };
const tempDir = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-keep-stalled-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
async function boot(t, dataDir) {
  const { child, ready } = spawnAppServer({ env: { ...ENV, DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir } });
  t.after(() => child.kill());
  return ready;
}
const keep = async (base, runId) => {
  const r = await fetch(`${base}/api/library/keep`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId, kept: true }) });
  return { status: r.status, body: await r.json() };
};

// A thread: an answered turn, then the turns named in `rest` (each a function that finishes a new run its own way).
function seed(dataDir, rest) {
  const s = new Storage({ dataDir });
  try {
    const ledger = new RunLedger({ storage: s });
    const first = ledger.create({ type: 'chat', title: 'What is a lock' });
    ledger.complete(first.id, { summary: 'A lock guards a resource.', output: { text: 'A lock guards a resource.' } });
    const ids = rest.map(finish => { const r = ledger.create({ type: 'chat', title: 'What is a mutex', threadId: first.threadId }); finish(ledger, r.id); return r.id; });
    return { first: first.id, ids };
  } finally { s.close(); }
}
const stall = (ledger, id) => { ledger.fail(id, 'No reply after 180 s'); ledger.update(id, { output: { text: 'A mutex ', stalled: true } }); };

test('Keep on a thread whose last turn stalled files the answered turns only; the cut-off text is no answer', async t => {
  const dataDir = tempDir(t);
  const { first, ids: [cut] } = seed(dataDir, [stall]);
  const base = await boot(t, dataDir);
  const { status, body } = await keep(base, cut);
  assert.equal(status, 200, JSON.stringify(body));
  const it = body.item;
  assert.deepEqual(Object.keys(it.data.turns), [first], 'only the answered turn is filed');
  assert.equal(it.data.response, 'A lock guards a resource.');
  assert.equal(it.summary, 'A lock guards a resource.');
  assert.ok(!JSON.stringify(it).includes('A mutex '), 'the partial text is nowhere in the item');
});

test('Keep files no failed or cancelled turn, and a thread with no answer at all keeps no answer', async t => {
  const dataDir = tempDir(t);
  const failed = (ledger, id) => { ledger.fail(id, 'Model offline'); ledger.update(id, { output: { text: 'half' } }); };
  const cancelled = (ledger, id) => ledger.cancel(id, 'Client disconnected');
  const { first, ids } = seed(dataDir, [failed, cancelled]);
  const base = await boot(t, dataDir);
  const { body } = await keep(base, ids[1]);
  assert.deepEqual(Object.keys(body.item.data.turns), [first]);
  assert.equal(body.item.data.response, 'A lock guards a resource.');

  // Only a stalled turn: kept, with no answer, not the cut-off text.
  const dir2 = tempDir(t);
  const s = new Storage({ dataDir: dir2 });
  let only;
  try { const ledger = new RunLedger({ storage: s }); only = ledger.create({ type: 'chat', title: 'What is a mutex' }).id; stall(ledger, only); } finally { s.close(); }
  const base2 = await boot(t, dir2);
  const r2 = await keep(base2, only);
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.deepEqual(r2.body.item.data.turns, {});
  assert.equal(r2.body.item.data.response, '');
  assert.equal(r2.body.item.summary, '');
});
