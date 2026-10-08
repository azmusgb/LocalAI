'use strict';

const RUN_LEDGER_KEY = 'unified-runs-v1';
const MAX_RUNS = 500;
const MAX_EVENTS = 120;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const STATUSES = new Set(['queued', 'running', 'streaming', 'awaiting_approval', 'completed', 'failed', 'cancelled']);

function nowIso() { return new Date().toISOString(); }
function id() { return `run-${Date.now()}-${Math.random().toString(16).slice(2, 9)}`; }
function cleanText(value, max = 4000) { return String(value ?? '').slice(0, max); }

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
    if (!storage || typeof storage.readSetting !== 'function' || typeof storage.writeSetting !== 'function') {
      throw new TypeError('storage with readSetting/writeSetting is required');
    }
    this.storage = storage;
    this.maxRuns = Math.max(20, Math.min(2000, Number(maxRuns) || MAX_RUNS));
  }

  read() {
    const value = this.storage.readSetting(RUN_LEDGER_KEY, []);
    return Array.isArray(value) ? value : [];
  }

  write(items) {
    this.storage.writeSetting(RUN_LEDGER_KEY, items.slice(0, this.maxRuns));
  }

  create(spec = {}) {
    const at = nowIso();
    const run = {
      id: id(),
      type: cleanText(spec.type || 'task', 80),
      title: cleanText(spec.title || 'Untitled run', 240),
      status: 'queued',
      progress: 0,
      createdAt: at,
      startedAt: null,
      updatedAt: at,
      finishedAt: null,
      summary: cleanText(spec.summary || '', 1200),
      input: spec.input && typeof spec.input === 'object' ? spec.input : {},
      output: null,
      error: null,
      artifactIds: [],
      source: spec.source && typeof spec.source === 'object' ? spec.source : null,
      meta: spec.meta && typeof spec.meta === 'object' ? spec.meta : {},
      cancellable: spec.cancellable === true,
      retryRequest: spec.retryRequest && typeof spec.retryRequest === 'object' ? spec.retryRequest : null,
      attempt: Number.isSafeInteger(spec.attempt) && spec.attempt > 0 ? spec.attempt : 1,
      retryOf: spec.retryOf || null,
      events: [{ at, status: 'queued', detail: cleanText(spec.eventDetail || 'Run queued', 1200) }]
    };
    const items = this.read();
    items.unshift(run);
    this.write(items);
    return publicRun(run);
  }

  getInternal(runId) {
    return this.read().find(item => item?.id === runId) || null;
  }

  get(runId) { return publicRun(this.getInternal(runId)); }

  list({ limit = 100, status = '', type = '' } = {}) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.read()
      .filter(item => (!status || item.status === status) && (!type || item.type === type))
      .slice(0, safeLimit)
      .map(publicRun);
  }

  update(runId, patch = {}, eventDetail = '') {
    const items = this.read();
    const index = items.findIndex(item => item?.id === runId);
    if (index < 0) return null;
    const run = items[index];
    if (TERMINAL.has(run.status) && patch.status && patch.status !== run.status) return publicRun(run);

    const nextStatus = patch.status || run.status;
    if (!STATUSES.has(nextStatus)) throw new TypeError(`Invalid run status: ${nextStatus}`);
    const at = nowIso();
    Object.assign(run, patch, { status: nextStatus, updatedAt: at });
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
    this.write(items);
    return publicRun(run);
  }

  start(runId, detail = 'Run started') { return this.update(runId, { status: 'running', progress: 5 }, detail); }
  stream(runId, detail = 'Streaming output') { return this.update(runId, { status: 'streaming', progress: 35 }, detail); }

  complete(runId, { summary = '', output = null, artifactIds = [], meta = {} } = {}) {
    return this.update(runId, {
      status: 'completed', progress: 100,
      summary: cleanText(summary, 1200),
      output: output === undefined ? null : output,
      artifactIds: Array.isArray(artifactIds) ? artifactIds.slice(0, 100) : [],
      meta: meta && typeof meta === 'object' ? meta : {}
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
    return JSON.parse(JSON.stringify(run.retryRequest));
  }
}

module.exports = { RunLedger, RUN_LEDGER_KEY, TERMINAL, STATUSES, publicRun };
