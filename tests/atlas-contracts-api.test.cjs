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
  assert.equal(out.body.contracts.length, 10);
});
