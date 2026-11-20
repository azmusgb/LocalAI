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
const SOURCE_FIELDS = ['name', 'url', 'kind', 'trust', 'topics', 'scheduleMinutes', 'status'];

function createResearchRoutes(ctx) {
  const { intake, json, readBody, store, storageError } = ctx;
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
    try { return json(res, 200, read()); } catch (e) { fail(res, e); }
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

  return { apiResearchState, apiResearchPause, apiResearchSources, apiResearchSourceAdd, apiResearchSourceUpdate, apiResearchSourceFetch, apiResearchDocuments };
}

module.exports = { createResearchRoutes };
