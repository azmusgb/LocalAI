const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('atlas/contracts.json adheres to schema and semantic invariants', () => {
  const filePath = path.join(__dirname, '..', 'atlas', 'contracts.json');
  assert.ok(fs.existsSync(filePath), 'atlas/contracts.json must exist');

  const raw = fs.readFileSync(filePath, 'utf8');
  const contracts = JSON.parse(raw);
  assert.ok(Array.isArray(contracts), 'contracts.json must be an array');
  assert.ok(contracts.length >= 10, 'must define at least the 10 known contracts');

  const seenIds = new Set();
  const allowedMethods = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);
  const allowedProviderRepos = new Set(['pi-hub', 'localai', 'print-lab']);
  const allowedConsumerRepos = new Set(['pi-hub', 'localai', 'print-lab', 'home-mcp', 'appliance-ui', 'netmon', 'bambuhelper-smart-display']);
  const providerRoutes = new Set();

  for (const c of contracts) {
    assert.ok(typeof c.id === 'string' && c.id.length > 0, `Contract must have an id: ${JSON.stringify(c)}`);
    assert.ok(!seenIds.has(c.id), `Duplicate contract id: ${c.id}`);
    seenIds.add(c.id);

    assert.ok(c.contract === null || typeof c.contract === 'string', `Contract type must be string or null for ${c.id}`);
    if (c.contract === null) {
      assert.ok(typeof c.label === 'string' && c.label.length > 0, `Uncontracted edge must have a label: ${c.id}`);
    }

    assert.ok(c.provider && typeof c.provider === 'object', `Provider missing on ${c.id}`);
    assert.ok(allowedProviderRepos.has(c.provider.repo), `Provider repo invalid: ${c.provider.repo}`);
    assert.ok(typeof c.provider.module === 'string' && c.provider.module.length > 0, `Provider module invalid: ${c.id}`);
    assert.ok(allowedMethods.has(c.provider.method), `Provider method invalid: ${c.provider.method}`);
    assert.ok(c.provider.path.startsWith('/'), `Provider path must start with /: ${c.provider.path}`);
    const route = `${c.provider.repo} ${c.provider.method} ${c.provider.path}`;
    assert.ok(!providerRoutes.has(route), `Duplicate provider route: ${route}`);
    providerRoutes.add(route);

    assert.ok(Array.isArray(c.consumers) && c.consumers.length > 0, `Consumers must be a non-empty array: ${c.id}`);
    for (const cons of c.consumers) {
      assert.ok(allowedConsumerRepos.has(cons.repo), `Consumer repo invalid: ${cons.repo} in ${c.id}`);
      assert.ok(typeof cons.module === 'string' && cons.module.length > 0, `Consumer module missing in ${c.id}`);
    }

    assert.ok(typeof c.source === 'string' && c.source.length > 0, `Contract source description required: ${c.id}`);
  }
});

test('atlas/contracts.json declares the Pi Hub calls of home-mcp and the smart display (platform capture spec)', () => {
  const contracts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'atlas', 'contracts.json'), 'utf8'));
  const consumersOf = (repo) => contracts.filter((c) => c.consumers.some((cons) => cons.repo === repo)).map((c) => c.provider.path);
  for (const p of ['/api/workshop', '/api/pi', '/api/system/backups', '/api/freshness', '/api/alerts']) {
    assert.ok(consumersOf('home-mcp').includes(p), `home-mcp calls ${p}`);
  }
  assert.ok(consumersOf('bambuhelper-smart-display').includes('/api/display/feed'), 'the smart display reads its feed from Pi Hub');
  // Every edge added for these repos names the file and line it was verified at.
  for (const c of contracts.filter((x) => x.consumers.some((cons) => ['home-mcp', 'bambuhelper-smart-display'].includes(cons.repo)))) {
    assert.match(c.source, /:\d+/, `${c.id} source names a file and line`);
  }
});
