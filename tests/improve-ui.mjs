import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { addAxe } from './axe-helper.mjs';
import { checkReopenQuickly } from './sheet-reopen.mjs';

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
  finding('claude-done', { title: 'Shipped one', rank: 5, score: 0, status: 'fixed', stage: 'shipped', pr: 'https://github.com/azmusgb/LocalAI/pull/140', shipped: { version: '2.0.300', at: '2026-10-14T10:00:00.000Z' } }),
  finding('idea-waiting', { title: 'Waiting for my OK', rank: 6, score: 30, source: 'idea', stage: 'inProgress', change: { id: 'chg-2', status: 'awaiting_approval', summary: 'y' } }),
  finding('idea-failed', { title: 'Patch did not apply', rank: 7, score: 25, source: 'idea', stage: 'inProgress', change: { id: 'chg-3', status: 'patch_failed', summary: 'z' } }),
  finding('claude-held', { title: 'Claude is on it', rank: 8, score: 20, status: 'in_progress', stage: 'inProgress', sessionId: 'sess-1' }),
  finding('signal-gone', { title: 'Went away', rank: 9, score: 0, source: 'signal', status: 'fixed', stage: 'shipped', decisionNote: 'Resolved on its own', shipped: { version: '2.0.310', at: '2026-10-15T10:00:00.000Z' } }),
  finding('claude-old', { title: 'Fixed before releases were stamped', rank: 11, score: 0, status: 'fixed', stage: 'shipped', updatedAt: '2026-10-01T10:00:00.000Z' }),
  finding('claude-unstamped', { title: 'Closed on the board, no release stamp', rank: 12, score: 0, status: 'fixed', stage: 'shipped', decidedAt: '2026-10-14T12:00:00.000Z', updatedAt: '2026-10-14T12:00:00.000Z' }),
  finding('claude-fresh', { title: 'Closed after the latest release', rank: 13, score: 0, status: 'fixed', stage: 'shipped', decidedAt: '2026-10-16T12:00:00.000Z', updatedAt: '2026-10-16T12:00:00.000Z' }),
  finding('claude-new', { title: 'Newest release fix', rank: 10, score: 0, status: 'fixed', stage: 'shipped', pr: 'https://github.com/azmusgb/LocalAI/pull/150', shipped: { version: '2.0.310', at: '2026-10-15T11:00:00.000Z' } })
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
await page.route('**/api/improve/{item,idea,signal,handoff}', async r => { posts.push({ url: new URL(r.request().url()).pathname, body: r.request().postDataJSON() }); await r.fulfill({ status: 200, json: { item: ITEMS[0] } }); });
await page.route('**/api/claude/board', r => r.fulfill({ json: { sessions: [{ id: 'sess-1', title: 'Fix login', status: 'active', lastEvent: 'Running the tests', updatedAt: new Date(Date.now() - 120e3).toISOString() }] } }));
// Releases as the appliance records them (newest first): an unstamped item belongs to the first release after it closed.
await page.route('**/api/releases', r => r.fulfill({ json: { current: { version: '2.0.310' }, history: [
  { version: '2.0.310', deployedAt: '2026-10-15T09:00:00.000Z' }, { version: '2.0.305', deployedAt: '2026-10-14T20:00:00.000Z' }, { version: '2.0.300', deployedAt: '2026-10-14T09:00:00.000Z' }] } }));
await page.route('**/api/quality', r => r.fulfill({ json: { latest: { checks: [{ name: 'syntax app.js', result: 'PASS', detail: '' }] }, events: [], scans: [], summary: {} } }));
await page.goto(base + '/#backlog', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#backlog.active #backlogList .improve-row');
const lastPost = () => posts[posts.length - 1];
// Clicks, then waits for the POST that click sends (the stub records it).
async function postFrom(click) { const n = posts.length; await click(); for (let i = 0; i < 100 && posts.length === n; i++) await new Promise(r => setTimeout(r, 50)); return lastPost(); }

await check('Backlog lists only Backlog items, in rank order, with source icons and the Handed badge', async () => {
  const rows = await page.locator('#backlogList .improve-row').evaluateAll(rs => rs.map(r => ({ id: r.dataset.itemId, icon: r.querySelector('.list-row__icon use')?.getAttribute('href'), text: r.textContent })));
  assert.deepEqual(rows.map(r => r.id), ['claude-top', 'idea-sticky', 'signal-issue-1']);
  assert.deepEqual(rows.map(r => r.icon), ['#i-sparkle', '#i-improve', '#i-alert']);
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

await check('New idea: Add to backlog and Start now post the text and the choice', async () => {
  for (const [label, start] of [['Add to backlog', false], ['Start now', true]]) {
    await page.locator('#improveNewIdea').click();
    const sheet = page.locator('#improveIdeaSheet');
    await sheet.waitFor({ state: 'visible' });
    await sheet.locator('textarea').fill('Remember the last image size');
    await sheet.getByRole('button', { name: label }).click();
    await page.waitForFunction(() => !document.getElementById('improveIdeaSheet').open);
    assert.deepEqual(lastPost(), { url: '/api/improve/idea', body: { text: 'Remember the last image size', start } });
  }
});

await check('New idea: Hand to Claude hands the text to Claude Code from Improve and says where it went', async () => {
  await page.locator('#improveNewIdea').click();
  const sheet = page.locator('#improveIdeaSheet');
  await sheet.waitFor({ state: 'visible' });
  await sheet.locator('textarea').fill('Polish Agent World');
  await sheet.getByRole('button', { name: 'Hand to Claude' }).click();
  await page.waitForFunction(() => !document.getElementById('improveIdeaSheet').open);
  assert.deepEqual(lastPost(), { url: '/api/improve/handoff', body: { text: 'Polish Agent World', from: 'improve' } });
  await page.waitForFunction(() => /Handed to Claude Code — it appears in Improve › In progress/.test(document.getElementById('toast')?.textContent || ''));
});

await check('Back closes an open item or idea sheet and stays on Backlog; a sheet closed another way leaves no extra history', async () => {
  for (const [open, id] of [
    [() => page.locator('#backlogList [data-item-id="claude-top"] .improve-row__open').click(), 'improveItemSheet'],
    [() => page.locator('#improveNewIdea').click(), 'improveIdeaSheet']
  ]) {
    const before = await page.evaluate(() => history.length);
    await open();
    await page.locator('#' + id).waitFor({ state: 'visible' });
    await page.goBack();
    await page.waitForFunction(id => !document.getElementById(id).open, id);
    assert.equal(await page.evaluate(() => location.hash), '#backlog');
    assert.ok(await page.locator('#backlog.active').count(), 'still on Backlog');
    // Closed with Escape: the entry the sheet pushed is popped again, so the page's history is as before.
    await open();
    await page.locator('#' + id).waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.waitForFunction(id => !document.getElementById(id).open, id);
    await page.waitForFunction(n => history.state?.localaiSheet == null && history.length >= n, before);
    assert.equal(await page.evaluate(() => history.state?.localaiSheet ?? null), null, 'no sheet entry left on top');
  }
});

await check('an item or idea sheet closed and opened again at once stays open, three times, and leaves no entry behind', async () => {
  await page.locator('#backlogList [data-item-id="claude-top"] .improve-row__open').click();
  await page.locator('#improveItemSheet').waitFor({ state: 'visible' });
  await checkReopenQuickly(page, 'improveItemSheet', () => { document.getElementById('improveItemSheet').close(); window.LocalAIImprove.openItem('idea-sticky'); });
  await page.locator('#improveNewIdea').click();
  await page.locator('#improveIdeaSheet').waitFor({ state: 'visible' });
  await checkReopenQuickly(page, 'improveIdeaSheet', () => { document.getElementById('improveIdeaSheet').close(); window.LocalAIImprove.openIdea(); });
});

await check('Signals: open ones listed with Promote and Dismiss; a promoted one says so', async () => {
  await page.evaluate(() => window.showView('signals'));
  await page.waitForSelector('#signals.active #signalsList .improve-row');
  const ids = await page.locator('#signalsList .improve-row').evaluateAll(rs => rs.map(r => r.dataset.signalId));
  assert.deepEqual(ids, ['issue-1', 'issue-2']);
  assert.match(await page.locator('#signalsList [data-signal-id="issue-1"]').innerText(), /In the Backlog/);
  assert.deepEqual(await postFrom(() => page.locator('#signalsList [data-signal-id="issue-2"]').getByRole('button', { name: 'Promote' }).click()), { url: '/api/improve/signal', body: { id: 'issue-2', action: 'promote' } });
  assert.deepEqual(await postFrom(() => page.locator('#signalsList [data-signal-id="issue-2"]').getByRole('button', { name: 'Dismiss' }).click()), { url: '/api/improve/signal', body: { id: 'issue-2', action: 'dismiss' } });
  assert.equal(await page.locator('#signalsRunChecks').isVisible(), true, 'Run checks is in the page, also on a phone');
  assert.equal(await page.locator('#uxCommandBtn').isVisible(), true, 'Search keeps its place in the header');
});

await check('a failed Run checks shows the reason in the page under the button, not in a passing toast', async () => {
  await page.route('**/api/issues/scan', r => r.fulfill({ status: 500, json: { error: 'The checks could not start' } }));
  await page.evaluate(() => window.showView('signals'));
  await page.waitForSelector('#signals.active #signalsList .improve-row');
  await page.locator('#signalsRunChecks').click();
  const err = page.locator('#signals [role="alert"]', { hasText: 'The checks could not start' });
  await err.waitFor();
  assert.equal(await err.isVisible(), true);
  assert.equal(await err.evaluate(e => !!(document.getElementById('signalsRunChecks').compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(e.compareDocumentPosition(document.getElementById('signalsList')) & Node.DOCUMENT_POSITION_FOLLOWING)), true, 'after the button, above the list');
  assert.doesNotMatch(await page.locator('#toast').innerText(), /could not start/);
  await page.unroute('**/api/issues/scan');
});

await check('a failed vote says why under that row, in an alert', async () => {
  await page.route('**/api/claude/findings/vote', r => r.fulfill({ status: 503, json: { error: 'The board is busy' } }));
  await page.evaluate(() => window.showView('backlog'));
  await page.waitForSelector('#backlog.active #backlogList .improve-row');
  await page.locator('#backlogList [data-item-id="idea-sticky"] [data-vote="1"]').click();
  const err = page.locator('#backlogList [role="alert"]', { hasText: 'The board is busy' });
  await err.waitFor();
  assert.equal(await err.evaluate(e => e.previousElementSibling?.dataset.itemId), 'idea-sticky', 'right under the row voted on');
  assert.doesNotMatch(await page.locator('#toast').innerText(), /busy/);
  await page.unroute('**/api/claude/findings/vote');
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

await check('In progress lists running changes with their state, and a Claude-held item with its live status', async () => {
  await page.evaluate(() => window.showView('inProgress'));
  await page.waitForSelector('#inProgress.active #inProgressList .improve-row');
  const rows = await page.locator('#inProgressList .improve-row').evaluateAll(rs => rs.map(r => [r.dataset.itemId, r.querySelector('.list-row__sub').textContent]));
  assert.deepEqual(rows.map(r => r[0]), ['idea-running', 'idea-waiting', 'idea-failed', 'claude-held']);
  assert.match(rows[1][1], /Waiting for your OK/);
  assert.match(rows[2][1], /Needs a look/);
  // The session's state, not its latest step: one session holds many items, so its step would repeat on each of them.
  assert.match(rows[3][1], /Claude's session is active · 2m ago/);
  assert.doesNotMatch(rows[3][1], /Running the tests/);
});

await check('a failed change offers Retry, Back to backlog and Discard; Discard asks Back to backlog or Set aside', async () => {
  await page.locator('#inProgressList [data-item-id="idea-failed"] .improve-row__open').click();
  const sheet = page.locator('#improveItemSheet');
  await sheet.waitFor({ state: 'visible' });
  assert.deepEqual(await sheet.locator('#improveItemActions button').allInnerTexts(), ['Retry', 'Back to backlog', 'Discard']);
  await sheet.getByRole('button', { name: 'Discard' }).click();
  assert.deepEqual(await sheet.locator('#improveItemActions button').allInnerTexts(), ['Back to backlog', 'Set aside']);
  await sheet.getByRole('button', { name: 'Set aside' }).click();
  await page.waitForFunction(() => !document.getElementById('improveItemSheet').open);
  assert.deepEqual(lastPost(), { url: '/api/improve/item', body: { id: 'idea-failed', action: 'discard', then: 'aside' } });
});

await check('a planned change offers Test the change; one waiting for you offers Approve, after a confirmation', async () => {
  const changePosts = [];
  await page.route('**/api/changes/{stage,approve}', async r => { changePosts.push({ url: new URL(r.request().url()).pathname, body: r.request().postDataJSON() }); await r.fulfill({ json: { item: {} } }); });
  const sheet = page.locator('#improveItemSheet');
  await page.locator('#inProgressList [data-item-id="idea-running"] .improve-row__open').click();
  await sheet.waitFor({ state: 'visible' });
  assert.deepEqual(await sheet.locator('#improveItemActions button').allInnerTexts(), ['Test the change', 'See the changes', 'Back to backlog', 'Discard']);
  await sheet.getByRole('button', { name: 'Test the change' }).click();
  await page.waitForFunction(() => !document.getElementById('improveItemSheet').open);
  await page.locator('#inProgressList [data-item-id="idea-waiting"] .improve-row__open').click();
  await sheet.waitFor({ state: 'visible' });
  assert.deepEqual(await sheet.locator('#improveItemActions button').allInnerTexts(), ['Approve', 'See the changes', 'Back to backlog', 'Discard']);
  await sheet.getByRole('button', { name: 'Approve' }).click();
  await page.locator('.ask-sheet').getByRole('button', { name: 'Approve' }).click();
  await page.waitForFunction(() => !document.getElementById('improveItemSheet').open);
  assert.deepEqual(changePosts, [{ url: '/api/changes/stage', body: { id: 'chg-1' } }, { url: '/api/changes/approve', body: { id: 'chg-2', decision: 'approved' } }]);
});

await check('Shipped groups items by release, newest first, with the PR link or Resolved on its own', async () => {
  await page.evaluate(() => window.showView('shipped'));
  await page.waitForSelector('#shipped.active #shippedList .improve-row');
  const groups = await page.locator('#shippedList .improve-release').evaluateAll(gs => gs.map(g => [g.querySelector('h2').textContent, [...g.querySelectorAll('.improve-row')].map(r => r.dataset.itemId)]));
  assert.deepEqual(groups, [
    ['Next release', ['claude-fresh']],
    ['Version 2.0.310', ['claude-new', 'signal-gone']],
    ['Version 2.0.305', ['claude-unstamped']],
    ['Version 2.0.300', ['claude-done']],
    ['Earlier', ['claude-old']]
  ]);
  assert.deepEqual([...new Set(await page.locator('#shippedList .improve-row .list-row__icon use').evaluateAll(us => us.map(u => u.getAttribute('href'))))], ['#i-check'], 'shipped rows show a check, not a spinner-like sparkle');
  assert.equal(await page.locator('#shippedList [data-item-id="claude-new"] a').getAttribute('href'), 'https://github.com/azmusgb/LocalAI/pull/150');
  assert.match(await page.locator('#shippedList [data-item-id="signal-gone"]').innerText(), /Resolved on its own/);
});

await check('Shipped: each release is one card of rows, all the same height with or without a pull request link', async () => {
  for (const g of await page.locator('#shippedList .improve-release').all()) {
    assert.equal(await g.locator(':scope > .list-group').count(), 1, 'one card per release');
    assert.equal(await g.locator(':scope > .list-group > .improve-row').count(), await g.locator('.improve-row').count(), 'every row is in the card');
  }
  const h = id => page.locator(`#shippedList [data-item-id="${id}"]`).evaluate(r => r.getBoundingClientRect().height - parseFloat(getComputedStyle(r).borderTopWidth));   // a row after another has a 1px divider
  const [withPr, resolved, plain] = [await h('claude-new'), await h('signal-gone'), await h('claude-old')];
  assert.ok(Math.abs(withPr - resolved) < 1 && Math.abs(withPr - plain) < 1, `rows are ${withPr}, ${resolved} and ${plain}px`);
  // The link is the whole row to tap.
  const hit = await page.locator('#shippedList [data-item-id="claude-new"]').evaluate(r => { const b = r.getBoundingClientRect(); return document.elementFromPoint(b.right - 8, b.top + b.height / 2)?.closest('a')?.href || ''; });
  assert.equal(hit, 'https://github.com/azmusgb/LocalAI/pull/150');
});

await check('See the changes shows the diff inside the item sheet, without leaving In progress', async () => {
  await page.route('**/api/changes?id=*', r => r.fulfill({ json: { item: { id: 'chg-2', status: 'awaiting_approval', notes: 'Rounds the buttons.', files: [{ path: 'app/public/app.css' }], diffs: [{ path: 'app/public/app.css', diff: '-.btn{border-radius:4px}\n+.btn{border-radius:12px}' }] } } }));
  await page.evaluate(() => window.showView('inProgress'));
  await page.locator('#inProgressList [data-item-id="idea-waiting"] .improve-row__open').click();
  const sheet = page.locator('#improveItemSheet');
  await sheet.waitFor({ state: 'visible' });
  await sheet.getByRole('button', { name: 'See the changes' }).click();
  await sheet.locator('.improve-diff').waitFor();
  assert.match(await sheet.locator('.improve-diff').innerText(), /app\/public\/app\.css[\s\S]*border-radius:12px/);
  assert.equal(await page.evaluate(() => location.hash), '#inProgress');
  await sheet.getByRole('button', { name: 'Close' }).click();
});

await check('a note for Claude is saved from a Backlog item', async () => {
  const decided = page.waitForRequest(r => r.url().includes('/api/claude/findings/decision'), { timeout: 8000 }).catch(() => null); // never an unhandled rejection
  await page.route('**/api/claude/findings/decision', r => r.fulfill({ json: { item: ITEMS[0] } }));
  await page.evaluate(() => window.showView('backlog'));
  await page.locator('#backlogList [data-item-id="claude-top"] .improve-row__open').click();
  const sheet = page.locator('#improveItemSheet');
  await sheet.waitFor({ state: 'visible' });
  await sheet.locator('#improveItemNote').fill('Check with the HTTPS work first');
  await sheet.getByRole('button', { name: 'Save note' }).click();
  const req = await decided; assert.ok(req, 'no decision request');
  assert.deepEqual(req.postDataJSON(), { id: 'claude-top', status: 'approved', note: 'Check with the HTTPS work first' });
  await page.waitForFunction(() => !document.getElementById('improveItemSheet').open);
});

// After an action on a Backlog item: focus comes back to that item's row (or the next one when it left the list), and
// #toast (role=status) says what happened. The stub applies each action to ITEMS the way the server would.
const APPLY = { moveToTop: () => {}, defer: it => { it.stage = 'aside'; it.status = 'deferred'; }, reject: it => { it.stage = 'aside'; it.status = 'rejected'; }, handToClaude: it => { it.handedToClaude = true; }, start: it => { it.stage = 'inProgress'; it.change = { id: 'chg-9', status: 'planned', summary: 's' }; } };
async function itemAct(id, label, view = 'backlog') {
  const saved = ITEMS.map(i => ({ ...i }));
  const apply = async r => { const b = r.request().postDataJSON(); posts.push({ url: '/api/improve/item', body: b }); APPLY[b.action]?.(ITEMS.find(i => i.id === b.id)); await r.fulfill({ json: { item: {} } }); };
  await page.route('**/api/improve/item', apply);
  await page.evaluate(v => window.showView(v), view);
  await page.evaluate(() => window.LocalAIImprove.refresh()); // the previous check put ITEMS back
  await page.waitForSelector(`#${view}.active [data-item-id="${id}"]`);
  await page.locator(`#${view}List [data-item-id="${id}"] .improve-row__open`).click();
  const sheet = page.locator('#improveItemSheet');
  await sheet.waitFor({ state: 'visible' });
  await sheet.getByRole('button', { name: label, exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('improveItemSheet').open);
  return async () => { await page.unroute('**/api/improve/item', apply); ITEMS.splice(0, ITEMS.length, ...saved); };
}
const focusIn = sel => page.waitForFunction(s => !!document.activeElement?.closest(s), sel, { timeout: 4000 }).then(() => true, () => false);
const said = text => page.waitForFunction(t => document.getElementById('toast').textContent.includes(t), text, { timeout: 4000 }).then(() => true, () => false);

await check('Move to top: focus returns to that item\'s row and "Moved to top" is announced', async () => {
  const done = await itemAct('idea-sticky', 'Move to top');
  try {
    assert.equal(await focusIn('#backlogList [data-item-id="idea-sticky"]'), true, 'focus on the row, not ' + await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)));
    assert.equal(await said('Moved to top'), true, 'announced');
  } finally { await done(); }
});

await check('Defer: the item leaves the Backlog, focus moves to the next row, and "Deferred" is announced', async () => {
  const done = await itemAct('claude-top', 'Defer');
  try {
    await page.waitForFunction(() => !document.querySelector('#backlogList [data-item-id="claude-top"]'));
    assert.equal(await focusIn('#backlogList [data-item-id="idea-sticky"]'), true, 'focus on the next row');
    assert.equal(await said('Deferred'), true);
  } finally { await done(); }
});

await check('Reject the last item: focus moves to the row before it, and "Rejected" is announced', async () => {
  const done = await itemAct('signal-issue-1', 'Reject');
  try {
    await page.waitForFunction(() => !document.querySelector('#backlogList [data-item-id="signal-issue-1"]'));
    assert.equal(await focusIn('#backlogList [data-item-id="idea-sticky"]'), true);
    assert.equal(await said('Rejected'), true);
  } finally { await done(); }
});

await check('Hand to Claude says what happens next, the badge appears and focus stays on the row', async () => {
  const done = await itemAct('claude-top', 'Hand to Claude');
  try {
    assert.equal(await said('Claude will pick this up in its next session'), true);
    await page.waitForFunction(() => /Handed to Claude/.test(document.querySelector('#backlogList [data-item-id="claude-top"]')?.textContent || ''));
    assert.equal(await focusIn('#backlogList [data-item-id="claude-top"]'), true);
  } finally { await done(); }
});

await check('Start from the Backlog lands on In progress with the item highlighted and focused', async () => {
  const done = await itemAct('claude-top', 'Start');
  try {
    await page.waitForFunction(() => location.hash === '#inProgress' && document.querySelector('#inProgress.active'), null, { timeout: 4000 });
    const row = page.locator('#inProgressList [data-item-id="claude-top"]');
    await row.waitFor();
    assert.equal(await focusIn('#inProgressList [data-item-id="claude-top"]'), true);
    assert.match(await row.getAttribute('class'), /is-highlighted/);
    assert.equal(await said('In progress'), true);
  } finally { await done(); }
});

await check('the old pages land in Improve: #changes and #engineering on In progress, #issues and #quality on Signals', async () => {
  for (const [from, to] of [['changes', 'inProgress'], ['engineering', 'inProgress'], ['issues', 'signals'], ['quality', 'signals']]) {
    await page.evaluate(h => { location.hash = h; }, '#' + from);
    await page.waitForFunction(t => location.hash === '#' + t && document.querySelector('.view.active')?.id === t, to);
  }
});

await check('Improve has six tabs (Deployments after In progress, 31 Oct 2026), Claude Code last, and the Claude Code page shows no second priorities list', async () => {
  assert.deepEqual(await page.evaluate(() => window.LocalAIViews.sections('improve').flatMap(s => s.views)), ['backlog', 'inProgress', 'deployments', 'shipped', 'signals', 'claude']);
  assert.equal(await page.evaluate(() => window.LocalAIViews.view('claude').domain), 'improve');
  await page.evaluate(() => window.showView('claude'));
  await page.waitForSelector('#claude.active');
  assert.equal(await page.locator('#claudeFindings').isVisible(), false);
  assert.equal(await page.locator('#claudeChat').isVisible(), true);
});

await check('no colour-contrast or touch-target problems on Backlog, Signals, In progress and Shipped (axe)', async () => {
  await addAxe(page, axePath);
  const problems = [];
  for (const view of ['backlog', 'signals', 'inProgress', 'shipped']) {
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
