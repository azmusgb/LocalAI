'use strict';

// What runs where (Atlas redesign spec, PR 4; decision 2). Pi Hub keeps the one list of hosts, with the states of their
// services and deploy targets from its records (GET /api/systems, a machine path over plain http). This reads it, adds
// each repository's newest Atlas snapshot, and keeps the last good copy in DATA_DIR, so the Systems strip still draws,
// marked with that copy's age, when the Pi can't be reached. Read only towards Pi Hub; never throws.
const fs = require('node:fs');
const path = require('node:path');

const REPO_LABELS = { localai: 'Local AI', 'pi-hub': 'Pi Hub', 'print-lab': 'Print lab', 'bambuhelper-smart-display': 'Smart display' };
const HEX40 = /^[0-9a-f]{40}$/;
const ID = /^[a-z0-9_-]{1,40}$/;
const TIMEOUT_MS = 6000;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const id = (v) => (typeof v === 'string' && ID.test(v) ? v : null);

// Only the fields the strip shows, each bounded: a host list from the network is data, never trusted as is.
function clean(body, repos) {
  if (!body || !Array.isArray(body.hosts)) return null;
  const hosts = body.hosts.filter((h) => h && id(h.id)).slice(0, 12).map((h) => ({
    id: h.id, label: str(h.label, 80), runs: str(h.runs, 80),
    services: (Array.isArray(h.services) ? h.services : []).filter((s) => s && id(s.id)).slice(0, 40).map((s) => ({
      id: s.id, label: str(s.label, 80), state: id(s.state) || 'unknown', severity: id(s.severity) || 'attention',
      headline: str(s.headline, 200), stale: s.stale === true,
    })),
    targets: (Array.isArray(h.targets) ? h.targets : []).filter((t) => t && id(t.id)).slice(0, 20).map((t) => {
      const commit = String(t.commit || '').toLowerCase();
      return {
        id: t.id, label: str(t.label, 80), repo: str(t.repo, 120) || null, atlas: repos.has(t.atlas) ? t.atlas : null,
        state: id(t.state) || 'unknown', commit: HEX40.test(commit) ? commit : null,
        deployedAt: str(t.deployed_at, 40) || null, version: str(t.version, 40) || null,
      };
    }),
  }));
  const asOf = typeof body.as_of === 'number' ? body.as_of : NaN;
  const date = new Date(asOf * 1000);
  return { hosts, hubAsOf: asOf > 0 && Number.isFinite(date.getTime()) ? date.toISOString() : null };
}

// How the newest map compares with the running release. Commit ancestry needs git, and the runner's mirror lives on the
// host (the container reads only index.json), so this never says `ahead` (a newer map) and `behind` stays null unless a
// snapshot row carries a positive integer `behind`. Without ancestry: the same commit is current; any other commit is
// `behind` (the page words it neutrally as a different commit). No time comparison: the runner scans any ref, and the
// hub's and the PC's clocks differ.
function freshness(target, newest, nowMs) {
  const live = target.commit || null;
  const scanned = newest?.commit || null;
  const at = Date.parse(newest?.generatedAt);
  const scanAgeSeconds = Number.isFinite(at) ? Math.max(0, Math.round((nowMs - at) / 1000)) : null;
  const known = Number(newest?.behind);
  let state = 'behind';
  if (!newest) state = 'no snapshot';
  else if (!live) state = 'no release';
  else if (scanned === live) state = 'current';
  return { live, scanned, behind: state === 'behind' && Number.isInteger(known) && known > 0 ? known : null, scanAgeSeconds, state };
}

// Each host's repositories that Atlas keeps: the newest snapshot, whether one exists at the commit that is live, and how
// fresh the map is against the release.
function withSnapshots(hosts, list, nowMs = Date.now()) {
  const rows = (Array.isArray(list?.snapshots) ? list.snapshots : []).slice()
    .sort((a, b) => String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')));
  return hosts.map((h) => {
    const repos = [];
    for (const t of h.targets) {
      if (!t.atlas || repos.some((r) => r.repo === t.atlas)) continue;
      const mine = rows.filter((r) => r.repo === t.atlas);
      const newest = mine[0];
      repos.push({ repo: t.atlas, label: REPO_LABELS[t.atlas] || t.atlas, liveCommit: t.commit,
        snapshot: newest ? { commit: newest.commit, generatedAt: newest.generatedAt || null } : null,
        atLive: !!t.commit && mine.some((r) => r.commit === t.commit), freshness: freshness(t, newest, nowMs) });
    }
    return { ...h, repos };
  });
}

function createSystems({ hubUrl = process.env.LOCALAI_PI_HUB_URL || 'http://10.0.0.80', fetchWithTimeout, snapshots,
  cachePath = null, now = Date.now } = {}) {
  const off = !hubUrl || hubUrl === 'off';
  let memory = null;

  function readCopy() {
    if (memory) return memory;
    if (!cachePath) return null;
    try {
      const saved = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (saved && Array.isArray(saved.hosts) && saved.fetchedAt) memory = saved;
    } catch {}
    return memory;
  }

  function keep(copy) {
    memory = copy;
    if (!cachePath) return;
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      const tmp = `${cachePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(copy));
      fs.renameSync(tmp, cachePath);
    } catch {}
  }

  async function fetchHub() {
    if (off) return { error: 'Pi Hub is not configured on this appliance (LOCALAI_PI_HUB_URL).' };
    try {
      const r = await fetchWithTimeout(new URL('/api/systems', hubUrl).toString(), { headers: { Accept: 'application/json' } }, TIMEOUT_MS);
      if (!r.ok) return { error: `Pi Hub answered ${r.status}.` };
      const repos = new Set(snapshotList().repos || []);
      const shaped = clean(await r.json(), repos);
      return shaped ? { shaped } : { error: "Pi Hub's answer was not a list of hosts." };
    } catch (error) {
      return { error: `Pi Hub could not be reached (${String(error?.message || error).slice(0, 120)}).` };
    }
  }

  function snapshotList() {
    try { return snapshots?.list?.() || {}; } catch { return {}; }
  }

  // { status, body }: the live list, else the last good copy with why, else what failed.
  async function read() {
    const got = await fetchHub();
    let copy = null, source = 'live', error = null;
    if (got.shaped) {
      copy = { ...got.shaped, fetchedAt: new Date(now()).toISOString() };
      keep(copy);
    } else {
      copy = readCopy();
      source = 'cache';
      error = got.error;
    }
    if (!copy) return { status: 503, body: { error: { code: 'atlas_systems_unavailable', message: got.error } } };
    return { status: 200, body: { source, error, fetchedAt: copy.fetchedAt, hubAsOf: copy.hubAsOf || null,
      hosts: withSnapshots(copy.hosts, snapshotList(), now()) } };
  }

  return { read };
}

module.exports = { createSystems };
