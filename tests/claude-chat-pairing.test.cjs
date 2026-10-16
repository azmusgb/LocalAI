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
