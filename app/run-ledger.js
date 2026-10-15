'use strict';

// Legacy layout: every run in one settings row, rewritten on each update. Runs now have a row each.
const RUN_LEDGER_KEY = 'unified-runs-v1';
const RUN_KEY_PREFIX = 'unified-run/';
const MAX_RUNS = 250;
const MAX_EVENTS = 120;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const STATUSES = new Set(['queued', 'running', 'streaming', 'awaiting_approval', 'completed', 'failed', 'cancelled']);
const INTERRUPTIBLE = new Set(['queued', 'running', 'streaming']);

function nowIso() { return new Date().toISOString(); }
// Ids sort by creation (they are also the storage key order): a zero-padded sequence breaks ties
// within the same millisecond, and the clock never appears to go backwards.
let lastIdMs = 0, idSeq = 0;
function id() {
  const now = Math.max(Date.now(), lastIdMs);
  idSeq = now === lastIdMs ? idSeq + 1 : 0;
  lastIdMs = now;
  return `run-${now}-${idSeq.toString(36).padStart(3, '0')}${Math.random().toString(16).slice(2, 6)}`;
}
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
function cleanId(value) { return typeof value === 'string' && ID_RE.test(value) ? value : null; }
// Kept runs (pinned, filed under a project, or holding artifacts) are never pruned.
const KEPT_EXEMPT = { truthy: ['$.pinned', '$.projectId'] };
function isKept(run) { return !!run && (!!run.pinned || !!run.projectId); }
function cleanText(value, max = 4000) { return String(value ?? '').slice(0, max); }

function boundedClone(value, maxBytes, fallback) {
  try {
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw, 'utf8') > maxBytes) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function boundedOutput(value) {
  if (value === undefined || value === null) return null;
  const cloned = boundedClone(value, 24 * 1024, null);
  if (cloned !== null) return cloned;
  let preview = '';
  try { preview = typeof value === 'string' ? value : JSON.stringify(value); } catch { preview = String(value); }
  return { truncated: true, preview: cleanText(preview, 12000) };
}

function publicRun(run) {
  if (!run) return null;
  const { retryRequest, ...safe } = run;
  return {
    ...safe,
    retryable: !!retryRequest && TERMINAL.has(run.status) && run.status !== 'cancelled'
  };
}

class RunLedger {
  constructor({ storage, maxRuns = MAX_RUNS } = {}) {
    for (const method of ['readSetting', 'writeSetting', 'deleteSetting', 'listSettings', 'pruneSettings']) {
      if (!storage || typeof storage[method] !== 'function') throw new TypeError(`storage with ${method} is required`);
    }
    this.storage = storage;
    this.maxRuns = Math.max(20, Math.min(1000, Number(maxRuns) || MAX_RUNS));
    this.migrateLegacy();
    this.reconcileInterrupted();
  }

  key(runId) { return RUN_KEY_PREFIX + runId; }

  write(run) { this.storage.writeSetting(this.key(run.id), run); }

  // Run ids start with a millisecond timestamp, so key order is creation order.
  migrateLegacy() {
    const legacy = this.storage.readSetting(RUN_LEDGER_KEY, null);
    if (legacy === null) return;
    const migrate = () => {
      for (const run of (Array.isArray(legacy) ? legacy : []).slice(0, this.maxRuns)) {
        if (run && typeof run.id === 'string' && !this.storage.readSetting(this.key(run.id), null)) this.write(run);
      }
      this.storage.deleteSetting(RUN_LEDGER_KEY);
    };
    if (typeof this.storage.transaction === 'function') this.storage.transaction(migrate);
    else migrate();
  }

  reconcileInterrupted() {
    const at = nowIso();
    for (const status of INTERRUPTIBLE) for (const run of this.storage.listSettings(RUN_KEY_PREFIX, { where: { status } })) {
      run.status = 'failed';
      run.updatedAt = at;
      run.finishedAt = at;
      run.cancellable = false;
      run.error = 'Run interrupted by appliance restart';
      run.progress = Math.max(0, Math.min(99, Number(run.progress) || 0));
      if (!Array.isArray(run.events)) run.events = [];
      run.events.push({ at, status: 'failed', detail: 'Run interrupted by appliance restart' });
      if (run.events.length > MAX_EVENTS) run.events = run.events.slice(-MAX_EVENTS);
      this.write(run);
    }
  }

  create(spec = {}) {
    const at = nowIso();
    const run = {
      id: id(),
      projectId: cleanId(spec.projectId),
      threadId: null,
      pinned: false,
      type: cleanText(spec.type || 'task', 80),
      title: cleanText(spec.title || 'Untitled run', 240),
      status: 'queued',
      progress: 0,
      createdAt: at,
      startedAt: null,
      updatedAt: at,
      finishedAt: null,
      summary: cleanText(spec.summary || '', 1200),
      input: boundedClone(spec.input && typeof spec.input === 'object' ? spec.input : {}, 16 * 1024, { truncated: true }),
      output: null,
      error: null,
      artifactIds: [],
      source: spec.source && typeof spec.source === 'object' ? boundedClone(spec.source, 4 * 1024, null) : null,
      meta: boundedClone(spec.meta && typeof spec.meta === 'object' ? spec.meta : {}, 8 * 1024, { truncated: true }),
      cancellable: spec.cancellable === true,
      retryRequest: spec.retryRequest && typeof spec.retryRequest === 'object'
        ? boundedClone(spec.retryRequest, 48 * 1024, null)
        : null,
      attempt: Number.isSafeInteger(spec.attempt) && spec.attempt > 0 ? spec.attempt : 1,
      retryOf: spec.retryOf || null,
      events: [{ at, status: 'queued', detail: cleanText(spec.eventDetail || 'Run queued', 1200) }]
    };
    run.threadId = cleanId(spec.threadId) || run.id;
    this.write(run);
    this.storage.pruneSettings(RUN_KEY_PREFIX, this.maxRuns, { exempt: KEPT_EXEMPT });
    return publicRun(run);
  }

  getInternal(runId) {
    return typeof runId === 'string' && runId ? this.storage.readSetting(this.key(runId), null) : null;
  }

  get(runId) { return publicRun(this.getInternal(runId)); }

  // Pin and/or file a run. `projectId: null` unfiles; an invalid id is ignored.
  file(runId, { projectId, pinned } = {}) {
    const run = this.getInternal(runId);
    if (!run) return null;
    if (projectId === null) run.projectId = null;
    else if (cleanId(projectId)) run.projectId = projectId;
    if (typeof pinned === 'boolean') run.pinned = pinned;
    run.updatedAt = nowIso();
    this.write(run);
    return publicRun(run);
  }

  list({ limit = 100, status = '', type = '', projectId = '', threadId = '', collapseThreads = false } = {}) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const where = {};
    if (status) where.status = status;
    if (type) where.type = type;
    if (projectId) where.projectId = projectId;
    if (threadId) where.threadId = threadId;
    if (!collapseThreads) return this.storage.listSettings(RUN_KEY_PREFIX, { limit: safeLimit, where }).map(publicRun);
    const seen = new Set();
    return this.storage.listSettings(RUN_KEY_PREFIX, { where }).filter(r => {
      const t = r.threadId || r.id;
      return seen.has(t) ? false : (seen.add(t), true);
    }).slice(0, safeLimit).map(publicRun);
  }

  update(runId, patch = {}, eventDetail = '') {
    const run = this.getInternal(runId);
    if (!run) return null;
    if (TERMINAL.has(run.status) && patch.status && patch.status !== run.status) return publicRun(run);

    const nextStatus = patch.status || run.status;
    if (!STATUSES.has(nextStatus)) throw new TypeError(`Invalid run status: ${nextStatus}`);
    const at = nowIso();
    const safePatch = { ...patch };
    if (Object.hasOwn(safePatch, 'output')) safePatch.output = boundedOutput(safePatch.output);
    if (Object.hasOwn(safePatch, 'meta')) safePatch.meta = boundedClone(safePatch.meta || {}, 8 * 1024, { truncated: true });
    Object.assign(run, safePatch, { status: nextStatus, updatedAt: at });
    if ((nextStatus === 'running' || nextStatus === 'streaming') && !run.startedAt) run.startedAt = at;
    if (TERMINAL.has(nextStatus)) {
      run.finishedAt = run.finishedAt || at;
      run.progress = nextStatus === 'completed' ? 100 : Math.max(0, Math.min(99, Number(run.progress) || 0));
      run.cancellable = false;
    } else {
      run.progress = Math.max(0, Math.min(99, Number(run.progress) || 0));
    }
    if (!Array.isArray(run.events)) run.events = [];
    const previous = run.events[run.events.length - 1];
    if (eventDetail || previous?.status !== nextStatus) {
      run.events.push({ at, status: nextStatus, detail: cleanText(eventDetail || nextStatus, 1200) });
      if (run.events.length > MAX_EVENTS) run.events = run.events.slice(-MAX_EVENTS);
    }
    this.write(run);
    return publicRun(run);
  }

  start(runId, detail = 'Run started') { return this.update(runId, { status: 'running', progress: 5 }, detail); }
  stream(runId, detail = 'Streaming output') { return this.update(runId, { status: 'streaming', progress: 35 }, detail); }

  complete(runId, { summary = '', output = null, artifactIds = [], meta = {} } = {}) {
    return this.update(runId, {
      status: 'completed', progress: 100,
      summary: cleanText(summary, 1200),
      output,
      artifactIds: Array.isArray(artifactIds) ? artifactIds.slice(0, 100) : [],
      meta
    }, 'Run completed');
  }

  fail(runId, error, detail = 'Run failed') {
    return this.update(runId, { status: 'failed', error: cleanText(error?.message || error || 'Unknown error', 8000) }, detail);
  }

  cancel(runId, reason = 'Cancelled by user') {
    const run = this.getInternal(runId);
    if (!run) return null;
    if (TERMINAL.has(run.status)) return publicRun(run);
    return this.update(runId, { status: 'cancelled', error: cleanText(reason, 2000) }, reason);
  }

  retryRequest(runId) {
    const run = this.getInternal(runId);
    if (!run || !run.retryRequest || !TERMINAL.has(run.status) || run.status === 'cancelled') return null;
    return boundedClone(run.retryRequest, 48 * 1024, null);
  }
}

module.exports = { RunLedger, RUN_LEDGER_KEY, RUN_KEY_PREFIX, TERMINAL, STATUSES, publicRun, isKept, cleanId };
