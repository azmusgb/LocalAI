'use strict';

// The page-open counter (navigation depth, D5): which pages the owner opens, so the pages worth pinning or retiring
// are known rather than guessed. One settings row per local day, `nav-opens:<YYYY-MM-DD>` = { day, views: { id: n } },
// view ids only, kept 90 days, never sent anywhere.
//   POST   /api/nav/open {view}     counts one open of a known page (an alias counts as the page it resolves to)
//   GET    /api/nav/opens?days=30   [{view,label,count}], most opened first
//   DELETE /api/nav/opens           forgets every count
const REGISTRY = require('../public/view-registry.js');

const PREFIX = 'nav-opens:';
const KEEP_DAYS = 90;
const DEFAULT_DAYS = 30;

const pad = n => String(n).padStart(2, '0');
const dayOf = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
// The day `n` days before `date`, on the calendar (a daylight-saving change never skips or repeats a day).
const daysBefore = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() - n);

function createNav(ctx) {
  const { json, readBody, sameOriginJson, storage, storageError } = ctx;
  const now = ctx.now || (() => new Date());

  // The registry id a request names, or null: aliases resolve to their page, anything else unknown is refused.
  function knownView(id) {
    if (typeof id !== 'string' || !id || id.length > 64) return null;
    return REGISTRY.view(REGISTRY.resolve(id))?.id || null;
  }

  function record(view, date = now()) {
    const id = knownView(view);
    if (!id) return null;
    const key = PREFIX + dayOf(date), oldest = dayOf(daysBefore(date, KEEP_DAYS - 1));
    storage.transaction(() => {
      const row = storage.readSetting(key, null);
      const views = row && typeof row.views === 'object' && row.views ? row.views : {};
      views[id] = (Number(views[id]) || 0) + 1;
      storage.writeSetting(key, { day: dayOf(date), views });
      for (const old of storage.listSettings(PREFIX)) if (typeof old.day === 'string' && old.day < oldest) storage.deleteSetting(PREFIX + old.day);
    });
    return id;
  }

  function totals(days = DEFAULT_DAYS, date = now()) {
    const since = dayOf(daysBefore(date, days - 1)), sum = new Map();
    for (const row of storage.listSettings(PREFIX)) {
      if (typeof row.day !== 'string' || row.day < since) continue;
      for (const [view, n] of Object.entries(row.views || {})) sum.set(view, (sum.get(view) || 0) + (Number(n) || 0));
    }
    return [...sum].filter(([, count]) => count > 0)
      .map(([view, count]) => ({ view, label: REGISTRY.label(view), count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }

  function clear() {
    return storage.transaction(() => {
      const rows = storage.listSettings(PREFIX);
      for (const row of rows) if (typeof row.day === 'string') storage.deleteSetting(PREFIX + row.day);
      return rows.length;
    });
  }

  async function apiNavOpen(req, res) {
    if (!sameOriginJson(req, res)) return;
    try {
      const b = await readBody(req, 4 * 1024);
      const id = record(b && b.view);
      return id ? json(res, 200, { ok: true, view: id }) : json(res, 400, { error: 'Unknown page' });
    } catch (e) { storageError(res, e, 400); }
  }
  async function apiNavOpens(req, res, urlObj) {
    try {
      const raw = urlObj.searchParams.get('days');
      const days = raw === null || raw === '' ? DEFAULT_DAYS : Number(raw);
      if (!Number.isInteger(days) || days < 1 || days > KEEP_DAYS) return json(res, 400, { error: `days must be a whole number from 1 to ${KEEP_DAYS}` });
      return json(res, 200, totals(days));
    } catch (e) { storageError(res, e, 500); }
  }
  async function apiNavOpensClear(req, res) {
    try { return json(res, 200, { ok: true, days: clear() }); } catch (e) { storageError(res, e, 500); }
  }
  return { apiNavOpen, apiNavOpens, apiNavOpensClear, record, totals, clear };
}

module.exports = { createNav, KEEP_DAYS };
