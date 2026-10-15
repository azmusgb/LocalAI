'use strict';

// Claude chat relay: the appliance side of the LocalAI web <-> Claude Code session chat.
// Mac-side calls (announce, inbox, mirror) carry X-LocalAI-Mac-Key; device-side calls use deviceFor().
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const PREFIX = 'claudeChat:';
const SESSION_ID_RE = /^[A-Za-z0-9-]{1,80}$/;
const MAX_TEXT = 50000;
const MAX_MESSAGES = 1000;
const IDLE_PRUNE_MS = 30 * 24 * 3600 * 1000;
const MAX_WAIT_S = 25;

const sessionKey = id => `${PREFIX}session:${id}`;
const seqKey = id => `${PREFIX}seq:${id}`;
const msgPrefix = id => `${PREFIX}msg:${id}:`;
const pad = seq => String(seq).padStart(10, '0');
const msgId = (sessionId, seq) => `${sessionId}:${pad(seq)}`;

function createClaudeChat({ storage, dataDir, json, readBody, now = () => Date.now() }) {
  const onlineMs = Number(process.env.LOCALAI_CHAT_ONLINE_MS) > 0 ? Number(process.env.LOCALAI_CHAT_ONLINE_MS) : 45000;
  const wakeups = new EventEmitter();
  wakeups.setMaxListeners(0);

  // ---- auth ----------------------------------------------------------------------------------
  const keyFile = path.join(dataDir, 'claude-chat-mac-key.sha256');
  let keyCache = { mtimeMs: -1, hash: null };
  function macKeyHash() {
    try {
      const { mtimeMs } = fs.statSync(keyFile);
      if (mtimeMs !== keyCache.mtimeMs) {
        const hex = fs.readFileSync(keyFile, 'utf8').trim();
        keyCache = { mtimeMs, hash: /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : null };
      }
      return keyCache.hash;
    } catch { keyCache = { mtimeMs: -1, hash: null }; return null; }
  }
  function macAuthorized(req) {
    const expected = macKeyHash();
    const header = req.headers['x-localai-mac-key'];
    if (!expected || typeof header !== 'string' || !header) return false;
    const actual = crypto.createHash('sha256').update(header).digest();
    return crypto.timingSafeEqual(actual, expected);
  }
  // The single device check. Task 5 replaces this with cookie auth; until then nothing is open
  // unless the test env says so. Returns {id, name} or null.
  function deviceFor(req) {
    if (process.env.LOCALAI_CHAT_TEST_OPEN === '1') return { id: 'test-device', name: 'Test device' };
    return null;
  }

  function checkPost(req, res) {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) { json(res, 403, { error: 'Origin not allowed' }); return false; }
    if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') { json(res, 415, { error: 'Content-Type must be application/json' }); return false; }
    return true;
  }
  async function body(req, res) {
    if (!checkPost(req, res)) return null;
    try { return await readBody(req, 512 * 1024); }
    catch (e) { json(res, e.statusCode || 400, { error: String(e.message || e) }); return null; }
  }

  // ---- data helpers --------------------------------------------------------------------------
  const isOnline = s => now() - (s.lastSeenAt || 0) < onlineMs;
  function capText(value) {
    const s = typeof value === 'string' ? value : '';
    return s.length > MAX_TEXT ? { text: s.slice(0, MAX_TEXT), truncated: true } : { text: s, truncated: false };
  }
  function publicMessage(m) {
    const { id, seq, role, source, text, at, status, deviceName, truncated } = m;
    return { id, seq, role, source, text, at, status, ...(deviceName ? { deviceName } : {}), ...(truncated ? { truncated: true } : {}) };
  }
  // Allocate the next seq and store the message in one transaction so concurrent senders never collide.
  function appendMessage(sessionId, fields) {
    return storage.transaction(() => {
      const seq = (storage.readSetting(seqKey(sessionId), 0) || 0) + 1;
      storage.writeSetting(seqKey(sessionId), seq);
      const message = { id: msgId(sessionId, seq), sessionId, seq, at: now(), ...fields };
      storage.writeSetting(`${msgPrefix(sessionId)}${pad(seq)}`, message);
      if (seq > MAX_MESSAGES) storage.pruneSettings(msgPrefix(sessionId), MAX_MESSAGES);
      return message;
    });
  }
  function pruneIdleSessions() {
    const cutoff = now() - IDLE_PRUNE_MS;
    for (const s of storage.listSettings(`${PREFIX}session:`)) {
      if ((s.lastSeenAt || s.announcedAt || 0) >= cutoff) continue;
      storage.transaction(() => {
        storage.pruneSettings(msgPrefix(s.sessionId), 0);
        storage.deleteSetting(seqKey(s.sessionId));
        storage.deleteSetting(sessionKey(s.sessionId));
      });
    }
  }
  function touch(sessionId) {
    const s = storage.readSetting(sessionKey(sessionId), null);
    if (s) storage.writeSetting(sessionKey(sessionId), { ...s, lastSeenAt: now() });
    return s;
  }
  function claimQueued(sessionId) {
    return storage.transaction(() => {
      const queued = storage.listSettings(msgPrefix(sessionId), { where: { status: 'queued', source: 'web' } }).reverse();
      for (const m of queued) storage.writeSetting(`${msgPrefix(sessionId)}${pad(m.seq)}`, { ...m, status: 'delivered' });
      return queued;
    });
  }

  // ---- Mac-side handlers ---------------------------------------------------------------------
  async function announce(req, res) {
    const b = await body(req, res); if (!b) return;
    if (!SESSION_ID_RE.test(String(b.sessionId || ''))) return json(res, 400, { error: 'Invalid sessionId' });
    const t = now();
    const prev = storage.readSetting(sessionKey(b.sessionId), null);
    storage.writeSetting(sessionKey(b.sessionId), {
      sessionId: b.sessionId, title: String(b.title || '').slice(0, 200), cwd: String(b.cwd || '').slice(0, 500),
      announcedAt: prev?.announcedAt || t, lastSeenAt: t
    });
    pruneIdleSessions();
    json(res, 200, { ok: true });
  }

  async function inboxHandler(req, res, urlObj) {
    const sessionId = urlObj.searchParams.get('sessionId') || '';
    if (!SESSION_ID_RE.test(sessionId)) return json(res, 400, { error: 'Invalid sessionId' });
    const waitRaw = Number(urlObj.searchParams.get('wait'));
    const waitMs = Math.max(0, Math.min(MAX_WAIT_S, Number.isFinite(waitRaw) ? waitRaw : 0)) * 1000;
    touch(sessionId);
    let items = claimQueued(sessionId);
    if (!items.length && waitMs > 0) {
      await new Promise(resolve => {
        let timer;
        const done = () => { clearTimeout(timer); wakeups.off(sessionId, done); req.off('close', done); resolve(); };
        timer = setTimeout(done, waitMs);
        wakeups.on(sessionId, done);
        req.on('close', done);
      });
      if (req.destroyed || res.destroyed) return; // client went away; leave messages queued
      touch(sessionId);
      items = claimQueued(sessionId);
    }
    json(res, 200, { items: items.map(m => ({ id: m.id, seq: m.seq, text: m.text, deviceName: m.deviceName || '' })) });
  }

  async function mirror(req, res) {
    const b = await body(req, res); if (!b) return;
    if (!SESSION_ID_RE.test(String(b.sessionId || ''))) return json(res, 400, { error: 'Invalid sessionId' });
    if (!['user', 'assistant'].includes(b.role)) return json(res, 400, { error: 'role must be user or assistant' });
    if (!['terminal', 'reply'].includes(b.source)) return json(res, 400, { error: 'source must be terminal or reply' });
    if (typeof b.text !== 'string' || !b.text.trim()) return json(res, 400, { error: 'text is required' });
    const { text, truncated } = capText(b.text);
    const message = storage.transaction(() => {
      if (b.source === 'reply') {
        const [newest] = storage.listSettings(msgPrefix(b.sessionId), { where: { status: 'delivered', source: 'web' }, limit: 1 });
        if (newest) storage.writeSetting(`${msgPrefix(b.sessionId)}${pad(newest.seq)}`, { ...newest, status: 'answered' });
      }
      return appendMessage(b.sessionId, { role: b.role, source: b.source, text, ...(truncated ? { truncated: true } : {}), status: 'delivered' });
    });
    json(res, 200, { ok: true, seq: message.seq });
  }

  // ---- device-side handlers ------------------------------------------------------------------
  function sessions(req, res) {
    const items = storage.listSettings(`${PREFIX}session:`).map(s => ({ sessionId: s.sessionId, title: s.title, cwd: s.cwd, online: isOnline(s), lastSeenAt: s.lastSeenAt }));
    items.sort((a, c) => (c.lastSeenAt || 0) - (a.lastSeenAt || 0));
    json(res, 200, { items });
  }

  function messagesHandler(req, res, urlObj) {
    const sessionId = urlObj.searchParams.get('sessionId') || '';
    if (!SESSION_ID_RE.test(sessionId)) return json(res, 400, { error: 'Invalid sessionId' });
    const after = Number(urlObj.searchParams.get('after')) || 0;
    const items = storage.listSettings(msgPrefix(sessionId), { limit: MAX_MESSAGES }).filter(m => m.seq > after).reverse();
    json(res, 200, { items: items.map(publicMessage) });
  }

  async function sendHandler(req, res, device) {
    const b = await body(req, res); if (!b) return;
    if (!SESSION_ID_RE.test(String(b.sessionId || ''))) return json(res, 400, { error: 'Invalid sessionId' });
    if (typeof b.text !== 'string' || !b.text.trim()) return json(res, 400, { error: 'text is required' });
    const session = storage.readSetting(sessionKey(b.sessionId), null);
    if (!session || !isOnline(session)) return json(res, 409, { error: 'Session is offline' });
    const { text, truncated } = capText(b.text);
    const message = appendMessage(b.sessionId, { role: 'user', source: 'web', text, ...(truncated ? { truncated: true } : {}), status: 'queued', deviceId: device.id, deviceName: device.name });
    wakeups.emit(b.sessionId);
    json(res, 201, { item: publicMessage(message) });
  }

  async function deleteHandler(req, res, device) {
    const b = await body(req, res); if (!b) return;
    const m = /^([A-Za-z0-9-]{1,80}):(\d{10})$/.exec(String(b.id || ''));
    if (!m) return json(res, 409, { error: 'Message cannot be deleted' });
    const key = `${msgPrefix(m[1])}${m[2]}`;
    const result = storage.transaction(() => {
      const message = storage.readSetting(key, null);
      if (!message || message.source !== 'web' || message.status !== 'queued') return 409;
      if (message.deviceId !== device.id) return 403;
      storage.deleteSetting(key);
      return 200;
    });
    if (result !== 200) return json(res, result, { error: 'Message cannot be deleted' });
    json(res, 200, { ok: true });
  }

  async function handle(req, res, urlObj, p) {
    if (!p.startsWith('/api/claude/chat/')) return false;
    const route = `${req.method} ${p}`;
    const macRoutes = {
      'POST /api/claude/chat/announce': () => announce(req, res),
      'GET /api/claude/chat/inbox': () => inboxHandler(req, res, urlObj),
      'POST /api/claude/chat/mirror': () => mirror(req, res)
    };
    if (macRoutes[route]) {
      if (!macAuthorized(req)) { json(res, 401, { error: 'Unauthorized' }); return true; }
      await macRoutes[route]();
      return true;
    }
    const deviceRoutes = {
      'GET /api/claude/chat/sessions': () => sessions(req, res),
      'GET /api/claude/chat/messages': () => messagesHandler(req, res, urlObj),
      'POST /api/claude/chat/send': d => sendHandler(req, res, d),
      'POST /api/claude/chat/messages/delete': d => deleteHandler(req, res, d)
    };
    if (deviceRoutes[route]) {
      const device = deviceFor(req);
      if (!device) { json(res, 401, { error: 'Unauthorized' }); return true; }
      await deviceRoutes[route](device);
      return true;
    }
    return false;
  }

  return { handle };
}

module.exports = { createClaudeChat };
