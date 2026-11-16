'use strict';

// A fixed, LocalAI-shaped Atlas graph (scanner schema 2) for the Architecture page's browser suite and its visual
// baselines: browser scripts calling the server over HTTP, a server wiring up modules, shared and data modules with and
// without tests, one changed module and one browser call nothing serves.
const DOMAINS = {
  UI: ['app/public/home.js', 'app/public/work.js', 'app/public/improve.js', 'app/public/architecture.js', 'app/public/router.js'],
  Platform: ['app/server.js'],
  Tooling: ['scripts/local-ci.mjs'],
  API: ['app/server/chat.js', 'app/server/runs.js', 'app/server/atlas.js', 'app/server/status.js'],
  AI: ['app/model-router.js', 'app/model-http.js', 'app/agent-orchestrator.js'],
  Workshop: ['app/print-lab.js'],
  Core: ['app/notify.js', 'app/release.js', 'app/plain-text.js', 'app/glance.js'],
  Data: ['app/storage.js', 'app/run-ledger.js', 'app/journal.js'],
};
const TESTED = { 'app/storage.js': 6, 'app/run-ledger.js': 3, 'app/model-router.js': 1, 'app/release.js': 2, 'app/print-lab.js': 1 };
const IMPORTS = [
  ...['app/server/chat.js', 'app/server/runs.js', 'app/server/atlas.js', 'app/server/status.js', 'app/notify.js', 'app/release.js',
    'app/glance.js', 'app/storage.js', 'app/print-lab.js', 'app/model-router.js', 'app/journal.js', 'app/plain-text.js'].map((t) => ['app/server.js', t]),
  ['app/server/chat.js', 'app/model-router.js'], ['app/server/chat.js', 'app/run-ledger.js'], ['app/server/runs.js', 'app/run-ledger.js'],
  ['app/server/status.js', 'app/release.js'], ['app/model-router.js', 'app/model-http.js'], ['app/agent-orchestrator.js', 'app/model-router.js'],
  ['app/agent-orchestrator.js', 'app/storage.js'], ['app/run-ledger.js', 'app/storage.js'], ['app/journal.js', 'app/storage.js'],
  ['app/glance.js', 'app/notify.js'], ['app/notify.js', 'app/plain-text.js'], ['app/print-lab.js', 'app/notify.js'],
  ['app/public/home.js', 'app/public/router.js'], ['app/public/work.js', 'app/public/router.js'], ['app/public/improve.js', 'app/public/router.js'],
];
const HTTP = [
  ['app/public/home.js', 'app/server.js', ['/api/health']], ['app/public/home.js', 'app/server/status.js', ['/api/status']],
  ['app/public/work.js', 'app/server/runs.js', ['/api/runs']], ['app/public/work.js', 'app/server/chat.js', ['/api/chat']],
  ['app/public/architecture.js', 'app/server/atlas.js', ['/api/atlas/graph', '/api/atlas/summary']],
];

function atlasFixture({ version = 2, skipped = null, nodes: only = null, edges: onlyEdges = null } = {}) {
  const nodes = [];
  const usedBy = new Map();
  for (const [s, t] of IMPORTS) (usedBy.get(t) || usedBy.set(t, new Set()).get(t)).add(s);
  const reachOf = (id) => {
    const seen = new Set(), todo = [id];
    while (todo.length) for (const u of usedBy.get(todo.pop()) || []) if (u !== id && !seen.has(u)) { seen.add(u); todo.push(u); }
    return seen.size;
  };
  for (const [domain, ids] of Object.entries(DOMAINS)) for (const id of ids) {
    const out = IMPORTS.filter(([s]) => s === id).length, inn = (usedBy.get(id) || new Set()).size, reach = reachOf(id), tests = TESTED[id] || 0;
    const parts = { reach: Math.round(45 * Math.min(1, Math.log1p(reach) / Math.log1p(10))), out: Math.round(70 * Math.min(1, Math.log1p(out) / Math.log1p(50))),
      in: Math.round(15 * Math.min(1, Math.log1p(inn) / Math.log1p(10))) };
    const structure = Math.min(100, parts.reach + parts.out + parts.in);
    parts.tested = Math.round(structure * (0.5 + 0.5 / (1 + 0.5 * tests))) - structure;
    nodes.push({ id, label: id.split('/').pop(), path: id, domain, inbound: inn + tests, outbound: out, testRefs: tests, changed: id === 'app/notify.js',
      risk: structure + parts.tested, ...(version >= 2 ? { reach, riskParts: parts } : {}) });
  }
  const tests = Object.entries(TESTED).flatMap(([target, n]) => Array.from({ length: n }, (_, i) => ({ source: `tests/${target.split('/').pop().replace('.js', '')}-${i}.test.cjs`, target })));
  for (const t of new Set(tests.map((e) => e.source))) nodes.push({ id: t, label: t.split('/').pop(), domain: 'Tests', risk: 0, testRefs: 0 });
  const edges = [
    ...IMPORTS.map(([source, target]) => ({ source, target, ...(version >= 2 ? { kind: 'import' } : {}) })),
    ...tests.map((e) => ({ ...e, ...(version >= 2 ? { kind: 'test' } : {}) })),
    ...(version >= 2 ? HTTP.map(([source, target, paths]) => ({ source, target, kind: 'http', paths })) : []),
  ];
  return {
    ...(version >= 2 ? { schemaVersion: 2, danglingHttp: [{ source: 'app/public/improve.js', path: '/api/improve/retired', line: 42 }] } : { schemaVersion: 1, danglingHttp: null }),
    generatedAt: '2026-10-14T13:00:00Z', stats: { files: nodes.length, productionFiles: Object.values(DOMAINS).flat().length }, domains: [],
    nodes: only || nodes, edges: onlyEdges || edges, changedNodes: [], highestRisk: [], stale: false, staleReason: null, snapshot: null,
    ...(skipped ? { skipped } : {}),
  };
}

// What Local AI's /api/atlas/systems answers (Atlas redesign PR 4): five hosts from Pi Hub, Local AI mapped (not at its
// live commit), Pi Hub mapped, print-lab never snapshotted, one service that needs a look.
function systemsFixture({ source = 'live' } = {}) {
  const svc = (id, label, state = 'ok', severity = 'ok') => ({ id, label, state, severity, headline: '', stale: false });
  const t = (id, label, atlas, commit) => ({ id, label, repo: null, atlas, state: 'live', commit, deployedAt: null, version: null });
  return {
    source, error: source === 'cache' ? 'Pi Hub could not be reached (timeout).' : null,
    fetchedAt: new Date(Date.now() - (source === 'cache' ? 2 * 3600e3 : 10e3)).toISOString(), hubAsOf: null,
    hosts: [
      { id: 'pi', label: 'Raspberry Pi', runs: 'Always on', services: [svc('hub', "The hub's sources"), svc('adguard', 'Ad blocking', 'paused', 'attention'), svc('weather', 'Weather')],
        targets: [t('pi-hub', 'Pi Hub', 'pi-hub', '4'.repeat(40)), t('netmon', 'netmon', null, '2'.repeat(40))],
        repos: [{ repo: 'pi-hub', label: 'Pi Hub', liveCommit: '4'.repeat(40), snapshot: { commit: '4'.repeat(40), generatedAt: new Date().toISOString() }, atLive: true }] },
      { id: 'pc', label: 'Windows PC', runs: 'May sleep', services: [svc('local_ai', 'Local AI', 'ready'), svc('pc', 'Windows PC', 'on')],
        targets: [t('localai', 'Local AI', 'localai', 'f'.repeat(40))],
        repos: [{ repo: 'localai', label: 'Local AI', liveCommit: 'f'.repeat(40), snapshot: { commit: 'e'.repeat(40), generatedAt: new Date(Date.now() - 4.5 * 86400e3).toISOString() }, atLive: false }] },
      { id: 'mac', label: 'Mac', runs: 'When it is awake', services: [svc('mac_lab', 'Print lab on the Mac', 'idle')],
        targets: [t('print-lab', 'Print lab', 'print-lab', '9'.repeat(40))],
        repos: [{ repo: 'print-lab', label: 'Print lab', liveCommit: '9'.repeat(40), snapshot: null, atLive: false }] },
      { id: 'devices', label: 'Devices', runs: 'On the home network', services: [svc('printer', 'Bambu X2D', 'idle')], targets: [t('firmware', 'Display firmware', null, '7'.repeat(40))], repos: [] },
      { id: 'offsite', label: 'Off-site', runs: 'Google Drive, nightly', services: [svc('backups', 'Backups')], targets: [], repos: [] },
    ],
  };
}

// GET /api/atlas/contracts as the server answers it (app/server/atlas-contracts.js), from the declared edges in
// app/atlas/contracts.json: Local AI's consumers confirmed, print-lab and home-mcp not checked (no snapshot, not mapped), the
// smart display's firmware not parsed, the PowerShell consumer not scanned, and camera-feed's consumer missing so all
// three marks show. `undeclared` is shaped like the real scan's 96 calls (localai 22, pi-hub 34, smart display 40).
function contractsFixture({ extra = 0 } = {}) {
  const declared = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'atlas', 'contracts.json'), 'utf8'));
  const CHECK = { checked: 'confirmed', consumer_missing: 'consumer missing', not_checked: 'no snapshot' };
  const consumerState = (entry, c) => {
    if (entry.id === 'camera-feed') return ['consumer_missing', `Declared but not found in ${c.module} at eeeeeee`];
    if (c.repo === 'home-mcp') return ['not_checked', "home-mcp isn't mapped"];
    if (c.repo === 'print-lab') return ['not_checked', 'No snapshot available for print-lab'];
    if (c.repo === 'bambuhelper-smart-display') return ['not_checked', `${c.module} is firmware source, not parsed in bambuhelper-smart-display at 4ebcb58`];
    if (c.module.endsWith('.ps1')) return ['not_checked', `${c.module}: PowerShell source, not scanned in localai at eeeeeee`];
    return ['checked', 'Call found'];
  };
  const list = [...declared, ...Array.from({ length: extra }, (_, i) => ({ id: `extra-${i}`, provider: { repo: 'pi-hub', module: 'hub/app.py', method: 'GET', path: `/api/extra/${i}` },
    consumers: [{ repo: 'localai', module: `app/extra-${i}.js` }] }))];
  const contracts = list.map((entry) => {
    const consumers = entry.consumers.map((c) => { const [state, detail] = consumerState(entry, c); return { ...c, state, detail, commit: null, live: true, check: CHECK[state] }; });
    const check = consumers.some((c) => c.state === 'consumer_missing') ? 'consumer missing' : consumers.some((c) => c.state === 'not_checked') ? 'no snapshot' : 'confirmed';
    return { id: entry.id, contract: entry.contract || null, label: entry.label || null, state: check === 'confirmed' ? 'checked' : check === 'consumer missing' ? 'broken' : 'partially_checked',
      check, provider: { ...entry.provider, state: 'checked', detail: '', commit: '4'.repeat(40), live: true }, consumers, source: entry.source || null };
  });
  const calls = (repo, module, n, path, method = null) => Array.from({ length: n }, (_, i) => ({ repo, module, method, path: path(i), line: 10 + i * 7 }));
  const undeclared = [
    ...calls('localai', 'app/ollama.js', 14, (i) => `/api/${['tags', 'ps', 'pull', 'generate', 'chat', 'show', 'embed'][i % 7]}`),
    ...calls('localai', 'app/workshop.js', 2, (i) => ['/api/status/lite', '/api/portal-code'][i], 'GET'),
    ...calls('localai', 'host/mac-watch/watch.py', 1, () => '/api/notify/mac-watch', 'POST'),
    ...calls('localai', 'app/bambuddy.js', 5, (i) => `/api/v1/printers/${i}`),
    ...calls('pi-hub', 'hub/bambuddy.py', 28, (i) => `/api/v1/${['spools', 'projects', 'archives', 'printers'][i % 4]}/${i}`),
    ...calls('pi-hub', 'hub/display_ai.py', 3, (i) => ['/api/display/ai-cards', '/api/images/view', '/api/images/view'][i], 'GET'),
    ...calls('pi-hub', 'hub/display_routes.py', 3, () => '/api/images/view', 'GET'),
    ...calls('bambuhelper-smart-display', 'tools/acceptance_workshop_os12.py', 24, (i) => `/api/status/${['lite', 'full', 'screens', 'touch'][i % 4]}`),
    ...calls('bambuhelper-smart-display', 'tools/validate_display_contract.py', 16, (i) => `/api/${['portal-code', 'settings', 'ota'][i % 3]}`),
  ];
  return { contracts, undeclared, brokenCount: contracts.filter((c) => c.state === 'broken').length,
    commits: { 'pi-hub': '4'.repeat(40), localai: 'f'.repeat(40) }, systems: { source: 'live', hubAsOf: null, fetchedAt: new Date().toISOString(), error: null } };
}

module.exports = { atlasFixture, systemsFixture, contractsFixture };
