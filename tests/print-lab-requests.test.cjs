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

function harness(t, opts = {}) {
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
    now: () => '2026-10-25T12:00:00.000Z',
    ...opts
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

// ---- the page's buttons: start, approve, abandon (print-lab lab/pull.py applies them) ----
const act = (id, kind, payload, extra = {}) => ({ id, kind, experiment: 'E-020', payload, ...extra });

test('start, approve and abandon are queued with no run, and the Mac sees exactly what lab pull reads', async t => {
  const { call } = harness(t);
  const tapped = '2026-10-25T11:58:00.000Z';
  const s = await call('POST', '/api/lab/hex-tile/requests', { body: act('rq-a000000000000001', 'start', { tapped_at: tapped }, { run_seen: null }) });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const a = await call('POST', '/api/lab/hex-tile/requests', { body: act('rq-a000000000000002', 'approve', { reason: 'worth 85 min over', build_seen: 'BLD-020-01', reasons_seen: ['auto_stopped', 'full_part_required'] }) });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const d = await call('POST', '/api/lab/hex-tile/requests', { body: act('rq-a000000000000003', 'abandon', { reason: 'the strip came loose' }) });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const s2 = await call('POST', '/api/lab/hex-tile/requests', { body: act('rq-a000000000000004', 'start', { tapped_at: tapped }, { run_seen: 'PR-019-01' }) });
  assert.equal(s2.status, 200, JSON.stringify(s2.body));

  const { body } = await call('GET', '/api/lab/hex-tile/requests?status=pending', { asMac: true });
  const by = Object.fromEntries(body.items.map(i => [i.id, i]));
  assert.equal(by['rq-a000000000000001'].run, null, 'no run: lab pull refuses a run id that is not PR-nnn-nn');
  assert.equal(by['rq-a000000000000001'].run_seen, null);
  assert.deepEqual(by['rq-a000000000000001'].payload, { tapped_at: tapped });
  assert.equal(by['rq-a000000000000004'].run_seen, 'PR-019-01');
  assert.deepEqual(by['rq-a000000000000002'].payload, { reason: 'worth 85 min over', build_seen: 'BLD-020-01', reasons_seen: ['auto_stopped', 'full_part_required'] });
  assert.deepEqual(by['rq-a000000000000003'].payload, { reason: 'the strip came loose' });
});

test('abandon and approve need a reason of at most 500 characters; start needs a tap time; ids are checked', async t => {
  const { call } = harness(t);
  const bad = [
    act('rq-b000000000000001', 'abandon', {}),
    act('rq-b000000000000002', 'abandon', { reason: '   ' }),
    act('rq-b000000000000003', 'abandon', { reason: 'x'.repeat(501) }),
    act('rq-b000000000000004', 'approve', { build_seen: 'BLD-020-01', reasons_seen: [] }),
    act('rq-b000000000000005', 'approve', { reason: 'ok', build_seen: 'BLD-020-01', reasons_seen: 'auto_stopped' }),
    act('rq-b000000000000006', 'approve', { reason: 'ok', build_seen: '../../x', reasons_seen: [] }),
    act('rq-b000000000000007', 'approve', { reason: 'ok', build_seen: 'BLD-020-01', reasons_seen: ['<img>'] }),
    act('rq-b000000000000008', 'start', { tapped_at: 'yesterday' }),
    act('rq-b000000000000009', 'start', { tapped_at: '2026-10-25T11:58:00Z' }, { run_seen: '../PR-1' }),
    act('rq-b000000000000010', 'start', { tapped_at: '2026-10-25T11:58:00Z' }, { experiment: 'Q-003' })
  ];
  for (const body of bad) {
    const r = await call('POST', '/api/lab/hex-tile/requests', { body });
    assert.equal(r.status, 422, `${body.id}: ${JSON.stringify(r.body)}`);
  }
  const ok = await call('POST', '/api/lab/hex-tile/requests', { body: act('rq-b000000000000011', 'abandon', { reason: 'x'.repeat(500) }) });
  assert.equal(ok.status, 200);
  const big = await call('POST', '/api/lab/hex-tile/requests', { body: act('rq-b000000000000012', 'abandon', { reason: 'é'.repeat(2100) }) });
  assert.equal(big.status, 413, 'the 4 KB limit still applies first');
  const noRun = await call('POST', '/api/lab/hex-tile/requests', { body: { id: 'rq-b000000000000013', kind: 'verdict', experiment: 'E-020', payload: {} } });
  assert.equal(noRun.status, 422, 'a verdict still names its run');
});

test('the new kinds count toward the 20-pending limit', async t => {
  const { call } = harness(t);
  for (let i = 1; i <= 20; i++) {
    const r = await call('POST', '/api/lab/hex-tile/requests', { body: act(`rq-c${String(i).padStart(15, '0')}`, 'abandon', { reason: 'r' }) });
    assert.equal(r.status, 200);
  }
  const r21 = await call('POST', '/api/lab/hex-tile/requests', { body: act('rq-c000000000000021', 'start', { tapped_at: '2026-10-25T11:58:00Z' }) });
  assert.equal(r21.status, 429);
});

// ---- the live printer block ----
const labIndex = experiments => ({ schema: 'print-lab-index/1', project: 'hex-tile', generated_at: '2026-10-25T11:00:00Z', fingerprint: crypto.createHash('sha256').update(JSON.stringify(experiments)).digest('hex'), questions: [], experiments, needs: [], problems: [], records: {} });
const labExp = (id, status, run = null) => ({ id, status, run, photos: [] });

test('the project carries the live print for the one experiment that is printing', async t => {
  let printer = { state: 'printing', progress: 42, minutesLeft: 95, errorCode: null, access: 'ok' };
  const { lab, call } = harness(t, { printer: () => printer, clock: () => Date.parse('2026-10-25T12:00:00Z') });
  assert.equal(lab.sync('hex-tile', labIndex([labExp('E-020', 'printing', 'PR-020-01'), labExp('E-019', 'approved')]))[0], 200);
  let r = await call('GET', '/api/lab/hex-tile');
  assert.deepEqual(r.body.live, { experiment: 'E-020', run: 'PR-020-01', state: 'printing', progress: 42, minutesLeft: 95, finishAt: '2026-10-25T13:35:00.000Z', errorCode: null });
  const list = await call('GET', '/api/lab/projects');
  assert.deepEqual(list.body.projects[0].live, { experiment: 'E-020', state: 'printing', progress: 42, minutesLeft: 95, finishAt: '2026-10-25T13:35:00.000Z' });

  printer = { state: 'error', progress: null, minutesLeft: null, errorCode: '0700_8010', access: 'ok' };
  r = await call('GET', '/api/lab/hex-tile');
  assert.equal(r.body.live.state, 'error');
  assert.equal(r.body.live.errorCode, '0700_8010');
  assert.equal(r.body.live.finishAt, null);

  printer = null; // the display's status token isn't set up
  r = await call('GET', '/api/lab/hex-tile');
  assert.equal(r.body.live.state, 'unknown');
});

test('two experiments printing: no live match, only the conflict; none printing: live is null', async t => {
  const { lab, call } = harness(t, { printer: () => ({ state: 'printing', progress: 10, minutesLeft: 5, access: 'ok' }) });
  lab.sync('hex-tile', labIndex([labExp('E-020', 'printing', 'PR-020-01'), labExp('E-019', 'printing', 'PR-019-01')]));
  let r = await call('GET', '/api/lab/hex-tile');
  assert.deepEqual(r.body.live, { conflict: true });
  assert.equal((await call('GET', '/api/lab/projects')).body.projects[0].live, null);
  lab.sync('hex-tile', { ...labIndex([labExp('E-020', 'answered', 'PR-020-01')]), generated_at: '2026-10-25T11:30:00Z' });
  r = await call('GET', '/api/lab/hex-tile');
  assert.equal(r.body.live, null);
});

// ---- the camera snapshot (GET /api/lab/camera.jpg) ----
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const reply = (status, body, type = 'image/jpeg') => new Response(body, { status, headers: { 'content-type': type } });

test('the camera snapshot is passed through from the bridge for a paired phone, never cached', async t => {
  const seen = [];
  const { call } = harness(t, { cameraUrl: 'http://10.0.0.30:8091/x2d/frame.jpg', fetchImpl: async (url, init) => { seen.push([String(url), init.redirect]); return reply(200, JPG); } });
  const r = await call('GET', '/api/lab/camera.jpg');
  assert.equal(r.status, 200);
  assert.equal(r.headers['Content-Type'], 'image/jpeg');
  assert.match(r.headers['Cache-Control'], /no-store/);
  assert.ok(Buffer.from(r.body).equals(JPG));
  assert.deepEqual(seen, [['http://10.0.0.30:8091/x2d/frame.jpg', 'error']], 'no redirects are followed');
  const noPhone = await call('GET', '/api/lab/camera.jpg', { dev: null });
  assert.equal(noPhone.status, 401);
});

test('no picture: 503 with the Pi hub\'s reason, or a plain one when the hub is quiet too', async t => {
  const hub = { reason: 'liveview_off' };
  const fetchImpl = async url => {
    if (String(url).endsWith('/x2d/frame.jpg')) return reply(503, 'no frame', 'text/plain');
    if (String(url) === 'http://10.0.0.30/api/camera') return hub.reason ? reply(200, JSON.stringify({ ok: false, reason: hub.reason }), 'application/json') : reply(500, 'x', 'text/plain');
    throw new Error(`unexpected ${url}`);
  };
  const { call } = harness(t, { cameraUrl: 'http://10.0.0.30:8091/x2d/frame.jpg', piHubUrl: 'http://10.0.0.30', fetchImpl });
  let r = await call('GET', '/api/lab/camera.jpg');
  assert.equal(r.status, 503);
  assert.equal(r.body.reason, 'liveview_off');
  hub.reason = 'printer_unreachable';
  assert.equal((await call('GET', '/api/lab/camera.jpg')).body.reason, 'printer_unreachable');
  hub.reason = '<script>';
  assert.equal((await call('GET', '/api/lab/camera.jpg')).body.reason, 'no_picture', 'only known reasons pass');
  hub.reason = null;
  assert.equal((await call('GET', '/api/lab/camera.jpg')).body.reason, 'no_picture');
});

test('a slow or odd bridge: 503 within the time limit; a non-JPEG is not passed on', async t => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const { call } = harness(t, { cameraUrl: 'http://10.0.0.30:8091/x2d/frame.jpg', piHubUrl: 'http://10.0.0.30', cameraTimeoutMs: 150, fetchImpl: hang });
  const t0 = Date.now();
  const r = await call('GET', '/api/lab/camera.jpg');
  assert.equal(r.status, 503);
  assert.ok(Date.now() - t0 < 1000, `answered in ${Date.now() - t0} ms`);
  assert.equal(r.body.reason, 'no_picture');

  const { call: call2 } = harness(t, { cameraUrl: 'http://10.0.0.30:8091/x2d/frame.jpg', piHubUrl: 'off', fetchImpl: async () => reply(200, '<html>hi</html>', 'text/html') });
  const r2 = await call2('GET', '/api/lab/camera.jpg');
  assert.equal(r2.status, 503);
});

test('an oversized or endless camera answer is cut off, never buffered whole', async t => {
  const big = Buffer.alloc(3 * 1024 * 1024, 0xff); big[1] = 0xd8;
  const withLength = async () => new Response(big, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(big.length) } });
  const { call } = harness(t, { cameraUrl: 'http://10.0.0.30:8091/x2d/frame.jpg', piHubUrl: 'off', fetchImpl: withLength });
  const r = await call('GET', '/api/lab/camera.jpg');
  assert.equal(r.status, 503);
  assert.equal(r.body.reason, 'no_picture');

  let pulled = 0, cancelled = false;
  const endless = async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array([0xff, 0xd8])); },
    pull(c) { pulled += 64 * 1024; if (pulled > 64 * 1024 * 1024) { c.close(); return; } c.enqueue(new Uint8Array(64 * 1024)); },
    cancel() { cancelled = true; }
  }), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  const { call: call2 } = harness(t, { cameraUrl: 'http://10.0.0.30:8091/x2d/frame.jpg', piHubUrl: 'off', fetchImpl: endless });
  const r2 = await call2('GET', '/api/lab/camera.jpg');
  assert.equal(r2.status, 503);
  assert.ok(cancelled, 'the stream is cancelled once it passes the cap');
  assert.ok(pulled <= 3 * 1024 * 1024, `read ${pulled} bytes`);
});

test("each photo carries its tab from the experiment's record, so the page can pair photos by tab", async t => {
  const { lab, call } = harness(t);
  const sha1 = '1'.repeat(64), sha2 = '2'.repeat(64);
  const ix = labIndex([{ id: 'E-020', status: 'printing', run: 'PR-020-01', photos: [{ run: 'PR-020-01', sha256: sha1 }, { run: 'PR-020-01', sha256: sha2 }] }]);
  ix.records = { 'E-020': { type: 'experiment', file: 'experiments/E-020.json', sha256: 'a'.repeat(64), payload: { id: 'E-020', print_runs: [{ id: 'PR-020-01', photos: [{ sha256: sha1, tab: '12A' }, { sha256: sha2 }, { sha256: 'x', tab: '<b>' }] }] } } };
  assert.equal(lab.sync('hex-tile', ix)[0], 200);
  const r = await call('GET', '/api/lab/hex-tile');
  assert.deepEqual(r.body.index.experiments[0].photos.map(p => p.tab ?? null), ['12A', null]);
});

test('a photos request names only sha256 photos with short tabs, so its clean-up never leaves incoming/', async t => {
  const { call, dataDir } = harness(t);
  const victim = path.join(dataDir, 'print-lab', 'hex-tile', 'keep.jpg');
  fs.mkdirSync(path.dirname(victim), { recursive: true });
  fs.writeFileSync(victim, 'x');
  const bad = [
    { photos: [{ sha256: '../keep', tab: '12A' }] },
    { photos: [{ sha256: 'a'.repeat(64), tab: '<img src=x>' }] },
    { photos: 'x' },
    { photos: Array.from({ length: 51 }, () => ({ sha256: 'a'.repeat(64) })) }
  ];
  let n = 0;
  for (const payload of bad) {
    const r = await call('POST', '/api/lab/hex-tile/requests', { body: { id: `rq-d${String(++n).padStart(15, '0')}`, kind: 'photos', experiment: 'E-001', run: 'PR-001-01', payload } });
    assert.equal(r.status, 422, JSON.stringify(payload).slice(0, 60));
  }
  const ok = await call('POST', '/api/lab/hex-tile/requests', { body: { id: 'rq-d000000000000099', kind: 'photos', experiment: 'E-001', run: 'PR-001-01', payload: { run: 'PR-001-01', photos: [{ sha256: 'a'.repeat(64), tab: null }, { sha256: 'b'.repeat(64), tab: '12B' }] } } });
  assert.equal(ok.status, 200);
  assert.ok(fs.existsSync(victim));
});

test('a result names a request by its id shape only', async t => {
  const { call } = harness(t);
  const r = await call('POST', '/api/lab/hex-tile/requests/..%2Fmeta/result', { asMac: true, body: { status: 'applied' } });
  assert.equal(r.status, 404);
});

test("the Pi hub's no-picture answer is read up to a small cap", async t => {
  const fetchImpl = async url => String(url).endsWith('/frame.jpg') ? reply(503, 'x', 'text/plain')
    : new Response(JSON.stringify({ reason: 'liveview_off', pad: 'x'.repeat(64 * 1024) }), { status: 200, headers: { 'content-type': 'application/json' } });
  const { call } = harness(t, { cameraUrl: 'http://10.0.0.30:8091/x2d/frame.jpg', piHubUrl: 'http://10.0.0.30', fetchImpl });
  const r = await call('GET', '/api/lab/camera.jpg');
  assert.equal(r.status, 503);
  assert.equal(r.body.reason, 'no_picture', 'an oversized answer is not parsed');
});

// ---- observations (print-lab spec 2026-10-26-observation-records-design rev 2) ----------------------------------

const snapshot = (kind = 'pair') => ({
  subject: { kind, experiment: 'E-023', run: 'PR-023-01', build: 'BLD-023-01', variant: 'E-023-A', label: '23A', tile: null, identified: 'confirmed', note: null },
  viewing: { light: 'room' },
  outcomes: { separation: { status: 'assessed', value: 'effort', note: null }, acceptance: { status: 'not_assessed', value: null, note: null } },
  source: { kind: 'owner_report', words: 'twisted apart', evidence: [], occurred_at: null, attributed_by: 'phone_session' }
});

test('a phone observation session is queued with its snapshots, up to 16 KB', async t => {
  const { call } = harness(t);
  const ok = await call('POST', '/api/lab/hex-tile/requests', {
    body: { id: 'rq-0000000000000a01', kind: 'observation', experiment: 'E-023', run: 'PR-023-01', payload: { snapshots: [snapshot(), snapshot('tile'), snapshot('tile')] } }
  });
  assert.equal(ok.status, 200);
  const pending = await call('GET', '/api/lab/hex-tile/requests?status=pending', { asMac: true });
  const item = pending.body.items.find(i => i.id === 'rq-0000000000000a01');
  assert.equal(item.kind, 'observation');
  assert.equal(item.payload.snapshots.length, 3);
  const big = await call('POST', '/api/lab/hex-tile/requests', {
    body: { id: 'rq-0000000000000a02', kind: 'observation', experiment: 'E-023', run: 'PR-023-01', payload: { snapshots: [{ ...snapshot(), source: { ...snapshot().source, words: 'x'.repeat(17 * 1024) } }] } }
  });
  assert.equal(big.status, 413);
});

test('observation payloads are checked: snapshots, correction ids, revisions and reasons', async t => {
  const { call } = harness(t);
  const post = (id, kind, payload) => call('POST', '/api/lab/hex-tile/requests', { body: { id, kind, experiment: 'E-023', run: 'PR-023-01', payload } });
  assert.equal((await post('rq-0000000000000b01', 'observation', { snapshots: [] })).status, 422);
  assert.equal((await post('rq-0000000000000b02', 'observation', { snapshots: [{ subject: 'x' }] })).status, 422);
  assert.equal((await post('rq-0000000000000b03', 'observation_correction', { observation: '../x', expected_rev: 1, snapshot: snapshot(), reason: 'r' })).status, 422);
  assert.equal((await post('rq-0000000000000b04', 'observation_correction', { observation: 'OBS-0001', expected_rev: 0, snapshot: snapshot(), reason: 'r' })).status, 422);
  assert.equal((await post('rq-0000000000000b05', 'observation_correction', { observation: 'OBS-0001', expected_rev: 1, snapshot: snapshot(), reason: ' ' })).status, 422);
  assert.equal((await post('rq-0000000000000b06', 'observation_correction', { observation: 'OBS-0001', expected_rev: 1, snapshot: snapshot(), reason: 'misread' })).status, 200);
});

test("observations come from a paired phone, not the Workshop display", async t => {
  const { lab } = harness(t);
  const [status] = lab.queueRequest('hex-tile', { id: 'rq-0000000000000c01', kind: 'observation', experiment: 'E-023', run: 'PR-023-01', payload: { snapshots: [snapshot()] } }, 'display');
  assert.equal(status, 403);
});
