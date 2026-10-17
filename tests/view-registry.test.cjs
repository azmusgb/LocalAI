'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.resolve(__dirname, '../app/public');
const registry = require(path.join(pub, 'view-registry.js'));
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const ux = fs.readFileSync(path.join(pub, 'ui.js'), 'utf8');
const app = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');

// Views whose section and nav button are created at runtime by another script.
const INJECTED = { models: 'ui.js', runs: 'ui.js', integrations: 'ui.js' };
// Registered ahead of its section: Task 3 of the navigation plan creates #work.
const PENDING = new Set(['work']);

test('registry has five domains and every view belongs to one', () => {
  assert.deepEqual(registry.DOMAINS.map(d => d.id), ['home', 'work', 'projects', 'improve', 'system']);
  assert.deepEqual(registry.DOMAINS.map(d => d.defaultView), ['home', 'work', 'library', 'backlog', 'status']);
  const domains = new Set([...registry.DOMAINS.map(d => d.id), 'hidden']);
  const ids = registry.VIEWS.map(v => v.id);
  assert.equal(new Set(ids).size, ids.length, 'view ids must be unique');
  for (const v of registry.VIEWS) {
    assert.ok(domains.has(v.domain), `${v.id} has unknown domain ${v.domain}`);
    assert.ok(v.label && v.description && v.section && v.icon, `${v.id} is missing label, description, section or icon`);
  }
  for (const d of registry.DOMAINS) assert.equal(registry.view(d.defaultView)?.domain, d.id, `${d.id} default view must be in that domain`);
  for (const id of ['ask', 'create', 'agents', 'runs']) assert.equal(registry.view(id).domain, 'hidden', `${id} has no nav entry`);
  assert.equal(registry.resolve('runs'), 'work');
  assert.equal(registry.resolve('agents'), 'work');
  assert.equal(registry.resolve('ask'), 'home');
  assert.equal(registry.resolve('create'), 'home');
  // Improve's stages replaced Change requests, Issues and Quality signals.
  for (const [from, to] of [['engineering', 'inProgress'], ['changes', 'inProgress'], ['issues', 'signals'], ['quality', 'signals']]) assert.equal(registry.resolve(from), to, from);
  // Retired (owner decision D4): no page of their own, only the address.
  for (const id of ['changes', 'issues', 'quality']) {
    assert.ok(!registry.VIEWS.some(v => v.id === id), `${id} is not a view`);
    assert.doesNotMatch(html, new RegExp(`<section id="${id}"|data-view="${id}"`), `#${id} is gone`);
  }
});

test('Monitors is part of Automations: #operations opens Automations (D9)', () => {
  assert.equal(registry.VIEWS.some(v => v.id === 'operations'), false);
  assert.equal(registry.resolve('operations'), 'automationStudio');
  assert.equal(registry.view('operations').id, 'automationStudio');
  assert.ok(registry.view('automationStudio').aka.includes('morning brief'), 'typing "morning brief" in ⌘K finds Automations');
});

test('every domain icon has a sprite symbol', () => {
  for (const d of registry.DOMAINS) assert.match(html, new RegExp(`<symbol id="i-${d.icon}"`), `i-${d.icon}`);
});

test('the router is a shell script that loads before app.js', () => {
  assert.ok(html.includes('<script src="/router.js">') && html.indexOf('/router.js') < html.indexOf('/app.js'));
  assert.match(sw, /'\/router\.js'/);
});

test('every registered view has a page, and every nav button is registered', () => {
  for (const v of registry.VIEWS) {
    if (PENDING.has(v.id)) continue;
    if (INJECTED[v.id]) {
      const src = fs.readFileSync(path.join(pub, INJECTED[v.id]), 'utf8');
      assert.ok(src.includes(`'${v.id}'`), `${INJECTED[v.id]} should create the ${v.id} view`);
    } else {
      assert.match(html, new RegExp(`<section id="${v.id}"`), `index.html is missing section #${v.id}`);
    }
  }
  const buttons = [...html.matchAll(/class="navbtn[^"]*" data-view="([^"]+)"/g)].map(m => m[1]);
  assert.ok(buttons.length >= 15);
  for (const id of buttons) {
    assert.ok(registry.VIEWS.some(v => v.id === id), `nav button ${id} is not in view-registry.js`);
    assert.ok(!registry.view(id).parent, `${id} is a tab and should not have its own nav button`);
  }
});

test('page headings and nav labels match the registry', () => {
  for (const v of registry.VIEWS) {
    if (v.id === 'home' || INJECTED[v.id] || PENDING.has(v.id)) continue;
    const m = html.match(new RegExp(`<section id="${v.id}"[^>]*>[\\s\\S]*?<h1>([^<]*)</h1>`));
    assert.equal(m?.[1], registry.page(v.id).label, `#${v.id} heading`);
    if (v.parent) continue;
    const b = html.match(new RegExp(`data-view="${v.id}"><span class="navicon">[^<]*</span>([^<]*)</button>`));
    assert.equal(b?.[1], v.label, `${v.id} nav button`);
  }
});

test('navigation surfaces read from the registry instead of their own lists', () => {
  assert.match(ux, /window\.LocalAIViews/);
  assert.doesNotMatch(ux, /const LABELS=/);
  assert.match(app, /window\.LocalAIViews\.VIEWS/);
  assert.doesNotMatch(app, /function evoNav|function groupNavigation|function addReleaseNav/);
  assert.ok(html.indexOf('/view-registry.js') < html.indexOf('/app.js'), 'registry must load before app.js');
  assert.match(sw, /'\/view-registry\.js'/);
});

// Developer tools (the Health switch) hide the pages whose first screen is for a developer: the registry says
// which, so the rail, the page strip, the phone sheet and ⌘K all agree and a future developer page gets it for free.
test('the developer pages carry the dev flag and nothing else does', () => {
  const dev = registry.VIEWS.filter(v => v.dev).map(v => v.id).sort();
  assert.deepEqual(dev, ['actions', 'automations', 'claude', 'powershell', 'repoTools', 'workbench']);
  for (const v of registry.VIEWS.filter(x => x.dev)) assert.equal(v.domain, 'system', `${v.id} is a System page`);
});

test('tabs belong to a top-level page in the same domain', () => {
  for (const v of registry.VIEWS.filter(x => x.parent)) {
    const parent = registry.view(v.parent);
    assert.ok(parent && !parent.parent, `${v.id} parent must be a top-level view`);
    assert.equal(parent.domain, v.domain, `${v.id} must share its parent's domain`);
    assert.ok(v.tab && parent.tab, `${v.id} and ${parent.id} need tab labels`);
  }
  assert.deepEqual(registry.tabs('approvals').map(v => v.id), ['inbox', 'approvals']);
  assert.deepEqual(registry.tabs('projects').map(v => v.id), ['projects', 'knowledge', 'memory']);
  assert.deepEqual(registry.tabs('claude'), []);
});

test('retired views redirect to the page that replaced them', () => {
  for (const [from, to] of Object.entries(registry.ALIASES)) {
    assert.equal(registry.resolve(from), to);
    // A hidden view keeps its own page and stays reachable by id; every other alias is a retired page.
    if (registry.view(from).domain === 'hidden') assert.match(html + ux, new RegExp(`id="${from}"|id = '${from}'`), `#${from} stays routable`);
    else assert.doesNotMatch(html, new RegExp(`<section id="${from}"`), `#${from} should be gone`);
  }
  assert.match(app, /id=window\.LocalAIViews\?\.resolve\(id\)\|\|id/, 'showView must resolve aliases');
  assert.doesNotMatch(app, /showView\('engineering'\)|view:'engineering'/);
});

test('every page loads its data when opened, whichever control opened it', () => {
  assert.match(app, /const VIEW_LOADERS=\{/);
  assert.match(app, /if\(VIEW_LOADERS\[id\]\)/);
  assert.doesNotMatch(app, /const oldShow=showView/, 'loaders must not depend on nav button click handlers');
});

test('the retired Change requests form and its scripts are gone; the run view keeps the change detail', () => {
  for (const id of ['engineeringRequest', 'engineeringTarget', 'engineeringAttempts', 'engineeringRunBtn', 'changeList', 'engineeringRuns', 'issueList', 'qualityChecks']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`), `#${id}`);
  }
  for (const fn of ['planChange', 'runEngineeringAgent', 'loadQuality', 'loadIssues', 'scanIssues', 'runQualityScanClient']) assert.doesNotMatch(app, new RegExp(`function ${fn}\\(`), fn);
  // The run view and the deploy contract still use these.
  for (const fn of ['selectChange', 'showChange', 'stageChange', 'approveChange', 'applyChange', 'renderEngineeringRun', 'loadEngineeringRuns', 'pollEngineeringIntent', 'engineeringRunText', 'reportQualityEvent']) assert.match(app, new RegExp(`function ${fn}\\(`), fn);
});

// Menus draw every page's icon from the sprite; letters and loose symbols (M, W, R, PS, ↗) looked like three designs.
test('every domain and page names an icon the sprite has', () => {
  const symbols = new Set([...html.matchAll(/<symbol id="i-([\w-]+)"/g)].map(m => m[1]));
  const missing = [...registry.DOMAINS.map(d => [d.id, d.icon]), ...registry.VIEWS.map(v => [v.id, v.svg])].filter(([, s]) => !symbols.has(s));
  assert.deepEqual(missing, [], 'views without a sprite icon');
});
