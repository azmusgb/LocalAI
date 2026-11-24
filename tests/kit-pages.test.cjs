'use strict';
// Two navigation lists must agree (Pi Hub A27 plan, risks): the kit's page list (app/public/ui/pages.json, which Pi Hub
// draws the Assistant's frame from) and Local AI's own (view-registry.js). Each kit page of the Assistant names the
// Local AI view it opens; that view must exist, and every Local AI page must be one the kit lists. The kit's retired ids
// (kit 2.26.0 `redirects`) must each land, through Local AI's ALIASES, on the page the kit's redirect(id) names.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const pub = path.resolve(__dirname, '../app/public');
const R = require(path.join(pub, 'view-registry.js'));
const kitFile = path.join(pub, 'ui', 'pages.js');
const kit = () => import(require('node:url').pathToFileURL(kitFile).href);

// Local AI pages the kit does not list, and why. In progress and Shipped are stages of Changes (the kit redirects
// changes-in-progress and changes-shipped to them); Runs is a hidden page whose address means Work; Research is not in
// the kit's list yet (a kit change adds it).
const NOT_IN_KIT = { inProgress: 'a stage of Changes', shipped: 'a stage of Changes', runs: 'hidden; #runs opens Work', research: 'not in the kit yet' };
// A Changes stage in the kit's words, and the Local AI page that shows it.
const STAGE_VIEW = { 'in-progress': 'inProgress', shipped: 'shipped' };

const own = id => R.VIEWS.find(v => v.id === id) || null; // a page of its own, not an alias

test('every Assistant page and card in the kit opens a Local AI page of its own', async () => {
  const { PAGES } = await kit();
  const assistant = PAGES.filter(p => p.system === 'assistant');
  assert.ok(assistant.length >= 20, 'the kit lists the Assistant');
  for (const p of assistant) {
    if (p.view) assert.ok(own(p.view), `${p.id} opens view ${p.view}, which view-registry.js has`);
    for (const c of p.cards || []) assert.ok(own(c.view), `${p.id} card ${c.id} opens view ${c.view}`);
  }
});

test('every Local AI page is one the kit lists, or is named here with its reason', async () => {
  const { PAGES } = await kit();
  const listed = new Set(PAGES.filter(p => p.system === 'assistant').flatMap(p => [p.view, ...(p.cards || []).map(c => c.view)]).filter(Boolean));
  const missing = R.VIEWS.map(v => v.id).filter(id => !listed.has(id) && !NOT_IN_KIT[id]);
  assert.deepEqual(missing, [], 'pages the kit does not list');
  for (const id of Object.keys(NOT_IN_KIT)) assert.ok(own(id) && !listed.has(id), `${id} is still a page the kit does not list; drop it from NOT_IN_KIT`);
});

test("System's one page and its five cards match the kit's, in order and by name", async () => {
  const { PAGES, page } = await kit();
  const system = page('assistant-system');
  assert.equal(system.view, 'system');
  assert.equal(R.label('system'), system.label);
  assert.equal(R.view('system').domain, 'system');
  const details = PAGES.filter(p => p.parent === 'assistant-system');
  assert.ok(details.every(p => p.role === 'detail'), 'detail rows, no tabs');
  assert.deepEqual(R.cards('system').map(v => v.id), details.map(p => p.view));
  assert.deepEqual(R.cards('system').map(v => v.label), details.map(p => p.label));
  const tools = page('developer-tools');
  assert.equal(tools.view, 'tools');
  assert.deepEqual(R.cards('tools').map(v => v.id), tools.cards.map(c => c.view));
  assert.deepEqual(R.cards('tools').map(v => v.label), tools.cards.map(c => c.label));
});

test("every retired id resolves through the kit's redirect(id) and Local AI's ALIASES to the same page", async () => {
  const { REDIRECTS, redirect, page } = await kit();
  const ids = ['assistant-status', 'tools-files', 'tools-repository', 'tools-powershell', 'tools-browser', 'tools-n8n', 'changes-in-progress', 'changes-shipped'];
  assert.deepEqual(REDIRECTS.map(r => r.id).sort(), [...ids].sort(), 'the kit retires these ids');
  for (const id of ids) {
    const r = redirect(id);
    assert.ok(r, `kit redirect(${id})`);
    assert.equal(page(id), null, `${id} is no kit page`);
    const to = page(r.to);
    assert.ok(to, `${id} goes to kit page ${r.to}`);
    const want = r.card ? to.cards.find(c => c.id === r.card)?.view : r.stage ? STAGE_VIEW[r.stage] : to.view;
    assert.ok(want && own(want), `${id}: the kit's target opens a Local AI page (${want})`);
    assert.equal(R.resolve(id), want, `#${id} opens ${want}`);
    assert.equal(R.view(id)?.id, want, `view(${id})`);
    assert.equal(own(id), null, `${id} has no page of its own`);
  }
  assert.equal(redirect('status'), null, 'a live page is not a redirect');
});
