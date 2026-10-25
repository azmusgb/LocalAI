'use strict';

// Print lab: the Mac pushes its read-only projection; Local AI stores it and never changes it (app/print-lab.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');

const KEY = 'test-mac-key-print-lab';
let child, dataDir, base;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-lab-'));
  fs.writeFileSync(path.join(dataDir, 'claude-chat-mac-key.sha256'), crypto.createHash('sha256').update(KEY).digest('hex'));
  const off = 'http://127.0.0.1:9';
  let ready;
  ({ child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, GRIDCRAFT_URL: off, LOCALAI_BAMBUDDY_URL: off, LOCALAI_PI_HUB_URL: off } }));
  base = await ready;
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const MAC = { 'X-LocalAI-Mac-Key': KEY };
const rec = (id, n = 1) => ({ type: id.startsWith('Q') ? 'question' : 'experiment', file: `x/${id}.json`, sha256: String(n).repeat(64).slice(0, 64), payload: { id, n } });
const index = (at, records, extra = {}) => ({ schema: 'print-lab-index/1', project: 'hex-tile', generated_at: at, fingerprint: crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex'), questions: [], experiments: [{ id: 'E-001', photos: [] }], needs: [], problems: [], records, ...extra });
async function call(method, p, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const r = await fetch(base + p, { method, headers: { ...(body && !isBuf ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body) });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
}

test('only the Mac writes; reads say what to do before the first sync', async () => {
  assert.equal((await call('POST', '/api/lab/hex-tile/sync', index('2026-10-25T01:00:00Z', {}))).status, 401);
  const r = await call('GET', '/api/lab/hex-tile');
  assert.equal(r.status, 404);
  assert.match(r.body.error, /lab sync/);
});

test('a push is stored, re-pushing is a no-op, an older push is refused and gone records are removed', async () => {
  let r = await call('POST', '/api/lab/hex-tile/sync', index('2026-10-25T02:00:00Z', { 'E-001': rec('E-001'), 'Q-001': rec('Q-001') }), MAC);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.upserted, r.body.removed], [2, 0]);
  r = await call('POST', '/api/lab/hex-tile/sync', index('2026-10-25T02:00:00Z', { 'E-001': rec('E-001'), 'Q-001': rec('Q-001') }), MAC);
  assert.deepEqual([r.body.upserted, r.body.unchanged], [0, 2]);
  r = await call('POST', '/api/lab/hex-tile/sync', index('2026-10-25T01:30:00Z', { 'E-001': rec('E-001', 2) }), MAC);
  assert.equal(r.status, 409);
  r = await call('POST', '/api/lab/hex-tile/sync', index('2026-10-25T03:00:00Z', { 'E-001': rec('E-001', 3) }), MAC);
  assert.deepEqual([r.body.upserted, r.body.removed], [1, 1]);
  const got = await call('GET', '/api/lab/hex-tile');
  assert.equal(got.status, 200);
  assert.equal(got.body.meta.generated_at, '2026-10-25T03:00:00Z');
  assert.equal(got.body.index.records, undefined, 'the index travels without the originals');
  assert.equal((await call('GET', '/api/lab/hex-tile/record/E-001')).body.payload.n, 3);
  assert.equal((await call('GET', '/api/lab/hex-tile/record/Q-001')).status, 404);
  assert.deepEqual((await call('GET', '/api/lab/projects')).body.projects.map(p => p.name), ['hex-tile']);
});

test('a push with the wrong schema or project is refused', async () => {
  assert.equal((await call('POST', '/api/lab/hex-tile/sync', { ...index('2026-10-25T04:00:00Z', {}), schema: 'v0' }, MAC)).status, 422);
  assert.equal((await call('POST', '/api/lab/hex-tile/sync', { ...index('2026-10-25T04:00:00Z', {}), project: 'other' }, MAC)).status, 422);
});

test('photos go up once by their sha256, must be JPEGs that match it, and come back cached', async () => {
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const sha = crypto.createHash('sha256').update(jpg).digest('hex');
  assert.equal((await call('PUT', `/api/lab/hex-tile/photos/${sha}.jpg`, jpg)).status, 401);
  assert.equal((await call('PUT', `/api/lab/hex-tile/photos/${sha}.jpg`, Buffer.from('not a jpeg'), MAC)).status, 415);
  assert.equal((await call('PUT', `/api/lab/hex-tile/photos/${'0'.repeat(64)}.jpg`, jpg, MAC)).status, 422);
  assert.equal((await call('PUT', `/api/lab/hex-tile/photos/${sha}.jpg`, jpg, MAC)).status, 200);
  assert.deepEqual((await call('GET', '/api/lab/hex-tile/photos')).body.have, [sha]);
  const r = await call('GET', `/api/lab/hex-tile/photo/${sha}.jpg`);
  assert.equal(r.status, 200);
  assert.ok(r.body.equals(jpg));
  assert.match(r.headers.get('cache-control'), /immutable/);
});

test('a push over 4 MB is refused', async () => {
  const big = index('2026-10-25T05:00:00Z', {}, { pad: 'x'.repeat(4.5 * 1024 * 1024) });
  assert.equal((await call('POST', '/api/lab/hex-tile/sync', big, MAC)).status, 413);
});
