'use strict';
// Pairing slots with a frozen clock: requests made in the same millisecond must still give way oldest first.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../app/storage');
const { createClaudeChat } = require('../app/claude-chat');

test('with every request in the same millisecond, the sixth still replaces the first, not a random one', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-pair-'));
  const storage = new Storage({ dataDir });
  t.after(() => { storage.close?.(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const json = (res, status, body) => { res.status = status; res.body = body; };
  const chat = createClaudeChat({ storage, dataDir, json, readBody: async () => ({}), now: () => 1800000000000 });
  const call = async (method, p) => {
    const res = {};
    const req = { method, headers: { host: 'localai.test', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } };
    await chat.handle(req, res, new URL('http://localai.test' + p), p.split('?')[0]);
    return res;
  };
  const ids = [];
  for (let i = 0; i < 6; i++) { const r = await call('POST', '/api/claude/chat/pair-request'); assert.equal(r.status, 201); ids.push(r.body.id); }
  const status = async id => (await call('GET', `/api/claude/chat/pair-status?id=${id}`)).body.status;
  assert.equal(await status(ids[0]), 'expired');
  for (const id of ids.slice(1)) assert.equal(await status(id), 'pending');
});

// Devices say what they are, and the Mac can rename them.
const crypto = require('node:crypto');
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
function harness(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-dev-'));
  const storage = new Storage({ dataDir });
  t.after(() => { storage.close?.(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(dataDir, 'claude-chat-mac-key.sha256'), crypto.createHash('sha256').update('mac-secret').digest('hex'));
  const json = (res, status, body) => { res.status = status; res.body = body; };
  let bodyNext = {};
  const chat = createClaudeChat({ storage, dataDir, json, readBody: async () => bodyNext, now: () => Date.now() });
  const call = async (method, p, { b = {}, ua = MAC, mac = false, cookie = '' } = {}) => {
    bodyNext = b; const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
    const headers = { host: 'localai.test', 'content-type': 'application/json', 'user-agent': ua, ...(mac ? { 'x-localai-mac-key': 'mac-secret' } : {}), ...(cookie ? { cookie } : {}) };
    await chat.handle({ method, headers, socket: { remoteAddress: '127.0.0.1' } }, res, new URL('http://localai.test' + p), p.split('?')[0]);
    return res;
  };
  const pair = async (ua, name) => {
    const r = await call('POST', '/api/claude/chat/pair-request', { ua });
    await call('POST', '/api/claude/chat/pair/approve', { mac: true, b: name ? { code: r.body.code, name } : { code: r.body.code } });
    const s = await call('GET', `/api/claude/chat/pair-status?id=${r.body.id}`, { ua });
    return { id: s.body.device.id, cookie: String(s.headers['set-cookie']).split(';')[0] };
  };
  return { call, pair, storage };
}

test('a device paired without a name is named after what it is, and the list says its kind', async t => {
  const h = harness(t);
  await h.pair(IPHONE); await h.pair(MAC, 'Office Mac');
  const list = (await h.call('GET', '/api/claude/chat/devices', { mac: true })).body.items.map(d => [d.name, d.kind]);
  assert.deepEqual(list, [['iPhone', 'iPhone'], ['Office Mac', 'Mac']]);
});

test('the Mac renames a device; a device cookie or no key cannot; bad ids and names are refused', async t => {
  const h = harness(t);
  const d = await h.pair(IPHONE);
  assert.equal((await h.call('POST', '/api/claude/chat/devices/rename', { b: { id: d.id, name: 'Nope' }, cookie: d.cookie })).status, 401);
  assert.equal((await h.call('POST', '/api/claude/chat/devices/rename', { b: { id: d.id, name: 'Nope' } })).status, 401);
  assert.equal((await h.call('POST', '/api/claude/chat/devices/rename', { mac: true, b: { id: 'dev-000000000000', name: 'X' } })).status, 404);
  assert.equal((await h.call('POST', '/api/claude/chat/devices/rename', { mac: true, b: { id: d.id, name: '  ' } })).status, 400);
  assert.equal((await h.call('POST', '/api/claude/chat/devices/rename', { mac: true, b: { id: d.id, name: 'x'.repeat(61) } })).status, 400);
  const ok = await h.call('POST', '/api/claude/chat/devices/rename', { mac: true, b: { id: d.id, name: "  Bill's iPhone " } });
  assert.equal(ok.status, 200);
  assert.equal((await h.call('GET', '/api/claude/chat/devices', { mac: true })).body.items[0].name, "Bill's iPhone");
  // The device still works after the rename.
  assert.equal((await h.call('GET', '/api/claude/chat/whoami', { cookie: d.cookie })).body.paired, true);
});

test('a device paired before kinds were recorded gets its kind the next time it is used', async t => {
  const h = harness(t);
  const d = await h.pair(MAC);
  const k = `claudeChat:device:${d.id}`;
  const { kind, ...old } = h.storage.readSetting(k, null);
  h.storage.writeSetting(k, old);
  await h.call('GET', '/api/claude/chat/whoami', { cookie: d.cookie, ua: IPHONE });
  assert.equal((await h.call('GET', '/api/claude/chat/devices', { mac: true })).body.items[0].kind, 'iPhone');
});
