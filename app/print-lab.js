'use strict';

// Print lab (Projects › Print lab): a read-only copy of the Mac's print-lab records (print-lab repo, `lab sync`).
// The Mac is the record: only it writes (X-LocalAI-Mac-Key), and nothing here changes what it sent. Each push is the
// whole projection (schema print-lab-index/1); one older than the last stored is refused, records are upserted by
// id and skipped when their sha256 is unchanged, and records the Mac no longer has are removed.
// Photos are stored once each under DATA_DIR/print-lab/<project>/photos/<sha256>.jpg.
// Requests and incoming photos are sent by paired phones and picked up by the Mac (`lab pull`).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA = 'print-lab-index/1';
const PREFIX = 'printLab:';
const PROJECT_RE = /^[a-z0-9-]{1,40}$/;
const ID_RE = /^[A-Z]{1,4}-\d{1,6}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const REQUEST_ID_RE = /^rq-[0-9a-f]{16}$/;
const EXPERIMENT_ID_RE = /^[A-Z]{1,4}-\d{1,6}(-\d{2})?$/;
const RUN_ID_RE = /^[A-Z]{1,4}-\d{1,6}(-\d{2})?$/;
const MAX_SYNC = 4 * 1024 * 1024;
const MAX_PHOTO = 8 * 1024 * 1024;
const MAX_REQUEST = 4 * 1024;
const MAX_RECORDS = 2000;
const MAX_PENDING = 20;

const key = (project, part) => `${PREFIX}${project}:${part}`;

function readRaw(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0, tooLarge = false;
    const chunks = [];
    req.on('data', c => {
      if (tooLarge) return;
      total += c.length;
      if (total > maxBytes) { tooLarge = true; chunks.length = 0; reject(Object.assign(new Error('Request body too large'), { statusCode: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function createPrintLab({ storage, dataDir, json, macAuthorized, deviceFor = () => null, now = () => new Date().toISOString() }) {
  const photoDir = project => path.join(dataDir, 'print-lab', project, 'photos');
  const incomingDir = project => path.join(dataDir, 'print-lab', project, 'incoming');
  const projects = () => storage.readSetting(`${PREFIX}projects`, { names: [] }).names;

  function sync(project, ix) {
    if (!ix || ix.schema !== SCHEMA) return [422, { error: `Expected schema ${SCHEMA}; update the lab on the Mac.` }];
    if (ix.project !== project) return [422, { error: `The push is for ${ix.project}, not ${project}.` }];
    const at = Date.parse(ix.generated_at);
    if (!Number.isFinite(at)) return [422, { error: 'generated_at is missing or not a date.' }];
    const records = ix.records && typeof ix.records === 'object' ? ix.records : {};
    const ids = Object.keys(records);
    if (ids.length > MAX_RECORDS || ids.some(id => !ID_RE.test(id))) return [422, { error: 'Record ids must look like E-001 or Q-001.' }];
    const meta = storage.readSetting(key(project, 'meta'), null);
    if (meta && meta.fingerprint === ix.fingerprint) {
      storage.writeSetting(key(project, 'meta'), { ...meta, synced_at: now() });
      return [200, { ok: true, upserted: 0, removed: 0, unchanged: ids.length }];
    }
    if (meta && Date.parse(meta.generated_at) > at) return [409, { error: `An older push than the one stored (${meta.generated_at}); nothing changed.` }];
    let upserted = 0, unchanged = 0, removed = 0;
    storage.transaction(() => {
      for (const id of ids) {
        const r = records[id] || {};
        const old = storage.readSetting(key(project, `record:${id}`), null);
        if (old && old.sha256 === r.sha256) { unchanged++; continue; }
        storage.writeSetting(key(project, `record:${id}`), { id, type: r.type, file: r.file, sha256: r.sha256, payload: r.payload, received_at: now() });
        upserted++;
      }
      for (const old of storage.listSettings(key(project, 'record:'))) {
        if (!(old.id in records)) { storage.deleteSetting(key(project, `record:${old.id}`)); removed++; }
      }
      const { records: _drop, colours: _c, ...index } = ix;
      storage.writeSetting(key(project, 'index'), index);
      storage.writeSetting(key(project, 'meta'), { generated_at: ix.generated_at, fingerprint: ix.fingerprint, synced_at: now(), counts: { records: ids.length, experiments: (ix.experiments || []).length } });
      if (!projects().includes(project)) storage.writeSetting(`${PREFIX}projects`, { names: [...projects(), project].sort() });
    });
    return [200, { ok: true, upserted, removed, unchanged }];
  }

  function havePhotos(project) {
    try { return fs.readdirSync(photoDir(project)).filter(f => /^[0-9a-f]{64}\.jpg$/.test(f)).map(f => f.slice(0, 64)); } catch { return []; }
  }

  // true when it answered.
  async function handle(req, res, p) {
    const m = /^\/api\/lab\/([a-z0-9-]{1,40})(?:\/(sync|photos|photo|record|requests|incoming)(?:\/([^/]+)(?:\/([^/]+))?)?)?$/.exec(p);
    if (p === '/api/lab/projects' && req.method === 'GET') {
      json(res, 200, { projects: projects().map(name => ({ name, ...storage.readSetting(key(name, 'meta'), {}) })) });
      return true;
    }
    if (!m || !m[1] || !PROJECT_RE.test(m[1])) return false;
    const [, project, part, arg, sub] = m;
    try {
      if (!part && req.method === 'GET') {
        const index = storage.readSetting(key(project, 'index'), null);
        if (!index) json(res, 404, { error: 'No lab data yet. Run `lab sync` on the Mac.' });
        else json(res, 200, { meta: storage.readSetting(key(project, 'meta'), {}), index });
        return true;
      }
      if (part === 'sync' && req.method === 'POST') {
        if (!macAuthorized(req)) { req.resume(); json(res, 401, { error: 'Only the Mac (lab sync) writes the print lab.' }); return true; }
        let ix;
        try { ix = JSON.parse((await readRaw(req, MAX_SYNC)).toString('utf8')); } catch (e) { if (e.statusCode) throw e; json(res, 400, { error: 'Invalid JSON request body' }); return true; }
        const [status, body] = sync(project, ix);
        json(res, status, body);
        return true;
      }
      if (part === 'photos' && !arg && req.method === 'GET') { json(res, 200, { have: havePhotos(project) }); return true; }
      if (part === 'photos' && arg && req.method === 'PUT') {
        if (!macAuthorized(req)) { req.resume(); json(res, 401, { error: 'Only the Mac (lab sync) writes the print lab.' }); return true; }
        const sha = arg.replace(/\.jpg$/, '');
        if (!SHA_RE.test(sha) || !arg.endsWith('.jpg')) { req.resume(); json(res, 400, { error: 'Name a photo by its sha256: <sha256>.jpg' }); return true; }
        const body = await readRaw(req, MAX_PHOTO);
        if (body[0] !== 0xff || body[1] !== 0xd8) { json(res, 415, { error: 'Only JPEG photos.' }); return true; }
        if (crypto.createHash('sha256').update(body).digest('hex') !== sha) { json(res, 422, { error: "The photo doesn't match its sha256." }); return true; }
        fs.mkdirSync(photoDir(project), { recursive: true });
        const file = path.join(photoDir(project), `${sha}.jpg`);
        if (!fs.existsSync(file)) { fs.writeFileSync(`${file}.tmp`, body); fs.renameSync(`${file}.tmp`, file); }
        json(res, 200, { ok: true });
        return true;
      }
      if (part === 'photo' && arg && req.method === 'GET') {
        const sha = arg.replace(/\.jpg$/, '');
        const file = path.join(photoDir(project), `${sha}.jpg`);
        if (!SHA_RE.test(sha) || !fs.existsSync(file)) { json(res, 404, { error: 'No such photo.' }); return true; }
        const jpg = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpg.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
        res.end(jpg);
        return true;
      }
      if (part === 'record' && arg && req.method === 'GET') {
        const r = ID_RE.test(arg) ? storage.readSetting(key(project, `record:${arg}`), null) : null;
        if (!r) json(res, 404, { error: `No record ${arg}.` }); else json(res, 200, r);
        return true;
      }
      if (part === 'incoming' && arg && req.method === 'PUT') {
        const dev = deviceFor(req);
        if (!dev) { req.resume(); json(res, 401, { error: "This phone isn't paired with Local AI. Pair it in Settings › Devices." }); return true; }
        const sha = arg.replace(/\.jpg$/, '');
        if (!SHA_RE.test(sha) || !arg.endsWith('.jpg')) { req.resume(); json(res, 400, { error: 'Name an incoming photo by its sha256: <sha256>.jpg' }); return true; }
        const body = await readRaw(req, MAX_PHOTO);
        if (body[0] !== 0xff || body[1] !== 0xd8) { json(res, 415, { error: 'Only JPEG photos.' }); return true; }
        if (crypto.createHash('sha256').update(body).digest('hex') !== sha) { json(res, 422, { error: "The photo doesn't match its sha256." }); return true; }
        fs.mkdirSync(incomingDir(project), { recursive: true });
        const file = path.join(incomingDir(project), `${sha}.jpg`);
        if (!fs.existsSync(file)) { fs.writeFileSync(`${file}.tmp`, body); fs.renameSync(`${file}.tmp`, file); }
        json(res, 200, { ok: true });
        return true;
      }
      if (part === 'incoming' && arg && req.method === 'GET') {
        if (!macAuthorized(req)) { json(res, 401, { error: 'Only the Mac reads incoming photos.' }); return true; }
        const sha = arg.replace(/\.jpg$/, '');
        const file = path.join(incomingDir(project), `${sha}.jpg`);
        if (!SHA_RE.test(sha) || !fs.existsSync(file)) { json(res, 404, { error: 'No such photo.' }); return true; }
        const jpg = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpg.length });
        res.end(jpg);
        return true;
      }
      if (part === 'requests' && !arg && req.method === 'POST') {
        const dev = deviceFor(req);
        if (!dev) { req.resume(); json(res, 401, { error: "This phone isn't paired with Local AI. Pair it in Settings › Devices." }); return true; }
        let data;
        try { data = JSON.parse((await readRaw(req, MAX_REQUEST)).toString('utf8')); }
        catch (e) { if (e.statusCode) throw e; json(res, 400, { error: 'Invalid JSON request body' }); return true; }
        const { id, kind, experiment, run, payload } = data || {};
        if (!REQUEST_ID_RE.test(id || '')) { json(res, 422, { error: 'Request id must look like rq-0123456789abcdef' }); return true; }
        if (kind !== 'verdict' && kind !== 'photos') { json(res, 422, { error: 'kind must be verdict or photos' }); return true; }
        if (!EXPERIMENT_ID_RE.test(experiment || '')) { json(res, 422, { error: 'Invalid experiment id' }); return true; }
        if (!RUN_ID_RE.test(run || '')) { json(res, 422, { error: 'Invalid run id' }); return true; }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { json(res, 422, { error: 'payload must be an object' }); return true; }

        const existing = storage.readSetting(key(project, `request:${id}`), null);
        if (existing) {
          json(res, 200, { ok: true, id, status: existing.status });
          return true;
        }

        const allReqs = storage.listSettings(key(project, 'request:'));
        const pending = allReqs.filter(r => r.status === 'pending');
        if (pending.length >= MAX_PENDING) {
          json(res, 429, { error: "The Mac hasn't picked up the last 20 requests. Check that the Mac is awake." });
          return true;
        }

        const item = {
          id,
          kind,
          experiment,
          run,
          payload,
          status: 'pending',
          message: null,
          at: now(),
          by: dev.id || dev
        };
        storage.writeSetting(key(project, `request:${id}`), item);
        json(res, 200, { ok: true, id, status: 'pending' });
        return true;
      }
      if (part === 'requests' && !arg && req.method === 'GET') {
        const url = new URL(req.url, 'http://localhost');
        const isPending = url.searchParams.get('status') === 'pending';
        if (isPending) {
          if (!macAuthorized(req)) { json(res, 401, { error: 'Only the Mac reads pending requests.' }); return true; }
          const items = storage.listSettings(key(project, 'request:'))
            .filter(r => r.status === 'pending')
            .sort((a, b) => (a.at > b.at ? 1 : -1));
          json(res, 200, { items });
          return true;
        }
        const dev = deviceFor(req);
        if (!dev && !macAuthorized(req)) {
          json(res, 401, { error: "This phone isn't paired with Local AI. Pair it in Settings › Devices." });
          return true;
        }
        const items = storage.listSettings(key(project, 'request:'))
          .sort((a, b) => (a.at < b.at ? 1 : -1))
          .slice(0, 50)
          .map(({ id, kind, experiment, status, message, at }) => ({ id, kind, experiment, status, message, at }));
        json(res, 200, { items });
        return true;
      }
      if (part === 'requests' && arg && sub === 'result' && req.method === 'POST') {
        if (!macAuthorized(req)) { req.resume(); json(res, 401, { error: 'Only the Mac writes request results.' }); return true; }
        const reqId = arg;
        let body;
        try { body = JSON.parse((await readRaw(req, MAX_REQUEST)).toString('utf8')); }
        catch (e) { if (e.statusCode) throw e; json(res, 400, { error: 'Invalid JSON request body' }); return true; }
        const { status, message } = body || {};
        if (!['applied', 'refused', 'duplicate'].includes(status)) {
          json(res, 422, { error: 'status must be applied, refused, or duplicate' });
          return true;
        }
        const item = storage.readSetting(key(project, `request:${reqId}`), null);
        if (!item) {
          json(res, 404, { error: `No request ${reqId}.` });
          return true;
        }
        item.status = status;
        item.message = message || null;
        item.resolved_at = now();
        storage.writeSetting(key(project, `request:${reqId}`), item);
        if (status === 'applied' && item.kind === 'photos' && item.payload && Array.isArray(item.payload.photos)) {
          for (const p of item.payload.photos) {
            if (p && p.sha256) {
              try { fs.unlinkSync(path.join(incomingDir(project), `${p.sha256}.jpg`)); } catch {}
            }
          }
        }
        json(res, 200, { ok: true });
        return true;
      }
    } catch (e) {
      if (e.statusCode === 413) { json(res, 413, { error: 'Too large for the print lab.' }); return true; }
      throw e;
    }
    json(res, 405, { error: 'Not a print-lab route.' });
    return true;
  }

  return { handle, sync };
}

module.exports = { createPrintLab, SCHEMA };
