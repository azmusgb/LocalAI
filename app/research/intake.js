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

  let running = false;
  let lastTickAt = '';
  const isEnabled = () => (typeof enabled === 'function' ? !!enabled() : !!enabled);
  const isPaused = () => store.getMeta('paused') === '1';
  const setPaused = paused => { store.setMeta('paused', paused ? '1' : '0'); };
  const safeLog = (...args) => { try { log(...args); } catch { /* logging never breaks the job */ } };

  // Why nothing may be fetched right now, or '' when something may.
  function blocker() {
    if (!isEnabled()) return 'off';
    if (isPaused()) return 'paused';
    if (store.fetchesToday() >= dailyFetches) return 'daily_cap';
    return '';
  }

  function record(source, outcome) {
    try { store.recordFetch(source.id, outcome); }
    catch (error) { safeLog('research intake: could not record fetch', source.id, error && error.message); }
  }

  // Fetch, parse and store one source. Never rejects; every failure is recorded as a failure with a reason.
  async function work(source) {
    const started = now();
    const ms = () => Math.max(0, now() - started);
    try {
      const result = await fetcher.fetchText(source.url, { allowHosts: [source.host], etag: source.etag, lastModified: source.lastModified });
      if (!result || typeof result !== 'object') throw new Error('fetcher returned no result');
      if (!result.ok) {
        const reason = String(result.reason || 'fetch failed'), code = String(result.code || 'fetch_failed');
        record(source, { ok: false, status: result.status, reason, code, ms: ms() });
        return failure(reason, code);
      }
      if (result.status === 304 || result.notModified) {
        record(source, { ok: true, status: 304, bytes: 0, added: 0, revised: 0, ms: ms() });
        return { ok: true, added: 0, revised: 0, notModified: true };
      }
      let feed;
      try { feed = parseFeed(String(result.body ?? ''), { baseUrl: result.finalUrl || source.url }); }
      catch (error) {
        if (!(error instanceof FeedError)) throw error;
        record(source, { ok: false, status: result.status, reason: 'not a feed', code: 'not_a_feed', bytes: result.bytes, ms: ms() });
        return failure('not a feed', 'not_a_feed');
      }
      const { added, revised } = store.saveEntries(source.id, feed.entries);
      record(source, { ok: true, status: result.status, bytes: result.bytes, added, revised, etag: result.etag, lastModified: result.lastModified, ms: ms() });
      return { ok: true, added, revised, notModified: false };
    } catch (error) {
      safeLog('research intake: source failed', source.id, error && error.message);
      record(source, { ok: false, reason: 'internal error', code: 'internal', ms: ms() });
      return failure('internal error', 'internal');
    }
  }

  async function fetchSource(id) {
    const off = !isEnabled() ? 'off' : isPaused() ? 'paused' : '';
    if (off) return failure(off === 'off' ? 'research intake is off' : 'research intake is paused', off);
    if (running) return failure('a fetch is already running', 'busy');
    running = true;
    try {
      const source = store.getSource(id);
      if (!source) return failure('unknown source', 'not_found');
      if (source.status !== 'active') return failure(`source is ${source.status}`, 'not_active');
      if (store.fetchesToday() >= dailyFetches) return failure('daily fetch limit reached', 'daily_cap');
      return await work(source);
    } catch (error) {
      safeLog('research intake: fetchSource failed', error && error.message);
      return failure('internal error', 'internal');
    } finally { running = false; }
  }

  async function tick() {
    if (running) return { ran: 0, skipped: 'busy' };
    running = true;
    let ran = 0, skipped = '';
    try {
      skipped = blocker();
      if (!skipped) {
        for (const due of store.dueSources(perTick)) {
          skipped = blocker();
          if (skipped) break;
          const source = store.getSource(due.id);
          if (!source || source.status !== 'active') continue;
          await work(source);
          ran++;
        }
      }
    } catch (error) {
      safeLog('research intake: tick failed', error && error.message);
    } finally {
      running = false;
      try { lastTickAt = new Date(now()).toISOString(); } catch { /* keep the previous value */ }
    }
    return { ran, skipped };
  }

  function state() {
    const sources = { active: 0, paused: 0, quarantined: 0, retired: 0 };
    for (const s of store.listSources()) if (s.status in sources) sources[s.status]++;
    return { enabled: isEnabled(), paused: isPaused(), running, fetchesToday: store.fetchesToday(), dailyFetches, lastTickAt, sources };
  }

  return { state, setPaused, fetchSource, tick };
}

module.exports = { createIntake };
