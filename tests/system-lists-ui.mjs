import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// System lists: the Inbox shows waiting approvals first with decided ones folded into History; the Audit log's Clear button is not the page's headline action.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}
const card = (id, status) => ({ id, title: `Approval ${id}`, detail: 'Writes a file', risk: 'medium', status });
let items = [card('a1', 'pending'), card('a2', 'approved'), card('a3', 'rejected')];
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = []; page.on('pageerror', e => errors.push(e.message));
await page.route('**/api/approvals', r => r.fulfill({ json: { items } }));
await page.route('**/api/notifications', r => r.fulfill({ json: { items: [], unread: 0 } }));
await page.goto(base + '/#inbox', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.showView === 'function');
const open = async () => { await page.evaluate(() => window.showView('inbox')); await page.waitForSelector('#inbox.active #inboxList .inbox-waiting, #inbox.active #inboxList .empty-state'); };

await check('Inbox: waiting approvals come first; decided ones sit in a closed "History (2)" section', async () => {
  await open();
  await page.waitForSelector('#inboxList .inbox-waiting li');
  assert.deepEqual(await page.locator('#inboxList .inbox-waiting li').allInnerTexts().then(t => t.map(x => /Approval a1/.test(x))), [true]);
  const history = page.locator('#inboxList details.inbox-resolved');
  assert.match(await history.locator('summary').innerText(), /History \(2\)/);
  assert.equal(await history.evaluate(d => d.open), false);
});

await check('Inbox: Approve in the sheet confirms in the owner\'s words', async () => {
  await page.route('**/api/approvals/decide', r => { items[0] = card('a1', 'approved'); r.fulfill({ json: { item: { id: 'a1', status: 'approved' } } }); });
  await page.locator('#inboxList [data-approval-open="a1"]').click();
  await page.locator('#approvalSheet [data-decide="approved"]').click();
  await page.waitForFunction(() => document.getElementById('toast').textContent === 'Approved — Local AI will apply it');
});

await check('Inbox: with nothing waiting it says so, above the history', async () => {
  items = [card('a2', 'approved')];
  await page.evaluate(() => window.showView('home'));
  await open();
  await page.waitForFunction(() => /Nothing needs you right now/.test(document.getElementById('inboxList').textContent));
  assert.match(await page.locator('#inboxList details.inbox-resolved summary').innerText(), /History \(1\)/);
});

const EMPTY = /^[^.]+ appear(s)? here\. [A-Z][^.]*\.$|^What happens on Local AI is listed here\. [^.]+\.$/;
await check('Audit log: Clear user activity is not in the page header, and shows only when there is user activity to clear (E3)', async () => {
  let activity = [{ id: 's1', type: 'system', title: 'Appliance started', detail: 'v2.0.1', createdAt: new Date().toISOString() }];
  await page.route('**/api/activity', r => r.fulfill({ json: { items: activity } }));
  await page.evaluate(() => window.showView('activity'));
  await page.waitForFunction(() => { const t = document.querySelector('#activity.active #activityList')?.innerText || ''; return /Appliance started/.test(t) && !/Asked/.test(t) && document.querySelectorAll('#activityList > *').length === 1; });
  assert.equal(await page.locator('#activity .topbar #clearUserActivityBtn').count(), 0);
  assert.equal(await page.locator('#activity #clearUserActivityBtn').count(), 1);
  assert.equal(await page.locator('#clearUserActivityBtn').isVisible(), false, 'a log of system events only has nothing to clear');
  activity = [...activity, { id: 'u1', type: 'chat', title: 'Asked a question', detail: '', createdAt: new Date().toISOString() }];
  await page.evaluate(() => window.showView('home')); await page.evaluate(() => window.showView('activity'));
  await page.locator('#clearUserActivityBtn').waitFor({ state: 'visible' });
  activity = [];
  await page.evaluate(() => window.showView('home')); await page.evaluate(() => window.showView('activity'));
  await page.waitForFunction(() => /listed here/.test(document.getElementById('activityList').textContent));
  assert.match((await page.locator('#activityList').innerText()).trim(), EMPTY);
  assert.equal(await page.locator('#clearUserActivityBtn').isVisible(), false);
  await page.unroute('**/api/activity');
});

await check('Health: the Notifications card comes after the Appliance summary', async () => {
  await page.evaluate(() => window.showView('status'));
  await page.waitForSelector('#status #notifications', { state: 'attached' });
  assert.equal(await page.evaluate(() => !!(document.getElementById('statusSummary').compareDocumentPosition(document.getElementById('notifications')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
});

// Health must not say "ready" when the check itself failed: a 500 or an answer without services keeps the last known
// list and says the check couldn't be made.
const healthy = { overall: 'HEALTHY', checkedAt: new Date().toISOString(), services: [{ name: 'ollama', label: 'Intelligence', state: 'HEALTHY', required: true }, { name: 'comfy', label: 'Images', state: 'HEALTHY', required: false }] };
const checkAgain = async () => { await page.evaluate(() => document.getElementById('statusRetryBtn').click()); await page.waitForFunction(() => document.getElementById('statusRetryBtn').textContent === 'Check again'); };
await check('Health: a failed status check says so and keeps the last known services', async () => {
  await page.route('**/api/status', r => r.fulfill({ json: healthy }));
  await page.evaluate(() => window.showView('status'));
  await checkAgain();
  await page.waitForFunction(() => /Everything is ready/.test(document.getElementById('statusSummary').textContent));
  assert.equal(await page.locator('#serviceList .service-card').count(), 2);
  assert.equal(await page.locator('#statusSummary').getAttribute('role'), 'status');

  await page.route('**/api/status', r => r.fulfill({ status: 500, json: { error: 'boom' } }));
  await checkAgain();
  const summary = await page.locator('#statusSummary').innerText();
  assert.match(summary, /Couldn't check the services\. Try again/);
  assert.doesNotMatch(summary, /ready/i);
  assert.equal(await page.locator('#serviceList .service-card').count(), 2, 'the last known list stays');
  assert.match(await page.locator('#serviceList').innerText(), /Intelligence/);
  assert.equal(await page.locator('#serviceList .status-error').count(), 1);
});
await check('Health: an answer without a service list is a failed check, not "ready"', async () => {
  await page.route('**/api/status', r => r.fulfill({ json: {} }));
  await checkAgain();
  const summary = await page.locator('#statusSummary').innerText();
  assert.match(summary, /Couldn't check the services\. Try again/);
  assert.doesNotMatch(summary, /ready/i);
  assert.equal(await page.locator('#serviceList .service-card').count(), 2);
  assert.doesNotMatch(await page.locator('#home').innerText(), /Healthy/);
});

// During a deploy the HTTPS front end answers 503 {error:"Local AI is updating"} with Retry-After (deploy/caddy/Caddyfile).
await check('Health: while Local AI restarts for an update, the check says "updating", not that it failed', async () => {
  await page.route('**/api/status', r => r.fulfill({ status: 503, headers: { 'Retry-After': '5' }, json: { error: 'Local AI is updating', updating: true } }));
  await checkAgain();
  const summary = await page.locator('#statusSummary').innerText();
  assert.match(summary, /Local AI is updating…/);
  assert.doesNotMatch(summary, /Couldn't check/);
  assert.match(await page.locator('#serviceList .status-error').innerText(), /Local AI is updating\. This checks again in a moment\./);
  assert.equal(await page.locator('#homeState').innerText(), 'Updating…');
  assert.equal(await page.locator('#serviceList .service-card').count(), 2, 'the last known list stays');
  // It looks again after Retry-After on its own: once Local AI is back, the services show without a tap.
  await page.route('**/api/status', r => r.fulfill({ json: { ...healthy, checkedAt: new Date().toISOString() } }));
  await page.waitForFunction(() => /Everything is ready/.test(document.getElementById('statusSummary').textContent), null, { timeout: 9000 });
  await page.route('**/api/status', r => r.fulfill({ json: {} }));
  await checkAgain();
});

await check('Health: a failed check says when it was tried and when the list was last right', async () => {
  assert.match(await page.locator('#statusCheckedAt').innerText(), /^Tried \d{1,2}:\d{2}:\d{2}.* · last good check \d{1,2}:\d{2}:\d{2}/);
});
// iOS can freeze a request when the app goes to the background. One that never answers must time out, or it holds
// the "checking" flag forever and every later check is skipped, leaving an old failure on screen.
await check('Health: a status request that never answers times out, and the next check still runs', async () => {
  await page.route('**/api/status', () => {}); // never fulfilled
  await page.evaluate(() => document.getElementById('statusRetryBtn').click());
  await page.waitForFunction(() => document.getElementById('statusRetryBtn').textContent === 'Check again', null, { timeout: 25000 });
  assert.match(await page.locator('#statusSummary').innerText(), /Couldn't check the services/);
  await page.route('**/api/status', r => r.fulfill({ json: { ...healthy, checkedAt: new Date().toISOString() } }));
  await checkAgain();
  await page.waitForFunction(() => /Everything is ready/.test(document.getElementById('statusSummary').textContent));
  assert.match(await page.locator('#statusCheckedAt').innerText(), /^Checked /);
});

// Reviewing a change reads in the owner's words, not the planner's.
await check('Changes: an unplanned change reads "Nothing to apply yet", "Not tested yet", "Changes appear after testing"', async () => {
  await page.route('**/api/changes', r => r.fulfill({ json: { items: [{ id: 'chg-1', status: 'planned', target: 'self', request: 'Make the header fit on phones', summary: 'Header fits on phones', files: [], validation: null, diffs: [], createdAt: new Date().toISOString() }], pending: 0 } }));
  // The change detail lives in the run view now (Change requests is retired); render it the way the run view does.
  await page.evaluate(() => { const el = document.createElement('div'); el.id = 'testChangeDetail'; document.body.appendChild(el); window.LocalAIChanges.show('chg-1', el); });
  await page.waitForFunction(() => /Header fits on phones/.test(document.getElementById('testChangeDetail').textContent));
  const text = await page.locator('#testChangeDetail').innerText();
  await page.evaluate(() => document.getElementById('testChangeDetail').remove());
  assert.match(text, /Nothing to apply yet/);
  assert.match(text, /Not tested yet/);
  assert.match(text, /Changes appear after testing/);
  assert.doesNotMatch(text, /patch|workspace|validated/i);
});

await check('Projects: with no projects there is one empty state, not zero tiles and an empty detail pane', async () => {
  await page.route('**/api/projects', r => r.fulfill({ json: { items: [] } }));
  await page.evaluate(() => window.showView('projects'));
  await page.waitForFunction(() => /Your projects appear here/.test(document.getElementById('projectList').textContent));
  assert.match((await page.locator('#projectList').innerText()).trim(), EMPTY);
  assert.equal(await page.locator('#projectMetrics').isVisible(), false);
  assert.equal(await page.locator('#projectDetail').isVisible(), false);
  assert.doesNotMatch(await page.locator('#projects').innerText(), /workspace/i);
});

await check('Empty states say what appears and how (E3): Automations, Sources, Library, Signals without an empty Latest checks', async () => {
  await page.route('**/api/automations', r => r.fulfill({ json: { items: [], runs: [] } }));
  await page.route('**/api/monitors', r => r.fulfill({ json: { items: [] } }));   // health checks share the list
  await page.route('**/api/library', r => r.fulfill({ json: { items: [] } }));
  await page.route('**/api/quality', r => r.fulfill({ json: { latest: null, events: [] } }));
  await page.evaluate(() => window.showView('automationStudio'));
  await page.waitForFunction(() => /appear here/.test(document.getElementById('automationList').textContent));
  assert.match((await page.locator('#automationList').innerText()).trim(), EMPTY);
  await page.evaluate(() => window.showView('library'));
  await page.waitForFunction(() => /appears? here/.test(document.getElementById('libraryGrid').textContent));   // "What you keep appears here"
  assert.match((await page.locator('#libraryGrid').innerText()).trim(), EMPTY);
  await page.evaluate(() => window.showView('signals'));
  await page.waitForSelector('#signals.active');
  await page.waitForFunction(() => document.querySelector('#signalsScan > *'));
  assert.equal(await page.locator('#signalsDetails').isVisible(), false, 'no empty Latest checks');
  for (const u of ['**/api/automations', '**/api/monitors', '**/api/library', '**/api/quality']) await page.unroute(u);
});

// Health's technical detail (probe names, HTTP results) is for a developer: it shows only with developer tools on.
await check('Health: Advanced service details shows only with developer tools on', async () => {
  await page.evaluate(() => window.showView('status'));
  await page.waitForSelector('#status.active #technicalStatus', { state: 'attached' });
  const details = page.locator('#status details:has(#technicalStatus)');
  await page.evaluate(() => document.body.classList.add('dev-tools-off'));
  assert.equal(await details.isVisible(), false, 'hidden with developer tools off');
  await page.evaluate(() => document.body.classList.remove('dev-tools-off'));
  assert.equal(await details.isVisible(), true, 'shown with developer tools on');
});

// One Automations page (D9): Monitors folded in as the kinds Health check and Morning brief; "Open n8n" stays a button.
// The health check below is really created on the server, which has no way to delete one, and a server reused across
// runs keeps every earlier one (and other suites' automations). So the page sees only what this run creates: it starts
// empty, as on a fresh server, which keeps the phone's New form open, and the new row is found by this run's name.
const MONITOR = `Nightly health ${Date.now().toString(36)}`;
const ours = async (route, keep) => {
  const res = await route.fetch().catch(() => null); if (!res) return route.abort().catch(() => {});
  const j = await res.json(); route.fulfill({ json: { ...j, items: (j.items || []).filter(keep) } });
};
await page.route('**/api/automations', r => ours(r, () => false));
await page.route('**/api/monitors', r => ours(r, m => m.name === MONITOR));
await check('Automations: an old #operations link lands on Automations, which has the four kinds and Open n8n', async () => {
  await page.evaluate(() => { location.hash = '#operations'; });
  await page.waitForSelector('#automationStudio.active');
  assert.equal(await page.evaluate(() => location.hash), '#automationStudio');
  assert.equal(await page.locator('#operations').count(), 0, 'Monitors is no longer a page of its own');
  assert.deepEqual(await page.locator('#autoKind option').allInnerTexts(), ['Prompt', 'Research', 'Health check', 'Morning brief']);
  assert.equal(await page.locator('#automationStudio a[href="/go/n8n"]').innerText(), 'Open n8n ↗');
});

await check('Automations: a health monitor is created with kind "Health check" and listed with the automations', async () => {
  await page.selectOption('#autoKind', 'monitor');
  assert.equal(await page.locator('#autoSchedule').isVisible(), false, 'a health check runs every 15 minutes; no schedule to pick');
  assert.equal(await page.locator('#autoPrompt').isVisible(), false, 'a health check needs no instruction');
  assert.match(await page.locator('#autoKindNote').innerText(), /15 minutes/);
  await page.fill('#autoName', MONITOR);
  const created = page.waitForRequest(r => r.url().endsWith('/api/monitors/create'));
  await page.locator('#autoCreateBtn').click();
  assert.deepEqual((await created).postDataJSON(), { name: MONITOR, kind: 'health' });
  const row = page.locator('#automationList .item-card', { hasText: MONITOR });
  await row.waitFor();
  assert.match(await row.innerText(), /Health check/);
  assert.equal(await row.locator('[data-monitor-run]').count(), 1, 'Run now checks it at once');
  await page.waitForFunction(() => /Health check created/.test(document.getElementById('toast').textContent));
});

await check('Automations: Generate brief lives on Automations, as the Morning brief kind', async () => {
  await page.selectOption('#autoKind', 'brief');
  assert.equal(await page.locator('#autoCreateBtn').isVisible(), false);
  const brief = page.locator('#automationStudio #briefBtn');
  assert.equal(await brief.innerText(), 'Generate brief');
  await brief.click();
  await page.waitForFunction(() => /system health/i.test(document.getElementById('briefBox')?.textContent || ''));
  assert.equal(await page.locator('#briefBox').isVisible(), true);
  await page.selectOption('#autoKind', 'prompt');
  assert.equal(await page.locator('#autoSchedule').isVisible(), true);
  assert.equal(await page.locator('#autoCreateBtn').isVisible(), true);
});
for (const u of ['**/api/automations', '**/api/monitors']) await page.unroute(u);

// Automations, Sources and Memory: on a phone the owner's items come first and the "New …" form opens from a button;
// with nothing yet the form is the empty state and stays open. On a computer the cards beside the form fit their content.
const ago = new Date().toISOString();
const listed = { automations: { items: [1, 2, 3].map(n => ({ id: `a${n}`, name: `Automation ${n}`, kind: 'prompt', schedule: 'daily', enabled: true })), runs: [] },
  knowledge: { items: [1, 2, 3].map(n => ({ id: `k${n}`, name: `source-${n}.md`, size: 2048, projectId: '' })) },
  memory: { items: [1, 2, 3].map(n => ({ id: `m${n}`, category: 'note', text: `Memory ${n}`, pinned: false, createdAt: ago })) } };
async function foldPage(viewport, data) {
  const p = await browser.newPage({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500, serviceWorkers: 'block' });
  p.on('pageerror', e => errors.push(e.message));
  await p.route('**/api/automations', r => r.fulfill({ json: data.automations }));
  await p.route('**/api/monitors', r => r.fulfill({ json: { items: [] } }));
  await p.route('**/api/knowledge', r => r.fulfill({ json: data.knowledge }));
  await p.route(/\/api\/memory\?/, r => r.fulfill({ json: data.memory }));
  await p.goto(base + '/#home', { waitUntil: 'load' });
  await p.waitForFunction(() => typeof window.showView === 'function');
  return p;
}
const FOLDS = [['automationStudio', 'autoForm', '#automationList .item-card', '#autoName', 'New automation'],
  ['knowledge', 'knowledgeForm', '#knowledgeList .item-card', '#knowledgeName', 'New source'],
  ['memory', 'memoryForm', '#memoryList .memory-card', '#memoryText', 'New memory']];
await check('Automations, Sources and Memory on a phone: items first, the "New …" form opens from a button', async () => {
  const p = await foldPage({ width: 390, height: 844 }, listed);
  for (const [view, form, item, field, label] of FOLDS) {
    await p.evaluate(v => window.showView(v), view);
    await p.waitForSelector(`#${view}.active ${item}`);
    await p.waitForFunction(v => !document.getElementById(v).classList.contains('no-items'), view);
    const toggle = p.locator(`#${form} > .phone-fold__toggle`);
    assert.equal(await toggle.innerText(), label, view);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false', view);
    assert.equal(await p.locator(field).isVisible(), false, `${view}: the empty form is folded away`);
    const top = await p.locator(item).first().evaluate(e => e.getBoundingClientRect().top);
    assert.ok(top < 844 - 120, `${view}: the first item starts at ${Math.round(top)}px, on the first screen`);
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', view);
    assert.equal(await p.locator(field).isVisible(), true, `${view}: the button opens the form`);
    await toggle.click();
    assert.equal(await p.locator(field).isVisible(), false, `${view}: and closes it`);
  }
  assert.equal(await p.locator('#memoryProject').isVisible(), true, 'Memory keeps its project picker, which chooses the list');
  await p.close();
});
await check('Automations, Sources and Memory on a phone: with nothing yet the form stays open as the empty state', async () => {
  const p = await foldPage({ width: 390, height: 844 }, { automations: { items: [], runs: [] }, knowledge: { items: [] }, memory: { items: [] } });
  for (const [view, form, , field] of FOLDS) {
    await p.evaluate(v => window.showView(v), view);
    await p.waitForFunction(v => document.getElementById(v).classList.contains('no-items'), view);
    assert.equal(await p.locator(`#${form} > .phone-fold__toggle`).isVisible(), false, view);
    assert.equal(await p.locator(field).isVisible(), true, `${view}: the form is open`);
  }
  await p.close();
});
await check('Automations, Sources and Memory on a computer: the form shows as before; the card beside it fits its content', async () => {
  const p = await foldPage({ width: 1440, height: 900 }, listed);
  for (const [view, form, item, field] of FOLDS) {
    await p.evaluate(v => window.showView(v), view);
    await p.waitForSelector(`#${view}.active ${item}`);
    assert.equal(await p.locator(`#${form} > .phone-fold__toggle`).isVisible(), false, view);
    assert.equal(await p.locator(field).isVisible(), true, view);
  }
  for (const view of ['knowledge', 'memory']) {
    await p.evaluate(v => window.showView(v), view);
    const [a, b] = await p.locator(`#${view} > .two > .card`).evaluateAll(cs => cs.map(c => c.getBoundingClientRect().height));
    assert.ok(b < a - 100, `${view}: the side card is ${Math.round(b)}px beside a ${Math.round(a)}px form, not stretched to it`);
  }
  await p.close();
});

await check('no script errors', async () => assert.deepEqual(errors, []));
await browser.close();
if (failures.length) { console.error('\nSystem list failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll system list checks passed.');
