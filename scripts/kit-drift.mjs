#!/usr/bin/env node
// Prints where LocalAI's copy of the appliance-ui kit (app/public/ui) stands: a shallow clone of the kit, then its
// scripts/drift.mjs for this repo's line. Local CI runs it as a step.
// Warn-only: exits 0 whatever drift reports, until KIT_DRIFT_ENFORCE=1 makes the kit's exit 1 (modified copy, bad VERSION,
// behind across a release that needs a consumer change) fail it. Never fails for the network or tooling: no clone (60 s limit), no
// node or gh, no drift.mjs on the kit's main yet, or a drift that prints nothing prints "kit drift check unavailable: <reason>" and exits 0.
// KIT_DRIFT_URL overrides the kit's clone URL (tests point it nowhere).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAME = 'LocalAI';
const KIT_URL = process.env.KIT_DRIFT_URL || 'https://github.com/azmusgb/appliance-ui';
const have = cmd => !spawnSync(cmd, ['--version'], { stdio: 'ignore' }).error;

// Returns { text, fail }; never exits, so the caller removes the clone on every path.
function check(tmp) {
  const unavailable = reason => ({ text: `kit drift check unavailable: ${reason}`, fail: false });
  for (const cmd of ['git', 'gh']) if (!have(cmd)) return unavailable(`${cmd} not found`);
  const clone = spawnSync('git', ['clone', '--depth', '1', '-q', KIT_URL, path.join(tmp, 'kit')], { stdio: 'ignore', timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });   // a private kit never prompts
  if (clone.status !== 0) return unavailable(`could not clone ${KIT_URL}`);
  const drift = path.join(tmp, 'kit', 'scripts', 'drift.mjs');
  if (!fs.existsSync(drift)) return unavailable("scripts/drift.mjs is not on the kit's main yet");
  const r = spawnSync(process.execPath, [drift, '--only', NAME], { encoding: 'utf8', timeout: 120000 });
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status !== 0 && r.status !== 1) return unavailable(`drift.mjs exited ${r.status ?? r.signal}: ${text.split('\n')[0]}`);
  if (!text) return unavailable('drift printed nothing');
  return { text, fail: r.status === 1 && process.env.KIT_DRIFT_ENFORCE === '1' };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-drift-'));
let result;
try { result = check(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(result.text);
if (result.fail) process.exitCode = 1;
