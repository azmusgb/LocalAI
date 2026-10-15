// Claude page decisions: one primary action per state, no manual "Start", instant update with Undo, inline notes.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const axePath = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
await post('/api/claude/findings', { sessionId: 'ui-test', findings: [
  { id: 'ui-test-a', title: 'UI test finding A', category: 'ux', severity: 'high' },
  { id: 'ui-test-b', title: 'UI test finding B', category: 'bug', severity: 'low' }
] });

const browser = await chromium.launch();
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS', name) } catch (e) { failed++; console.log('FAIL', name, e.message) } }
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(base, { waitUntil: 'networkidle' });
await page.evaluate(() => window.showView('claude'));
await page.waitForSelector('.claude-finding[data-id="ui-test-a"]');
const card = () => page.locator('.claude-finding[data-id="ui-test-a"]');
const count = async (tab) => Number(await page.locator(`[data-claude-status="${tab}"] b`).innerText());

await check('proposed cards offer Approve, Later and Won\'t do, never Start', async () => {
  assert.deepEqual(await card().locator('[data-claude-decision]').allInnerTexts(), ['Approve', 'Later', "Won't do"]);
  assert.equal(await page.locator('[data-claude-decision="in_progress"]').count(), 0);
  assert.match(await card().locator('.claude-state').innerText(), /Needs your decision/);
});
await check('approving moves the card to the queue at once and offers Undo', async () => {
  const decide = await count('decide'), queued = await count('queued');
  await card().locator('[data-claude-decision="approved"]').click();
  await page.waitForSelector('#claudeToast.show');
  assert.match(await page.locator('#claudeToast').innerText(), /Approved: UI test finding A/);
  assert.equal(await count('decide'), decide - 1);
  assert.equal(await count('queued'), queued + 1);
  await page.locator('#claudeToast button').click();
  await page.waitForTimeout(500);
  assert.equal(await count('decide'), decide);
  assert.match(await card().locator('.claude-state').innerText(), /Needs your decision/);
});
await check('notes for Claude are saved inline', async () => {
  await card().locator('[data-claude-note]').click();
  await page.locator('[data-claude-note-form] textarea').fill('Check with the HTTPS work first');
  await page.locator('[data-claude-note-form] button[type=submit]').click();
  await page.waitForTimeout(500);
  assert.match(await card().locator('.claude-note').innerText(), /Check with the HTTPS work first/);
  const saved = await (await fetch(`${base}/api/claude/board?session=ui-test`)).json();
  assert.equal(saved.findings.find(f => f.id === 'ui-test-a').decisionNote, 'Check with the HTTPS work first');
});
await check('on a phone, a long session title keeps the live chip, picker and Refresh on screen', async () => {
  await fetch(`${base}/api/claude/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'ui-test-long', sessionTitle: 'Sub-project 1: all 6 tasks done and reviewed; final whole-branch review running now', events: [{ kind: 'note', title: 'x' }] }) });
  const phone = await browser.newPage({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
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
    const res = await route.fetch();
    const j = await res.json();
    j.live = live;
    j.sessions = [...live.map((l) => ({ id: l.id, title: l.title, updatedAt: l.at })), ...j.sessions];
    await route.fulfill({ response: res, json: j });
  });
}
const liveChips = (pg) => pg.locator('#claudeLiveNow button[data-claude-live]');
const liveDesktop = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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
await check('the working tab label carries the live count', async () => {
  assert.match(await liveDesktop.locator('[data-claude-status="working"]').innerText(), /^Claude is working · 2 live/);
  assert.doesNotMatch(await liveDesktop.locator('[data-claude-status="queued"]').innerText(), /live/);
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

await check('with no live sessions the row is hidden and the tab label is plain', async () => {
  const pg = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await liveStubbed(pg, []);
  await pg.goto(base, { waitUntil: 'networkidle' });
  await pg.evaluate(() => window.showView('claude'));
  await pg.waitForSelector('[data-claude-status="working"]');
  assert.equal(await pg.locator('#claudeLiveNow').isVisible(), false);
  assert.match(await pg.locator('[data-claude-status="working"]').innerText(), /^Claude is working\s+\d+$/);
  await pg.close();
});
await check('on a phone the chips are 44px tall, scroll sideways, and pass axe color-contrast and target-size', async () => {
  const pg = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
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
  await pg.addScriptTag({ path: axePath });
  const v = await pg.evaluate(() => window.axe.run('#claudeLiveNow', { runOnly: { type: 'rule', values: ['color-contrast', 'target-size'] } }).then((r) => r.violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.html).join(' | ')}`)));
  assert.deepEqual(v, []);
  await pg.close();
});

await check('chips stay the same elements across polls, keeping keyboard focus', async () => {
  const pg = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let age = 5;
  await pg.route('**/api/claude/board*', async (route) => {
    const res = await route.fetch();
    const j = await res.json();
    j.live = LIVE.map((l, i) => ({ ...l, at: iso(age + i) }));
    j.sessions = [...j.live.map((l) => ({ id: l.id, title: l.title, updatedAt: l.at })), ...j.sessions];
    await route.fulfill({ response: res, json: j });
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
  const pg = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
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
  const pg = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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
await browser.close();
if (failed) process.exit(1);
