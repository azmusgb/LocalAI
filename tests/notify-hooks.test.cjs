'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');

// Decrypt what the server pushed (RFC 8291 receiver side), to read the notification's title and tag.
function decrypt(body, ua, auth) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ua.computeSecret(asPublic), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32));
  const d = crypto.createDecipheriv('aes-128-gcm', Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)), Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const p = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(p.subarray(0, p.lastIndexOf(2)).toString('utf8'));
}

test('events reach the phone: failed run, approval, new Claude finding, host failure', { timeout: 60000 }, async t => {
  const pushes = [];
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const fake = http.createServer((req, res) => { const c = []; req.on('data', x => c.push(x)).on('end', () => { pushes.push(decrypt(Buffer.concat(c), ua, auth)); res.writeHead(201); res.end(); }); });
  fake.listen(0, '127.0.0.1'); await once(fake, 'listening');
  const host = `127.0.0.1:${fake.address().port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-hooks-'));
  // OLLAMA_URL points at a closed port, so a chat run fails quickly.
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, PUSH_TEST_ENDPOINT_HOST: host, OLLAMA_URL: 'http://127.0.0.1:9', TZ: 'UTC' } });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } fake.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = await ready;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const sub = await (await post('/api/push/subscribe', { subscription: { endpoint: `http://${host}/phone`, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }, name: 'iPhone' })).json();
  // No quiet hours, so every kind can arrive whatever time the test runs.
  await post('/api/push/devices/update', { id: sub.device.id, quiet: { on: false } });
  const waitFor = async (pred) => { for (let i = 0; i < 50; i++) { const hit = pushes.find(pred); if (hit) return hit; await new Promise(r => setTimeout(r, 100)); } return null; };

  await t.test('a failed chat run', async () => {
    await post('/api/chat', { messages: [{ role: 'user', content: 'hi' }] });
    const p = await waitFor(x => x.title === 'Failed');
    assert.ok(p, JSON.stringify(pushes));
    assert.match(p.tag, /^run:/);
  });
  await t.test('an approval', async () => {
    await post('/api/approvals/create', { title: 'Delete old backups', detail: 'Frees 2 GB' });
    const p = await waitFor(x => x.title === 'Approval needed');
    assert.equal(p.body, 'Delete old backups');
  });
  await t.test('a new Claude finding notifies once', async () => {
    const f = { sessionId: 'hooks-test', findings: [{ id: 'hooks-test-1', title: 'Check the thing', category: 'ux', severity: 'low' }] };
    await post('/api/claude/findings', f); await post('/api/claude/findings', f);
    await waitFor(x => x.title === 'Claude needs your decision');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(pushes.filter(x => x.title === 'Claude needs your decision').length, 1);
  });
  await t.test('a failed update notifies; a successful one does not', async () => {
    await post('/api/notifications/system', { kind: 'deploy', title: 'Local AI updated to 2.0.300', meta: { outcome: 'deployed' } });
    await post('/api/notifications/system', { kind: 'deploy', title: 'Automatic update to abc failed', detail: 'Rolled back', meta: { outcome: 'failed' } });
    assert.ok(await waitFor(x => x.title === 'Automatic update to abc failed'));
    assert.equal(pushes.filter(x => /updated to 2\.0\.300/.test(x.title)).length, 0);
  });
});
