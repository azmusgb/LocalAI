'use strict';

// Claude chat relay: the appliance side of the LocalAI web <-> Claude Code session chat.
// Mac-side calls (announce, inbox, inbox/ack, mirror) carry X-LocalAI-Mac-Key; device-side calls use deviceFor() (cookie auth).
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
const MAX_ACK_IDS = 50;

const sessionKey = id => `${PREFIX}session:${id}`;
const seqKey = id => `${PREFIX}seq:${id}`;
const msgPrefix = id => `${PREFIX}msg:${id}:`;
const pad = seq => String(seq).padStart(10, '0');
const msgId = (sessionId, seq) => `${sessionId}:${pad(seq)}`;

function createClaudeChat({ storage, dataDir, json, readBody, now = () => Date.now() }) {
  const onlineMs = Number(process.env.LOCALAI_CHAT_ONLINE_MS) > 0 ? Number(process.env.LOCALAI_CHAT_ONLINE_MS) : 45000;
  // How long a claimed (delivering) message waits for the bridge's ack before it is offered again.
  const leaseMs = Number(process.env.LOCALAI_CHAT_LEASE_MS) > 0 ? Number(process.env.LOCALAI_CHAT_LEASE_MS) : 60000;
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
  // ---- device cookie auth --------------------------------------------------------------------
  const COOKIE = 'localai_chat_device';
  const deviceKey = id => `${PREFIX}device:${id}`;
  const pairKey = id => `${PREFIX}pair:${id}`;
  const sha256hex = v => crypto.createHash('sha256').update(v).digest('hex');
  const LASTSEEN_MS = 60000;
  function parseCookies(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) { const k = part.slice(0, i).trim(); if (!(k in out)) out[k] = part.slice(i + 1).trim(); }
    }
    return out;
  }
  // The single device check: valid cookie -> {id, name}, else null.
  function deviceFor(req) {
    const value = parseCookies(req.headers.cookie)[COOKIE];
    const m = /^(dev-[0-9a-f]{12})\.([A-Za-z0-9_-]{1,100})$/.exec(value || '');
    if (!m) return null;
    const device = storage.readSetting(deviceKey(m[1]), null);
    if (!device || typeof device.tokenSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(device.tokenSha256)) return null;
    const actual = crypto.createHash('sha256').update(m[2]).digest();
    if (!crypto.timingSafeEqual(actual, Buffer.from(device.tokenSha256, 'hex'))) return null;
    if (now() - (device.lastSeenAt || 0) >= LASTSEEN_MS) storage.writeSetting(deviceKey(device.id), { ...device, lastSeenAt: now() });
    return { id: device.id, name: device.name };
  }

  function checkPost(req, res) {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) { json(res, 403, { error: 'Origin not allowed' }); return false; }
    if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') { json(res, 415, { error: 'Content-Type must be application/json' }); return false; }
    return true;
  }
  async function body(req, res) {
    if (!checkPost(req, res)) return null;
    let parsed;
    try { parsed = await readBody(req, 512 * 1024); }
    catch (e) { json(res, e.statusCode || 400, { error: String(e.message || e) }); return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { json(res, 400, { error: 'JSON object body required' }); return null; }
    return parsed;
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
  const msgKey = m => `${msgPrefix(m.sessionId)}${pad(m.seq)}`;
  // A delivering message whose lease ran out (the inbox response or the ack never arrived) goes back to queued.
  // Callers run this inside their transaction.
  function requeueExpired(sessionId) {
    const t = now();
    for (const m of storage.listSettings(msgPrefix(sessionId), { where: { status: 'delivering', source: 'web' } })) {
      if ((m.leaseUntil || 0) <= t) { const { leaseUntil, ...rest } = m; storage.writeSetting(msgKey(m), { ...rest, status: 'queued' }); }
    }
  }
  // Claim queued web messages for the bridge: they are leased (delivering) until it acks them, never marked delivered here,
  // so a response lost on the way to the Mac delays a message instead of losing it.
  function claimQueued(sessionId) {
    return storage.transaction(() => {
      requeueExpired(sessionId);
      const queued = storage.listSettings(msgPrefix(sessionId), { where: { status: 'queued', source: 'web' } }).reverse();
      const leaseUntil = now() + leaseMs;
      for (const m of queued) storage.writeSetting(msgKey(m), { ...m, status: 'delivering', leaseUntil });
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

  async function ackHandler(req, res) {
    const b = await body(req, res); if (!b) return;
    const sessionId = String(b.sessionId || '');
    if (!SESSION_ID_RE.test(sessionId)) return json(res, 400, { error: 'Invalid sessionId' });
    const idRe = new RegExp(`^${sessionId}:\\d{10}$`); // sessionId is [A-Za-z0-9-] only, safe in a pattern
    if (!Array.isArray(b.ids) || b.ids.length > MAX_ACK_IDS || !b.ids.every(id => typeof id === 'string' && idRe.test(id))) {
      return json(res, 400, { error: `ids must be an array of at most ${MAX_ACK_IDS} message ids of this session` });
    }
    const acked = storage.transaction(() => {
      requeueExpired(sessionId);
      const done = [];
      for (const id of new Set(b.ids)) {
        const key = `${msgPrefix(sessionId)}${id.slice(sessionId.length + 1)}`;
        const m = storage.readSetting(key, null);
        if (!m || m.source !== 'web' || m.status !== 'delivering') continue; // unknown, already delivered/answered, or requeued
        const { leaseUntil, ...rest } = m;
        storage.writeSetting(key, { ...rest, status: 'delivered' });
        done.push(id);
      }
      return done;
    });
    json(res, 200, { acked });
  }

  async function mirror(req, res) {
    const b = await body(req, res); if (!b) return;
    if (!SESSION_ID_RE.test(String(b.sessionId || ''))) return json(res, 400, { error: 'Invalid sessionId' });
    if (!['user', 'assistant'].includes(b.role)) return json(res, 400, { error: 'role must be user or assistant' });
    if (!['terminal', 'reply'].includes(b.source)) return json(res, 400, { error: 'source must be terminal or reply' });
    if (typeof b.text !== 'string' || !b.text.trim()) return json(res, 400, { error: 'text is required' });
    const { text, truncated } = capText(b.text);
    // A reply answers every delivered web message before it (several may share a turn, or an earlier turn
    // may have produced no reply); all of them carry a lower seq than the reply appended here.
    const message = storage.transaction(() => {
      const reply = appendMessage(b.sessionId, { role: b.role, source: b.source, text, ...(truncated ? { truncated: true } : {}), status: 'delivered' });
      if (b.source === 'reply') {
        for (const m of storage.listSettings(msgPrefix(b.sessionId), { where: { status: 'delivered', source: 'web' } })) {
          if (m.seq < reply.seq) storage.writeSetting(`${msgPrefix(b.sessionId)}${pad(m.seq)}`, { ...m, status: 'answered' });
        }
      }
      return reply;
    });
    json(res, 200, { ok: true, seq: message.seq });
  }

  // ---- pairing and devices -------------------------------------------------------------------
  const PAIR_TTL_MS = Number(process.env.LOCALAI_CHAT_PAIR_TTL_MS) > 0 ? Number(process.env.LOCALAI_CHAT_PAIR_TTL_MS) : 10 * 60 * 1000;
  const MAX_PENDING = 5;
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  function livePairings() {
    const t = now();
    const live = [];
    for (const r of storage.listSettings(`${PREFIX}pair:`)) {
      if (r.expiresAt <= t) storage.deleteSetting(pairKey(r.id));
      else live.push(r);
    }
    return live;
  }
  function newCode(taken) {
    for (;;) {
      let code = '';
      for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!taken.has(code)) return code;
    }
  }
  async function pairRequest(req, res) {
    if (!checkPost(req, res)) return;
    try { await readBody(req, 4096); } catch { /* body is ignored */ }
    const result = storage.transaction(() => {
      const pending = livePairings().filter(r => r.status === 'pending');
      if (pending.length >= MAX_PENDING) return null;
      const record = { id: `pair-${crypto.randomBytes(8).toString('hex')}`, code: newCode(new Set(pending.map(r => r.code))), status: 'pending', createdAt: now(), expiresAt: now() + PAIR_TTL_MS };
      storage.writeSetting(pairKey(record.id), record);
      return record;
    });
    if (!result) return json(res, 429, { error: 'Too many pending pairing requests' });
    json(res, 201, { id: result.id, code: result.code, expiresAt: result.expiresAt });
  }
  function pairStatus(req, res, urlObj) {
    const id = urlObj.searchParams.get('id') || '';
    const outcome = storage.transaction(() => {
      livePairings();
      const record = /^pair-[0-9a-f]{16}$/.test(id) ? storage.readSetting(pairKey(id), null) : null;
      if (!record) return { status: 'expired' };
      if (record.status === 'pending') return { status: 'pending' };
      storage.deleteSetting(pairKey(id));
      const token = crypto.randomBytes(32).toString('base64url');
      const t = now();
      const device = { id: record.deviceId, name: record.deviceName, tokenSha256: sha256hex(token), pairedAt: record.approvedAt || t, lastSeenAt: t };
      storage.writeSetting(deviceKey(device.id), device);
      return { status: 'approved', device: { id: device.id, name: device.name }, cookie: `${COOKIE}=${device.id}.${token}; HttpOnly; SameSite=Strict; Path=/api/claude/chat; Max-Age=15552000` };
    });
    if (outcome.cookie) {
      res.setHeader('Set-Cookie', outcome.cookie);
      res.setHeader('Cache-Control', 'no-store');
      delete outcome.cookie;
    }
    json(res, 200, outcome);
  }
  async function pairApprove(req, res) {
    const b = await body(req, res); if (!b) return;
    const name = (b.name === undefined || b.name === null ? '' : String(b.name).trim()) || 'Device';
    if (name.length > 60) return json(res, 400, { error: 'name must be at most 60 characters' });
    const code = String(b.code || '').trim().toUpperCase();
    const result = storage.transaction(() => {
      const record = livePairings().find(r => r.status === 'pending' && r.code === code);
      if (!record) return null;
      const deviceId = `dev-${crypto.randomBytes(6).toString('hex')}`;
      storage.writeSetting(pairKey(record.id), { ...record, status: 'approved', deviceId, deviceName: name, approvedAt: now() });
      return deviceId;
    });
    if (!result) return json(res, 404, { error: 'Unknown or expired code' });
    json(res, 200, { deviceId: result });
  }
  function devicesList(req, res, current) {
    const items = storage.listSettings(`${PREFIX}device:`).map(d => ({ id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeenAt: d.lastSeenAt, current: !!current && d.id === current.id }));
    items.sort((a, c) => (a.pairedAt || 0) - (c.pairedAt || 0));
    json(res, 200, { items });
  }
  async function devicesRevoke(req, res) {
    const b = await body(req, res); if (!b) return;
    const id = String(b.id || '');
    const found = /^dev-[0-9a-f]{12}$/.test(id) && storage.transaction(() => {
      if (!storage.readSetting(deviceKey(id), null)) return false;
      storage.deleteSetting(deviceKey(id));
      return true;
    });
    if (!found) return json(res, 404, { error: 'Unknown device' });
    json(res, 200, { ok: true });
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
    // Expire stale leases first, so a message whose bridge vanished (session offline) shows as queued, not sending forever.
    const items = storage.transaction(() => {
      requeueExpired(sessionId);
      return storage.listSettings(msgPrefix(sessionId), { limit: MAX_MESSAGES }).filter(m => m.seq > after).reverse();
    });
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
      requeueExpired(m[1]); // an expired lease is queued again, so it can be deleted
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
      'POST /api/claude/chat/inbox/ack': () => ackHandler(req, res),
      'POST /api/claude/chat/mirror': () => mirror(req, res)
    };
    if (macRoutes[route]) {
      if (!macAuthorized(req)) { json(res, 401, { error: 'Unauthorized' }); return true; }
      await macRoutes[route]();
      return true;
    }
    if (route === 'POST /api/claude/chat/pair-request') { await pairRequest(req, res); return true; }
    if (route === 'GET /api/claude/chat/pair-status') { pairStatus(req, res, urlObj); return true; }
    if (route === 'POST /api/claude/chat/pair/approve') {
      if (!macAuthorized(req)) { json(res, 401, { error: 'Unauthorized' }); return true; }
      await pairApprove(req, res);
      return true;
    }
    // Either the Mac key or a device cookie.
    if (route === 'GET /api/claude/chat/devices' || route === 'POST /api/claude/chat/devices/revoke') {
      const device = deviceFor(req);
      if (!device && !macAuthorized(req)) { json(res, 401, { error: 'Unauthorized' }); return true; }
      if (route.startsWith('GET')) devicesList(req, res, device); else await devicesRevoke(req, res);
      return true;
    }
    // Lets the page ask whether it is paired without provoking a 401 (and a console error) on every load.
    if (route === 'GET /api/claude/chat/whoami') { json(res, 200, { paired: !!deviceFor(req) }); return true; }
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
