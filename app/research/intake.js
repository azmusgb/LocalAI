'use strict';

// Research intake job: decides which sources are due, fetches each one (through the fetcher, which is the only network
// path), parses it, stores it and applies the per-tick and daily caps, the pause and the off switch. Sources run one at a
// time. `enabled`, the pause and the daily count are re-read before every source, not once per tick. Store calls are
// synchronous and happen only after the network call has returned; nothing is awaited inside a store transaction.

const { parseFeed, FeedError } = require('./feed');

const failure = (reason, code) => ({ ok: false, reason, code });

// enabled: a boolean, or a function returning one (so the switch can be read afresh each time).
function createIntake({ store, fetcher, enabled = false, log = () => {}, perTick = 3, dailyFetches = 200, now = Date.now } = {}) {
  if (!store || typeof store.dueSources !== 'function') throw new TypeError('store is required');
  if (!fetcher || typeof fetcher.fetchText !== 'function') throw new TypeError('fetcher is required');

  const UNREAD = 'research state could not be read', UNRECORDED = 'the last fetch could not be recorded', HOLD_MS = 15 * 60000;
  let running = false;
  let lastTickAt = '';
  let lastTickSkipped = ''; // why the last tick stopped early: '' | off | paused | busy | daily_cap | error
  let holdUntil = 0; // after a fetch that could not be recorded, nothing is fetched until this time
  let unrecorded = { day: '', n: 0 }; // network calls made that have no research_fetches row, for the current day
  const isEnabled = () => (typeof enabled === 'function' ? !!enabled() : !!enabled);
  const isPaused = () => store.getMeta('paused') === '1';
  const setPaused = paused => { store.setMeta('paused', paused ? '1' : '0'); };
  const safeLog = (...args) => { try { log(...args); } catch { /* logging never breaks the job */ } };
  const today = () => new Date(now()).toISOString().slice(0, 10);
  const unrecordedToday = () => (unrecorded.day === today() ? unrecorded.n : 0);
  const callsToday = () => store.fetchesToday() + unrecordedToday();

  // Why nothing may be fetched right now: null, or { code, reason }. A state that cannot be read is a stop, not a go.
  // The daily count is checked separately by fetchSource, after its source checks, so those codes keep their order.
  function blocker(withCap = true) {
    try {
      if (!isEnabled()) return { code: 'off', reason: 'research intake is off' };
      if (isPaused()) return { code: 'paused', reason: 'research intake is paused' };
      if (now() < holdUntil) return { code: 'error', reason: UNRECORDED };
      if (withCap && callsToday() >= dailyFetches) return { code: 'daily_cap', reason: 'daily fetch limit reached' };
      return null;
    } catch (error) {
      safeLog('research intake: state unreadable', error && error.message);
      return { code: 'error', reason: UNREAD };
    }
  }

  // Writes the fetch row. False when the store refused: the attempt then has no row, so it is counted here for the cap
  // and the intake holds off for a while rather than retrying a store that is failing.
  function record(source, outcome) {
    try { store.recordFetch(source.id, outcome); return true; }
    catch (error) {
      safeLog('research intake: could not record fetch', source.id, error && error.message);
      const day = today();
      unrecorded = { day, n: (unrecorded.day === day ? unrecorded.n : 0) + 1 };
      holdUntil = now() + HOLD_MS;
      return false;
    }
  }
  const unrecordedResult = () => failure('could not record the fetch', 'record_failed');

  // Fetch, parse and store one source. Never rejects; every failure is recorded as a failure with a reason.
  async function work(source) {
    const started = now();
    const ms = () => Math.max(0, now() - started);
    try {
      const result = await fetcher.fetchText(source.url, { allowHosts: [source.host], etag: source.etag, lastModified: source.lastModified });
      if (!result || typeof result !== 'object') throw new Error('fetcher returned no result');
      if (!result.ok) {
        const reason = String(result.reason || 'fetch failed'), code = String(result.code || 'fetch_failed');
        if (!record(source, { ok: false, status: result.status, reason, code, ms: ms(), url: source.url })) return unrecordedResult();
        return failure(reason, code);
      }
      if (result.status === 304 || result.notModified) {
        if (!record(source, { ok: true, status: 304, bytes: 0, added: 0, revised: 0, ms: ms(), url: source.url })) return unrecordedResult();
        return { ok: true, added: 0, revised: 0, notModified: true };
      }
      let feed;
      try { feed = parseFeed(String(result.body ?? ''), { baseUrl: result.finalUrl || source.url }); }
      catch (error) {
        if (!(error instanceof FeedError)) throw error;
        if (!record(source, { ok: false, status: result.status, reason: 'not a feed', code: 'not_a_feed', bytes: result.bytes, ms: ms(), url: source.url })) return unrecordedResult();
        return failure('not a feed', 'not_a_feed');
      }
      const { added, revised } = store.saveEntries(source.id, feed.entries, { url: source.url });
      if (!record(source, { ok: true, status: result.status, bytes: result.bytes, added, revised, etag: result.etag, lastModified: result.lastModified, ms: ms(), url: source.url })) return unrecordedResult();
      return { ok: true, added, revised, notModified: false };
    } catch (error) {
      safeLog('research intake: source failed', source.id, error && error.message);
      if (!record(source, { ok: false, reason: 'internal error', code: 'internal', ms: ms(), url: source.url })) return unrecordedResult();
      return failure('internal error', 'internal');
    }
  }

  async function fetchSource(id) {
    const stop = blocker(false);
    if (stop) return failure(stop.reason, stop.code);
    if (running) return failure('a fetch is already running', 'busy');
    running = true;
    try {
      const source = store.getSource(id);
      if (!source) return failure('unknown source', 'not_found');
      if (source.status !== 'active') return failure(`source is ${source.status}`, 'not_active');
      if (callsToday() >= dailyFetches) return failure('daily fetch limit reached', 'daily_cap');
      return await work(source);
    } catch (error) {
      safeLog('research intake: fetchSource failed', error && error.message);
      return failure(UNREAD, 'error');
    } finally { running = false; }
  }

  async function tick() {
    if (running) { lastTickSkipped = 'busy'; return { ran: 0, skipped: 'busy' }; }
    running = true;
    let ran = 0, skipped = '';
    try {
      const first = blocker();
      if (first) skipped = first.code;
      else {
        for (const due of store.dueSources(perTick)) {
          const stop = blocker();
          if (stop) { skipped = stop.code; break; }
          const source = store.getSource(due.id);
          if (!source || source.status !== 'active') continue;
          const result = await work(source);
          ran++;
          if (result.code === 'record_failed') { skipped = 'error'; break; }
        }
      }
    } catch (error) {
      safeLog('research intake: tick failed', error && error.message);
      skipped = 'error';
    } finally {
      running = false;
      lastTickSkipped = skipped;
      try { lastTickAt = new Date(now()).toISOString(); } catch { /* keep the previous value */ }
    }
    return { ran, skipped };
  }

  function state() {
    const sources = { active: 0, paused: 0, quarantined: 0, retired: 0 };
    try {
      for (const s of store.listSources()) if (s.status in sources) sources[s.status]++;
      return {
        enabled: isEnabled(), paused: isPaused(), running, fetchesToday: callsToday(), dailyFetches, lastTickAt, lastTickSkipped, sources,
        error: now() < holdUntil ? UNRECORDED : '', unreadable: false,
      };
    } catch (error) {
      safeLog('research intake: state unreadable', error && error.message);
      return { enabled: false, paused: true, running, fetchesToday: 0, dailyFetches, lastTickAt, lastTickSkipped, sources: { active: 0, paused: 0, quarantined: 0, retired: 0 }, error: UNREAD, unreadable: true };
    }
  }

  return { state, setPaused, fetchSource, tick };
}

module.exports = { createIntake };
