'use strict';
// Atlas on release records (platform baseline 6.4, migration step 10; plan docs/superpowers/plans/2026-11-01-atlas-
// every-repo.md, PR 6). Every few minutes while the PC is awake, read Pi Hub's release:<target> records and ask Atlas
// for a snapshot of any live commit it hasn't got. The first read after the PC wakes catches up, since it compares
// against the snapshot index rather than remembering what it saw. Read only towards Pi Hub; never throws.

// release target -> the repository its commit belongs to. Targets whose repository Atlas doesn't keep are skipped.
const TARGET_REPO = { 'pi-hub': 'pi-hub', localai: 'localai', 'mac-watch': 'localai', 'print-lab': 'print-lab' };
const EVERY_MS = 5 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000; // a commit asked for and still missing is asked for again after this long
const HEX40 = /^[0-9a-f]{40}$/;

// The commits Pi Hub's records say are deployed, one per (repo, commit), in record order.
function liveCommits(body, repos) {
  const out = [], seen = new Set();
  for (const r of Array.isArray(body?.records) ? body.records : []) {
    const target = typeof r?.id === 'string' && r.id.startsWith('release:') ? r.id.slice(8) : null;
    const repo = TARGET_REPO[target];
    const commit = String(r?.detail?.commit || '').toLowerCase();
    if (!repo || !repos.has(repo) || !HEX40.test(commit) || seen.has(`${repo}@${commit}`)) continue;
    seen.add(`${repo}@${commit}`);
    out.push({ target, repo, commit });
  }
  return out;
}

function createAtlasReleaseTrigger({ hubUrl = process.env.LOCALAI_PI_HUB_URL || 'http://10.0.0.80', fetchImpl = fetch,
  snapshots, requestSnapshot, now = Date.now, log = () => {}, timeoutMs = 10000 } = {}) {
  const off = !hubUrl || hubUrl === 'off' || typeof requestSnapshot !== 'function' || !snapshots;
  const asked = new Map(); // `${repo}@${commit}` -> when it was asked for
  let running = false;

  // One pass: returns what it asked for, for tests and the log.
  async function tick() {
    if (off || running) return [];
    running = true;
    try {
      let body;
      try {
        const r = await fetchImpl(new URL('/api/records', hubUrl), { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
        if (!r.ok) return [];
        body = await r.json();
      } catch { return []; }
      const { repos, snapshots: have } = snapshots.list();
      const kept = new Set(have.map((s) => `${s.repo}@${s.commit}`));
      const t = now(), requested = [];
      for (const { repo, commit } of liveCommits(body, new Set(repos))) {
        const key = `${repo}@${commit}`;
        if (kept.has(key)) { asked.delete(key); continue; }
        if (t - (asked.get(key) ?? -Infinity) < RETRY_MS) continue;
        const res = await requestSnapshot(repo, commit);
        if (res?.ok) { asked.set(key, t); requested.push(key); log(`Atlas: snapshot of ${repo} at ${commit.slice(0, 7)} asked for (a live release)`); }
        else if (res?.status === 429) break; // its queue is full; the next pass tries again
      }
      return requested;
    } catch {
      return [];
    } finally {
      running = false;
    }
  }

  function start(every = EVERY_MS) {
    if (off) return null;
    const timer = setInterval(() => { tick().catch(() => {}); }, every);
    timer.unref?.();
    setTimeout(() => { tick().catch(() => {}); }, 30 * 1000).unref?.(); // soon after a start, too
    return timer;
  }

  return { tick, start };
}

module.exports = { createAtlasReleaseTrigger, liveCommits, TARGET_REPO };
