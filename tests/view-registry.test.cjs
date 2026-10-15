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

test('registry has five domains and every view belongs to one', () => {
  assert.equal(registry.DOMAINS.length, 5);
  const domains = new Set(registry.DOMAINS.map(d => d.id));
  const ids = registry.VIEWS.map(v => v.id);
  assert.equal(new Set(ids).size, ids.length, 'view ids must be unique');
  for (const v of registry.VIEWS) {
    assert.ok(domains.has(v.domain), `${v.id} has unknown domain ${v.domain}`);
    assert.ok(v.label && v.description && v.section && v.icon, `${v.id} is missing label, description, section or icon`);
  }
  for (const d of registry.DOMAINS) assert.equal(registry.view(d.defaultView)?.domain, d.id, `${d.id} default view must be in that domain`);
});

test('every registered view has a page, and every nav button is registered', () => {
  for (const v of registry.VIEWS) {
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
    if (v.id === 'home' || INJECTED[v.id]) continue;
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

test('tabs belong to a top-level page in the same domain', () => {
  for (const v of registry.VIEWS.filter(x => x.parent)) {
    const parent = registry.view(v.parent);
    assert.ok(parent && !parent.parent, `${v.id} parent must be a top-level view`);
    assert.equal(parent.domain, v.domain, `${v.id} must share its parent's domain`);
    assert.ok(v.tab && parent.tab, `${v.id} and ${parent.id} need tab labels`);
  }
  assert.deepEqual(registry.tabs('quality').map(v => v.id), ['issues', 'quality']);
  assert.deepEqual(registry.tabs('approvals').map(v => v.id), ['inbox', 'approvals']);
  assert.deepEqual(registry.tabs('projects').map(v => v.id), ['projects', 'knowledge', 'memory']);
  assert.deepEqual(registry.tabs('claude'), []);
});

test('retired views redirect to the page that replaced them', () => {
  for (const [from, to] of Object.entries(registry.ALIASES)) {
    assert.equal(registry.view(from).id, to);
    assert.doesNotMatch(html, new RegExp(`<section id="${from}"`), `#${from} should be gone`);
  }
  assert.match(app, /id=window\.LocalAIViews\?\.resolve\(id\)\|\|id/, 'showView must resolve aliases');
  assert.doesNotMatch(app, /showView\('engineering'\)|view:'engineering'/);
});

test('every page loads its data when opened, whichever control opened it', () => {
  assert.match(app, /const VIEW_LOADERS=\{/);
  assert.match(app, /if\(VIEW_LOADERS\[id\]\)/);
  assert.doesNotMatch(app, /const oldShow=showView/, 'loaders must not depend on nav button click handlers');
});

test('change requests use one form for plan-only and agent runs', () => {
  for (const id of ['engineeringRequest', 'engineeringTarget', 'engineeringAttempts', 'engineeringRunBtn', 'changeList', 'engineeringRuns']) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id}`);
  }
  assert.match(html, /<option value="0">Plan only/);
  assert.doesNotMatch(html, /id="changeRequest"|id="changePlanBtn"/);
  assert.match(app, /if\(Number\(\$\('engineeringAttempts'\)\.value\)===0\)return planChange\(\)/);
});
