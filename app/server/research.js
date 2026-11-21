'use strict';

// Research intake's API (app/research/): the owner's registered feeds and what was read from them. Off unless
// LOCALAI_RESEARCH=on: the GETs then answer 200 with enabled:false and empty lists (off is a known state, not a failed
// read) and the POSTs answer 409. A store failure is an error status, never an empty list. No route reads an
// `approved` field: nothing here approves anything. ctx holds what this code uses from the rest of the server.
const OFF = { error: 'research is off' };
// fetchSource refusals that are a state of the intake, not a failure of the feed.
const REFUSED = new Set(['off', 'paused', 'busy', 'not_active', 'daily_cap']);
// The intake could not read its state or record the fetch: the store is failing, not the feed.
const UNAVAILABLE = new Set(['error', 'record_failed']);
// New findings shown per calendar day (A31: the daily attention cap).
const CAP = 10;
const SOURCE_FIELDS = ['name', 'url', 'kind', 'trust', 'topics', 'scheduleMinutes', 'status'];

function createResearchRoutes(ctx) {
  const { budget, experiments, intake, measures, outcomes, reader, json, readBody, store, storageError, topics } = ctx;
  const pick = (b, fields) => Object.fromEntries(fields.filter(k => k in b).map(k => [k, b[k]]));
  // Store validation errors carry .status 400, 404, 409 or 410 and a message written for the owner; anything else is a failure.
  function fail(res, e) {
    if ([400, 404, 409, 410].includes(e?.status)) return json(res, e.status, { error: String(e.message) });
    return storageError(res, e, 500);
  }
  // intake.state() never throws: when the store can't be read it answers enabled:false, paused:true and an error. That is
  // an unknown, not "off", so it becomes a 503 here and is never shown as an empty, switched-off list.
  function read() {
    const state = intake.state();
    if (state.unreadable) throw Object.assign(new Error(state.error), { statusCode: 503 });
    return state;
  }
  // A body that is not JSON is the caller's mistake (400); readBody already gives a too-large body its 413.
  const body = async req => {
    let b;
    try { b = await readBody(req, 16 * 1024); }
    catch (e) { throw e && e.statusCode ? e : Object.assign(new Error('request body is not valid JSON'), { statusCode: 400 }); }
    return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
  };

  async function apiResearchState(req, res) {
    // The model budgets ride along (A32 D2): each cap's limit, used and resetsAt. A failed read of them is `unreadable`, never zero used.
    try { return json(res, 200, { ...read(), budget: budget ? budget.state() : { unreadable: true, reason: 'budget not configured', caps: [] }, reader: reader ? reader.state() : { enabled: false, unreadable: true }, measures: measures ? measures.compute() : { unreadable: true, reason: 'measures not configured', measures: {} } }); } catch (e) { fail(res, e); }
  }
  async function apiResearchPause(req, res) {
    try {
      if (!read().enabled) return json(res, 409, OFF);
      const b = await body(req);
      if (typeof b.paused !== 'boolean') return json(res, 400, { error: 'paused must be true or false' });
      intake.setPaused(b.paused);
      return json(res, 200, read());
    } catch (e) { fail(res, e); }
  }
  async function apiResearchSources(req, res) {
    try {
      const enabled = read().enabled;
      return json(res, 200, { enabled, sources: enabled ? store.listSources() : [] });
    } catch (e) { fail(res, e); }
  }
  async function apiResearchSourceAdd(req, res) {
    try {
      if (!read().enabled) return json(res, 409, OFF);
      const b = await body(req);
      return json(res, 200, { source: store.addSource(pick(b, SOURCE_FIELDS.filter(k => k !== 'status'))) });
    } catch (e) { fail(res, e); }
  }
  async function apiResearchSourceUpdate(req, res) {
    try {
      if (!read().enabled) return json(res, 409, OFF);
      const b = await body(req);
      const source = store.updateSource(String(b.id ?? ''), pick(b, SOURCE_FIELDS));
      return source ? json(res, 200, { source }) : json(res, 404, { error: 'No such source' });
    } catch (e) { fail(res, e); }
  }
  async function apiResearchSourceFetch(req, res) {
    try {
      if (!read().enabled) return json(res, 409, OFF);
      const b = await body(req);
      const r = await intake.fetchSource(String(b.id ?? ''));
      if (r.ok) return json(res, 200, r);
      if (REFUSED.has(r.code)) return json(res, 409, r);
      if (UNAVAILABLE.has(r.code)) return json(res, 503, r);
      return json(res, r.code === 'not_found' ? 404 : 502, r);
    } catch (e) { fail(res, e); }
  }
  async function apiResearchDocuments(req, res, urlObj) {
    try {
      const enabled = read().enabled;
      if (!enabled) return json(res, 200, { enabled, documents: [] });
      const q = urlObj.searchParams;
      return json(res, 200, { enabled, documents: store.listDocuments({ sourceId: q.get('source') || undefined, q: q.get('q') || '', limit: q.get('limit') || 50, before: q.get('before') || undefined }) });
    } catch (e) { fail(res, e); }
  }

  async function apiResearchFindings(req, res, urlObj) {
    try {
      const enabled = read().enabled;
      if (!enabled) return json(res, 200, { enabled, findings: [] });
      const q = urlObj.searchParams;
      const status = q.get('status') || '';
      const limit = Math.min(CAP, Math.max(1, Number.parseInt(q.get('limit'), 10) || CAP));
      // At most CAP new (extracted) findings are shown per calendar day; the rest wait (store.inbox). `counts` feeds
      // "New today N of 10 · M waiting". A failed read throws to fail(), never to zero.
      const box = store.inbox(CAP);
      // The released ids are the oldest waiting, so they are fetched by id: paging the newest 100 would miss them.
      const others = status === 'extracted' ? [] : store.listFindings({ status, limit: 100 }).filter(f => f.status !== 'extracted');
      const released = !status || status === 'extracted' ? box.ids.slice().reverse().map(id => store.getFinding(id)).filter(f => f && f.status === 'extracted') : [];
      const findings = [...others, ...released].slice(0, limit);
      return json(res, 200, { enabled, findings, counts: { newToday: box.newToday, cap: box.cap, waiting: box.waiting } });
    } catch (e) { fail(res, e); }
  }

  async function apiResearchFindingDecide(req, res) {
    try {
      if (!read().enabled) return json(res, 409, OFF);
      const b = await body(req);
      const finding = store.decideFinding(String(b.id || ''), String(b.status || ''), { changeId: b.changeId });
      return json(res, 200, { finding });
    } catch (e) { fail(res, e); }
  }

  async function apiResearchFindingPromote(req, res) {
    try {
      if (!read().enabled) return json(res, 409, OFF);
      const b = await body(req);
      const finding = store.getFinding(String(b.id || ''));
      if (!finding) return json(res, 404, { error: 'No such finding' });

      // Promotion creates an ordinary Improve backlog item (app/server/changes.js addResearchItem). Without one the finding
      // stays as it was and the owner is told: a promote that made nothing is never shown as done.
      if (!ctx.changes || typeof ctx.changes.addResearchItem !== 'function') return json(res, 503, { error: 'Improve is not available, so nothing was promoted' });
      const doc = store.getDocument(finding.documentId), src = store.getSource(finding.sourceId);
      const sources = [src && { name: src.name, url: src.url }, doc && doc.url && { name: doc.title, url: doc.url }].filter(Boolean);
      let item;
      try { item = ctx.changes.addResearchItem(finding, sources, String(b.title || '').trim()); }
      catch (e) { return json(res, 500, { error: `Could not add it to the backlog, so nothing was promoted: ${String(e && e.message || e).slice(0, 200)}` }); }
      const changeId = item && typeof item.id === 'string' ? item.id : '';
      if (!changeId) return json(res, 500, { error: 'Could not add it to the backlog, so nothing was promoted' });

      const updated = store.decideFinding(finding.id, 'promoted', { changeId });
      return json(res, 200, { finding: updated, changeId });
    } catch (e) { fail(res, e); }
  }

  async function apiImproveOutcome(req, res) {
    try {
      const b = await body(req);
      const outcome = store.recordOutcome({
        findingId: b.findingId,
        changeId: b.changeId,
        metricName: b.metricName,
        beforeVal: b.beforeVal,
        afterVal: b.afterVal,
        verdict: b.verdict,
        notes: b.notes
      });
      return json(res, 200, { ok: true, outcome });
    } catch (e) { fail(res, e); }
  }

  // Owner-recorded inputs of two measures (outcomes.js). Guarded like every /api/research/* route; `by` is fixed to 'owner'
  // here, so the body cannot name another writer. Off means 409 like the other writes; a missing recorder is 501.
  async function apiResearchRecord(req, res, kind) {
    try {
      const b = await body(req);
      if (!read().enabled) return json(res, 409, OFF);
      if (!outcomes) return json(res, 501, { error: 'Outcome recorder not configured' });
      if (kind === 'ship') return json(res, 200, { ok: true, record: outcomes.recordShipOutcome({ ...pick(b, ['changeId', 'outcome', 'gateShouldHaveCaught', 'note']), by: 'owner' }) });
      return json(res, 200, { ok: true, record: outcomes.recordDefect({ ...pick(b, ['defectId', 'source', 'flaggedByCheck', 'check', 'note']), by: 'owner' }) });
    } catch (e) { fail(res, e); }
  }
  const apiResearchShipOutcome = (req, res) => apiResearchRecord(req, res, 'ship');
  const apiResearchDefect = (req, res) => apiResearchRecord(req, res, 'defect');

  async function apiResearchExperiments(req, res, urlObj) {
    try {
      const enabled = read().enabled;
      if (!enabled) return json(res, 200, { enabled, experiments: [] });
      if (req.method === 'POST') {
        const b = await body(req);
        if (!experiments) return json(res, 501, { error: 'Experiments engine not configured' });
        const exp = experiments.planExperiment(b);
        return json(res, 200, { experiment: exp });
      }
      const limit = Number(urlObj?.searchParams?.get('limit')) || 50;
      const list = experiments ? experiments.listExperiments({ limit }) : [];
      return json(res, 200, { enabled, experiments: list });
    } catch (e) { fail(res, e); }
  }

  async function apiResearchContracts(req, res, urlObj) {
    try {
      const enabled = read().enabled;
      if (!enabled) return json(res, 200, { enabled, contracts: [] });
      if (req.method === 'POST') {
        const b = await body(req);
        if (!experiments) return json(res, 501, { error: 'Contracts engine not configured' });
        const contract = experiments.createContract(b);
        return json(res, 200, { contract });
      }
      const id = urlObj?.searchParams?.get('id') || '';
      const c = experiments ? experiments.getContractRecord(id) : null;
      return json(res, 200, { enabled, contract: c });
    } catch (e) { fail(res, e); }
  }

  async function apiResearchTopics(req, res, urlObj) {
    try {
      const enabled = read().enabled;
      if (!enabled) return json(res, 200, { enabled, topics: [] });
      if (req.method === 'POST') {
        const b = await body(req);
        if (!topics) return json(res, 501, { error: 'Topics manager not configured' });
        const t = topics.addTopic(b);
        return json(res, 200, { topic: t });
      }
      const list = topics ? topics.listTopics() : [];
      return json(res, 200, { enabled, topics: list });
    } catch (e) { fail(res, e); }
  }

  async function apiResearchTopicUpdate(req, res) {
    try {
      if (!read().enabled) return json(res, 409, OFF);
      const b = await body(req);
      if (!topics) return json(res, 501, { error: 'Topics manager not configured' });
      const t = topics.updateTopic(b.id, b);
      return json(res, 200, { topic: t });
    } catch (e) { fail(res, e); }
  }

  async function apiResearchConflicts(req, res, urlObj) {
    try {
      const enabled = read().enabled;
      if (!enabled) return json(res, 200, { enabled, conflicts: [] });
      if (req.method === 'POST') {
        const b = await body(req);
        if (!topics) return json(res, 501, { error: 'Topics manager not configured' });
        const c = topics.recordConflict(b);
        return json(res, 200, { conflict: c });
      }
      const findingId = urlObj?.searchParams?.get('findingId') || '';
      const list = topics && findingId ? topics.getConflictsForFinding(findingId) : [];
      return json(res, 200, { enabled, conflicts: list });
    } catch (e) { fail(res, e); }
  }

  return {
    apiResearchState, apiResearchPause, apiResearchSources, apiResearchSourceAdd,
    apiResearchSourceUpdate, apiResearchSourceFetch, apiResearchDocuments,
    apiResearchFindings, apiResearchFindingDecide, apiResearchFindingPromote, apiImproveOutcome,
    apiResearchExperiments, apiResearchContracts,
    apiResearchTopics, apiResearchTopicUpdate, apiResearchConflicts,
    apiResearchShipOutcome, apiResearchDefect
  };
}

module.exports = { createResearchRoutes };
