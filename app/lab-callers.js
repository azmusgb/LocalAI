'use strict';

// Caller ledger for /api/lab/* routes (Platform step 6, PR 6.4, Decision 6).
// Persisted in storage settings under key 'lab:callers'.
// Tracks callers across server recreates so we can prove zero remaining callers
// before decommissioning /api/lab/* (D5.3 evidence window).
// Caller class is one of: 'hub-key', 'device', 'mac', 'host', or 'anonymous'.
// No secret keys, cookies, client IPs, or query parameters are stored.

const SETTING_KEY = 'lab:callers';

function routeShape(p) {
  const cleanPath = String(p || '').split('?')[0];
  if (cleanPath === '/api/lab/projects') return '/api/lab/projects';
  if (cleanPath === '/api/lab/camera.jpg') return '/api/lab/camera.jpg';
  const m = /^\/api\/lab\/([a-z0-9-]{1,40})(?:\/(sync|photos|photo|record|requests|incoming)(?:\/([^/]+)(?:\/([^/]+))?)?)?$/.exec(cleanPath);
  if (!m) return cleanPath;
  const [, , part, arg, sub] = m;
  if (!part) return '/api/lab/:project';
  if (part === 'sync') return '/api/lab/:project/sync';
  if (part === 'photos') return arg ? '/api/lab/:project/photos/:sha' : '/api/lab/:project/photos';
  if (part === 'photo') return '/api/lab/:project/photo/:sha';
  if (part === 'record') return '/api/lab/:project/record/:id';
  if (part === 'incoming') return '/api/lab/:project/incoming/:sha';
  if (part === 'requests') {
    if (!arg) return '/api/lab/:project/requests';
    if (sub === 'result') return '/api/lab/:project/requests/:id/result';
    return '/api/lab/:project/requests/:id';
  }
  return `/api/lab/:project/${part}`;
}

function callerClass(req, { hubKeyAuthorized, macAuthorized, deviceFor, isHostReq }) {
  if (hubKeyAuthorized && hubKeyAuthorized(req)) return 'hub-key';
  if (macAuthorized && macAuthorized(req)) return 'mac';
  if (deviceFor && deviceFor(req)) return 'device';
  if (isHostReq && isHostReq(req)) return 'host';
  return 'anonymous';
}

function createLabCallers({ storage, now = () => new Date().toISOString() }) {
  function record(req, p, authHelpers = {}) {
    if (!p.startsWith('/api/lab/')) return;
    const method = String(req.method || 'GET').toUpperCase();
    const shape = routeShape(p);
    const caller = callerClass(req, authHelpers);
    const key = `${method} ${shape} [${caller}]`;
    const t = now();

    const stored = storage.readSetting(SETTING_KEY, { callers: {} });
    const callers = stored.callers || {};
    const existing = callers[key];

    if (!existing) {
      callers[key] = {
        method,
        shape,
        caller,
        first_seen: t,
        last_seen: t,
        count: 1
      };
      console.log(`[lab-callers] first seen: ${method} ${shape} caller=${caller}`);
    } else {
      existing.last_seen = t;
      existing.count += 1;
    }

    storage.writeSetting(SETTING_KEY, { callers });
  }

  function report() {
    const stored = storage.readSetting(SETTING_KEY, { callers: {} });
    const list = Object.values(stored.callers || {}).sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
    return {
      total_callers: list.length,
      callers: list
    };
  }

  return { record, report, routeShape, callerClass };
}

module.exports = { createLabCallers, routeShape, callerClass, SETTING_KEY };
