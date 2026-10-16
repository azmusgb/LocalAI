import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { addAxe } from './axe-helper.mjs';

// Improve › Backlog and Signals (sub-project 4, task 4), with /api/improve/* stubbed.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const axePath = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}

const at = '2026-10-15T20:00:00.000Z';
const finding = (id, o) => ({ id, title: id, severity: 'medium', status: 'approved', source: 'claude', votes: { up: 0, down: 0 }, priorityBoost: 0, createdAt: at, updatedAt: at, stage: 'backlog', change: null, ...o });
const ITEMS = [
  finding('claude-top', { title: 'Fix the run drawer focus so that keyboard users land back on the row they opened, every time', rank: 1, score: 60, severity: 'high', summary: 'Focus is lost when the drawer closes.', fix: 'Return focus to the opener.', file: 'app/public/ui.js' }),
  finding('idea-sticky', { title: 'Make the header sticky', rank: 2, score: 55, source: 'idea', handedToClaude: true, decisionNote: 'Handed to Claude' }),
  finding('signal-issue-1', { title: 'TypeError in app.js', rank: 3, score: 40, source: 'signal', signalId: 'issue-1', status: 'proposed' }),
  finding('idea-running', { title: 'Already running', rank: 4, score: 35, source: 'idea', stage: 'inProgress', change: { id: 'chg-1', status: 'planned', summary: 'x' } }),
  finding('claude-done', { title: 'Shipped one', rank: 5, score: 0, status: 'fixed', stage: 'shipped' })
];
const SIGNALS = [
  { id: 'issue-1', name: 'TypeError in app.js', severity: 'high', status: 'open', occurrences: 4, lastSeenAt: at },
  { id: 'issue-2', name: 'Slow health check on the image generation service when the GPU is busy rendering a batch', severity: 'medium', status: 'open', occurrences: 1, lastSeenAt: at },
  { id: 'issue-3', name: 'Old resolved one', severity: 'low', status: 'resolved', occurrences: 2, lastSeenAt: at }
];

const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = []; page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem('localai.devTools', '1'); } catch {} });
let failItems = false;
const posts = [];
await page.route('**/api/improve/items', r => failItems ? r.fulfill({ status: 500, json: { error: 'Database is busy' } }) : r.fulfill({ json: { items: ITEMS, signals: SIGNALS } }));
await page.route('**/api/improve/{item,idea,signal}', async r => { posts.push({ url: new URL(r.request().url()).pathname, body: r.request().postDataJSON() }); await r.fulfill({ status: 200, json: { item: ITEMS[0] } }); });
await page.route('**/api/quality', r => r.fulfill({ json: { latest: { checks: [{ name: 'syntax app.js', result: 'PASS', detail: '' }] }, events: [], scans: [], summary: {} } }));
await page.goto(base + '/#backlog', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#backlog.active #backlogList .improve-row');
const lastPost = () => posts[posts.length - 1];
// Clicks, then waits for the POST that click sends (the stub records it).
async function postFrom(click) { const n = posts.length; await click(); for (let i = 0; i < 100 && posts.length === n; i++) await new Promise(r => setTimeout(r, 50)); return lastPost(); }

await check('Backlog lists only Backlog items, in rank order, with source icons and the Handed badge', async () => {
  const rows = await page.locator('#backlogList .improve-row').evaluateAll(rs => rs.map(r => ({ id: r.dataset.itemId, icon: r.querySelector('.list-row__icon use')?.getAttribute('href'), text: r.textContent })));
  assert.deepEqual(rows.map(r => r.id), ['claude-top', 'idea-sticky', 'signal-issue-1']);
  assert.deepEqual(rows.map(r => r.icon), ['#i-sparkle', '#i-compose', '#i-alert']);
  assert.match(rows[1].text, /Handed to Claude/);
  assert.doesNotMatch(rows[0].text, /Handed to Claude/);
});

await check('tapping a row opens its sheet; Move to top posts the action', async () => {
  await page.locator('#backlogList [data-item-id="claude-top"] .improve-row__open').click();
  const sheet = page.locator('#improveItemSheet');
  await sheet.waitFor({ state: 'visible' });
  assert.match(await sheet.innerText(), /Focus is lost when the drawer closes\.[\s\S]*Return focus to the opener\.[\s\S]*app\/public\/ui\.js/);
  await sheet.getByRole('button', { name: 'Move to top' }).click();
  await page.waitForFunction(() => !document.getElementById('improveItemSheet').open);
  assert.deepEqual(lastPost(), { url: '/api/improve/item', body: { id: 'claude-top', action: 'moveToTop' } });
});

await check('votes post to the board', async () => {
  const voted = page.waitForRequest(r => r.url().includes('/api/claude/findings/vote'));
  await page.route('**/api/claude/findings/vote', r => r.fulfill({ json: { item: ITEMS[0] } }));
  await page.locator('#backlogList [data-item-id="claude-top"] [data-vote="1"]').click();
  assert.deepEqual((await voted).postDataJSON(), { id: 'claude-top', delta: 1 });
});

await check('+ New idea: Add to backlog and Start now post the text and the choice', async () => {
  for (const [label, start] of [['Add to backlog', false], ['Start now', true]]) {
    await page.locator('#uxHeaderAction').click();
    const sheet = page.locator('#improveIdeaSheet');
    await sheet.waitFor({ state: 'visible' });
    await sheet.locator('textarea').fill('Remember the last image size');
    await sheet.getByRole('button', { name: label }).click();
    await page.waitForFunction(() => !document.getElementById('improveIdeaSheet').open);
    assert.deepEqual(lastPost(), { url: '/api/improve/idea', body: { text: 'Remember the last image size', start } });
  }
});

await check('Signals: open ones listed with Promote and Dismiss; a promoted one says so', async () => {
  await page.evaluate(() => window.showView('signals'));
  await page.waitForSelector('#signals.active #signalsList .improve-row');
  const ids = await page.locator('#signalsList .improve-row').evaluateAll(rs => rs.map(r => r.dataset.signalId));
  assert.deepEqual(ids, ['issue-1', 'issue-2']);
  assert.match(await page.locator('#signalsList [data-signal-id="issue-1"]').innerText(), /In the Backlog/);
  assert.deepEqual(await postFrom(() => page.locator('#signalsList [data-signal-id="issue-2"]').getByRole('button', { name: 'Promote' }).click()), { url: '/api/improve/signal', body: { id: 'issue-2', action: 'promote' } });
  assert.deepEqual(await postFrom(() => page.locator('#signalsList [data-signal-id="issue-2"]').getByRole('button', { name: 'Dismiss' }).click()), { url: '/api/improve/signal', body: { id: 'issue-2', action: 'dismiss' } });
  assert.equal(await page.locator('#uxHeaderAction').getAttribute('aria-label'), 'Run checks now');
});

await check('a failed load shows the error state with Retry, and Retry recovers', async () => {
  failItems = true;
  await page.evaluate(() => window.showView('backlog'));
  await page.evaluate(() => window.LocalAIImprove.refresh());
  await page.waitForSelector('#backlogList .state-error');
  assert.match(await page.locator('#backlogList .state-error').innerText(), /Database is busy/);
  failItems = false;
  await page.locator('#backlogList .state-error button').click();
  await page.waitForSelector('#backlogList .improve-row');
});

await check('long titles stay inside the screen on a phone (Backlog and Signals)', async () => {
  const problems = [];
  for (const view of ['backlog', 'signals']) {
    await page.evaluate(v => window.showView(v), view);
    await page.waitForSelector(`#${view}.active .improve-row`);
    problems.push(...await page.evaluate(v => {
      const out = [], sw = document.documentElement.scrollWidth, cw = document.documentElement.clientWidth;
      if (sw > cw + 1) out.push(`${v}: page ${sw}px wide in ${cw}px`);
      for (const e of document.querySelectorAll(`#${v} .improve-row *`)) { const r = e.getBoundingClientRect(); if (r.width && r.right > innerWidth + 1) { out.push(`${v}: ${e.className || e.tagName} ends at ${Math.round(r.right)}`); break; } }
      return out;
    }, view));
  }
  assert.deepEqual(problems, []);
});

await check('no colour-contrast or touch-target problems on Backlog and Signals (axe)', async () => {
  await addAxe(page, axePath);
  const problems = [];
  for (const view of ['backlog', 'signals']) {
    await page.evaluate(v => window.showView(v), view);
    await page.waitForSelector(`#${view}.active .improve-row`);
    // Pages fade in; measuring contrast mid-fade reads the text as dimmer than it is.
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.view.active')).opacity === '1');
    const found = await page.evaluate(async () => (await window.axe.run(document.querySelector('.view.active'), { runOnly: { type: 'rule', values: ['color-contrast', 'target-size'] } })).violations.map(v => `${v.id} ×${v.nodes.length}: ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(', ')}`));
    problems.push(...found.map(f => `${view}: ${f}`));
  }
  assert.deepEqual(problems, []);
});

await check('no script errors', async () => assert.deepEqual(errors, []));

await page.unrouteAll({ behavior: 'ignoreErrors' });
await browser.close();
if (failures.length) { console.error('\nImprove failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll Improve checks passed.');
