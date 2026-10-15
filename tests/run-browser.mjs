// Runs every tests/*-ui.mjs browser suite against the server at LOCALAI_URL (default 127.0.0.1:3080), one after
// another, and reports all failures at the end instead of stopping at the first. New suites are picked up
// automatically.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const suites = readdirSync(dir).filter(f => f.endsWith('-ui.mjs') && (!only.length || only.some(o => f.includes(o)))).sort();
const failed = [];
for (const suite of suites) {
  console.log(`\n=== ${suite}`);
  const started = Date.now();
  const r = spawnSync(process.execPath, [join(dir, suite)], { stdio: 'inherit', env: process.env });
  console.log(`--- ${suite}: ${r.status === 0 ? 'passed' : 'FAILED'} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (r.status !== 0) failed.push(suite);
}
console.log(`\n${suites.length - failed.length} of ${suites.length} browser suites passed${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
