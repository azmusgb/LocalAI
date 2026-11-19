// Keeps the browser suites off the deployed appliance. The suites write to the server they test (Claude board findings
// and sessions, chats, settings), and most default LOCALAI_URL to 127.0.0.1:3080, which on the Windows host is the live
// appliance. tests/run-browser.mjs asks the target's /healthz first: a deployed release reports the releaseCommit from
// the release.json the deploy writes (app/release.js); a server started from a checkout reports null. A target that is
// a release, or that can't be read, is refused. Suites run directly make the same check (browser-target-guard.mjs). Only LOCALAI_TESTS_WRITE_TO_PRODUCTION=1 lets a release through.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PRODUCTION_OVERRIDE = 'LOCALAI_TESTS_WRITE_TO_PRODUCTION';
// Set by run-browser.mjs to the URL it checked, so browser-target-guard.mjs in each suite doesn't ask again.
export const TARGET_CHECKED = 'LOCALAI_TARGET_CHECKED';
export const DEFAULT_TARGET = 'http://127.0.0.1:3080';
const START_ONE = 'Start a throwaway server from this checkout (docs/DEVELOPMENT.md, Browser tests) and set LOCALAI_URL to it.';

// { ok: true } | { ok: true, warning } (override) | { ok: false, reason }
export async function checkBrowserTarget(base, { fetch = globalThis.fetch, env = process.env, timeoutMs = 5000 } = {}) {
  const url = `${String(base).replace(/\/+$/, '')}/healthz`;
  let status, text;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    status = res.status;
    text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${status}`);
  } catch (e) {
    return { ok: false, reason: `Refusing to run browser suites: could not read ${url} (${[e?.message || e, e?.cause?.code || e?.cause?.message].filter(Boolean).join(': ')}), so it is not known to be a throwaway server. ${START_ONE}` };
  }
  let health;
  try { health = JSON.parse(text); } catch { health = undefined; }
  if (!health || typeof health !== 'object') return { ok: false, reason: `Refusing to run browser suites: ${url} answered HTTP ${status} but not JSON. ${START_ONE}` };
  if (health.appliance !== 'Local AI') return { ok: false, reason: `Refusing to run browser suites: ${url} is not Local AI. ${START_ONE}` };
  if (!('releaseCommit' in health)) return { ok: false, reason: `Refusing to run browser suites: ${url} does not report releaseCommit, so it cannot be told apart from a deployed release. ${START_ONE}` };
  if (health.releaseCommit === null) return { ok: true };
  const what = `${url} is a deployed release (releaseCommit ${String(health.releaseCommit).slice(0, 12)}); the suites would write test data to it`;
  if (env[PRODUCTION_OVERRIDE] === '1') return { ok: true, warning: `WARNING: ${what}. Running anyway because ${PRODUCTION_OVERRIDE}=1.` };
  return { ok: false, reason: `Refusing to run browser suites: ${what}. ${START_ONE} To write to it on purpose, set ${PRODUCTION_OVERRIDE}=1.` };
}

// The suites that use LOCALAI_URL. The others start their own server and need no target.
export function suitesNeedingTarget(suites, dir) {
  return suites.filter(s => readFileSync(join(dir, s), 'utf8').includes('LOCALAI_URL'));
}
