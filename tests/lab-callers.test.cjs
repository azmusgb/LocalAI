'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLabCallers, routeShape, callerClass } = require('../app/lab-callers');

function createMockStorage() {
  const map = new Map();
  return {
    readSetting: (key, fallback = {}) => (map.has(key) ? JSON.parse(map.get(key)) : fallback),
    writeSetting: (key, value) => { map.set(key, JSON.stringify(value)); }
  };
}

test('routeShape normalizes paths without query params or IDs', () => {
  assert.equal(routeShape('/api/lab/projects'), '/api/lab/projects');
  assert.equal(routeShape('/api/lab/camera.jpg'), '/api/lab/camera.jpg');
  assert.equal(routeShape('/api/lab/hex-tile'), '/api/lab/:project');
  assert.equal(routeShape('/api/lab/hex-tile/sync'), '/api/lab/:project/sync');
  assert.equal(routeShape('/api/lab/hex-tile/photos'), '/api/lab/:project/photos');
  assert.equal(routeShape('/api/lab/hex-tile/photos/abcdef.jpg'), '/api/lab/:project/photos/:sha');
  assert.equal(routeShape('/api/lab/hex-tile/photo/123456.jpg'), '/api/lab/:project/photo/:sha');
  assert.equal(routeShape('/api/lab/hex-tile/record/E-001'), '/api/lab/:project/record/:id');
  assert.equal(routeShape('/api/lab/hex-tile/requests'), '/api/lab/:project/requests');
  assert.equal(routeShape('/api/lab/hex-tile/requests?status=pending'), '/api/lab/:project/requests');
  assert.equal(routeShape('/api/lab/hex-tile/requests/rq-1234567812345678/result'), '/api/lab/:project/requests/:id/result');
});

test('callerClass categorizes requests according to credentials and origin', () => {
  const req = { headers: {} };
  assert.equal(callerClass(req, {}), 'anonymous');
  assert.equal(callerClass(req, { hubKeyAuthorized: () => true }), 'hub-key');
  assert.equal(callerClass(req, { macAuthorized: () => true }), 'mac');
  assert.equal(callerClass(req, { deviceFor: () => ({ id: 'dev-1' }) }), 'device');
  assert.equal(callerClass(req, { isHostReq: () => true }), 'host');
});

test('caller ledger persists sightings and increments counts', () => {
  const storage = createMockStorage();
  let time = '2026-11-03T12:00:00Z';
  const ledger = createLabCallers({ storage, now: () => time });

  const req = { method: 'GET', headers: {} };
  ledger.record(req, '/api/lab/projects', { hubKeyAuthorized: () => true });

  let rep = ledger.report();
  assert.equal(rep.total_callers, 1);
  assert.equal(rep.callers[0].method, 'GET');
  assert.equal(rep.callers[0].shape, '/api/lab/projects');
  assert.equal(rep.callers[0].caller, 'hub-key');
  assert.equal(rep.callers[0].count, 1);
  assert.equal(rep.callers[0].first_seen, time);
  assert.equal(rep.callers[0].last_seen, time);

  // Second call with later time updates last_seen and count
  time = '2026-11-03T12:05:00Z';
  ledger.record(req, '/api/lab/projects', { hubKeyAuthorized: () => true });

  rep = ledger.report();
  assert.equal(rep.total_callers, 1);
  assert.equal(rep.callers[0].count, 2);
  assert.equal(rep.callers[0].first_seen, '2026-11-03T12:00:00Z');
  assert.equal(rep.callers[0].last_seen, '2026-11-03T12:05:00Z');

  // Distinct route or caller creates separate entry
  ledger.record({ method: 'POST' }, '/api/lab/hex-tile/sync', { macAuthorized: () => true });
  rep = ledger.report();
  assert.equal(rep.total_callers, 2);
});
