'use strict';
// app/mission-evidence.js: a mission about part of Local AI reads that part's code and docs. Live (17 Oct), "Improve
// look feel and polish of agent world" got excerpts of the orchestrator and server instead, and its answer was that
// "agent world" appears nowhere in the evidence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createMissionEvidence = require('../app/mission-evidence');
const createOrchestrator = require('../app/agent-orchestrator');
const { createResearchTools } = require('../app/agent-tools');

const repo = path.resolve(__dirname, '..');
const evidence = createMissionEvidence({ appRoot: path.join(repo, 'app') });
const labels = goal => evidence.select(goal).map(s => s.source);
// The packet limits: 7 sources, 40000 chars in all. The first turn then takes the most relevant of them up to the
// evidence budget (fitEvidence, tests/model-wait.test.cjs); the tools can read the rest.
function assertSmall(sources) {
  assert.ok(sources.length <= 7, 'at most 7 sources');
  for (const s of sources) assert.ok(s.text.length <= 5600, s.source + ' is ' + s.text.length + ' chars');
  assert.ok(sources.reduce((n, s) => n + s.text.length + s.source.length + 40, 0) <= 40000, 'fits the opening evidence');
}

test('a goal naming Agent World reads the Agent World code and specs', () => {
  const sources = evidence.select('Improve look feel and polish of agent world');
  const got = sources.map(s => s.source);
  for (const want of ['app/public/ui.js#agent-world-city.js', 'app/public/ui.js#agent-specialists.js', 'app/public/agent-world-words.js',
    'docs/superpowers/specs/2026-10-17-agent-world-design.md', 'docs/superpowers/specs/2026-10-18-agent-world-visuals.md']) assert.ok(got.includes(want), want + ' missing from ' + got.join(', '));
  assert.ok(!got.includes('app/server.js'), 'no unrelated server code');
  assertSmall(sources);
  const city = sources.find(s => s.source === 'app/public/ui.js#agent-world-city.js').text;
  assert.match(city, /\/\/ ==== agent-world-city\.js ====/, 'the section header leads');
  assert.match(city, /^Functions: .*applyMission/m, 'an outline of the section’s functions');
  assert.ok(!/ \| .{260}/.test(city), 'long bundle lines are cut');
  const spec = sources.find(s => s.source.endsWith('agent-world-design.md')).text;
  assert.match(spec, /^Headings: Agent World, redesigned/m);
  const css = sources.find(s => s.source === 'app/public/app.css');
  assert.ok(css && /\.awc/.test(css.text) && !/\.sheets-/.test(css.text), 'only Agent World CSS');
});

test('a goal naming Spreadsheets reads spreadsheets.js and the GridCraft docs', () => {
  const got = labels('Spreadsheets shows the wrong total');
  for (const want of ['app/public/spreadsheets.js', 'docs/GRIDCRAFT.md', 'docs/superpowers/specs/2026-10-17-gridcraft-workbook-ux-design.md']) assert.ok(got.includes(want), want + ' missing from ' + got.join(', '));
  assert.ok(!got.some(s => /agent-world/.test(s)));
  assertSmall(evidence.select('Spreadsheets shows the wrong total'));
  // The registry's other names for the page work too.
  assert.ok(labels('The GridCraft workbook will not open').includes('app/public/spreadsheets.js'));
});

test('a goal about something else brings no repo code', () => {
  assert.deepEqual(labels('plan the vegetable garden'), []);
  // An ordinary word that is also a page name needs the goal to be about the app.
  assert.deepEqual(evidence.featuresFor('Plan a home workout'), []);
  assert.deepEqual(evidence.featuresFor('The Home page is slow'), ['home']);
});

test('a goal naming no feature falls back to keyword search over app/, docs/ and host/', () => {
  const got = labels('the morning brief comes out empty');
  assert.ok(got.length > 0 && got.length <= 7);
  // The words that matter lead: files about the morning brief, not every file that says "empty".
  for (const label of got.slice(0, 3)) assert.match(fs.readFileSync(path.join(repo, label.split('#')[0]), 'utf8').toLowerCase(), /morning brief/, label);
  assert.ok(labels('PowerShellHost-Hidden launcher').some(l => l.startsWith('host/powershell-bridge/')), 'host/ is searched');
});

test('every feature source exists, with its ui.js section and index.html section', () => {
  for (const f of createMissionEvidence.FEATURES) for (const src of f.sources) {
    const file = path.join(repo, src.path);
    assert.ok(fs.existsSync(file), src.path + ' (' + f.id + ') is missing');
    const text = fs.readFileSync(file, 'utf8');
    if (src.section) assert.ok(text.includes('// ==== ' + src.section), src.path + ' has no section ' + src.section);
    if (src.anchor) assert.ok(text.includes('<section id="' + src.anchor + '"'), 'index.html has no section #' + src.anchor);
  }
});

test('the deployed app reads docs from its repo-context folder', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'repo-context', 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'repo-context', 'docs', 'GRIDCRAFT.md'), '# GridCraft\n\nDeployed copy.\n');
  const deployed = createMissionEvidence({ appRoot: path.join(repo, 'app'), repoRoots: [path.join(root, 'nowhere'), path.join(root, 'repo-context')] });
  const doc = deployed.select('Spreadsheets shows the wrong total').find(s => s.source === 'docs/GRIDCRAFT.md');
  assert.match(doc.text, /Deployed copy/);
});

test('the read tool accepts the evidence labels’ repo paths', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'public'));fs.mkdirSync(path.join(root, 'repo-context', 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'app.css'), '.aw-page{}\n');
  fs.writeFileSync(path.join(root, 'repo-context', 'docs', 'GRIDCRAFT.md'), '# GridCraft\n');
  const read = createResearchTools({ projectRoot: root }).find(x => x.name === 'read_project_file');
  assert.equal((await read.execute({ path: 'app/public/app.css' })).data.content, '.aw-page{}\n');
  assert.equal((await read.execute({ path: 'public/app.css' })).data.path, 'public/app.css');
  assert.equal((await read.execute({ path: 'docs/GRIDCRAFT.md' })).data.path, 'repo-context/docs/GRIDCRAFT.md');
});

test('the specialist prompt carries the goal’s evidence, or none', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-evidence-'));
  const prompts = [];
  const orchestrator = createOrchestrator({
    dataDir, ollamaUrl: 'http://unused.invalid', defaultModel: 'test-model',
    fetchWithTimeout: async () => ({ ok: true, json: async () => ({ models: [{ name: 'test-model' }] }) }),
    runLocalModel: async prompt => { prompts.push(prompt); return 'Finding [1]'; },
  });
  t.after(() => { orchestrator.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const world = await orchestrator.specialist('ux_analyst', 'Improve look feel and polish of agent world');
  assert.ok(world.evidence.includes('app/public/ui.js#agent-world-city.js'));
  assert.match(prompts[0], /SOURCE: app\/public\/ui\.js#agent-world-city\.js/);
  const garden = await orchestrator.specialist('ux_analyst', 'plan the vegetable garden');
  assert.deepEqual(garden.evidence, []);
  assert.match(prompts[1], /Authoritative project evidence:\n\(none\)/);
});
