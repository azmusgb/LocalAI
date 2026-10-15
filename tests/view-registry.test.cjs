'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.resolve(__dirname, '../app/public');
const registry = require(path.join(pub, 'view-registry.js'));
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const ux = fs.readFileSync(path.join(pub, 'ux-architecture-v2.js'), 'utf8');
const app = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');

// Views whose section and nav button are created at runtime by another script.
const INJECTED = { models: 'mobile-overhaul.js', runs: 'execution-runtime.js', integrations: 'ux-architecture-v2.js' };

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
  assert.ok(buttons.length >= 20);
  for (const id of buttons) assert.ok(registry.view(id), `nav button ${id} is not in view-registry.js`);
});

test('page headings and nav labels match the registry', () => {
  for (const v of registry.VIEWS) {
    if (v.id === 'home' || INJECTED[v.id]) continue;
    const m = html.match(new RegExp(`<section id="${v.id}"[^>]*>[\\s\\S]*?<h1>([^<]*)</h1>`));
    assert.equal(m?.[1], v.label, `#${v.id} heading`);
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
