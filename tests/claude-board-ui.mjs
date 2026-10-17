// Claude Code page (System › Tools): chat and live sessions. Its findings are Improve's Backlog (tests/improve-ui.mjs).
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addAxe } from './axe-helper.mjs';

const axePath = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
await post('/api/claude/events', { sessionId: 'ui-test', sessionTitle: 'UI test session', sessionStatus: 'idle', events: [{ kind: 'note', title: 'UI test', status: 'info' }] });

const browser = await chromium.launch();
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS', name) } catch (e) { failed++; console.log('FAIL', name, e.message) } }
const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
await page.goto(base, { waitUntil: 'networkidle' });
await page.evaluate(() => window.showView('claude'));
await page.waitForSelector('#claude.active #claudeChat');

await check('the page has no second priorities list: findings are in Improve › Backlog', async () => {
  assert.equal(await page.locator('#claudeFindings').isVisible(), false);
  assert.equal(await page.locator('#claudeFilters').isVisible(), false);
  assert.match(await page.locator('#claude .sub').innerText(), /Improve › Backlog/);
});

await check('on a phone, a long session title keeps the live chip, picker and Refresh on screen', async () => {
  await fetch(`${base}/api/claude/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'ui-test-long', sessionTitle: 'Sub-project 1: all 6 tasks done and reviewed; final whole-branch review running now', events: [{ kind: 'note', title: 'x' }] }) });
  const phone = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
  await phone.goto(base, { waitUntil: 'networkidle' });
  await phone.evaluate(() => window.showView('claude'));
  await phone.waitForSelector('#claudeSession option:nth-child(2)', { state: 'attached' });
  const boxes = await phone.evaluate(() => ['claudeLive', 'claudeSession', 'claudeRefresh'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return [id, Math.round(r.left), Math.round(r.right), Math.round(r.width)]; }));
  for (const [id, left, right, width] of boxes) assert.ok(left >= 0 && right <= 360 && width >= 40, `${id}: ${left}-${right}`);
  await phone.close();
});

// "Live now" row: sessions derived from the progress feed, stubbed so the states are deterministic.
const iso = (s) => new Date(Date.now() - s * 1000).toISOString();
const LIVE = [
  { id: 'cc-live0001', title: 'home · Claude Code · live0001', state: 'working', lastEvent: 'Edit app/server.js', at: iso(5) },
  { id: 'cc-live0002', title: 'api · Claude Code · live0002', state: 'working', lastEvent: 'Run the whole test suite and then some more words that should be truncated with an ellipsis', at: iso(40) },
  { id: 'cc-live0003', title: 'home · Claude Code · live0003', state: 'waiting', lastEvent: 'Finished responding', at: iso(300) }
];
async function liveStubbed(pg, live) {
  await pg.route('**/api/claude/board*', async (route) => {
    // The page can move on mid-request (connection reset); drop that request instead of crashing the suite.
    const res = await route.fetch().catch(() => null);
    if (!res) return route.abort().catch(() => {});
    const j = await res.json();
    j.live = live;
    j.sessions = [...live.map((l) => ({ id: l.id, title: l.title, updatedAt: l.at })), ...j.sessions];
    await route.fulfill({ response: res, json: j }).catch(() => {});
  });
}
const liveChips = (pg) => pg.locator('#claudeLiveNow button[data-claude-live]');
const liveDesktop = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
await liveStubbed(liveDesktop, LIVE);
await liveDesktop.goto(base, { waitUntil: 'networkidle' });
await liveDesktop.evaluate(() => window.showView('claude'));
await liveDesktop.waitForSelector('#claudeLiveNow button[data-claude-live]');
await check('live row shows one chip per session with working and waiting dots', async () => {
  assert.equal(await liveChips(liveDesktop).count(), 3);
  assert.deepEqual(await liveDesktop.locator('#claudeLiveNow button[data-claude-live] i.dot').evaluateAll((els) => els.map((e) => e.classList.contains('working') ? 'working' : e.classList.contains('waiting') ? 'waiting' : '?')), ['working', 'working', 'waiting']);
  const first = await liveChips(liveDesktop).first().innerText();
  assert.match(first, /home · Claude Code · live0001/);
  assert.match(first, /Edit app\/server\.js/);
  assert.match(first, /\d+s ago/);
});
await check('tapping a chip sets the session filter, tapping it again clears it', async () => {
  const chip = liveChips(liveDesktop).nth(1);
  await chip.click();
  await liveDesktop.waitForFunction(() => document.getElementById('claudeSession').value === 'cc-live0002');
  assert.equal(await liveChips(liveDesktop).nth(1).getAttribute('aria-pressed'), 'true');
  assert.equal(await liveChips(liveDesktop).nth(0).getAttribute('aria-pressed'), 'false');
  await liveChips(liveDesktop).nth(1).click();
  await liveDesktop.waitForFunction(() => document.getElementById('claudeSession').value === '');
  assert.equal(await liveChips(liveDesktop).nth(1).getAttribute('aria-pressed'), 'false');
});
await liveDesktop.close();

await check('with no live sessions the row is hidden', async () => {
  const pg = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  await liveStubbed(pg, []);
  await pg.goto(base, { waitUntil: 'networkidle' });
  await pg.evaluate(() => window.showView('claude'));
  await pg.waitForSelector('#claude.active #claudeChat');
  await pg.waitForTimeout(1500); // the live row is filled by the first poll
  assert.equal(await pg.locator('#claudeLiveNow').isVisible(), false);
  await pg.close();
});
await check('on a phone the chips are 44px tall, scroll sideways, and pass axe color-contrast and target-size', async () => {
  const pg = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await liveStubbed(pg, LIVE);
  await pg.goto(base, { waitUntil: 'networkidle' });
  await pg.evaluate(() => window.showView('claude'));
  await pg.waitForSelector('#claudeLiveNow button[data-claude-live]');
  const heights = await liveChips(pg).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  assert.ok(heights.length === 3 && heights.every((h) => h >= 44), `heights ${heights}`);
  assert.equal(await pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal page overflow');
  const row = await pg.evaluate(() => { const r = document.getElementById('claudeLiveNow'); return { wide: r.scrollWidth > r.clientWidth, wrap: getComputedStyle(r).flexWrap, ox: getComputedStyle(r).overflowX }; });
  assert.equal(row.wrap, 'nowrap');
  assert.ok(['auto', 'scroll'].includes(row.ox));
  await addAxe(pg, axePath);
  const v = await pg.evaluate(() => window.axe.run('#claudeLiveNow', { runOnly: { type: 'rule', values: ['color-contrast', 'target-size'] } }).then((r) => r.violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.html).join(' | ')}`)));
  assert.deepEqual(v, []);
  await pg.close();
});

await check('chips stay the same elements across polls, keeping keyboard focus', async () => {
  const pg = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  let age = 5;
  await pg.route('**/api/claude/board*', async (route) => {
    // The page can move on mid-request (connection reset); drop that request instead of crashing the suite.
    const res = await route.fetch().catch(() => null);
    if (!res) return route.abort().catch(() => {});
    const j = await res.json();
    j.live = LIVE.map((l, i) => ({ ...l, at: iso(age + i) }));
    j.sessions = [...j.live.map((l) => ({ id: l.id, title: l.title, updatedAt: l.at })), ...j.sessions];
    await route.fulfill({ response: res, json: j }).catch(() => {});
  });
  await pg.goto(base, { waitUntil: 'networkidle' });
  await pg.evaluate(() => window.showView('claude'));
  await pg.waitForSelector('#claudeLiveNow button[data-claude-live]');
  await pg.evaluate(() => { const b = document.querySelector('#claudeLiveNow button[data-claude-live]'); window.__chip = b; b.focus(); });
  const before = await pg.locator('#claudeLiveNow button').first().innerText();
  age = 50;
  await pg.evaluate(() => document.getElementById('claudeRefresh').click()); // scripted poll; a real click would move focus
  await pg.waitForFunction((t) => document.querySelector('#claudeLiveNow button').innerText !== t, before);
  assert.equal(await pg.evaluate(() => document.activeElement === window.__chip && document.body.contains(window.__chip)), true);
  await pg.close();
});
await check('each chip names its state for assistive tech, and a visible state label', async () => {
  const pg = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await liveStubbed(pg, LIVE);
  await pg.goto(base, { waitUntil: 'networkidle' });
  await pg.evaluate(() => window.showView('claude'));
  await pg.waitForSelector('#claudeLiveNow button[data-claude-live]');
  const names = await liveChips(pg).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  assert.match(names[0], /live0001, working, Edit app\/server\.js, \d+s ago/);
  assert.match(names[2], /live0003, waiting, Finished responding/);
  assert.match(await liveChips(pg).nth(2).innerText(), /Waiting/);
  assert.equal(await pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await pg.close();
});
await check('live titles and steps are text, never markup', async () => {
  const pg = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  const evil = '<img src=x onerror=window.__x=1>';
  await liveStubbed(pg, [{ id: 'cc-evil0001', title: evil, state: 'working', lastEvent: evil, at: iso(3) }]);
  await pg.goto(base, { waitUntil: 'networkidle' });
  await pg.evaluate(() => window.showView('claude'));
  await pg.waitForSelector('#claudeLiveNow button[data-claude-live]');
  await pg.waitForTimeout(300);
  assert.equal(await pg.locator('#claudeLiveNow img').count(), 0);
  assert.equal(await pg.evaluate(() => window.__x), undefined);
  assert.match(await pg.locator('#claudeLiveNow button').innerText(), /<img src=x/);
  await pg.close();
});
// app.js is a module, so window.toast never existed and a failed vote fell back to a blocking alert(). It says so in the toast.
await check('a failed action says so in the toast, never a blocking alert', async () => {
  await post('/api/claude/findings', { sessionId: 'ui-test', findings: [{ id: 'ui-vote-fail', title: 'Vote target', category: 'ux', severity: 'low', summary: 'x' }] });
  const pg = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  const dialogs = []; pg.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  await pg.route('**/api/claude/findings/vote', (r) => r.fulfill({ status: 500, json: { error: 'vote store is busy' } }));
  await pg.goto(base, { waitUntil: 'networkidle' });
  await pg.evaluate(() => window.showView('claude'));
  await pg.waitForSelector('#claude .claude-finding[data-id="ui-vote-fail"] [data-claude-vote="1"]', { state: 'attached' });
  await pg.evaluate(() => document.querySelector('#claude .claude-finding[data-id="ui-vote-fail"] [data-claude-vote="1"]').click());
  await pg.waitForFunction(() => /vote store is busy/.test(document.getElementById('toast')?.textContent || ''), null, { timeout: 5000 });
  assert.deepEqual(dialogs, []);
  await pg.close();
});
await browser.close();
if (failed) process.exit(1);
