'use strict';

// scripts/kit-drift.mjs prints the kit copy's drift line, or "unavailable", and fails only when KIT_DRIFT_ENFORCE=1.
// A fake `git` first on PATH "clones" a kit whose scripts/drift.mjs prints a stub line and exits as asked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../scripts/kit-drift.mjs');
const LINE = 'LocalAI\tbehind\t2.7.0 is behind 2.10.0 (stub)';

function run({ env = {}, driftExit = null, fakeGit = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-drift-test-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const full = { ...process.env, KIT_DRIFT_ENFORCE: '' };
  if (fakeGit) {
    const fake = path.join(bin, 'git');
    // git --version must still work; a clone makes the destination (the last argument) with or without drift.mjs.
    const drift = driftExit === null ? '' :
      `printf "console.log(%s);process.exit(%s)\\n" "'$KIT_STUB_LINE'" "$KIT_STUB_EXIT" > "\${dest}/scripts/drift.mjs"`;
    fs.writeFileSync(fake, `#!/bin/bash\n[ "$1" = clone ] || exit 0\ndest="\${@: -1}"\nmkdir -p "$dest/scripts"\n${drift}\n`, { mode: 0o755 });
    Object.assign(full, { PATH: bin + path.delimiter + process.env.PATH, KIT_STUB_LINE: LINE.replace(/\t/g, '\\t'), KIT_STUB_EXIT: String(driftExit ?? 0) });
  }
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...full, ...env } });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

test('an unreachable kit prints unavailable and passes', () => {
  const r = run({ env: { KIT_DRIFT_URL: '/nonexistent/appliance-ui', KIT_DRIFT_ENFORCE: '1' }, fakeGit: false });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^kit drift check unavailable: could not clone/);
});

test('a kit without drift.mjs prints unavailable and passes', () => {
  const r = run({ env: { KIT_DRIFT_ENFORCE: '1' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /unavailable: scripts\/drift\.mjs is not on the kit's main yet/);
});

test('a clean line is printed and passes', () => {
  const r = run({ driftExit: 0 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes(LINE), r.stdout);
});

test('a drift failure only warns by default', () => {
  const r = run({ driftExit: 1 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes(LINE), r.stdout);
});

test('KIT_DRIFT_ENFORCE=1 turns a drift failure into a failure', () => {
  const r = run({ driftExit: 1, env: { KIT_DRIFT_ENFORCE: '1' } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(r.stdout.includes(LINE), r.stdout);
});
