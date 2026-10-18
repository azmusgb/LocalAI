'use strict';

// GET /api/busy: the work a restart would lose right now. The host's auto-deploy asks before it restarts the
// appliance and holds the update (up to a limit) while anything is listed. Read-only, and it says only what is
// running: a kind, a short title and when it started. No inputs, outputs, ids or paths.
//
// Sources:
//   runs          run-ledger runs (chats, images, missions, ...) queued, running or streaming;
//   missions      orchestrator missions still running that have no active ledger run of their own;
//   specialists   single specialist runs in the orchestrator;
//   inFlight      requests tracked in memory by the server (GridCraft, automations).
// A record that hasn't changed for STALE_MS is treated as stuck, not running: one forgotten record must not hold
// every update for the full limit.

const ACTIVE = new Set(['queued', 'running', 'streaming']);
const STALE_MS = 60 * 60 * 1000;
const TITLE_MAX = 80;

function title(value, fallback) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1).trimEnd() + '…' : text;
}

function time(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function fresh(record, now) {
  const at = Date.parse(record.updatedAt || record.startedAt || record.createdAt || '');
  return !Number.isFinite(at) || now - at < STALE_MS;
}

function activeWork({ runs = [], missions = [], specialists = [], inFlight = [], now = Date.now() } = {}) {
  const active = [];
  const missionIds = new Set();
  for (const r of runs) {
    if (!r || !ACTIVE.has(r.status) || !fresh(r, now)) continue;
    if (r.meta && r.meta.missionId) missionIds.add(String(r.meta.missionId));
    active.push({ kind: String(r.type || 'run').slice(0, 40), title: title(r.title, 'Run'), startedAt: time(r.startedAt || r.createdAt) });
  }
  for (const m of missions) {
    if (!m || m.status !== 'running' || missionIds.has(String(m.id)) || !fresh(m, now)) continue;
    active.push({ kind: 'mission', title: title(m.goal, 'Mission'), startedAt: time(m.createdAt) });
  }
  for (const s of specialists) {
    if (!s || s.status !== 'running' || !fresh(s, now)) continue;
    active.push({ kind: 'specialist', title: title(s.agentName || s.goal, 'Specialist'), startedAt: time(s.createdAt) });
  }
  for (const w of inFlight) {
    if (!w) continue;
    active.push({ kind: String(w.kind || 'work').slice(0, 40), title: title(w.title, 'Work'), startedAt: time(w.startedAt) });
  }
  const starts = active.map(a => a.startedAt).filter(Boolean).sort();
  return { busy: active.length > 0, active, since: starts[0] || null };
}

// In-memory register for work that has no record while it runs. track() returns the function that ends it.
function createInFlight() {
  const items = new Map();
  let seq = 0;
  return {
    track(kind, workTitle) {
      const key = ++seq;
      items.set(key, { kind, title: workTitle, startedAt: new Date().toISOString() });
      return () => { items.delete(key); };
    },
    list() { return [...items.values()]; }
  };
}

module.exports = { activeWork, createInFlight, STALE_MS };
