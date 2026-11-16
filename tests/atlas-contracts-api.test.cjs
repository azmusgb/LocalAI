'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createContractsReader } = require('../app/server/atlas-contracts.js');
const { createAtlas } = require('../app/server/atlas.js');

test('contracts reader: checked when provider route and consumer call match', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contracts-test-'));
  const contractsFile = path.join(dir, 'contracts.json');
  fs.writeFileSync(contractsFile, JSON.stringify([
    {
      id: 'test-v1',
      contract: 'test.v1',
      provider: { repo: 'pi-hub', module: 'hub/app.py', method: 'GET', path: '/api/records' },
      consumers: [{ repo: 'localai', module: 'app/pi-hub.js' }],
      source: 'spec'
    }
  ]));

  const mockSnapshots = {
    find(repo, commit) {
      return { repo, commit };
    },
    list() {
      return { snapshots: [] };
    },
    graph(row) {
      if (row.repo === 'pi-hub') {
        return {
          schemaVersion: 3,
          httpRoutes: [{ path: '/api/records', owner: 'hub/app.py', method: 'GET' }],
          nodes: [{ id: 'hub/app.py', calls: [] }],
          edges: []
        };
      }
      if (row.repo === 'localai') {
        return {
          schemaVersion: 3,
          httpRoutes: [],
          nodes: [{ id: 'app/pi-hub.js', calls: [{ path: '/api/records', line: 10 }] }],
          edges: []
        };
      }
      return null;
    }
  };

  const mockSystems = {
    async read() {
      return {
        status: 200,
        body: {
          source: 'live',
          hosts: [
            { targets: [{ atlas: 'pi-hub', commit: '1111111111111111111111111111111111111111' }] },
            { targets: [{ atlas: 'localai', commit: '2222222222222222222222222222222222222222' }] }
          ]
        }
      };
    }
  };

  const reader = createContractsReader({
    contractsPath: contractsFile,
    snapshots: mockSnapshots,
    systems: mockSystems,
    repos: ['localai', 'pi-hub', 'print-lab']
  });

  const res = await reader.check();
  assert.equal(res.status, 200);
  assert.equal(res.body.brokenCount, 0);
  assert.equal(res.body.contracts.length, 1);
  const c = res.body.contracts[0];
  assert.equal(c.state, 'checked');
  assert.equal(c.provider.state, 'checked');
  assert.equal(c.consumers[0].state, 'checked');
});

test('contracts reader: provider missing when route not served or wrong owner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contracts-test-'));
  const contractsFile = path.join(dir, 'contracts.json');
  fs.writeFileSync(contractsFile, JSON.stringify([
    {
      id: 'missing-route',
      provider: { repo: 'pi-hub', module: 'hub/app.py', method: 'GET', path: '/api/missing' },
      consumers: [{ repo: 'localai', module: 'app/test.js' }]
    },
    {
      id: 'wrong-owner',
      provider: { repo: 'pi-hub', module: 'hub/app.py', method: 'GET', path: '/api/other' },
      consumers: [{ repo: 'localai', module: 'app/test.js' }]
    }
  ]));

  const mockSnapshots = {
    find(repo, commit) { return { repo, commit }; },
    graph(row) {
      return {
        schemaVersion: 3,
        httpRoutes: [{ path: '/api/other', owner: 'hub/different.py', method: 'GET' }],
        nodes: [
          { id: 'hub/app.py', calls: [] },
          { id: 'app/test.js', calls: [{ path: '/api/missing' }, { path: '/api/other' }] }
        ]
      };
    }
  };

  const mockSystems = {
    async read() {
      return {
        status: 200,
        body: {
          source: 'live',
          hosts: [{ targets: [{ atlas: 'pi-hub', commit: '1111111111111111111111111111111111111111' }, { atlas: 'localai', commit: '2222222222222222222222222222222222222222' }] }]
        }
      };
    }
  };

  const reader = createContractsReader({
    contractsPath: contractsFile,
    snapshots: mockSnapshots,
    systems: mockSystems,
    repos: ['localai', 'pi-hub']
  });

  const res = await reader.check();
  assert.equal(res.body.brokenCount, 2);
  assert.equal(res.body.contracts[0].provider.state, 'provider_missing');
  assert.equal(res.body.contracts[1].provider.state, 'provider_missing');
  assert.match(res.body.contracts[1].provider.detail, /owned by hub\/different\.py/);
});

test('contracts reader: consumer missing when module has no call to route', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contracts-test-'));
  const contractsFile = path.join(dir, 'contracts.json');
  fs.writeFileSync(contractsFile, JSON.stringify([
    {
      id: 'consumer-missing-call',
      provider: { repo: 'pi-hub', module: 'hub/app.py', method: 'GET', path: '/api/records' },
      consumers: [{ repo: 'localai', module: 'app/pi-hub.js' }]
    }
  ]));

  const mockSnapshots = {
    find(repo, commit) { return { repo, commit }; },
    graph() {
      return {
        schemaVersion: 3,
        httpRoutes: [{ path: '/api/records', owner: 'hub/app.py' }],
        nodes: [{ id: 'app/pi-hub.js', calls: [{ path: '/api/something_else' }] }]
      };
    }
  };

  const mockSystems = {
    async read() {
      return {
        status: 200,
        body: {
          source: 'live',
          hosts: [{ targets: [{ atlas: 'pi-hub', commit: '1111111111111111111111111111111111111111' }, { atlas: 'localai', commit: '2222222222222222222222222222222222222222' }] }]
        }
      };
    }
  };

  const reader = createContractsReader({
    contractsPath: contractsFile,
    snapshots: mockSnapshots,
    systems: mockSystems,
    repos: ['localai', 'pi-hub']
  });

  const res = await reader.check();
  assert.equal(res.body.brokenCount, 1);
  assert.equal(res.body.contracts[0].consumers[0].state, 'consumer_missing');
  assert.match(res.body.contracts[0].consumers[0].detail, /Declared but not found/);
});

test('contracts reader: unmapped repo or schema 2 snapshot is not_checked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contracts-test-'));
  const contractsFile = path.join(dir, 'contracts.json');
  fs.writeFileSync(contractsFile, JSON.stringify([
    {
      id: 'unmapped-and-v2',
      provider: { repo: 'pi-hub', module: 'hub/app.py', method: 'GET', path: '/api/records' },
      consumers: [
        { repo: 'home-mcp', module: 'src/home_mcp/server.py' },
        { repo: 'localai', module: 'app/pi-hub.js' }
      ]
    }
  ]));

  const mockSnapshots = {
    find(repo, commit) { return { repo, commit }; },
    graph(row) {
      if (row.repo === 'pi-hub') {
        return {
          schemaVersion: 2,
          httpRoutes: [{ path: '/api/records', owner: 'hub/app.py' }],
          nodes: [{ id: 'hub/app.py' }]
        };
      }
      if (row.repo === 'localai') {
        return {
          schemaVersion: 2,
          httpRoutes: [],
          nodes: [{ id: 'app/pi-hub.js' }]
        };
      }
      return null;
    }
  };

  const mockSystems = {
    async read() {
      return {
        status: 200,
        body: {
          source: 'live',
          hosts: [{ targets: [{ atlas: 'pi-hub', commit: '1111111111111111111111111111111111111111' }, { atlas: 'localai', commit: '2222222222222222222222222222222222222222' }] }]
        }
      };
    }
  };

  const reader = createContractsReader({
    contractsPath: contractsFile,
    snapshots: mockSnapshots,
    systems: mockSystems,
    repos: ['localai', 'pi-hub'] // home-mcp is unmapped
  });

  const res = await reader.check();
  assert.equal(res.body.brokenCount, 0);
  const c = res.body.contracts[0];
  assert.equal(c.consumers[0].state, 'not_checked');
  assert.match(c.consumers[0].detail, /home-mcp isn't mapped/);
  assert.equal(c.consumers[1].state, 'not_checked');
  assert.match(c.consumers[1].detail, /schema 2/);
});

test('apiAtlas route /api/atlas/contracts serves contract evaluations', async () => {
  const json = (res, status, body) => {
    res.statusCode = status;
    res.body = body;
    return { status, body };
  };
  const readBody = async () => ({});
  const fetchWithTimeout = async () => ({ ok: false, status: 503 });

  const atlas = createAtlas({
    json,
    readBody,
    fetchWithTimeout,
    contractsPath: path.resolve(__dirname, '..', 'atlas', 'contracts.json')
  });

  const req = { method: 'GET', url: '/api/atlas/contracts' };
  const res = {};
  const out = await atlas.apiAtlas(req, res, '/api/atlas/contracts');
  assert.equal(out.status, 200);
  assert.ok(Array.isArray(out.body.contracts));
  const declared = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'atlas', 'contracts.json'), 'utf8'));
  assert.equal(out.body.contracts.length, declared.length);
  assert.ok(Array.isArray(out.body.undeclared));
  for (const c of out.body.contracts) {
    assert.ok(['confirmed', 'provider missing', 'consumer missing', 'no snapshot'].includes(c.check), `${c.id}: ${c.check}`);
  }
});

// Platform capture (spec 2026-11-15, design item 2): each declared edge gets a `check`, and calls no edge declares are
// listed as `undeclared`. These fixtures use the scanner's real route shape ({path, match, module}).
function readerFor(contracts, graphs, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contracts-check-'));
  const contractsFile = path.join(dir, 'contracts.json');
  fs.writeFileSync(contractsFile, JSON.stringify(contracts));
  const snapshots = {
    find(repo, commit) { return graphs[repo] ? { repo, commit } : null; },
    list() { return { snapshots: Object.keys(graphs).map((repo) => ({ repo, commit: 'c'.repeat(40), generatedAt: '2026-11-15T00:00:00Z' })) }; },
    graph(row) { return graphs[row.repo]; },
  };
  const systems = {
    async read() {
      return { status: 200, body: { source: 'live', hosts: [{ targets: Object.keys(graphs).map((atlas) => ({ atlas, commit: 'c'.repeat(40) })) }] } };
    },
  };
  return createContractsReader({ contractsPath: contractsFile, snapshots, systems, ...options });
}

const hubGraph = (routes) => ({
  schemaVersion: 3,
  httpRoutes: routes,
  nodes: [{ id: 'hub/app.py', domain: 'API', calls: [] }],
  edges: [],
});
const records = { path: '/api/records', match: 'exact', module: 'hub/app.py' };
const recordsEdge = {
  id: 'records',
  contract: 'record.v1',
  provider: { repo: 'pi-hub', module: 'hub/app.py', method: 'GET', path: '/api/records' },
  consumers: [{ repo: 'localai', module: 'app/pi-hub.js' }],
  source: 'test',
};
const localGraph = (calls, extra = {}) => ({
  schemaVersion: 3,
  httpRoutes: [{ path: '/api/health', match: 'exact', module: 'app/server.js' }, { path: '/api/items/', match: 'prefix', module: 'app/server.js' }],
  nodes: [
    { id: 'app/pi-hub.js', domain: 'Workshop', calls },
    { id: 'app/server.js', domain: 'Platform', calls: [{ path: '/api/health', line: 4 }] },
    { id: 'app/public/home.js', domain: 'UI', calls: [{ path: '/api/items/', line: 2 }, { path: '/api/gone', line: 3 }] },
    { id: 'tests/hub.test.cjs', domain: 'Tests', calls: [{ path: '/api/fixture-only', line: 9 }] },
  ],
  edges: [],
  danglingHttp: [{ source: 'app/public/home.js', path: '/api/gone', line: 3 }],
  ...extra,
});

test('contracts check: confirmed when the provider serves the route (scanner shape) and the consumer calls it', async () => {
  const reader = readerFor([recordsEdge], { 'pi-hub': hubGraph([records]), localai: localGraph([{ path: '/api/records', line: 130 }]) });
  const { body } = await reader.check();
  assert.equal(body.contracts[0].provider.state, 'checked');
  assert.equal(body.contracts[0].check, 'confirmed');
  assert.equal(body.contracts[0].consumers[0].check, 'confirmed');
  assert.equal(body.brokenCount, 0);
});

test('contracts check: a scanner pattern route (*) serves a declared literal or {param} path', async () => {
  const notify = { ...recordsEdge, id: 'notify', provider: { repo: 'pi-hub', module: 'hub/notify_routes.py', method: 'POST', path: '/api/notify/localai' } };
  const reader = readerFor([notify], {
    'pi-hub': hubGraph([{ path: '/api/notify/*', match: 'pattern', module: 'hub/notify_routes.py' }]),
    localai: localGraph([{ path: '/api/notify/localai', line: 26 }]),
  });
  const { body } = await reader.check();
  assert.equal(body.contracts[0].check, 'confirmed');
});

test('contracts check: provider missing when the route is gone', async () => {
  const reader = readerFor([recordsEdge], { 'pi-hub': hubGraph([]), localai: localGraph([{ path: '/api/records', line: 130 }]) });
  const { body } = await reader.check();
  assert.equal(body.contracts[0].check, 'provider missing');
});

test('contracts check: consumer missing when the consumer no longer calls it', async () => {
  const reader = readerFor([recordsEdge], { 'pi-hub': hubGraph([records]), localai: localGraph([]) });
  const { body } = await reader.check();
  assert.equal(body.contracts[0].check, 'consumer missing');
  assert.equal(body.contracts[0].consumers[0].check, 'consumer missing');
});

test('contracts check: no snapshot when the provider repo has none', async () => {
  const reader = readerFor([recordsEdge], { localai: localGraph([{ path: '/api/records', line: 130 }]) });
  const { body } = await reader.check();
  assert.equal(body.contracts[0].check, 'no snapshot');
  assert.equal(body.brokenCount, 0);
});

test('contracts check: an unparsed firmware consumer is not checked, not missing', async () => {
  const feed = {
    id: 'display-feed', contract: null, label: 'Display feed',
    provider: { repo: 'pi-hub', module: 'hub/display_routes.py', method: 'GET', path: '/api/display/feed' },
    consumers: [{ repo: 'bambuhelper-smart-display', module: 'firmware/feed.cpp' }],
    source: 'test',
  };
  const reader = readerFor([feed], {
    'pi-hub': hubGraph([{ path: '/api/display/feed', match: 'exact', module: 'hub/display_routes.py' }]),
    'bambuhelper-smart-display': { schemaVersion: 3, httpRoutes: [], nodes: [], edges: [], skipped: [{ path: 'firmware/feed.cpp', reason: 'firmware source, not parsed' }] },
  });
  const { body } = await reader.check();
  const c = body.contracts[0];
  assert.equal(c.consumers[0].state, 'not_checked');
  assert.match(c.consumers[0].detail, /firmware source, not parsed/);
  assert.equal(c.check, 'no snapshot');
  assert.equal(body.brokenCount, 0);
});

test('contracts check: the default mapped repos include the smart display', async () => {
  const edge = { ...recordsEdge, consumers: [{ repo: 'bambuhelper-smart-display', module: 'tools/hub.py' }] };
  const display = { schemaVersion: 3, httpRoutes: [], nodes: [{ id: 'tools/hub.py', domain: 'Root', calls: [{ path: '/api/records', line: 3 }] }], edges: [] };
  const reader = readerFor([edge], { 'pi-hub': hubGraph([records]), 'bambuhelper-smart-display': display });
  const { body } = await reader.check();
  assert.equal(body.contracts[0].consumers[0].state, 'checked');
  assert.equal(body.contracts[0].check, 'confirmed');
});

test('contracts check: calls no declared edge covers are listed as undeclared, never an error', async () => {
  const calls = [{ path: '/api/records', line: 130 }, { path: '/api/workshop', line: 140, method: 'GET' }];
  const graphs = { 'pi-hub': hubGraph([records]), localai: localGraph(calls) };
  const { body } = await readerFor([recordsEdge], graphs).check();
  // Not listed: the declared call, the repo's own routes (exact and prefix), a browser call already reported as
  // dangling, and a test module's call.
  assert.deepEqual(body.undeclared, [{ repo: 'localai', module: 'app/pi-hub.js', method: 'GET', path: '/api/workshop', line: 140 }]);
  assert.equal(body.contracts[0].check, 'confirmed');
  assert.equal(body.brokenCount, 0);
  const { body: without } = await readerFor([recordsEdge], { 'pi-hub': hubGraph([records]), localai: localGraph([{ path: '/api/records', line: 130 }]) }).check();
  assert.deepEqual(without.undeclared, []);
  const undeclaredMethod = await readerFor([recordsEdge], { 'pi-hub': hubGraph([records]), localai: localGraph([{ path: '/api/workshop', line: 5 }, { path: '/api/records', line: 130 }]) }).check();
  assert.equal(undeclaredMethod.body.undeclared[0].method, null);
});

test('contracts check: a schema 2 snapshot is no snapshot and adds nothing to undeclared', async () => {
  const reader = readerFor([recordsEdge], { 'pi-hub': hubGraph([records]), localai: { schemaVersion: 2, httpRoutes: [], nodes: [{ id: 'app/pi-hub.js' }], edges: [] } });
  const { body } = await reader.check();
  assert.equal(body.contracts[0].check, 'no snapshot');
  assert.deepEqual(body.undeclared, []);
});
