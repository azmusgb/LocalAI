'use strict';

// Print lab: a read-only copy of the Mac's print-lab records (print-lab repo, `lab sync`).
// The Mac is the record: only it writes (X-LocalAI-Mac-Key), and nothing here changes what it sent. Each push is the
// whole projection (schema print-lab-index/1); one older than the last stored is refused, records are upserted by
// id and skipped when their sha256 is unchanged, and records the Mac no longer has are removed.
// Photos are stored once each under DATA_DIR/print-lab/<project>/photos/<sha256>.jpg.
// Requests and incoming photos are sent by paired phones (and a verdict by the Workshop display, app/display-lab.js) and
// picked up by the Mac (`lab pull`): verdict and photos, and
// the page's buttons start (It's printing now), approve and abandon (Drop). Local AI only queues them; the Mac applies
// each once with the CLI's own functions and posts the result back.
// The project also carries `live`: the Workshop printer's state for the one experiment that is printing, and
// GET /api/lab/camera.jpg passes on one snapshot from the Pi's camera bridge (paired devices only).
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
// A phone observation session (Record what happened) carries several complete snapshots, so it gets more room.
const MAX_OBS_REQUEST = 16 * 1024;
const OBS_KINDS = ['observation', 'observation_correction'];
const OBS_ID_RE = /^OBS-\d{4,}$/;

// Shape checks only: the Mac (lab pull) checks every field against the spec and refuses what doesn't fit.
function obsProblem(kind, payload) {
  const isSnap = x => x && typeof x === 'object' && !Array.isArray(x) && x.subject && typeof x.subject === 'object'
    && x.outcomes && typeof x.outcomes === 'object' && x.source && typeof x.source === 'object';
  if (kind === 'observation') {
    const s = payload.snapshots;
    if (!Array.isArray(s) || s.length < 1 || s.length > 8) return 'An observation session has 1 to 8 snapshots.';
    if (!s.every(isSnap)) return 'Each snapshot has a subject, outcomes and a source.';
    return null;
  }
  if (!OBS_ID_RE.test(payload.observation || '')) return 'The observation id looks like OBS-0001.';
  if (!Number.isSafeInteger(payload.expected_rev) || payload.expected_rev < 1) return 'expected_rev is the revision you corrected.';
  if (!isSnap(payload.snapshot)) return 'A correction carries a complete snapshot.';
  if (typeof payload.reason !== 'string' || !payload.reason.trim() || payload.reason.length > 500) return 'A correction needs a reason of at most 500 characters.';
  return null;
}
const MAX_RECORDS = 2000;
const MAX_PENDING = 20;
const MAX_REASON = 500;
const ACT_KINDS = ['start', 'approve', 'abandon'];
const BUILD_ID_RE = /^[A-Z]{1,4}-\d{1,6}-\d{1,4}$/;
const GUARD_CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;
// The Pi's camera bridge (it stays open for the Workshop display) and the Pi hub, which says why there is no picture.
const CAMERA_URL = 'http://10.0.0.80:8091/x2d/frame.jpg';
const CAMERA_TIMEOUT_MS = 3000;
const MAX_FRAME = 2 * 1024 * 1024; // read as a stream and cut off past this: a huge or endless answer is never held
const MAX_REASON_ANSWER = 4 * 1024; // the hub's /api/camera answer is about 200 bytes
const CAMERA_REASONS = new Set(['liveview_off', 'printer_unreachable']);
const CAMERA_WORDS = {
  liveview_off: 'No picture: LAN Only Liveview is off on the X2D.',
  printer_unreachable: "No picture: the printer isn't answering on the network.",
  no_picture: "No picture: the camera isn't sending one right now."
};

const key = (project, part) => `${PREFIX}${project}:${part}`;

// The Workshop display's Print lab card (docs/WORKSHOP-DISPLAY.md), from the stored index and live(index): while the
// one printing experiment's run is on the printer, "Lab · E-021" (busy); once the printer says it finished (idle,
// stopped or ended: the Print lab page's Judge it rule, app/public/print-lab.js FINISHED) and there is no verdict,
// "Judge E-021" (attention, ask lab-judge, with the run) for 24 h after the run's end (its estimated end, else its
// start). Two printing: none. Text from the Mac is passed on as strings only; the feed cuts it.
const FINISHED = new Set(['idle', 'cancelled', 'ended']);
const JUDGE_FOR_MS = 24 * 3600 * 1000;
const text = v => (typeof v === 'string' ? v : '');
function labCards(index, l, nowMs = Date.now()) {
  if (!l || l.conflict || typeof l.experiment !== 'string') return [];
  const x = (Array.isArray(index?.experiments) ? index.experiments : []).find(e => e && e.id === l.experiment);
  if (!x || x.status !== 'printing') return [];
  const run = text(l.run) || text(x.run);
  const ref = run || x.id;
  if (!FINISHED.has(l.state)) return [{ kind: 'lab', id: `lab-${ref}`, title: `Lab · ${x.id}`, text: text(x.judge_on) || text(x.question_text), tone: 'busy' }];
  if (x.verdict || x.owner_verdict) return [];
  const started = (Array.isArray(x.runs) ? x.runs : []).filter(r => r && (!run || r.id === run)).map(r => Date.parse(r.started_at)).pop();
  const end = Number.isFinite(Date.parse(x.due_at)) ? Date.parse(x.due_at) : started;
  if (Number.isFinite(end) && nowMs - end > JUDGE_FOR_MS) return [];
  return [{ kind: 'lab', id: `judge-${ref}`, title: `Judge ${x.id}`, text: `Look at: ${text(x.judge_on) || 'the face'}`, tone: 'attention', ask: 'lab-judge', ...(run ? { run } : {}) }];
}

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

// What is wrong with a start / approve / abandon request, or null. Only the fields lab pull reads pass, and only in the
// shapes it expects; the reason is the owner's own words and is shown back only as text.
function actProblem(kind, payload, runSeen) {
  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
  if (kind === 'start') {
    if (typeof payload.tapped_at !== 'string' || payload.tapped_at.length > 40 || !Number.isFinite(Date.parse(payload.tapped_at))) return 'tapped_at must be a date';
    if (runSeen !== null && runSeen !== undefined && !RUN_ID_RE.test(String(runSeen))) return 'Invalid run id';
    return null;
  }
  if (!reason) return kind === 'abandon' ? 'Dropping needs a reason.' : 'Approving needs a reason.';
  if ([...reason].length > MAX_REASON) return `Keep the reason to ${MAX_REASON} characters.`;
  if (kind === 'approve') {
    if (typeof payload.build_seen !== 'string' || !BUILD_ID_RE.test(payload.build_seen)) return 'build_seen must be a build id';
    if (!Array.isArray(payload.reasons_seen) || payload.reasons_seen.length > 30 || !payload.reasons_seen.every(c => typeof c === 'string' && GUARD_CODE_RE.test(c))) return 'reasons_seen must be a list of guard codes';
  }
  return null;
}

// What is wrong with a photos request, or null: each photo is named by its sha256 (the clean-up after it is applied
// deletes incoming/<sha256>.jpg, so nothing else may reach a path) with a short plain tab or none.
function photosProblem(payload) {
  const list = payload.photos;
  if (!Array.isArray(list) || !list.length || list.length > 50) return 'photos must list 1 to 50 photos';
  if (!list.every(p => p && typeof p === 'object' && SHA_RE.test(p.sha256 || '') && (p.tab == null || (typeof p.tab === 'string' && /^[\w.-]{1,16}$/.test(p.tab))))) return 'Each photo needs its sha256 and at most a short tab name.';
  return null;
}

function createPrintLab({ storage, dataDir, json, macAuthorized, deviceFor = () => null, now = () => new Date().toISOString(), clock = () => Date.now(), printer = () => null, cameraUrl = process.env.LOCALAI_LAB_CAMERA_URL || CAMERA_URL, piHubUrl = process.env.LOCALAI_PI_HUB_URL || 'http://10.0.0.80', cameraTimeoutMs = CAMERA_TIMEOUT_MS, fetchImpl = (...a) => fetch(...a) }) {
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
    // The Mac's spool colours (name → hex, from Bambuddy); anything else is dropped. The page checks each hex. They are
    // part of the stored fingerprint, so a push that only changes colours is stored and open pages refresh.
    const c = ix.colours, colours = c && typeof c === 'object' && !Array.isArray(c) && Object.values(c).every(v => typeof v === 'string') ? c : {};
    const fingerprint = Object.keys(colours).length ? `${ix.fingerprint}:${crypto.createHash('sha256').update(JSON.stringify(Object.entries(colours).sort())).digest('hex').slice(0, 16)}` : ix.fingerprint;
    const meta = storage.readSetting(key(project, 'meta'), null);
    if (meta && meta.fingerprint === fingerprint) {
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
      storage.writeSetting(key(project, 'index'), { ...index, colours });
      storage.writeSetting(key(project, 'meta'), { generated_at: ix.generated_at, fingerprint, synced_at: now(), counts: { records: ids.length, experiments: (ix.experiments || []).length } });
      if (!projects().includes(project)) storage.writeSetting(`${PREFIX}projects`, { names: [...projects(), project].sort() });
    });
    return [200, { ok: true, upserted, removed, unchanged }];
  }

  // Queues one request for the Mac (lab pull) and answers [status, body]. Used by the phone's POST
  // /api/lab/<project>/requests and the Workshop display's verdict route (app/display-lab.js), so both queue the same
  // thing under the same limits: 4 KB, 20 pending, an id sent twice is one request. `from` is who sent it: a device id,
  // or 'display'.
  function queueRequest(project, data, from) {
    const observing = OBS_KINDS.includes((data || {}).kind);
    if (Buffer.byteLength(JSON.stringify(data ?? null)) > (observing ? MAX_OBS_REQUEST : MAX_REQUEST)) return [413, { error: 'Too large for the print lab.' }];
    const { id, kind, experiment, run, run_seen: runSeen, payload } = data || {};
    const acting = ACT_KINDS.includes(kind);
    // What the owner saw is recorded as the owner's report only from their paired phone, never from the display.
    if (observing && from === 'display') return [403, { error: 'Observations come from a paired phone.' }];
    if (!REQUEST_ID_RE.test(id || '')) return [422, { error: 'Request id must look like rq-0123456789abcdef' }];
    if (kind !== 'verdict' && kind !== 'photos' && !acting && !observing) return [422, { error: 'kind must be verdict, photos, start, approve, abandon, observation or observation_correction' }];
    if (!(acting ? /^E-\d{1,6}$/ : EXPERIMENT_ID_RE).test(experiment || '')) return [422, { error: 'Invalid experiment id' }];
    if (!acting && !RUN_ID_RE.test(run || '')) return [422, { error: 'Invalid run id' }];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [422, { error: 'payload must be an object' }];
    const problem = acting ? actProblem(kind, payload, runSeen) : kind === 'photos' ? photosProblem(payload)
      : observing ? obsProblem(kind, payload) : null;
    if (problem) return [422, { error: problem }];

    const existing = storage.readSetting(key(project, `request:${id}`), null);
    if (existing) return [200, { ok: true, id, status: existing.status }];

    const allReqs = storage.listSettings(key(project, 'request:'));
    const pending = allReqs.filter(r => r.status === 'pending');
    if (pending.length >= MAX_PENDING) return [429, { error: "The Mac hasn't picked up the last 20 requests. Check that the Mac is awake." }];

    // The buttons' requests are about the experiment, not a run: lab pull refuses any run that isn't a print run id.
    const item = {
      id,
      kind,
      experiment,
      run: acting ? null : run,
      ...(kind === 'start' ? { run_seen: runSeen ?? null } : {}),
      payload: kind === 'start' ? { tapped_at: payload.tapped_at }
        : kind === 'abandon' ? { reason: payload.reason.trim() }
          : kind === 'approve' ? { reason: payload.reason.trim(), build_seen: payload.build_seen, reasons_seen: payload.reasons_seen }
            : payload,
      status: 'pending',
      message: null,
      at: now(),
      by: from
    };
    storage.writeSetting(key(project, `request:${id}`), item);
    return [200, { ok: true, id, status: 'pending' }];
  }
  const requestsFor = project => storage.listSettings(key(project, 'request:'));

  function havePhotos(project) {
    try { return fs.readdirSync(photoDir(project)).filter(f => /^[0-9a-f]{64}\.jpg$/.test(f)).map(f => f.slice(0, 64)); } catch { return []; }
  }

  // The printer as it is now, for the one experiment whose latest run is printing. Two printing: no guess, only the
  // conflict. The printer's state comes from the Workshop display's poller (app/workshop.js); null when not set up.
  function live(index) {
    const printing = (Array.isArray(index?.experiments) ? index.experiments : []).filter(x => x && x.status === 'printing');
    if (!printing.length) return null;
    if (printing.length > 1) return { conflict: true };
    const x = printing[0], p = printer() || {};
    const state = typeof p.state === 'string' ? p.state : 'unknown';
    const minutesLeft = Number.isSafeInteger(p.minutesLeft) ? p.minutesLeft : null;
    return {
      experiment: x.id, run: typeof x.run === 'string' ? x.run : null, state,
      progress: Number.isSafeInteger(p.progress) ? p.progress : null, minutesLeft,
      finishAt: state === 'printing' && minutesLeft !== null ? new Date(clock() + minutesLeft * 60000).toISOString() : null,
      errorCode: state === 'error' && typeof p.errorCode === 'string' ? p.errorCode : null
    };
  }
  // The index lists photos without their tab; the experiment's own record has it (lab photos add --tab). Copied onto each
  // photo (a short plain tab name only) so the page can pair photos by tab. Nothing stored changes.
  function withTabs(project, index) {
    if (!Array.isArray(index?.experiments)) return index;
    const experiments = index.experiments.map(x => {
      if (!x || !Array.isArray(x.photos) || !x.photos.length || !ID_RE.test(String(x.id))) return x;
      const runs = storage.readSetting(key(project, `record:${x.id}`), null)?.payload?.print_runs;
      const tabs = new Map();
      for (const r of Array.isArray(runs) ? runs : []) for (const ph of Array.isArray(r?.photos) ? r.photos : []) {
        if (ph && typeof ph.sha256 === 'string' && typeof ph.tab === 'string' && /^[\w.-]{1,16}$/.test(ph.tab)) tabs.set(ph.sha256, ph.tab);
      }
      return tabs.size ? { ...x, photos: x.photos.map(ph => (tabs.has(ph?.sha256) ? { ...ph, tab: tabs.get(ph.sha256) } : ph)) } : x;
    });
    return { ...index, experiments };
  }
  function liveSummary(project) {
    const l = live(storage.readSetting(key(project, 'index'), null));
    return l && !l.conflict ? { experiment: l.experiment, state: l.state, progress: l.progress, minutesLeft: l.minutesLeft, finishAt: l.finishAt } : null;
  }

  // The display feed's Print lab card across all projects: none when more than one experiment prints anywhere.
  function printingNow() {
    const found = projects().map(name => ({ name, ix: storage.readSetting(key(name, 'index'), null) })).map(p => ({ ...p, l: live(p.ix) })).filter(p => p.l);
    return found.length === 1 && !found[0].l.conflict ? found[0] : null;
  }
  function feedCards() {
    const p = printingNow();
    return p ? labCards(p.ix, p.l, clock()) : [];
  }
  // What the display's Judge it sheet judges (app/display-lab.js): the run of the judge card labCards makes, also once a
  // verdict has arrived (so the sheet can show it and Change it), with the experiment's stored record. Else null.
  function judgeTarget() {
    const p = printingNow();
    if (!p) return null;
    const x = p.ix.experiments.find(e => e && e.id === p.l.experiment);
    const unjudged = { ...p.ix, experiments: p.ix.experiments.map(e => (e === x ? { ...e, verdict: null, owner_verdict: null } : e)) };
    const card = labCards(unjudged, p.l, clock()).find(c => c.ask === 'lab-judge');
    if (!card || !card.run) return null;
    return { project: p.name, experiment: x, run: card.run, record: storage.readSetting(key(p.name, `record:${x.id}`), null)?.payload || null };
  }
  // The display's sheet after the judge card left (app/display-lab.js): once the Mac applies a verdict, lab pull syncs
  // and the experiment is answered, so judgeTarget finds nothing. For 24 h after a verdict request for exactly this
  // run, this is that run's experiment with its stored record and the run's verdict requests (newest first). Else null.
  function recentVerdict(run) {
    if (!RUN_ID_RE.test(String(run || ''))) return null;
    const since = clock() - JUDGE_FOR_MS;
    for (const name of projects()) {
      const reqs = requestsFor(name)
        .filter(r => r && r.kind === 'verdict' && r.run === run && Date.parse(r.at) >= since)
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      if (!reqs.length) continue;
      const id = reqs[0].experiment;
      const ix = storage.readSetting(key(name, 'index'), null);
      const x = (Array.isArray(ix?.experiments) ? ix.experiments : []).find(e => e && e.id === id) || { id };
      return { project: name, experiment: x, run, record: storage.readSetting(key(name, `record:${id}`), null)?.payload || null, requests: reqs.filter(r => r.experiment === id) };
    }
    return null;
  }

  // At most `limit` bytes of an answer, else null (and the rest is not read).
  async function readCapped(r, limit) {
    if (Number(r.headers.get('content-length')) > limit) { await r.body?.cancel?.().catch(() => {}); return null; }
    const reader = r.body?.getReader();
    if (!reader) return null;
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
  const readFrame = r => readCapped(r, MAX_FRAME);

  // One snapshot from the camera bridge, within cameraTimeoutMs in all. No redirects are followed and only a JPEG of
  // at most MAX_FRAME is passed on. When there is none, the Pi hub's reason (if it answers in the time left) says why.
  async function camera(res) {
    const signal = AbortSignal.timeout(cameraTimeoutMs);
    try {
      const r = await fetchImpl(cameraUrl, { signal, redirect: 'error', headers: { Accept: 'image/jpeg' } });
      if (r.ok && /^image\/jpeg/i.test(r.headers.get('content-type') || '')) {
        const body = await readFrame(r);
        if (body && body[0] === 0xff && body[1] === 0xd8) {
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          res.end(body);
          return;
        }
      } else await r.body?.cancel?.().catch(() => {});
    } catch {}
    let reason = 'no_picture';
    if (piHubUrl && piHubUrl !== 'off' && !signal.aborted) {
      try {
        const r = await fetchImpl(new URL('/api/camera', piHubUrl).href, { signal, redirect: 'error', headers: { Accept: 'application/json' } });
        const raw = r.ok ? await readCapped(r, MAX_REASON_ANSWER) : null;
        const d = raw ? JSON.parse(raw.toString('utf8')) : null;
        if (d && CAMERA_REASONS.has(d.reason)) reason = d.reason;
      } catch {}
    }
    json(res, 503, { reason, error: CAMERA_WORDS[reason] });
  }

  // true when it answered.
  async function handle(req, res, p) {
    const m = /^\/api\/lab\/([a-z0-9-]{1,40})(?:\/(sync|photos|photo|record|requests|incoming)(?:\/([^/]+)(?:\/([^/]+))?)?)?$/.exec(p);
    if (p === '/api/lab/projects' && req.method === 'GET') {
      json(res, 200, { projects: projects().map(name => ({ name, ...storage.readSetting(key(name, 'meta'), {}), live: liveSummary(name) })) });
      return true;
    }
    if (p === '/api/lab/camera.jpg' && req.method === 'GET') {
      if (!deviceFor(req) && !macAuthorized(req)) { json(res, 401, { error: "This phone isn't paired with Local AI. Pair it in Settings › Devices." }); return true; }
      await camera(res);
      return true;
    }
    if (!m || !m[1] || !PROJECT_RE.test(m[1])) return false;
    const [, project, part, arg, sub] = m;
    try {
      if (!part && req.method === 'GET') {
        const index = storage.readSetting(key(project, 'index'), null);
        if (!index) json(res, 404, { error: 'No lab data yet. Run `lab sync` on the Mac.' });
        else json(res, 200, { meta: storage.readSetting(key(project, 'meta'), {}), index: withTabs(project, index), live: live(index) });
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
        try { data = JSON.parse((await readRaw(req, MAX_OBS_REQUEST)).toString('utf8')); }
        catch (e) { if (e.statusCode) throw e; json(res, 400, { error: 'Invalid JSON request body' }); return true; }
        const [status, body] = queueRequest(project, data, dev.id || dev);
        json(res, status, body);
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
        if (!REQUEST_ID_RE.test(reqId)) { req.resume(); json(res, 404, { error: 'No such request.' }); return true; }
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
            if (p && SHA_RE.test(p.sha256 || '')) {
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

  return { handle, sync, feedCards, judgeTarget, recentVerdict, queueRequest, requestsFor };
}

module.exports = { createPrintLab, labCards, SCHEMA };
