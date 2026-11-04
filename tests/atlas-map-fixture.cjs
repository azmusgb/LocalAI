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

function atlasFixture({ version = 2 } = {}) {
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
    nodes, edges, changedNodes: [], highestRisk: [], stale: false, staleReason: null, snapshot: null,
  };
}

module.exports = { atlasFixture };
