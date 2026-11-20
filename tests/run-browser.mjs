// Runs every tests/*-ui.mjs browser suite against the server at LOCALAI_URL (default 127.0.0.1:3080; refused when it
// is a deployed release, see tests/browser-target.mjs), one after another, and reports all failures at the end
// instead of stopping at the first. New suites are picked up automatically.
//
//   node tests/run-browser.mjs                 every suite
//   node tests/run-browser.mjs images claude   suites whose names contain "images" or "claude"; a full name
//                                              ("home-ui.mjs") matches only that suite, not voice-home-ui.mjs
//   node tests/run-browser.mjs --shard 2/4     the second of four shares of the suites, for running workers side by
//                                              side, each against its own server (scripts/local-ci.mjs does this).
//                                              The timing-sensitive suites (SOLO_SUITES) are in no shard;
//   node tests/run-browser.mjs --solo          runs just those, best alone after the shards.
//   --list                                     prints the suites it would run, one per line, and runs none.
// Shards are split by partitionSuites (scripts/local-ci-lib.mjs): longest first by the seconds recorded in the JSON
// file LOCALAI_CI_DURATIONS names, else alphabetical round-robin. Every worker must see the same file to get the same
// split.
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShard, partitionSuites, SOLO_SUITES } from '../scripts/local-ci-lib.mjs';
import { checkBrowserTarget, DEFAULT_TARGET, suitesNeedingTarget, TARGET_CHECKED } from './browser-target.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const shardAt = argv.indexOf('--shard');
const shard = shardAt >= 0 ? parseShard(argv[shardAt + 1]) : null;
if (shardAt >= 0 && !shard) { console.error(`--shard needs i/n with 1 <= i <= n (got "${argv[shardAt + 1] ?? ''}")`); process.exit(2); }
const solo = argv.includes('--solo'), list = argv.includes('--list');
const only = argv.filter((a, i) => a !== '--solo' && a !== '--list' && (shardAt < 0 || (i !== shardAt && i !== shardAt + 1)));
const matches = (f, o) => (o.endsWith('-ui.mjs') ? f === o : f.includes(o));
let suites = readdirSync(dir).filter(f => f.endsWith('-ui.mjs') && (!only.length || only.some(o => matches(f, o)))).sort();
if (solo) suites = suites.filter(s => SOLO_SUITES.includes(s));
else if (shard) {
  let durations = {};
  if (process.env.LOCALAI_CI_DURATIONS) { try { durations = JSON.parse(readFileSync(process.env.LOCALAI_CI_DURATIONS, 'utf8')); } catch {} }
  suites = partitionSuites(suites.filter(s => !SOLO_SUITES.includes(s)), shard.count, durations)[shard.index];
}
if (list) { if (suites.length) console.log(suites.join('\n')); process.exit(0); }
// Never against the deployed appliance (tests/browser-target.mjs): checked once, before any suite runs.
// Each suite's own guard (browser-target-guard.mjs) skips the check for the URL named in TARGET_CHECKED.
const checked = {};
if (suitesNeedingTarget(suites, dir).length) {
  const base = process.env.LOCALAI_URL || DEFAULT_TARGET;
  const target = await checkBrowserTarget(base);
  if (!target.ok) { console.error(target.reason); process.exit(2); }
  if (target.warning) console.error(target.warning);
  checked[TARGET_CHECKED] = base;
}
const failed = [];
// Suites that start their own server pass this environment on. Default the Workshop display address to a dead
// loopback port so no test server ever contacts the owner's real display; a value you set yourself is kept.
const env = { ...process.env, LOCALAI_WORKSHOP_URL: process.env.LOCALAI_WORKSHOP_URL || 'http://127.0.0.1:9', ...checked };
for (const suite of suites) {
  console.log(`\n=== ${suite}`);
  const started = Date.now();
  const r = spawnSync(process.execPath, [join(dir, suite)], { stdio: 'inherit', env });
  console.log(`--- ${suite}: ${r.status === 0 ? 'passed' : 'FAILED'} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (r.status !== 0) failed.push(suite);
}
console.log(`\n${suites.length - failed.length} of ${suites.length} browser suites passed${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
