'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const KEY = 'test-mac-key-0123456789abcdef';
let child, dataDir, base, diagnostics = '', deviceCookie = '', deviceId = '';
let counter = 0;

async function freePort() {
  const s = http.createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const port = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return port;
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-chat-'));
  fs.writeFileSync(path.join(dataDir, 'claude-chat-mac-key.sha256'), crypto.createHash('sha256').update(KEY).digest('hex'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const off = 'http://127.0.0.1:9';
  child = spawn(process.execPath, [path.resolve(__dirname, '../app/server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), WORKSPACE_ROOT: dataDir, LOCALAI_CHAT_ONLINE_MS: '300', OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, GRIDCRAFT_URL: off }
  });
  child.stdout.on('data', c => diagnostics += c);
  child.stderr.on('data', c => diagnostics += c);
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(diagnostics);
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
    if (attempt === 79) throw new Error(`Server did not start: ${diagnostics}`);
    await new Promise(r => setTimeout(r, 100));
  }
  const paired = await pairDevice(base, 'Test device');
  deviceCookie = paired.cookie; deviceId = paired.deviceId;
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const mac = (extra = {}) => ({ 'X-LocalAI-Mac-Key': KEY, ...extra });
const JSONH = { 'Content-Type': 'application/json' };
async function pairDevice(url, name) {
  const pr = await (await fetch(`${url}/api/claude/chat/pair-request`, { method: 'POST', headers: JSONH, body: '{}' })).json();
  const ar = await fetch(`${url}/api/claude/chat/pair/approve`, { method: 'POST', headers: { ...JSONH, 'X-LocalAI-Mac-Key': KEY }, body: JSON.stringify({ code: pr.code, name }) });
  const approved = await ar.json();
  const sr = await fetch(`${url}/api/claude/chat/pair-status?id=${pr.id}`);
  const raw = sr.headers.get('set-cookie') || '';
  return { cookie: raw.split(';')[0], raw, deviceId: approved.deviceId, id: pr.id, code: pr.code, status: await sr.json() };
}
async function post(p, body, headers = {}) {
  const r = await fetch(base + p, { method: 'POST', headers: { ...JSONH, Cookie: deviceCookie, ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function get(p, headers = {}) {
  const r = await fetch(base + p, { headers: { Cookie: deviceCookie, ...headers } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const announce = (id, extra = {}) => post('/api/claude/chat/announce', { sessionId: id, title: 'T', cwd: '/x', ...extra }, mac());
const send = (id, text) => post('/api/claude/chat/send', { sessionId: id, text });
const inbox = (id, wait = 0) => get(`/api/claude/chat/inbox?sessionId=${id}&wait=${wait}`, mac());
const messages = (id, after = 0) => get(`/api/claude/chat/messages?sessionId=${id}&after=${after}`);
const mirror = (id, role, source, text) => post('/api/claude/chat/mirror', { sessionId: id, role, source, text }, mac());
async function session() {
  const id = `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  assert.equal((await announce(id)).status, 200);
  return id;
}

test('mac-side calls need the key', async () => {
  const body = { sessionId: 'abc-1', title: 't', cwd: '/c' };
  assert.equal((await post('/api/claude/chat/announce', body)).status, 401);
  assert.equal((await post('/api/claude/chat/announce', body, { 'X-LocalAI-Mac-Key': 'wrong' })).status, 401);
  assert.equal((await post('/api/claude/chat/announce', body, mac())).status, 200);
  assert.equal((await get('/api/claude/chat/inbox?sessionId=abc-1&wait=0')).status, 401);
  assert.equal((await post('/api/claude/chat/mirror', { sessionId: 'abc-1', role: 'user', source: 'terminal', text: 'x' })).status, 401);
});

test('mac-side POSTs follow the cross-origin and content-type rules; session ids are validated', async () => {
  const bad = await fetch(`${base}/api/claude/chat/announce`, { method: 'POST', headers: { ...JSONH, ...mac(), Origin: 'http://evil.example' }, body: '{}' });
  assert.equal(bad.status, 403);
  const form = await fetch(`${base}/api/claude/chat/announce`, { method: 'POST', headers: { 'Content-Type': 'text/plain', ...mac() }, body: '{}' });
  assert.equal(form.status, 415);
  assert.equal((await post('/api/claude/chat/announce', { sessionId: '../etc', title: 't', cwd: '/' }, mac())).status, 400);
  assert.equal((await mirror('abc-1', 'user', 'terminal', '')).status, 400);
  assert.equal((await mirror('abc-1', 'system', 'terminal', 'x')).status, 400);
  assert.equal((await mirror('abc-1', 'user', 'web', 'x')).status, 400);
});

test('announce makes a session online, then offline once the window passes', async () => {
  const id = await session();
  let list = (await get('/api/claude/chat/sessions')).body.items.find(s => s.sessionId === id);
  assert.equal(list.online, true);
  assert.equal(list.title, 'T');
  await new Promise(r => setTimeout(r, 400));
  list = (await get('/api/claude/chat/sessions')).body.items.find(s => s.sessionId === id);
  assert.equal(list.online, false);
});

test('send to an online session queues it; inbox delivers it once', async () => {
  const id = await session();
  const sent = await send(id, 'hello');
  assert.equal(sent.status, 201);
  assert.equal(sent.body.item.status, 'queued');
  assert.equal(sent.body.item.source, 'web');
  const first = await inbox(id);
  assert.equal(first.body.items.length, 1);
  assert.equal(first.body.items[0].text, 'hello');
  assert.ok(first.body.items[0].id && first.body.items[0].seq);
  assert.equal((await inbox(id)).body.items.length, 0);
  const msgs = (await messages(id)).body.items;
  assert.equal(msgs[0].status, 'delivered');
});

test('two concurrent inbox polls never share a message', async () => {
  const id = await session();
  for (let i = 0; i < 10; i++) assert.equal((await send(id, `m${i}`)).status, 201);
  const [a, b] = await Promise.all([inbox(id), inbox(id)]);
  const ids = [...a.body.items, ...b.body.items].map(x => x.id);
  assert.equal(new Set(ids).size, 10);
  assert.equal(ids.length, 10);
});

test('20 concurrent sends get distinct increasing seqs', async () => {
  const id = await session();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => send(id, `c${i}`)));
  const seqs = results.map(r => r.body.item.seq);
  assert.equal(new Set(seqs).size, 20);
  const stored = (await messages(id)).body.items.map(m => m.seq);
  assert.deepEqual(stored, [...stored].sort((x, y) => x - y));
  assert.equal(Math.max(...seqs) - Math.min(...seqs), 19);
});

test('long-poll wakes on send', async () => {
  const id = await session();
  const started = Date.now();
  const pending = inbox(id, 25);
  setTimeout(() => send(id, 'wake'), 200);
  const r = await pending;
  assert.ok(Date.now() - started < 2000);
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.items[0].text, 'wake');
});

test('mirror reply marks the newest delivered web message answered; terminal mirror appears', async () => {
  const id = await session();
  await send(id, 'one'); await send(id, 'two');
  await inbox(id);
  const m = await mirror(id, 'assistant', 'reply', 'the answer');
  assert.equal(m.status, 200);
  assert.ok(m.body.seq > 0);
  let msgs = (await messages(id)).body.items;
  const webs = msgs.filter(x => x.source === 'web');
  assert.equal(webs[0].status, 'delivered');
  assert.equal(webs[1].status, 'answered');
  assert.equal(msgs.at(-1).text, 'the answer');
  await mirror(id, 'user', 'terminal', 'typed in terminal');
  msgs = (await messages(id)).body.items;
  const t = msgs.at(-1);
  assert.equal(t.source, 'terminal');
  assert.equal(t.role, 'user');
});

test('send to an offline session is refused with 409', async () => {
  const id = await session();
  await new Promise(r => setTimeout(r, 400));
  assert.equal((await send(id, 'x')).status, 409);
  assert.equal((await send('never-announced', 'x')).status, 409);
  assert.equal((await send('bad/id', 'x')).status, 400);
});

test('a queued message can be deleted by its sender; a delivered one cannot (409)', async () => {
  const id = await session();
  const a = (await send(id, 'a')).body.item;
  assert.equal((await post('/api/claude/chat/messages/delete', { id: a.id })).status, 200);
  assert.equal((await messages(id)).body.items.length, 0);
  assert.equal((await inbox(id)).body.items.length, 0);
  const b = (await send(id, 'b')).body.item;
  await inbox(id);
  assert.equal((await post('/api/claude/chat/messages/delete', { id: b.id })).status, 409);
  assert.equal((await post('/api/claude/chat/messages/delete', { id: 'nope' })).status, 409);
});

test('text is stored verbatim and capped', async () => {
  const id = await session();
  const nasty = '<img src=x onerror=alert(1)> 😀';
  await send(id, nasty);
  await mirror(id, 'assistant', 'reply', 'z'.repeat(60000));
  const msgs = (await messages(id)).body.items;
  assert.equal(msgs[0].text, nasty);
  assert.equal(msgs[0].truncated, undefined);
  assert.equal(msgs[1].text.length, 50000);
  assert.equal(msgs[1].truncated, true);
});

test('messages?after= returns only newer messages; only the latest 1,000 are kept', async () => {
  const id = await session();
  for (let i = 0; i < 3; i++) await mirror(id, 'user', 'terminal', `t${i}`);
  const all = (await messages(id)).body.items;
  const newer = (await messages(id, all[0].seq)).body.items;
  assert.deepEqual(newer.map(m => m.text), ['t1', 't2']);
  const big = await session();
  for (let i = 0; i < 1050; i += 50) await Promise.all(Array.from({ length: 50 }, (_, j) => mirror(big, 'user', 'terminal', `n${i + j}`)));
  const kept = (await messages(big)).body.items;
  assert.equal(kept.length, 1000);
  assert.equal(kept.at(-1).seq, 1050);
});

test('non-object JSON bodies get a 400, not a hang', async () => {
  for (const raw of ['null', '[]', 'false', '0']) {
    const r = await fetch(`${base}/api/claude/chat/announce`, { method: 'POST', headers: { ...JSONH, ...mac() }, body: raw, signal: AbortSignal.timeout(3000) });
    assert.equal(r.status, 400, raw);
    assert.match((await r.json()).error, /object/);
  }
});

test('device routes are closed (401) without a valid device cookie, even with a Mac key or a forged cookie', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-chat-closed-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const off = 'http://127.0.0.1:9';
  const env = { ...process.env, DATA_DIR: dir, PORT: String(port), WORKSPACE_ROOT: dir, OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, GRIDCRAFT_URL: off };
  fs.writeFileSync(path.join(dir, 'claude-chat-mac-key.sha256'), crypto.createHash('sha256').update(KEY).digest('hex'));
  const c = spawn(process.execPath, [path.resolve(__dirname, '../app/server.js')], { env });
  let diag = '';
  c.stdout.on('data', d => diag += d); c.stderr.on('data', d => diag += d);
  t.after(async () => {
    if (c.exitCode === null && c.signalCode === null) { const done = once(c, 'exit'); c.kill('SIGTERM'); await done; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (let a = 0; a < 80; a++) {
    if (c.exitCode !== null) throw new Error(diag);
    try { if ((await fetch(`${url}/healthz`)).ok) break; } catch {}
    if (a === 79) throw new Error(`Server did not start: ${diag}`);
    await new Promise(r => setTimeout(r, 100));
  }
  for (const headers of [{}, mac(), { Cookie: 'localai_chat_device=dev-aaaaaaaaaaaa.forged' }, { Cookie: 'localai_chat_device=garbage' }]) {
    const h = { ...JSONH, ...headers };
    const calls = [
      fetch(`${url}/api/claude/chat/sessions`, { headers: h }),
      fetch(`${url}/api/claude/chat/messages?sessionId=abc-1&after=0`, { headers: h }),
      fetch(`${url}/api/claude/chat/send`, { method: 'POST', headers: h, body: JSON.stringify({ sessionId: 'abc-1', text: 'x' }) }),
      fetch(`${url}/api/claude/chat/messages/delete`, { method: 'POST', headers: h, body: JSON.stringify({ id: 'abc-1:0000000001' }) })
    ];
    if (!headers['X-LocalAI-Mac-Key']) calls.push(fetch(`${url}/api/claude/chat/devices`, { headers: h }), fetch(`${url}/api/claude/chat/devices/revoke`, { method: 'POST', headers: h, body: JSON.stringify({ id: 'dev-aaaaaaaaaaaa' }) }));
    for (const r of await Promise.all(calls)) assert.equal(r.status, 401);
  }
});

// ---- pairing and devices ---------------------------------------------------------------------
async function startServer(t, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-chat-pair-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const off = 'http://127.0.0.1:9';
  fs.writeFileSync(path.join(dir, 'claude-chat-mac-key.sha256'), crypto.createHash('sha256').update(KEY).digest('hex'));
  const c = spawn(process.execPath, [path.resolve(__dirname, '../app/server.js')], { env: { ...process.env, DATA_DIR: dir, PORT: String(port), WORKSPACE_ROOT: dir, OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, GRIDCRAFT_URL: off, ...extraEnv } });
  let diag = '';
  c.stdout.on('data', d => diag += d); c.stderr.on('data', d => diag += d);
  t.after(async () => {
    if (c.exitCode === null && c.signalCode === null) { const done = once(c, 'exit'); c.kill('SIGTERM'); await done; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (let a = 0; a < 80; a++) {
    if (c.exitCode !== null) throw new Error(diag);
    try { if ((await fetch(`${url}/healthz`)).ok) break; } catch {}
    if (a === 79) throw new Error(`Server did not start: ${diag}`);
    await new Promise(r => setTimeout(r, 100));
  }
  return url;
}
const pairReq = url => fetch(`${url}/api/claude/chat/pair-request`, { method: 'POST', headers: JSONH, body: '{}' });
const approve = (url, body, headers = { 'X-LocalAI-Mac-Key': KEY }) => fetch(`${url}/api/claude/chat/pair/approve`, { method: 'POST', headers: { ...JSONH, ...headers }, body: JSON.stringify(body) });

test('device endpoints return 401 without a cookie', async () => {
  const none = { headers: {} };
  for (const p of ['sessions', 'messages?sessionId=abc-1', 'devices']) assert.equal((await fetch(`${base}/api/claude/chat/${p}`, none)).status, 401, p);
  assert.equal((await post('/api/claude/chat/send', { sessionId: 'abc-1', text: 'x' }, { Cookie: '' })).status, 401);
  assert.equal((await post('/api/claude/chat/devices/revoke', { id: deviceId }, { Cookie: '' })).status, 401);
});

test('pairing: request -> approve with Mac key -> status sets an HttpOnly SameSite=Strict cookie once', async t => {
  const url = await startServer(t);
  const r = await pairReq(url);
  assert.equal(r.status, 201);
  const pr = await r.json();
  assert.match(pr.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  assert.match(pr.id, /^pair-[0-9a-f]{16}$/);
  assert.ok(pr.expiresAt > Date.now());
  const pending = await fetch(`${url}/api/claude/chat/pair-status?id=${pr.id}`);
  assert.deepEqual(await pending.json(), { status: 'pending' });
  assert.equal(pending.headers.get('set-cookie'), null);
  const ar = await approve(url, { code: pr.code.toLowerCase(), name: '  Phone  ' });
  assert.equal(ar.status, 200);
  const { deviceId: id } = await ar.json();
  assert.match(id, /^dev-[0-9a-f]{12}$/);
  const s1 = await fetch(`${url}/api/claude/chat/pair-status?id=${pr.id}`);
  assert.deepEqual(await s1.json(), { status: 'approved', device: { id, name: 'Phone' } });
  const cookie = s1.headers.get('set-cookie');
  assert.match(cookie, new RegExp(`^localai_chat_device=${id}\\.[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=/api/claude/chat; Max-Age=15552000$`));
  const s2 = await fetch(`${url}/api/claude/chat/pair-status?id=${pr.id}`);
  assert.deepEqual(await s2.json(), { status: 'expired' });
  assert.equal(s2.headers.get('set-cookie'), null);
  const ok = await fetch(`${url}/api/claude/chat/sessions`, { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(ok.status, 200);
  assert.equal((await fetch(`${url}/api/claude/chat/pair-status?id=pair-0000000000000000`)).status === 200, true);
});

test('approve without the Mac key is 401; wrong code is 404; bad name is 400', async t => {
  const url = await startServer(t);
  const pr = await (await pairReq(url)).json();
  assert.equal((await approve(url, { code: pr.code, name: 'x' }, {})).status, 401);
  assert.equal((await approve(url, { code: pr.code, name: 'x' }, { 'X-LocalAI-Mac-Key': 'nope' })).status, 401);
  assert.equal((await approve(url, { code: 'AAAAAA', name: 'x' })).status, 404);
  assert.equal((await approve(url, { code: pr.code, name: 'x'.repeat(61) })).status, 400);
  const def = await approve(url, { code: pr.code });
  assert.equal(def.status, 200);
  const status = await (await fetch(`${url}/api/claude/chat/pair-status?id=${pr.id}`)).json();
  assert.equal(status.device.name, 'Device');
});

test('a code older than the pairing window is expired and cannot be approved', async t => {
  const url = await startServer(t, { LOCALAI_CHAT_PAIR_TTL_MS: '200' });
  const pr = await (await pairReq(url)).json();
  await new Promise(r => setTimeout(r, 400));
  assert.equal((await approve(url, { code: pr.code, name: 'x' })).status, 404);
  assert.deepEqual(await (await fetch(`${url}/api/claude/chat/pair-status?id=${pr.id}`)).json(), { status: 'expired' });
});

test('a sixth pending pairing request is 429', async t => {
  const url = await startServer(t);
  for (let i = 0; i < 5; i++) assert.equal((await pairReq(url)).status, 201);
  assert.equal((await pairReq(url)).status, 429);
});

test('codes use only the allowed alphabet and are unique among pending requests', async t => {
  const url = await startServer(t, { LOCALAI_CHAT_PAIR_TTL_MS: '150' });
  const seen = new Set();
  for (let batch = 0; batch < 20; batch++) {
    const codes = [];
    for (let i = 0; i < 5; i++) { const pr = await (await pairReq(url)).json(); assert.match(pr.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/); codes.push(pr.code); seen.add(pr.code); }
    assert.equal(new Set(codes).size, 5);
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(seen.size > 90);
});

test('devices list marks the current device; revoke stops the cookie immediately', async t => {
  const url = await startServer(t);
  const a = await pairDevice(url, 'Phone');
  const b = await pairDevice(url, 'Laptop');
  const list = await (await fetch(`${url}/api/claude/chat/devices`, { headers: { Cookie: a.cookie } })).json();
  assert.equal(list.items.length, 2);
  const cur = list.items.find(d => d.current);
  assert.equal(cur.id, a.deviceId); assert.equal(cur.name, 'Phone');
  assert.ok(cur.pairedAt && cur.lastSeenAt);
  assert.equal(JSON.stringify(list).includes('tokenSha256'), false);
  const viaMac = await (await fetch(`${url}/api/claude/chat/devices`, { headers: { 'X-LocalAI-Mac-Key': KEY } })).json();
  assert.equal(viaMac.items.length, 2); assert.ok(viaMac.items.every(d => d.current === false));
  const rv = { method: 'POST', headers: { ...JSONH, Cookie: b.cookie }, body: JSON.stringify({ id: a.deviceId }) };
  assert.equal((await fetch(`${url}/api/claude/chat/devices/revoke`, { method: 'POST', headers: { ...JSONH, Cookie: b.cookie }, body: JSON.stringify({ id: 'dev-000000000000' }) })).status, 404);
  assert.deepEqual(await (await fetch(`${url}/api/claude/chat/devices/revoke`, rv)).json(), { ok: true });
  assert.equal((await fetch(`${url}/api/claude/chat/sessions`, { headers: { Cookie: a.cookie } })).status, 401);
  assert.equal((await fetch(`${url}/api/claude/chat/sessions`, { headers: { Cookie: b.cookie } })).status, 200);
  const viaKey = await fetch(`${url}/api/claude/chat/devices/revoke`, { method: 'POST', headers: { ...JSONH, 'X-LocalAI-Mac-Key': KEY }, body: JSON.stringify({ id: b.deviceId }) });
  assert.equal(viaKey.status, 200);
  assert.equal((await fetch(`${url}/api/claude/chat/sessions`, { headers: { Cookie: b.cookie } })).status, 401);
});

test('a cookie with the right id but wrong token is rejected', async t => {
  const url = await startServer(t);
  const a = await pairDevice(url, 'Phone');
  const forged = `localai_chat_device=${a.deviceId}.${'A'.repeat(43)}`;
  assert.equal((await fetch(`${url}/api/claude/chat/sessions`, { headers: { Cookie: forged } })).status, 401);
});

test('pairing POSTs: cross-origin is 403, non-JSON is 415', async t => {
  const url = await startServer(t);
  assert.equal((await fetch(`${url}/api/claude/chat/pair-request`, { method: 'POST', headers: { ...JSONH, Origin: 'http://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${url}/api/claude/chat/pair-request`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await approve(url, { code: 'AAAAAA' }, { 'X-LocalAI-Mac-Key': KEY, Origin: 'http://evil.example' })).status, 403);
});
