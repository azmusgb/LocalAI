'use strict';

// Joins atlas/contracts.json with snapshot graphs and live release commits from Pi Hub (GET /api/systems).
// Computes cross-repo contract edge states:
// - checked: provider serves route in module; consumer calls route in module
// - provider_missing: provider has no such route or owned by different module
// - consumer_missing: consumer module has no call to that route
// - not_checked: unmapped repo, schema < 3 (no outgoing calls), or no snapshot
const fs = require('node:fs');
const path = require('node:path');

const CONTRACTS_PATH = path.resolve(__dirname, '..', '..', 'atlas', 'contracts.json');

function normalizeRoutePattern(routePath) {
  if (!routePath) return '';
  // Convert {param} placeholders into wildcard regex segment
  const escaped = routePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regexStr = '^' + escaped.replace(/\\\{[a-zA-Z0-9_]+\\\}/g, '[^/]+') + '$';
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
  if (declaredPath.includes('{')) {
    const rx = normalizeRoutePattern(declaredPath);
    if (rx.test(callPath)) return true;
  }
  // If call path is a prefix or base of declared path without params (e.g. /api/releases vs /api/releases/{target})
  const baseDeclared = declaredPath.replace(/\/\{[a-zA-Z0-9_]+\}.*$/, '');
  if (baseDeclared && (callPath === baseDeclared || callPath.startsWith(baseDeclared + '/'))) {
    return true;
  }
  return false;
}

function createContractsReader(options = {}) {
  const contractsPath = options.contractsPath || CONTRACTS_PATH;
  const snapshots = options.snapshots;
  const systems = options.systems;
  const mappedRepos = new Set(options.repos || ['localai', 'pi-hub', 'print-lab']);

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
      const providerMethod = (provider.method || 'GET').toUpperCase();

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
          const matching = routes.filter((r) => matchRoute(r.path, providerPath));

          if (matching.length === 0) {
            providerState = 'provider_missing';
            providerDetail = `${providerRepo} does not serve ${providerPath} at ${pSnap.commit.slice(0, 7)}`;
          } else {
            const ownerMatch = matching.find((r) => r.owner === providerModule);
            if (!ownerMatch) {
              const actualOwner = matching[0].owner;
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

              if (!node) {
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
        });
      }

      // Aggregate contract-level state
      let contractState = 'checked';
      if (providerState === 'provider_missing' || evaluatedConsumers.some((c) => c.state === 'consumer_missing')) {
        contractState = 'broken';
      } else if (providerState === 'not_checked' || evaluatedConsumers.some((c) => c.state === 'not_checked')) {
        contractState = 'partially_checked';
      }

      evaluatedContracts.push({
        id: entry.id,
        contract: entry.contract || null,
        label: entry.label || null,
        state: contractState,
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

  return { check, loadContracts, getLiveCommits };
}

module.exports = {
  createContractsReader,
  normalizeRoutePattern,
  matchRoute,
  matchCallPath,
  CONTRACTS_PATH,
};
