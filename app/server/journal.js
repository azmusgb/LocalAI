'use strict';

// The journal's API (app/journal.js): GET /api/journal searches or lists what Local AI remembers; POST
// /api/journal/delete forgets one entry for good. ctx holds what this code uses from the rest of the server.
function createJournalRoutes(ctx) {
  const { journal, json, readBody, storageError } = ctx;
  async function apiJournal(req, res, urlObj) {
    try {
      const q = urlObj.searchParams;
      const sources = String(q.get('source') || '').split(',').map(s => s.trim()).filter(Boolean);
      return json(res, 200, journal.search({ q: q.get('q') || '', from: q.get('from'), to: q.get('to'), sources, limit: q.get('limit') || 50, before: q.get('before') }));
    } catch (e) { storageError(res, e, 400); }
  }
  async function apiJournalDelete(req, res) {
    try {
      const b = await readBody(req, 4 * 1024);
      return journal.remove(String(b.id || '')) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'No such entry' });
    } catch (e) { storageError(res, e, 400); }
  }
  return { apiJournal, apiJournalDelete };
}

module.exports = { createJournalRoutes };
