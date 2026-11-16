'use strict';

// Local AI System Atlas native web integration.
// The browser talks only to Local AI. This facade keeps Atlas Intelligence on
// loopback, exposes the deterministic graph even when the Python service is
// unavailable, and preserves upstream HTTP status for evidence-bounded errors.
const fs = require('node:fs');
const path = require('node:path');
const { createSystems } = require('./atlas-systems');
const { createContractsReader } = require('./atlas-contracts');

const DEFAULT_ATLAS_URL = 'http://127.0.0.1:8765';
const MAX_BODY = 64 * 1024;
// quick_arch.py writes the graph into its own folder; the container mounts that folder (a file mount would never see
// a rebuild, which replaces the file). Outside the container, the repo's copy.
const GRAPH_PATH = [
  process.env.LOCALAI_ATLAS_GRAPH,
  '/atlas-graph/system-atlas.html',
  path.resolve(__dirname, '..', '..', '.atlas', 'graph', 'system-atlas.html'),
].find((p) => p && fs.existsSync(path.dirname(p))) || '/atlas-graph/system-atlas.html';
// The container reaches the host's service by this name; it is the host, not some other machine.
const HOST_GATEWAY = 'host.docker.internal';
// Snapshots (platform baseline 6.4): quick_arch.py --repo/--git-dir/--commit writes <repo>/<commit>/graph.json and
// index.json here. The container mounts the folder read-only.
const SNAPSHOTS_PATH = [
  process.env.LOCALAI_ATLAS_SNAPSHOTS,
  '/atlas-snapshots',
  path.resolve(__dirname, '..', '..', '.atlas', 'snapshots'),
].find((p) => p && fs.existsSync(p)) || '/atlas-snapshots';
// Only these repositories are served, whatever the folder holds (plan decision 2: the core three first, then the smart display).
const DEFAULT_REPOS = ['localai', 'pi-hub', 'print-lab', 'bambuhelper-smart-display'];
const COMMIT = /^[0-9a-f]{7,40}$/;
// These answer about the latest scan, or with repo and commit about one snapshot.
const SCOPED = new Set(['/api/atlas/summary', '/api/atlas/findings', '/api/atlas/node', '/api/atlas/ask', '/api/atlas/goose']);

function normalizeAtlasBaseUrl(value, { allowRemote = false } = {}) {
  const raw = String(value || DEFAULT_ATLAS_URL).trim();
  let parsed;
  try { parsed = new URL(raw); } catch {
    throw new Error(`Invalid Atlas Intelligence URL: ${raw}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Atlas Intelligence URL must use HTTP or HTTPS.');
  const host = parsed.hostname.toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]' || host === HOST_GATEWAY;
  if (!loopback && !allowRemote) {
    throw new Error('Atlas Intelligence must remain on loopback unless LOCALAI_ATLAS_ALLOW_REMOTE=1 is set.');
  }
  return parsed.origin;
}

function extractAtlasGraph(html) {
  const marker = 'const DATA = ';
  const markerAt = String(html).indexOf(marker);
  if (markerAt < 0) throw new Error('system-atlas.html does not contain its DATA graph.');
  let start = markerAt + marker.length;
  while (/\s/.test(html[start] || '')) start += 1;
  if (html[start] !== '{') throw new Error('Atlas DATA graph does not begin with an object.');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const parsed = JSON.parse(html.slice(start, i + 1));
        if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
          throw new Error('Atlas DATA graph is missing nodes or edges.');
        }
        return parsed;
      }
    }
  }
  throw new Error('Atlas DATA graph is unterminated.');
}

function createGraphReader(graphPath = GRAPH_PATH) {
  let cache = null;
  let cachedMtime = -1;
  // A graph that can't be read or parsed (mid-rebuild, or a generator crash) keeps the last good copy, marked stale;
  // only a graph never read is an error.
  return function readGraph() {
    try {
      const stat = fs.statSync(graphPath);
      if (cache && stat.mtimeMs === cachedMtime) return cache;
      const html = fs.readFileSync(graphPath, 'utf8');
      cache = extractAtlasGraph(html);
      cachedMtime = stat.mtimeMs;
      return cache;
    } catch (error) {
      if (cache) return { ...cache, stale: true, staleReason: String(error?.message || error).slice(0, 200) };
      throw error;
    }
  };
}

// The snapshot index and one snapshot's graph, each re-read only when its file changes. Nothing outside
// <dir>/<allowed repo>/<full commit from the index>/graph.json is ever opened.
function createSnapshotReader(dir = SNAPSHOTS_PATH, repos = DEFAULT_REPOS) {
  const allowed = new Set(repos);
  let index = null;
  let indexMtime = -1;
  const graphs = new Map();

  function rows() {
    const file = path.join(dir, 'index.json');
    let stat;
    try { stat = fs.statSync(file); } catch { index = null; indexMtime = -1; return []; }
    if (!index || stat.mtimeMs !== indexMtime) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      index = (Array.isArray(parsed?.snapshots) ? parsed.snapshots : [])
        .filter((r) => r && allowed.has(r.repo) && typeof r.commit === 'string' && /^[0-9a-f]{40}$/.test(r.commit));
      indexMtime = stat.mtimeMs;
    }
    return index;
  }

  function list() {
    const snapshots = rows().slice().sort((a, b) => String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')));
    return { repos: [...allowed], snapshots };
  }

  // A full or abbreviated commit, matched against the index; an abbreviation must match exactly one snapshot.
  function find(repo, commit) {
    if (!allowed.has(repo)) return { error: 'atlas_repo_unknown', message: `No snapshots are kept for ${repo}.` };
    if (!COMMIT.test(commit)) return { error: 'atlas_commit_invalid', message: 'A commit is 7-40 hexadecimal characters.' };
    const matches = rows().filter((r) => r.repo === repo && r.commit.startsWith(commit));
    if (matches.length === 1) return { row: matches[0] };
    if (matches.length > 1) return { error: 'atlas_commit_ambiguous', message: 'That abbreviation matches more than one snapshot.' };
    return { error: 'atlas_snapshot_missing', message: `There is no snapshot of ${repo} at ${commit}.` };
  }

  function graph(row) {
    const file = path.join(dir, row.repo, row.commit, 'graph.json');
    const stat = fs.statSync(file);
    const hit = graphs.get(file);
    if (hit && hit.mtime === stat.mtimeMs) return hit.graph;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      throw new Error('The snapshot graph is missing nodes or edges.');
    }
    graphs.set(file, { mtime: stat.mtimeMs, graph: parsed });
    if (graphs.size > 20) graphs.delete(graphs.keys().next().value);
    return parsed;
  }

  return { list, find, graph };
}

function createAtlas(ctx = {}) {
  const { json, readBody, fetchWithTimeout } = ctx;
  if (typeof json !== 'function' || typeof readBody !== 'function' || typeof fetchWithTimeout !== 'function') {
    throw new TypeError('createAtlas requires json, readBody and fetchWithTimeout.');
  }

  const atlasUrl = normalizeAtlasBaseUrl(
    ctx.atlasUrl || process.env.LOCALAI_ATLAS_URL || DEFAULT_ATLAS_URL,
    { allowRemote: ctx.allowRemote === true || process.env.LOCALAI_ATLAS_ALLOW_REMOTE === '1' }
  );
  const readGraph = createGraphReader(ctx.graphPath || GRAPH_PATH);
  const repos = String(ctx.repos ?? process.env.LOCALAI_ATLAS_REPOS ?? '').split(',').map((r) => r.trim()).filter(Boolean);
  const snapshots = createSnapshotReader(ctx.snapshotsPath || SNAPSHOTS_PATH, repos.length ? repos : DEFAULT_REPOS);
  const atlasToken = String(ctx.atlasToken ?? process.env.LOCALAI_ATLAS_TOKEN ?? '').trim();
  // What runs where, from Pi Hub (Atlas redesign PR 4), with each repository's newest snapshot.
  const systems = createSystems({ hubUrl: ctx.hubUrl, fetchWithTimeout, snapshots, cachePath: ctx.systemsCache || null });
  const contractsReader = createContractsReader({
    contractsPath: ctx.contractsPath,
    snapshots,
    systems,
    repos: repos.length ? repos : DEFAULT_REPOS
  });

  const upstream = new Map([
    ['/api/atlas/health', '/health'],
    ['/api/atlas/summary', '/api/atlas/summary'],
    ['/api/atlas/findings', '/api/atlas/findings'],
    ['/api/atlas/node', '/api/atlas/node'],
    ['/api/atlas/ask', '/api/atlas/ask'],
    ['/api/atlas/goose', '/api/atlas/goose'],
    ['/api/atlas/snapshot', '/api/atlas/snapshot']
  ]);

  function shape(graph) {
    return {
      // Scanner v2 (Atlas redesign PR 1): a page tells an older snapshot by its version and lists calls nothing serves.
      schemaVersion: graph.schemaVersion || 1,
      danglingHttp: Array.isArray(graph.danglingHttp) ? graph.danglingHttp : null,
      generatedAt: graph.generatedAt || null,
      stats: graph.stats || {},
      domains: graph.domains || [],
      nodes: graph.nodes,
      edges: graph.edges,
      changedNodes: graph.changedNodes || [],
      highestRisk: graph.highestRisk || [],
      stale: graph.stale === true,
      staleReason: graph.staleReason || null,
      snapshot: graph.snapshot || null,
      // Files the scanner listed but did not parse (the smart display's firmware): [{ path, reason }], only when present.
      ...(Array.isArray(graph.skipped) ? { skipped: graph.skipped } : {})
    };
  }

  function graphResponse() {
    return shape(readGraph());
  }

  function notFound(res, found) {
    const status = found.error === 'atlas_snapshot_missing' || found.error === 'atlas_repo_unknown' ? 404 : 400;
    return json(res, status, { error: { code: found.error, message: found.message } });
  }

  function snapshotGraph(res, repo, commit) {
    const found = snapshots.find(repo, commit);
    if (found.error) return notFound(res, found);
    try {
      return json(res, 200, shape(snapshots.graph(found.row)));
    } catch (error) {
      return json(res, 503, {
        error: {
          code: 'atlas_snapshot_unavailable',
          message: 'That snapshot could not be read.',
          detail: String(error?.message || error).slice(0, 300)
        }
      });
    }
  }

  async function proxy(req, res, localPath) {
    const targetPath = upstream.get(localPath);
    if (!targetPath) return json(res, 404, { error: { code: 'atlas_route_not_found', message: 'Atlas route not found.' } });

    const requestUrl = new URL(req.url || localPath, 'http://localai.invalid');
    const params = req.method === 'GET' ? requestUrl.searchParams : new URLSearchParams();
    let body = null;
    if (req.method === 'POST') {
      const raw = await readBody(req, MAX_BODY);
      body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    }
    // Plan PR 5: intelligence about one snapshot. The repository and commit are matched against the snapshot list,
    // as for its graph, and only the listed repository and full commit go on to the service.
    let scoped = false;
    if (SCOPED.has(localPath)) {
      const given = body || Object.fromEntries(params);
      const repo = String(given.repo || '').trim().toLowerCase();
      const commit = String(given.commit || '').trim().toLowerCase();
      if (repo || commit) {
        if (!repo || !commit) {
          return json(res, 400, { error: { code: 'atlas_snapshot_query', message: 'Give both repo and commit, or neither.' } });
        }
        const found = snapshots.find(repo, commit);
        if (found.error) return notFound(res, found);
        if (body) body = { ...body, repo: found.row.repo, commit: found.row.commit };
        else { params.set('repo', found.row.repo); params.set('commit', found.row.commit); }
        scoped = true;
      } else if (body) {
        delete body.repo; delete body.commit;
      } else {
        params.delete('repo'); params.delete('commit');
      }
    }
    const search = params.toString();
    const query = search ? `?${search}` : '';
    const isAsk = localPath === '/api/atlas/ask';
    // A snapshot's first question makes a clean copy of its commit, which can take longer than a cached answer.
    const timeoutMs = isAsk ? 315000 : scoped ? 60000 : 10000;

    const options = {
      method: req.method,
      headers: { Accept: 'application/json' }
    };
    // The service accepts POSTs only with this secret (ATLAS_TOKEN there), so nothing but this proxy can start a run.
    if (atlasToken) options.headers['X-Atlas-Token'] = atlasToken;
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetchWithTimeout(`${atlasUrl}${targetPath}${query}`, options, timeoutMs);
    } catch (error) {
      return json(res, 502, {
        error: {
          code: 'atlas_unavailable',
          message: 'Atlas Intelligence is unavailable.',
          detail: String(error?.message || error).slice(0, 300)
        }
      });
    }

    const raw = await response.text();
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = {
        error: {
          code: 'atlas_invalid_response',
          message: 'Atlas Intelligence returned a non-JSON response.',
          detail: raw.slice(0, 300)
        }
      };
    }
    return json(res, response.status, payload);
  }

  async function apiAtlas(req, res, p) {
    if (req.method === 'GET' && p === '/api/atlas/snapshots') {
      try {
        return json(res, 200, snapshots.list());
      } catch (error) {
        return json(res, 503, {
          error: {
            code: 'atlas_snapshots_unavailable',
            message: 'The snapshot list could not be read.',
            detail: String(error?.message || error).slice(0, 300)
          }
        });
      }
    }
    if (req.method === 'GET' && p === '/api/atlas/systems') {
      const { status, body } = await systems.read();
      return json(res, status, body);
    }
    if (req.method === 'GET' && p === '/api/atlas/contracts') {
      const { status, body } = await contractsReader.check();
      return json(res, status, body);
    }
    if (req.method === 'GET' && p === '/api/atlas/graph') {
      const query = new URL(req.url || p, 'http://localai.invalid').searchParams;
      const repo = (query.get('repo') || '').trim().toLowerCase();
      const commit = (query.get('commit') || '').trim().toLowerCase();
      if (repo || commit) {
        if (!repo || !commit) {
          return json(res, 400, { error: { code: 'atlas_snapshot_query', message: 'Give both repo and commit, or neither.' } });
        }
        return snapshotGraph(res, repo, commit);
      }
      try {
        return json(res, 200, graphResponse());
      } catch (error) {
        return json(res, 503, {
          error: {
            code: 'atlas_graph_unavailable',
            message: 'System Atlas graph is unavailable.',
            detail: String(error?.message || error).slice(0, 300)
          }
        });
      }
    }
    if (!upstream.has(p)) return json(res, 404, { error: { code: 'atlas_route_not_found', message: 'Atlas route not found.' } });
    if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
    if (req.method === 'POST' && !['/api/atlas/ask', '/api/atlas/goose', '/api/atlas/snapshot'].includes(p)) {
      return json(res, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
    }
    if (req.method === 'GET' && ['/api/atlas/ask', '/api/atlas/goose'].includes(p)) {
      return json(res, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
    }
    return proxy(req, res, p);
  }

  // A snapshot request from inside the app (the release trigger, app/atlas-releases.js): the same service call as the
  // page's "Snapshot now", with the same token. Resolves { ok, status }; never throws.
  async function requestSnapshot(repo, ref) {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (atlasToken) headers['X-Atlas-Token'] = atlasToken;
    try {
      const r = await fetchWithTimeout(`${atlasUrl}/api/atlas/snapshot`, { method: 'POST', headers, body: JSON.stringify({ repo, ref }) }, 10000);
      return { ok: r.status >= 200 && r.status < 300, status: r.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  return { apiAtlas, atlasUrl, graphResponse, requestSnapshot, snapshots };
}

module.exports = { createAtlas, createSnapshotReader, extractAtlasGraph, normalizeAtlasBaseUrl };
