import './browser-target-guard.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { addAxe } from './axe-helper.mjs';

// ⌘K's Past work group (amendment A28, item 3): after two typed characters the palette asks GET /api/journal for up to 5
// hits and lists them below the page matches. /api/journal is mocked with Playwright routes, so each state (hits, none,
// a failed request, a slow or stale answer) is set by the test rather than by what a throwaway server happens to hold.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }
const axePath = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']; // as axe-ui.mjs
const sleep = ms => new Promise(r => setTimeout(r, ms));
const entry = (id, title, extra = {}) => ({ id, at: '2026-11-12T10:30:00.000Z', day: '2026-11-12', source: 'run', kind: 'chat', title, body: '', link: `#run/${id}`, meta: {}, ...extra });

// handler(q) → { status, body, delay } or 'abort'. Every request's query is recorded.
async function mock(page, handler) {
  const seen = [];
  await page.unroute('**/api/journal?*').catch(() => {});
  await page.route('**/api/journal?*', async route => {
    const u = new URL(route.request().url());
    const q = u.searchParams.get('q');
    seen.push({ q, limit: u.searchParams.get('limit') });
    const r = await handler(q);
    if (r === 'abort') return route.abort('failed');
    if (r.delay) await sleep(r.delay);
    await route.fulfill({ status: r.status || 200, contentType: 'application/json', body: JSON.stringify(r.body ?? { items: [], next: null }) }).catch(() => {});
  });
  return seen;
}

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
await page.goto(base + '/#home', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.showView === 'function' && document.querySelector('#uxCommandBtn'));
const open = async () => {
  if (await page.locator('#cmdk.show').count()) { await page.keyboard.press('Escape'); }
  await page.evaluate(() => window.showView('home')); await page.waitForSelector('#home.active');
  await page.locator('#uxCommandBtn').click(); await page.waitForSelector('#cmdk.show');
};
const group = () => page.locator('#cmdkList [data-cmd-group="journal"]');
const journalRows = () => page.locator('#cmdkList [data-cmd-journal]');
const pageRows = () => page.locator('#cmdkList [data-cmd-view]');

await check('one typed character asks nothing; two ask once, after the pause, for 5', async () => {
  const seen = await mock(page, () => ({ body: { items: [] } }));
  await open();
  await page.locator('#cmdkInput').pressSequentially('m');
  await sleep(400);
  assert.equal(seen.length, 0, 'no request for one character');
  await page.locator('#cmdkInput').pressSequentially('ode', { delay: 30 });
  await sleep(500);
  assert.deepEqual(seen, [{ q: 'mode', limit: '5' }], 'one debounced request for the final text');
});

await check('hits show below the page matches as Past work, with title, date and source, all text escaped', async () => {
  await mock(page, () => ({ body: { items: [
    entry('r1', 'Model comparison <img src=x onerror="window.__xss=1">'),
    entry('r2', 'Model poster', { kind: 'image' }),
    entry('r3', 'No link', { link: null }),
    entry('r4', 'Off-site link', { link: 'https://example.com/' }),
    entry('r5', 'Script link', { link: 'javascript:alert(1)' }),
  ] } }));
  await open();
  await page.locator('#cmdkInput').fill('model');
  await journalRows().first().waitFor(); // the group shows while loading too; wait for the hits
  assert.equal(await page.locator('#cmdkList [data-cmd-group="journal"] .cmdk-group__label').innerText(), 'Past work');
  // Page matches come first; the journal group is the last thing in the list.
  const order = await page.evaluate(() => [...document.querySelectorAll('#cmdkList [role="option"]')].map(o => o.dataset.cmdJournal ? 'j' : 'p').join(''));
  assert.match(order, /^p+j+$/, `pages then journal: ${order}`);
  // Only in-app hash links are listed; an entry without one is left out.
  assert.deepEqual(await journalRows().evaluateAll(b => b.map(x => x.dataset.cmdJournal)), ['#run/r1', '#run/r2']);
  const first = await journalRows().first().innerText();
  assert.match(first, /Model comparison <img src=x onerror="window.__xss=1">/, 'title shown as text');
  assert.match(first, /Chat/, 'source shown');
  assert.match(first, /12/, 'date shown');
  assert.match(await journalRows().nth(1).innerText(), /Image/);
  assert.equal(await journalRows().first().locator('time').getAttribute('datetime'), '2026-11-12T10:30:00.000Z');
  assert.equal(await page.evaluate(() => window.__xss), undefined, 'no markup ran');
  assert.doesNotMatch(await page.locator('#cmdk').innerText(), /history/i, 'the group is never called History');
  assert.match(await page.locator('#cmdkCount').textContent(), /2 from past work/);
});

await check('arrows move through pages and hits as one list; Enter follows the hit\'s link', async () => {
  await mock(page, () => ({ body: { items: [entry('rk1', 'Health check notes'), entry('rk2', 'Health poster')] } }));
  await open();
  await page.locator('#cmdkInput').fill('health');
  await journalRows().first().waitFor();
  const before = await page.locator('#cmdkList [role="option"]:not([data-cmd-journal])').count(); // pages and tools
  for (let i = 0; i <= before; i++) await page.keyboard.press('ArrowDown');
  const sel = page.locator('#cmdkList [aria-selected="true"]');
  assert.equal(await sel.getAttribute('data-cmd-journal'), '#run/rk2', 'the last row is the second hit');
  assert.equal(await page.locator('#cmdkInput').getAttribute('aria-activedescendant'), await sel.getAttribute('id'));
  await page.keyboard.press('ArrowUp');
  assert.equal(await sel.getAttribute('data-cmd-journal'), '#run/rk1');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.hash === '#run/rk1');
  assert.equal(await page.locator('#cmdk.show').count(), 0, 'the palette closed');
  await page.evaluate(() => window.LocalAIRouter?.go('#home'));
});

await check('a click on a hit follows its link', async () => {
  await mock(page, () => ({ body: { items: [entry('rc1', 'Clicked models')] } }));
  await open();
  await page.locator('#cmdkInput').fill('models');
  await journalRows().first().click();
  await page.waitForFunction(() => location.hash === '#run/rc1');
  await page.evaluate(() => window.LocalAIRouter?.go('#home'));
});

await check('a slow answer does not move the highlight or the page rows', async () => {
  await mock(page, () => ({ delay: 600, body: { items: [entry('rs1', 'Slow one')] } }));
  await open();
  await page.locator('#cmdkInput').fill('health');
  await sleep(50);
  const before = await pageRows().evaluateAll(b => b.map(x => x.textContent));
  await page.keyboard.press('ArrowDown');
  const selected = await page.locator('#cmdkList [aria-selected="true"]').innerText();
  await journalRows().first().waitFor();
  assert.deepEqual(await pageRows().evaluateAll(b => b.map(x => x.textContent)), before);
  assert.equal(await page.locator('#cmdkList [aria-selected="true"]').innerText(), selected, 'highlight kept');
});

await check('a stale answer never paints: "pri" then "print" shows only print', async () => {
  await mock(page, q => (q === 'pri' ? { delay: 700, body: { items: [entry('old', 'Old pri answer')] } } : { body: { items: [entry('new', `New ${q} answer`)] } }));
  await open();
  await page.locator('#cmdkInput').fill('pri');
  await sleep(250); // the pri request is in flight
  await page.locator('#cmdkInput').fill('print');
  await sleep(1100); // both answers are back
  assert.deepEqual(await journalRows().allInnerTexts().then(t => t.map(s => s.split('\n')[0])), ['New print answer']);
});

await check('closing the palette cancels the timer and the request', async () => {
  const seen = await mock(page, () => ({ delay: 400, body: { items: [entry('late', 'Late answer')] } }));
  await open();
  await page.locator('#cmdkInput').fill('health');
  await page.keyboard.press('Escape');
  await sleep(400);
  assert.equal(seen.length, 0, 'the debounce timer was cleared');
  await open();
  await page.locator('#cmdkInput').fill('health');
  await sleep(250); // in flight
  await page.keyboard.press('Escape');
  await open();
  await sleep(500);
  assert.equal(await journalRows().count(), 0, 'the late answer was dropped');
  assert.equal(await page.locator('#cmdkInput').inputValue(), '');
});

await check('zero hits shows no Past work group and leaves the pages alone', async () => {
  const seen = await mock(page, () => ({ body: { items: [], next: null } }));
  await open();
  await page.locator('#cmdkInput').fill('health');
  await page.waitForFunction(() => true);
  await sleep(400);
  assert.equal(seen.length, 1);
  assert.equal(await group().count(), 0);
  assert.ok(await pageRows().count() > 0);
  assert.doesNotMatch(await page.locator('#cmdkCount').textContent(), /past work/i);
});

for (const [name, handler] of [['a non-200 reply', () => ({ status: 500, body: { error: 'boom' } })], ['a network error', () => 'abort'], ['an unreadable reply', () => ({ body: { items: 'nope' } })]]) {
  await check(`${name} says "Couldn't search past work", never "no results", and keeps the pages`, async () => {
    await mock(page, handler);
    await open();
    await page.locator('#cmdkInput').fill('health');
    const err = page.locator('#cmdkPast [data-cmd-journal-error]');
    await err.waitFor();
    assert.match(await err.innerText(), /^Couldn't search past work\.\s*Try again$/);
    assert.ok(await err.evaluate(n => n.classList.contains('ui-notice--warn')), 'drawn as a warning, not grey text');
    assert.equal(await journalRows().count(), 0);
    assert.ok(await pageRows().count() > 0, 'page matches still listed');
    assert.doesNotMatch(await page.locator('#cmdk').innerText(), /no results|nothing found/i);
    assert.match(await page.locator('#cmdkCount').textContent(), /couldn't search past work/i);
    await page.keyboard.press('Enter'); // Enter still opens the first page match
    await page.waitForFunction(() => !document.querySelector('#cmdk.show'));
  });
}

await check('Try again after a failed search asks again and shows the hits; Tab reaches it and the arrows skip it', async () => {
  let fail = true;
  const seen = await mock(page, () => (fail ? { status: 503, body: { error: 'busy' } } : { body: { items: [entry('rt1', 'Health retried')] } }));
  await open();
  await page.locator('#cmdkInput').fill('health');
  const retry = page.locator('#cmdkPast [data-cmd-journal-retry]');
  await retry.waitFor();
  // The arrows never land on the button: the last option stays selected.
  const options = await page.locator('#cmdkList [role="option"]').count();
  for (let i = 0; i <= options; i++) await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#cmdkList [aria-selected="true"]').count(), 1);
  assert.equal(await page.locator('#cmdkList [aria-selected="true"][data-cmd-journal-retry]').count(), 0);
  let reached = false;
  for (let i = 0; i <= options + 1 && !reached; i++) { await page.keyboard.press('Tab'); reached = await page.evaluate(() => document.activeElement?.hasAttribute('data-cmd-journal-retry')); }
  assert.ok(reached, 'Tab reaches Try again');
  fail = false;
  await page.keyboard.press('Enter');
  await journalRows().first().waitFor();
  assert.equal(await journalRows().first().locator('.cmdk-item__title').innerText(), 'Health retried');
  assert.equal(seen.length, 2, 'asked twice');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'cmdkInput', 'focus back in the search box');
});

await check('retyping the same text after a failure asks again', async () => {
  let fail = true;
  const seen = await mock(page, () => (fail ? 'abort' : { body: { items: [entry('rr1', 'Health again')] } }));
  await open();
  await page.locator('#cmdkInput').fill('health');
  await page.locator('#cmdkPast [data-cmd-journal-error]').waitFor();
  fail = false;
  await page.locator('#cmdkInput').fill('health ');
  await journalRows().first().waitFor();
  assert.equal(seen.length, 2);
});

await check('while searching, Past work holds its place with one skeleton row and the page rows stay put', async () => {
  let release; const gate = new Promise(r => { release = r; });
  await mock(page, async () => { await gate; return { body: { items: [entry('rl1', 'Loaded')] } }; });
  await open();
  await page.locator('#cmdkInput').fill('health');
  const loading = page.locator('#cmdkPast [data-cmd-journal-loading]');
  await loading.waitFor();
  assert.equal(await loading.count(), 1);
  assert.equal(await loading.getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('#cmdkPast .cmdk-group__label').innerText(), 'Past work');
  const before = await pageRows().evaluateAll(b => b.map(x => x.getBoundingClientRect().top));
  release();
  await journalRows().first().waitFor();
  assert.equal(await loading.count(), 0);
  assert.deepEqual(await pageRows().evaluateAll(b => b.map(x => x.getBoundingClientRect().top)), before, 'page rows did not move');
});

await check('a long title is cut to two lines, and the whole title stays in the row\'s accessible text', async () => {
  const long = 'Which printer settings work best for PETG on the X2D with a long bridging section across the top of the enclosure lid and a brim that peels '.repeat(3).trim();
  await mock(page, () => ({ body: { items: [entry('rlong', long), entry('rshort', 'Short one')] } }));
  await page.setViewportSize({ width: 320, height: 640 });
  try {
    await open();
    await page.locator('#cmdkInput').fill('print');
    await journalRows().first().waitFor();
    const h = id => page.locator(`#cmdkList [data-cmd-journal="#run/${id}"] .cmdk-item__title`).evaluate(n => n.getBoundingClientRect().height);
    const lines = Math.round((await h('rlong')) / (await h('rshort'))); // a one-line title is the unit
    assert.ok(lines <= 2, `${lines} lines`);
    assert.equal(await page.locator('#cmdkList [data-cmd-journal="#run/rlong"] .cmdk-item__title').textContent(), long);
  } finally { await page.setViewportSize({ width: 1440, height: 900 }); }
});

await check('no page match, but hits: the hits are listed and Enter opens the first', async () => {
  await mock(page, () => ({ body: { items: [entry('rz1', 'zzqx in a chat')] } }));
  await open();
  await page.locator('#cmdkInput').fill('zzqx');
  await journalRows().first().waitFor();
  assert.match(await page.locator('#cmdkEmpty').innerText(), /No pages match/);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.hash === '#run/rz1');
  await page.evaluate(() => window.LocalAIRouter?.go('#home'));
});

// axe on the open palette (the same rules as axe-ui.mjs), and two checks axe can't make: the listbox holds only options
// and groups of options, and aria-activedescendant names an option that exists or is absent.
async function paletteAxe(label) {
  await addAxe(page, axePath);
  const bad = await page.evaluate(tags => window.axe.run('#cmdk', { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] })
    .then(r => r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${v.id} (${v.impact}): ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)), TAGS);
  assert.deepEqual(bad, [], `${label}: axe`);
  const stray = await page.evaluate(() => [...document.querySelectorAll('#cmdkList > *, #cmdkList [role="group"] > *')]
    .filter(n => !['option', 'group'].includes(n.getAttribute('role')) && !n.classList.contains('cmdk-group__label')).map(n => n.outerHTML.slice(0, 80)));
  assert.deepEqual(stray, [], `${label}: only options and groups in the listbox`);
  const ad = await page.locator('#cmdkInput').getAttribute('aria-activedescendant');
  if (ad !== null) assert.equal(await page.locator(`#cmdkList [role="option"]#${ad}`).count(), 1, `${label}: aria-activedescendant ${ad} names an option`);
}
for (const [label, query, handler, ready] of [
  ['hits', 'health', () => ({ body: { items: [entry('ax1', 'Health notes')] } }), '#cmdkList [data-cmd-journal]'],
  ['a failed search', 'health', () => ({ status: 500, body: {} }), '#cmdkPast [data-cmd-journal-retry]'],
  ['searching', 'health', () => ({ delay: 3000, body: { items: [] } }), '#cmdkPast [data-cmd-journal-loading]'],
  ['no page match, no hits', 'zzqx', () => ({ body: { items: [] } }), null],
  ['no page match, a failed search', 'zzqx', () => 'abort', '#cmdkPast [data-cmd-journal-retry]'],
  ['no page match, hits', 'zzqx', () => ({ body: { items: [entry('ax2', 'zzqx chat')] } }), '#cmdkList [data-cmd-journal]'],
]) {
  await check(`axe finds nothing serious in the open palette: ${label}`, async () => {
    await mock(page, handler);
    await open();
    await page.locator('#cmdkInput').fill(query);
    if (ready) await page.locator(ready).first().waitFor(); else await sleep(500);
    if (query === 'zzqx') {
      assert.equal(await page.locator('#cmdkEmpty [data-cmd-work]').isVisible(), true, 'Search your work is offered');
      if (!ready) assert.equal(await page.locator('#cmdkInput').getAttribute('aria-activedescendant'), null, 'no option, no active descendant');
    }
    await paletteAxe(label);
    await page.keyboard.press('Escape');
  });
}

await check('no script errors', async () => assert.deepEqual(errors, []));
await page.close();
await browser.close();
if (failures.length) { console.error('\nPast work palette failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll Past work palette checks passed.');
