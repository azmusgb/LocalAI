'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { Storage } = require('../app/storage');
const { createPrintLab } = require('../app/print-lab');

function harness(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-lab-req-'));
  const storage = new Storage({ dataDir });
  t.after(() => { storage.close?.(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  const json = (res, status, body) => {
    res.status = status;
    res.body = body;
    res.headers = res.headers || {};
  };

  let device = { id: 'dev-phone-1', name: 'iPhone' };
  let mac = false;

  const lab = createPrintLab({
    storage,
    dataDir,
    json,
    macAuthorized: req => Boolean(req.mac || mac),
    deviceFor: req => req.device !== undefined ? req.device : device,
    now: () => '2026-10-25T12:00:00.000Z'
  });

  const call = async (method, p, { body, asMac = false, dev, headers = {} } = {}) => {
    const res = {
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      writeHead(status, hdrs = {}) {
        this.status = status;
        Object.assign(this.headers, hdrs);
      },
      end(data) { this.body = data; }
    };

    let rawBuf;
    if (Buffer.isBuffer(body)) {
      rawBuf = body;
    } else if (body !== undefined) {
      rawBuf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    }

    const reqStream = rawBuf ? Readable.from([rawBuf]) : Readable.from([]);
    reqStream.method = method;
    reqStream.url = p;
    reqStream.headers = {
      host: 'localai.test',
      ...headers,
      ...(rawBuf ? { 'content-length': String(rawBuf.length) } : {})
    };
    reqStream.mac = asMac;
    reqStream.device = dev !== undefined ? dev : (asMac ? null : device);

    const pathname = p.split('?')[0];
    await lab.handle(reqStream, res, pathname);
    return res;
  };

  return { lab, storage, dataDir, call };
}

test('a paired phone sends a request; the Mac sees it pending and posts the result', async t => {
  const { call } = harness(t);
  const reqId = 'rq-0123456789abcdef';

  const send = await call('POST', '/api/lab/hex-tile/requests', {
    body: {
      id: reqId,
      kind: 'verdict',
      experiment: 'E-012',
      run: 'PR-012-01',
      payload: { grades: { 'E-012-A': { print: 'clean' } } }
    }
  });
  assert.equal(send.status, 200);
  assert.deepEqual(send.body, { ok: true, id: reqId, status: 'pending' });

  const listPhone = await call('GET', '/api/lab/hex-tile/requests');
  assert.equal(listPhone.status, 200);
  assert.equal(listPhone.body.items.length, 1);
  assert.equal(listPhone.body.items[0].id, reqId);
  assert.equal(listPhone.body.items[0].status, 'pending');
  assert.equal(listPhone.body.items[0].run, undefined, 'device list omits payload and run');

  const listMac = await call('GET', '/api/lab/hex-tile/requests?status=pending', { asMac: true });
  assert.equal(listMac.status, 200);
  assert.equal(listMac.body.items.length, 1);
  assert.equal(listMac.body.items[0].id, reqId);
  assert.equal(listMac.body.items[0].run, 'PR-012-01');
  assert.deepEqual(listMac.body.items[0].payload, { grades: { 'E-012-A': { print: 'clean' } } });

  const postRes = await call('POST', `/api/lab/hex-tile/requests/${reqId}/result`, {
    asMac: true,
    body: { status: 'applied', message: 'E-012 answered' }
  });
  assert.equal(postRes.status, 200);
  assert.deepEqual(postRes.body, { ok: true });

  const listAfter = await call('GET', '/api/lab/hex-tile/requests');
  assert.equal(listAfter.status, 200);
  assert.equal(listAfter.body.items[0].status, 'applied');
  assert.equal(listAfter.body.items[0].message, 'E-012 answered');

  const pendingAfter = await call('GET', '/api/lab/hex-tile/requests?status=pending', { asMac: true });
  assert.equal(pendingAfter.status, 200);
  assert.equal(pendingAfter.body.items.length, 0);
});

test('the same id sent twice is stored once', async t => {
  const { call } = harness(t);
  const reqId = 'rq-1111222233334444';
  const payload = {
    id: reqId,
    kind: 'verdict',
    experiment: 'E-012',
    run: 'PR-012-01',
    payload: { grades: { 'E-012-A': { print: 'clean' } } }
  };

  const r1 = await call('POST', '/api/lab/hex-tile/requests', { body: payload });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.status, 'pending');

  await call('POST', `/api/lab/hex-tile/requests/${reqId}/result`, {
    asMac: true,
    body: { status: 'applied', message: 'done' }
  });

  const r2 = await call('POST', '/api/lab/hex-tile/requests', { body: payload });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.status, 'applied');

  const list = await call('GET', '/api/lab/hex-tile/requests');
  assert.equal(list.body.items.length, 1);
});

test('no device: 401 with the pairing message', async t => {
  const { call } = harness(t);
  const rPost = await call('POST', '/api/lab/hex-tile/requests', {
    dev: null,
    body: { id: 'rq-0000000000000001', kind: 'verdict', experiment: 'E-001', run: 'PR-001-01', payload: {} }
  });
  assert.equal(rPost.status, 401);
  assert.equal(rPost.body.error, "This phone isn't paired with Local AI. Pair it in Settings › Devices.");

  const rPut = await call('PUT', '/api/lab/hex-tile/incoming/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.jpg', {
    dev: null,
    body: Buffer.from([0xff, 0xd8])
  });
  assert.equal(rPut.status, 401);
  assert.equal(rPut.body.error, "This phone isn't paired with Local AI. Pair it in Settings › Devices.");
});

test('pending list and result need the Mac key', async t => {
  const { call } = harness(t);
  const rPending = await call('GET', '/api/lab/hex-tile/requests?status=pending', { asMac: false });
  assert.equal(rPending.status, 401);

  const rResult = await call('POST', '/api/lab/hex-tile/requests/rq-0000000000000001/result', {
    asMac: false,
    body: { status: 'applied', message: 'ok' }
  });
  assert.equal(rResult.status, 401);

  const rIncoming = await call('GET', '/api/lab/hex-tile/incoming/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.jpg', {
    asMac: false
  });
  assert.equal(rIncoming.status, 401);
});

test('kind other than verdict/photos, bad ids, over 4 KB are refused', async t => {
  const { call } = harness(t);

  const rKind = await call('POST', '/api/lab/hex-tile/requests', {
    body: { id: 'rq-0000000000000001', kind: 'other', experiment: 'E-001', run: 'PR-001-01', payload: {} }
  });
  assert.equal(rKind.status, 422);

  const rId = await call('POST', '/api/lab/hex-tile/requests', {
    body: { id: 'bad-id', kind: 'verdict', experiment: 'E-001', run: 'PR-001-01', payload: {} }
  });
  assert.equal(rId.status, 422);

  const rExp = await call('POST', '/api/lab/hex-tile/requests', {
    body: { id: 'rq-0000000000000001', kind: 'verdict', experiment: 'bad_exp', run: 'PR-001-01', payload: {} }
  });
  assert.equal(rExp.status, 422);

  const rRun = await call('POST', '/api/lab/hex-tile/requests', {
    body: { id: 'rq-0000000000000001', kind: 'verdict', experiment: 'E-001', run: 'bad_run', payload: {} }
  });
  assert.equal(rRun.status, 422);

  const rBig = await call('POST', '/api/lab/hex-tile/requests', {
    body: {
      id: 'rq-0000000000000001',
      kind: 'verdict',
      experiment: 'E-001',
      run: 'PR-001-01',
      payload: { pad: 'x'.repeat(5 * 1024) }
    }
  });
  assert.equal(rBig.status, 413);
});

test('the 21st pending request gets 429 with the Mac-awake message', async t => {
  const { call } = harness(t);
  for (let i = 1; i <= 20; i++) {
    const id = `rq-${String(i).padStart(16, '0')}`;
    const r = await call('POST', '/api/lab/hex-tile/requests', {
      body: { id, kind: 'verdict', experiment: 'E-001', run: 'PR-001-01', payload: {} }
    });
    assert.equal(r.status, 200);
  }

  const r21 = await call('POST', '/api/lab/hex-tile/requests', {
    body: { id: 'rq-0000000000000021', kind: 'verdict', experiment: 'E-001', run: 'PR-001-01', payload: {} }
  });
  assert.equal(r21.status, 429);
  assert.equal(r21.body.error, "The Mac hasn't picked up the last 20 requests. Check that the Mac is awake.");
});

test('incoming photo: JPEG only, sha must match, 8 MB cap; applied request removes it', async t => {
  const { call, dataDir } = harness(t);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const sha = crypto.createHash('sha256').update(jpg).digest('hex');

  const rNotJpg = await call('PUT', `/api/lab/hex-tile/incoming/${sha}.jpg`, {
    body: Buffer.from('plain-text')
  });
  assert.equal(rNotJpg.status, 415);
  assert.equal(rNotJpg.body.error, 'Only JPEG photos.');

  const rBadSha = await call('PUT', `/api/lab/hex-tile/incoming/${'a'.repeat(64)}.jpg`, {
    body: jpg
  });
  assert.equal(rBadSha.status, 422);
  assert.equal(rBadSha.body.error, "The photo doesn't match its sha256.");

  const rOk = await call('PUT', `/api/lab/hex-tile/incoming/${sha}.jpg`, {
    body: jpg
  });
  assert.equal(rOk.status, 200);
  assert.deepEqual(rOk.body, { ok: true });

  const rGet = await call('GET', `/api/lab/hex-tile/incoming/${sha}.jpg`, { asMac: true });
  assert.equal(rGet.status, 200);
  assert.ok(Buffer.from(rGet.body).equals(jpg));

  const reqId = 'rq-9999999999999999';
  await call('POST', '/api/lab/hex-tile/requests', {
    body: {
      id: reqId,
      kind: 'photos',
      experiment: 'E-001',
      run: 'PR-001-01',
      payload: { photos: [{ sha256: sha, tab: '01A' }] }
    }
  });

  const photoPath = path.join(dataDir, 'print-lab', 'hex-tile', 'incoming', `${sha}.jpg`);
  assert.ok(fs.existsSync(photoPath));

  await call('POST', `/api/lab/hex-tile/requests/${reqId}/result`, {
    asMac: true,
    body: { status: 'applied', message: '1 photo added' }
  });

  assert.ok(!fs.existsSync(photoPath), 'incoming photo removed after applied');
});

test('the existing sync and photo routes still need the Mac key', async t => {
  const { call } = harness(t);
  const rSync = await call('POST', '/api/lab/hex-tile/sync', {
    asMac: false,
    body: { schema: 'print-lab-index/1', project: 'hex-tile', generated_at: '2026-10-25T12:00:00Z', fingerprint: 'f' }
  });
  assert.equal(rSync.status, 401);
  assert.match(rSync.body.error, /Only the Mac/);

  const rPhoto = await call('PUT', `/api/lab/hex-tile/photos/${'b'.repeat(64)}.jpg`, {
    asMac: false,
    body: Buffer.from([0xff, 0xd8, 1, 2])
  });
  assert.equal(rPhoto.status, 401);
  assert.match(rPhoto.body.error, /Only the Mac/);
});
