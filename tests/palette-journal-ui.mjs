import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// ⌘K's Past work group (amendment A28, item 3): after two typed characters the palette asks GET /api/journal for up to 5
// hits and lists them below the page matches. /api/journal is mocked with Playwright routes, so each state (hits, none,
// a failed request, a slow or stale answer) is set by the test rather than by what a throwaway server happens to hold.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }
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
  await group().waitFor();
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
  assert.doesNotMatch(await page.locator('#cmdkList').innerText(), /history/i, 'the group is never called History');
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
    const err = page.locator('#cmdkList [data-cmd-journal-error]');
    await err.waitFor();
    assert.equal((await err.innerText()).trim(), "Couldn't search past work");
    assert.equal(await journalRows().count(), 0);
    assert.ok(await pageRows().count() > 0, 'page matches still listed');
    assert.doesNotMatch(await page.locator('#cmdkList').innerText(), /no results|nothing found/i);
    assert.match(await page.locator('#cmdkCount').textContent(), /couldn't search past work/i);
    await page.keyboard.press('Enter'); // Enter still opens the first page match
    await page.waitForFunction(() => !document.querySelector('#cmdk.show'));
  });
}

await check('no page match, but hits: the hits are listed and Enter opens the first', async () => {
  await mock(page, () => ({ body: { items: [entry('rz1', 'zzqx in a chat')] } }));
  await open();
  await page.locator('#cmdkInput').fill('zzqx');
  await journalRows().first().waitFor();
  assert.match(await page.locator('#cmdkList').innerText(), /No pages match/);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.hash === '#run/rz1');
  await page.evaluate(() => window.LocalAIRouter?.go('#home'));
});

await check('no script errors', async () => assert.deepEqual(errors, []));
await page.close();
await browser.close();
if (failures.length) { console.error('\nPast work palette failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll Past work palette checks passed.');
