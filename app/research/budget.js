'use strict';

// Model budgets for the research loop (amendment A32 D2 and D4; design section 11.6). Every model call the research
// code makes asks `reserve` first; a refusal is a state to show, not an error to swallow. Four caps, all checked
// before the call: per topic (the "investigation": research_topics.budget_daily_*), per repository (the topic's
// target project), per day and per week. Tier 2 (cloud) has an allowance of zero until the owner sets one.
//
// Spend is an append-only row in research_events (entity_type 'budget'), so no new table exists and every call is
// auditable. Caps live in research_meta (`budget.*`); a missing key means the default, a key that is not a
// non-negative whole number means the config is unreadable and the call is refused. An unreadable counter is never
// treated as zero used.

const { localDay } = require('./store');

const DEFAULTS = Object.freeze({
  'budget.day.calls': 20, 'budget.day.chars': 100000,
  'budget.week.calls': 100, 'budget.week.chars': 500000,
  'budget.repo.day.calls': 10,
  'budget.tier2.day.calls': 0, 'budget.tier2.day.chars': 0,
});
const WEEK_DAYS = 7;

function createBudget({ db, store, topics, now = Date.now, timeZone = 'UTC' } = {}) {
  if (!db || !store || !topics) throw new Error('db, store and topics are required');
  const dayOf = ms => localDay(ms, timeZone);

  // The first instant of the next local day: the local date changes somewhere in the next 26 hours, found by
  // bisection so a daylight-saving day of 23 or 25 hours is still exact to the millisecond.
  function nextMidnight(ms) {
    const today = dayOf(ms);
    let lo = ms, hi = ms + 26 * 3600000;
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (dayOf(mid) === today) lo = mid; else hi = mid; }
    return new Date(hi).toISOString();
  }

  function cap(key) {
    const raw = store.getMeta(key);
    if (raw === null || raw === undefined) return { ok: true, value: DEFAULTS[key] };
    if (!/^\d{1,12}$/.test(String(raw))) return { ok: false, key };
    return { ok: true, value: Number(raw) };
  }

  const weekStart = () => dayOf(now() - (WEEK_DAYS - 1) * 86400000);
  // The week window ends when its oldest day drops out: the next local midnight after the first day of the window.
  const weekResets = () => nextMidnight(Date.parse(weekStart() + 'T12:00:00Z'));

  // Spend rows since the first day of the window, summed here. Throws if the database cannot be read or a row is bad.
  function sums() {
    const since = weekStart();
    const rows = db.prepare("SELECT reason FROM research_events WHERE entity_type = 'budget' AND at >= ? ORDER BY seq ASC")
      .all(new Date(since + 'T00:00:00Z').toISOString());
    const today = dayOf(now());
    const out = { day: { calls: 0, chars: 0, tier2calls: 0, tier2chars: 0, byTopic: {}, byProject: {} }, week: { calls: 0, chars: 0 } };
    for (const r of rows) {
      let e; try { e = JSON.parse(r.reason); } catch { throw new Error('unreadable budget row'); }
      if (!e || typeof e.day !== 'string' || !Number.isInteger(e.calls) || !Number.isInteger(e.chars)) throw new Error('unreadable budget row');
      if (e.day < since) continue;
      if (e.tier !== 2) { out.week.calls += e.calls; out.week.chars += e.chars; }
      if (e.day !== today) continue;
      if (e.tier === 2) { out.day.tier2calls += e.calls; out.day.tier2chars += e.chars; continue; }
      out.day.calls += e.calls; out.day.chars += e.chars;
      const t = out.day.byTopic[e.topicId] || (out.day.byTopic[e.topicId] = { calls: 0, chars: 0 });
      t.calls += e.calls; t.chars += e.chars;
      out.day.byProject[e.project] = (out.day.byProject[e.project] || 0) + e.calls;
    }
    return out;
  }

  const refuse = (code, reason, extra = {}) => ({ ok: false, code, reason, ...extra });

  // Check every cap and, if all pass, record the spend before the call is made (a call that then fails is not
  // refunded: the budget errs toward spending less). Never throws.
  function reserve({ topicId, tier = 1, chars = 0 } = {}) {
    try {
      const n = Number(chars);
      if (!Number.isInteger(n) || n < 0) return refuse('bad_request', 'chars must be a non-negative whole number');
      if (tier !== 1 && tier !== 2) return refuse('bad_request', 'tier must be 1 or 2');
      const topic = topics.getTopic(String(topicId || ''));
      if (!topic) return refuse('unknown_topic', 'no such topic');
      if (topic.status !== 'active') return refuse('topic_inactive', `topic is ${topic.status}`);
      const used = sums();
      const resetsDay = nextMidnight(now());
      const tests = [];
      const need = (key, name, usedNow, add, resetsAt) => {
        const c = cap(key);
        if (!c.ok) return refuse('budget_unreadable', `${c.key} is not a whole number`);
        tests.push({ name, limit: c.value, used: usedNow, add, resetsAt });
        return null;
      };
      let bad = null;
      if (tier === 2) {
        bad = need('budget.tier2.day.calls', 'tier2.day.calls', used.day.tier2calls, 1, resetsDay)
          || need('budget.tier2.day.chars', 'tier2.day.chars', used.day.tier2chars, n, resetsDay);
      } else {
        const seen = used.day.byTopic[topic.id] || { calls: 0, chars: 0 };
        tests.push({ name: 'topic.day.calls', limit: topic.budget_daily_model_calls, used: seen.calls, add: 1, resetsAt: resetsDay });
        tests.push({ name: 'topic.day.chars', limit: topic.budget_daily_characters, used: seen.chars, add: n, resetsAt: resetsDay });
        bad = need('budget.repo.day.calls', `repo.${topic.target_project}.day.calls`, used.day.byProject[topic.target_project] || 0, 1, resetsDay)
          || need('budget.day.calls', 'day.calls', used.day.calls, 1, resetsDay)
          || need('budget.day.chars', 'day.chars', used.day.chars, n, resetsDay)
          || need('budget.week.calls', 'week.calls', used.week.calls, 1, weekResets())
          || need('budget.week.chars', 'week.chars', used.week.chars, n, weekResets());
      }
      if (bad) return bad;
      for (const t of tests) {
        if (t.used + t.add > t.limit) {
          return refuse('budget_exhausted', `${t.name} limit ${t.limit} reached`, { cap: t.name, limit: t.limit, used: t.used, resetsAt: t.resetsAt });
        }
      }
      topics.recordEvent({ entityType: 'budget', entityId: topic.id, fromState: 'ok', toState: 'spent', by: 'system',
        reason: JSON.stringify({ day: dayOf(now()), topicId: topic.id, project: topic.target_project, tier, calls: 1, chars: n }) });
      return { ok: true };
    } catch {
      return refuse('budget_unreadable', 'the budget could not be read or recorded');
    }
  }

  // For the state route: every cap with its limit, what is used and when it resets. A failed read is `unreadable`,
  // never zero used. The repository cap shows the busiest repository.
  function state() {
    try {
      const used = sums();
      const resetsDay = nextMidnight(now());
      const caps = [];
      const rows = [['budget.day.calls', 'day', 'calls'], ['budget.day.chars', 'day', 'chars'], ['budget.week.calls', 'week', 'calls'],
        ['budget.week.chars', 'week', 'chars'], ['budget.repo.day.calls', 'day', 'repo'], ['budget.tier2.day.calls', 'day', 'tier2calls'],
        ['budget.tier2.day.chars', 'day', 'tier2chars']];
      for (const [key, win, unit] of rows) {
        const c = cap(key);
        if (!c.ok) return { unreadable: true, reason: `${c.key} is not a whole number`, caps: [] };
        const u = unit === 'repo' ? Math.max(0, ...Object.values(used.day.byProject)) : used[win][unit];
        caps.push({ name: key.replace('budget.', ''), limit: c.value, used: u, resetsAt: win === 'day' ? resetsDay : weekResets() });
      }
      return { unreadable: false, caps };
    } catch {
      return { unreadable: true, reason: 'the budget could not be read', caps: [] };
    }
  }

  return { reserve, state };
}

module.exports = { createBudget, DEFAULTS };
