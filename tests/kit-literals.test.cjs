'use strict';
// Pi Hub A22 1.5 (step 13, L3): the kit's literals check (app/public/ui/literals.mjs) holds app/public to
// .kit-literals-baseline.json. A colour, size, spacing, radius, shadow, duration, layer or private name written by hand
// may not be added; one that is removed lowers the baseline in the same PR
// (`node app/public/ui/literals.mjs app/public --write-baseline`). Local CI runs the check as its own step too.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const check = (cwd, ...args) => spawnSync(process.execPath, ['app/public/ui/literals.mjs', 'app/public', ...args], { cwd, encoding: 'utf8' });
// A copy of what the check reads, so a test can change a file without touching the checkout.
function copy(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-literals-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(ROOT, 'app/public'), path.join(dir, 'app/public'), { recursive: true });
  for (const f of ['.kit-literals-baseline.json', '.kit-literals-allow.json']) fs.cpSync(path.join(ROOT, f), path.join(dir, f));
  return dir;
}

test('app/public matches the literals baseline', () => {
  const r = check(ROOT);
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('adding one hex colour to the stylesheet fails the check, and names the file and the category', t => {
  const dir = copy(t);
  assert.equal(check(dir).status, 0);
  fs.appendFileSync(path.join(dir, 'app/public/app.css'), '\n.scratch { color: #ff0000; }\n');
  const r = check(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^app\/public\/app\.css: colour \d+, the baseline says \d+\. Use the kit's value instead/);
});

test('a new stylesheet starts at zero', t => {
  const dir = copy(t);
  fs.appendFileSync(path.join(dir, 'app/public/new-page.css'), '.n { margin: 4px; }\n');
  const r = check(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /app\/public\/new-page\.css: space 1, the baseline says 0: a new file starts at zero/);
});

// The names are per-instance (plan decision 5): the Claude board's heat cell (--heat is set per cell by ui.js, --sev per
// severity) and Atlas's risk band (--band per row, from the --atlas-* scale, which mixes kit colours the kit has no step for).
test('the allow list is Agent World\'s and Main Street\'s canvas art, and the four per-instance names', () => {
  const allow = JSON.parse(fs.readFileSync(path.join(ROOT, '.kit-literals-allow.json'), 'utf8'));
  assert.deepEqual(allow.files, ['app/public/street/**', 'app/public/aw/**']);
  assert.deepEqual(allow.names, ['--sev', '--heat', '--band', '--atlas-*']);
});

test('local CI runs the check as a step beside Kit drift', () => {
  const ci = fs.readFileSync(path.join(ROOT, 'scripts/local-ci.mjs'), 'utf8');
  assert.match(ci, /await step\('Kit literals', 'node', \['app\/public\/ui\/literals\.mjs', 'app\/public'\]\);/);
});

// Step 13, L4 to L9 (plan decision 12): the stylesheet moves onto the kit's names section by section. A cleaned section
// sits between `/* kit-clean:start <name> */` and `/* kit-clean:end */`; inside one, every var() is a kit value. L4 marks
// the shell and the shared parts, and takes the --ux-* colour aliases out of the whole file. L5 marks Setup's own blocks; L6 marks Improve's (Changes, Signals, Claude Code, Atlas); L7 marks Projects' (the page's rows and detail, Library's rows). A cleaned
// block that touches a cleaned section joins it (first-run, the page list and model downloads are in "design system",
// secure connection in "phone shell"): the shell's download budget has no room for a pair of markers each.
const cleanRegions = css => [...css.matchAll(/\/\* kit-clean:start ([\w -]+?) \*\/([\s\S]*?)\/\* kit-clean:end \*\//g)].map(m => ({ name: m[1], body: m[2] }));

test('a cleaned section of the stylesheet reads only the kit\'s names', () => {
  const css = fs.readFileSync(path.join(ROOT, 'app/public/app.css'), 'utf8');
  const regions = cleanRegions(css);
  // The per-instance names (plan decision 5): a part's own variable, set per element or per state, is not a kit value.
  const allow = JSON.parse(fs.readFileSync(path.join(ROOT, '.kit-literals-allow.json'), 'utf8')).names.map(n => new RegExp(`^${n.replace(/\*/g, '.*')}$`));
  assert.deepEqual(regions.map(r => r.name), ['navigation', 'improve claude', 'design system', 'phone shell', 'phone shell follow-ups', 'improve changes', 'improve rows', 'improve shipped',
    'improve signals', 'improve highlight', 'improve errors', 'projects library', 'atlas to setup diagnostics', 'setup status and projects page']);
  assert.equal((css.match(/kit-clean:start/g) || []).length, (css.match(/kit-clean:end/g) || []).length, 'every start has its end');
  for (const r of regions) {
    const priv = [...new Set([...r.body.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1]).filter(n => !n.startsWith('--ui-') && !allow.some(re => re.test(n))))];
    assert.deepEqual(priv, [], `"${r.name}" still reads ${priv.join(', ')}`);
    assert.doesNotMatch(r.body, /font-size:\s*\d+px/, `"${r.name}" sets a type size in px`);
  }
});

test('the --ux-* colour and radius aliases are gone: nothing defines or reads one', () => {
  const css = fs.readFileSync(path.join(ROOT, 'app/public/app.css'), 'utf8');
  const left = [...new Set(css.match(/--ux-(?:bg|rail|surface(?:-[23])?|line(?:-strong)?|text|muted|accent(?:-2)?|good|warn|bad|radius(?:-lg)?)\b/g) || [])];
  assert.deepEqual(left, []);
});
