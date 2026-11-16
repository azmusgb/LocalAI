'use strict';

// Joins app/atlas/contracts.json with snapshot graphs and live release commits from Pi Hub (GET /api/systems).
// Computes cross-repo contract edge states:
// - checked: provider serves route in module; consumer calls route in module
// - provider_missing: provider has no such route or owned by different module
// - consumer_missing: consumer module has no call to that route
// - not_checked: unmapped repo, schema < 3 (no outgoing calls), no snapshot, or a module the scanner lists as skipped
// Each edge also carries `check` (platform capture spec, design item 2): "confirmed", "provider missing",
// "consumer missing" or "no snapshot" (anything not checked). `undeclared` lists the outgoing calls found in the
// snapshots that no declared edge covers and the calling repository does not serve itself: information, never an error.
const fs = require('node:fs');
const path = require('node:path');

const CONTRACTS_PATH = path.resolve(__dirname, '..', 'atlas', 'contracts.json');

function normalizeRoutePattern(routePath) {
  if (!routePath) return '';
  // Convert {param} placeholders, and the scanner's "*" segments (a route's parameters), into a wildcard segment
  const escaped = routePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regexStr = '^' + escaped.replace(/\\\{[a-zA-Z0-9_]+\\\}|\\\*/g, '[^/]+') + '$';
  return new RegExp(regexStr);
}

function matchRoute(routePath, declaredPath) {
  if (!routePath || !declaredPath) return false;
  if (routePath === declaredPath) return true;
  // Match parameter patterns like /api/now/poster/{n}.jpg or /api/lab/{project}/sync
  try {
    const rx = normalizeRoutePattern(declaredPath);
    if (rx.test(routePath)) return true;
    const invRx = normalizeRoutePattern(routePath);
    if (invRx.test(declaredPath)) return true;
  } catch {}
  return false;
}

function matchCallPath(callPath, declaredPath) {
  if (!callPath || !declaredPath) return false;
  if (callPath === declaredPath) return true;
  if (!declaredPath.includes('{')) return false;
  const rx = normalizeRoutePattern(declaredPath);
  if (rx.test(callPath)) return true;
  // A call that stops at the declared path's parameters (/api/releases or /api/releases/ for /api/releases/{target}).
  // Only for a path with parameters: a call below /api/now (/api/now/poster/) is not a call to /api/now.
  const baseDeclared = declaredPath.replace(/\/\{[a-zA-Z0-9_]+\}.*$/, '');
  return Boolean(baseDeclared) && (callPath === baseDeclared || callPath.startsWith(baseDeclared + '/'));
}

// Does a route from a snapshot's httpRoutes ({path, match, module}) serve this path? A prefix route serves everything
// below it; a dynamic call path ("/api/items/") is served by a route that extends it.
function routeServes(route, callPath) {
  if (!route || !route.path || !callPath) return false;
  if (route.match === 'prefix') return callPath.startsWith(route.path);
  if (matchRoute(route.path, callPath)) return true;
  return callPath.endsWith('/') && route.path.startsWith(callPath);
}

const routeModule = (route) => route.module || route.owner;

// The file types quick_arch.py reads as modules (its SOURCE_EXTENSIONS). A declared consumer of another type
// (a PowerShell or shell script) never becomes a node, so it is not checked rather than missing.
const SCANNED_EXTENSIONS = new Set(['.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
const SOURCE_NAMES = { '.ps1': 'PowerShell' };
function unscannedReason(modulePath) {
  const ext = path.extname(String(modulePath || '')).toLowerCase();
  if (!ext || SCANNED_EXTENSIONS.has(ext)) return null;
  return `${SOURCE_NAMES[ext] || ext} source, not scanned`;
}

const CHECK = { checked: 'confirmed', provider_missing: 'provider missing', consumer_missing: 'consumer missing', not_checked: 'no snapshot' };

function createContractsReader(options = {}) {
  const contractsPath = options.contractsPath || CONTRACTS_PATH;
  const snapshots = options.snapshots;
  const systems = options.systems;
  const mappedRepos = new Set(options.repos || ['localai', 'pi-hub', 'print-lab', 'bambuhelper-smart-display']);

  function loadContracts() {
    try {
      if (!fs.existsSync(contractsPath)) {
        return { error: 'Contracts file not found.' };
      }
      const data = JSON.parse(fs.readFileSync(contractsPath, 'utf8'));
      if (!Array.isArray(data)) {
        return { error: 'Contracts file is not an array.' };
      }
      return { contracts: data };
    } catch (err) {
      return { error: `Contracts file could not be read: ${err.message}` };
    }
  }

  async function getLiveCommits() {
    const commits = {};
    if (!systems || typeof systems.read !== 'function') {
      return { commits, source: 'none', error: 'Systems reader unavailable' };
    }
    try {
      const res = await systems.read();
      if (res && res.body) {
        const body = res.body;
        const hosts = Array.isArray(body.hosts) ? body.hosts : [];
        for (const host of hosts) {
          const targets = Array.isArray(host.targets) ? host.targets : [];
          for (const target of targets) {
            if (target && target.atlas && target.commit) {
              commits[target.atlas] = target.commit;
            }
          }
        }
        return {
          commits,
          source: body.source || 'live',
          hubAsOf: body.hubAsOf || null,
          fetchedAt: body.fetchedAt || null,
          error: body.error || null,
        };
      }
    } catch (err) {
      return { commits, source: 'none', error: err.message };
    }
    return { commits, source: 'none', error: 'Failed to read systems' };
  }

  function getSnapshotForRepo(repo, commit) {
    if (!snapshots) return null;
    try {
      if (commit && typeof snapshots.find === 'function' && typeof snapshots.graph === 'function') {
        const row = snapshots.find(repo, commit);
        if (row) {
          const g = snapshots.graph(row);
          return { graph: g, commit: row.commit, live: true };
        }
      }
      // Fallback to newest snapshot for repo
      if (typeof snapshots.list === 'function' && typeof snapshots.graph === 'function') {
        const list = snapshots.list();
        const rows = (Array.isArray(list?.snapshots) ? list.snapshots : [])
          .filter((s) => s.repo === repo)
          .sort((a, b) => String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')));
        if (rows.length > 0) {
          const row = rows[0];
          const g = snapshots.graph(row);
          return { graph: g, commit: row.commit, live: false };
        }
      }
    } catch {}
    return null;
  }

  async function check() {
    const loaded = loadContracts();
    if (loaded.error) {
      return {
        status: 200,
        body: {
          error: { code: 'contracts_load_error', message: loaded.error },
          contracts: [],
          undeclared: [],
          brokenCount: 0,
          commits: {},
        },
      };
    }

    const { commits: liveCommits, source: systemsSource, hubAsOf, fetchedAt, error: systemsError } = await getLiveCommits();

    const repoSnapshots = new Map();
    const getSnapshot = (repo) => {
      if (!mappedRepos.has(repo)) return null;
      if (repoSnapshots.has(repo)) return repoSnapshots.get(repo);
      const snap = getSnapshotForRepo(repo, liveCommits[repo]);
      repoSnapshots.set(repo, snap);
      return snap;
    };

    let brokenCount = 0;
    const evaluatedContracts = [];

    for (const entry of loaded.contracts) {
      const provider = entry.provider || {};
      const providerRepo = provider.repo;
      const providerModule = provider.module;
      const providerPath = provider.path;

      let providerState = 'not_checked';
      let providerDetail = '';
      let providerSnapshotCommit = null;
      let providerIsLive = false;

      if (!mappedRepos.has(providerRepo)) {
        providerState = 'not_checked';
        providerDetail = `${providerRepo} isn't mapped`;
      } else {
        const pSnap = getSnapshot(providerRepo);
        if (!pSnap) {
          providerState = 'not_checked';
          providerDetail = `No snapshot available for ${providerRepo}`;
        } else {
          providerSnapshotCommit = pSnap.commit;
          providerIsLive = pSnap.live;
          const pGraph = pSnap.graph;
          const routes = Array.isArray(pGraph.httpRoutes) ? pGraph.httpRoutes : [];
          const matching = routes.filter((r) => matchRoute(r.path, providerPath) || (r.match === 'prefix' && routeServes(r, providerPath)));

          if (matching.length === 0) {
            providerState = 'provider_missing';
            providerDetail = `${providerRepo} does not serve ${providerPath} at ${pSnap.commit.slice(0, 7)}`;
          } else {
            const ownerMatch = matching.find((r) => routeModule(r) === providerModule);
            if (!ownerMatch) {
              const actualOwner = routeModule(matching[0]);
              providerState = 'provider_missing';
              providerDetail = `${providerPath} owned by ${actualOwner}, not ${providerModule} at ${pSnap.commit.slice(0, 7)}`;
            } else {
              providerState = 'checked';
            }
          }
        }
      }

      if (providerState === 'provider_missing') {
        brokenCount++;
      }

      const evaluatedConsumers = [];
      const consumers = Array.isArray(entry.consumers) ? entry.consumers : [];

      for (const consumer of consumers) {
        const cRepo = consumer.repo;
        const cModule = consumer.module;
        let cState = 'not_checked';
        let cDetail = '';
        let cSnapshotCommit = null;
        let cIsLive = false;

        if (!mappedRepos.has(cRepo)) {
          cState = 'not_checked';
          cDetail = `${cRepo} isn't mapped`;
        } else {
          const cSnap = getSnapshot(cRepo);
          if (!cSnap) {
            cState = 'not_checked';
            cDetail = `No snapshot available for ${cRepo}`;
          } else {
            cSnapshotCommit = cSnap.commit;
            cIsLive = cSnap.live;
            const cGraph = cSnap.graph;
            const schemaVer = Number(cGraph.schemaVersion || 1);

            if (schemaVer < 3) {
              cState = 'not_checked';
              cDetail = `${cRepo} snapshot is schema ${schemaVer} (no outgoing calls)`;
            } else {
              const nodes = Array.isArray(cGraph.nodes) ? cGraph.nodes : [];
              const node = nodes.find((n) => n.id === cModule);

              const skipped = Array.isArray(cGraph.skipped) ? cGraph.skipped.find((s) => s && s.path === cModule) : null;
              const unscanned = node ? null : unscannedReason(cModule);

              if (!node && skipped) {
                cState = 'not_checked';
                cDetail = `${cModule} is ${skipped.reason || 'not parsed'} in ${cRepo} at ${cSnap.commit.slice(0, 7)}`;
              } else if (!node && unscanned) {
                cState = 'not_checked';
                cDetail = `${cModule}: ${unscanned} in ${cRepo} at ${cSnap.commit.slice(0, 7)}`;
              } else if (!node) {
                cState = 'consumer_missing';
                cDetail = `Module ${cModule} not found in ${cRepo} at ${cSnap.commit.slice(0, 7)}`;
              } else {
                const calls = Array.isArray(node.calls) ? node.calls : [];
                const hasCall = calls.some((c) => matchCallPath(c.path, providerPath));

                if (hasCall) {
                  cState = 'checked';
                  cDetail = 'Call found';
                } else {
                  cState = 'consumer_missing';
                  cDetail = `Declared but not found in ${cModule} at ${cSnap.commit.slice(0, 7)}`;
                }
              }
            }
          }
        }

        if (cState === 'consumer_missing') {
          brokenCount++;
        }

        evaluatedConsumers.push({
          repo: cRepo,
          module: cModule,
          state: cState,
          detail: cDetail,
          commit: cSnapshotCommit,
          live: cIsLive,
          check: CHECK[cState],
        });
      }

      // Aggregate contract-level state
      let contractState = 'checked';
      if (providerState === 'provider_missing' || evaluatedConsumers.some((c) => c.state === 'consumer_missing')) {
        contractState = 'broken';
      } else if (providerState === 'not_checked' || evaluatedConsumers.some((c) => c.state === 'not_checked')) {
        contractState = 'partially_checked';
      }

      let edgeCheck = 'confirmed';
      if (providerState === 'provider_missing') edgeCheck = 'provider missing';
      else if (evaluatedConsumers.some((c) => c.state === 'consumer_missing')) edgeCheck = 'consumer missing';
      else if (providerState === 'not_checked' || evaluatedConsumers.some((c) => c.state === 'not_checked')) edgeCheck = 'no snapshot';

      evaluatedContracts.push({
        id: entry.id,
        contract: entry.contract || null,
        label: entry.label || null,
        state: contractState,
        check: edgeCheck,
        provider: {
          ...provider,
          state: providerState,
          detail: providerDetail,
          commit: providerSnapshotCommit,
          live: providerIsLive,
        },
        consumers: evaluatedConsumers,
        source: entry.source || null,
      });
    }

    return {
      status: 200,
      body: {
        contracts: evaluatedContracts,
        undeclared: findUndeclared(loaded.contracts, getSnapshot),
        brokenCount,
        commits: liveCommits,
        systems: {
          source: systemsSource,
          hubAsOf,
          fetchedAt,
          error: systemsError,
        },
      },
    };
  }

  // Outgoing calls in each mapped repository's snapshot (schema 3 or newer) that no declared edge names for that module.
  // Left out: calls the repository serves itself, browser calls the scanner already reports as dangling, and tests.
  function findUndeclared(contracts, getSnapshot) {
    const declared = new Map();
    for (const entry of contracts) {
      const providerPath = entry?.provider?.path;
      for (const consumer of Array.isArray(entry?.consumers) ? entry.consumers : []) {
        const key = `${consumer.repo}\n${consumer.module}`;
        if (!declared.has(key)) declared.set(key, []);
        declared.get(key).push(providerPath);
      }
    }
    const out = [];
    for (const repo of mappedRepos) {
      const snap = getSnapshot(repo);
      const graph = snap?.graph;
      if (!graph || Number(graph.schemaVersion || 1) < 3) continue;
      const ownRoutes = Array.isArray(graph.httpRoutes) ? graph.httpRoutes : [];
      const dangling = new Set((Array.isArray(graph.danglingHttp) ? graph.danglingHttp : []).map((d) => `${d.source}\n${d.path}\n${d.line}`));
      for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
        if (!node || node.domain === 'Tests' || !Array.isArray(node.calls)) continue;
        const paths = declared.get(`${repo}\n${node.id}`) || [];
        for (const call of node.calls) {
          if (!call || typeof call.path !== 'string') continue;
          if (paths.some((p) => matchCallPath(call.path, p))) continue;
          if (ownRoutes.some((r) => routeServes(r, call.path))) continue;
          if (dangling.has(`${node.id}\n${call.path}\n${call.line}`)) continue;
          out.push({ repo, module: node.id, method: call.method || null, path: call.path, line: call.line ?? null });
        }
      }
    }
    return out;
  }

  return { check, loadContracts, getLiveCommits };
}

module.exports = {
  createContractsReader,
  normalizeRoutePattern,
  matchRoute,
  matchCallPath,
  CONTRACTS_PATH,
};
