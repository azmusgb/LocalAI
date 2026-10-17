import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// System lists: Approvals shows waiting items first with resolved ones folded away; the Audit log's Clear button is not the page's headline action.
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
await page.goto(base + '/#approvals', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.showView === 'function');
const open = async () => { await page.evaluate(() => window.showView('approvals')); await page.waitForSelector('#approvals.active #approvalList .approval-card, #approvals.active #approvalList .empty'); };

await check('Approvals: waiting items are listed; resolved ones sit in a closed "Resolved (2)" section', async () => {
  await open();
  await page.waitForSelector('#approvalList .approval-card.pending');
  const top = await page.locator('#approvalList > .approval-list > .approval-card').evaluateAll(cs => cs.map(c => c.className));
  assert.deepEqual(top, ['approval-card pending']);
  const resolved = page.locator('#approvalList details.approval-resolved');
  assert.match(await resolved.locator('summary').innerText(), /Resolved \(2\)/);
  assert.equal(await resolved.evaluate(d => d.open), false);
});

await check('Approvals: Approve confirms in the owner\'s words', async () => {
  await page.route('**/api/approvals/decide', r => r.fulfill({ json: { item: { id: 'a1', status: 'approved' } } }));
  await page.locator('#approvalList [data-app-ok="a1"]').click();
  await page.waitForFunction(() => document.getElementById('toast').textContent === 'Approved — Local AI will apply it');
});

await check('Approvals: with nothing pending it says so, above the resolved section', async () => {
  items = [card('a2', 'approved')];
  await page.evaluate(() => window.showView('home'));
  await open();
  await page.waitForFunction(() => /Nothing is waiting for you/.test(document.getElementById('approvalList').textContent));
  assert.match(await page.locator('#approvalList details.approval-resolved summary').innerText(), /Resolved \(1\)/);
});

await check('Audit log: Clear user activity is not in the page header', async () => {
  await page.evaluate(() => window.showView('activity'));
  await page.waitForSelector('#activity.active');
  assert.equal(await page.locator('#activity .topbar #clearUserActivityBtn').count(), 0);
  assert.equal(await page.locator('#activity #clearUserActivityBtn').count(), 1);
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
  await page.waitForFunction(() => /Create your first project/.test(document.getElementById('projectList').textContent));
  assert.equal(await page.locator('#projectMetrics').isVisible(), false);
  assert.equal(await page.locator('#projectDetail').isVisible(), false);
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
  await page.fill('#autoName', 'Nightly health');
  const created = page.waitForRequest(r => r.url().endsWith('/api/monitors/create'));
  await page.locator('#autoCreateBtn').click();
  assert.deepEqual((await created).postDataJSON(), { name: 'Nightly health', kind: 'health' });
  const row = page.locator('#automationList .item-card', { hasText: 'Nightly health' });
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

await check('no script errors', async () => assert.deepEqual(errors, []));
await browser.close();
if (failures.length) { console.error('\nSystem list failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll system list checks passed.');
