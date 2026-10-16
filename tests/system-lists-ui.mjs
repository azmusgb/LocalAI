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
  const top = await page.locator('#approvalList > .approval-card').evaluateAll(cs => cs.map(c => c.className));
  assert.deepEqual(top, ['approval-card pending']);
  const resolved = page.locator('#approvalList details.approval-resolved');
  assert.match(await resolved.locator('summary').innerText(), /Resolved \(2\)/);
  assert.equal(await resolved.evaluate(d => d.open), false);
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

await check('Projects: with no projects there is one empty state, not zero tiles and an empty detail pane', async () => {
  await page.route('**/api/projects', r => r.fulfill({ json: { items: [] } }));
  await page.evaluate(() => window.showView('projects'));
  await page.waitForFunction(() => /Create your first project/.test(document.getElementById('projectList').textContent));
  assert.equal(await page.locator('#projectMetrics').isVisible(), false);
  assert.equal(await page.locator('#projectDetail').isVisible(), false);
});

await check('no script errors', async () => assert.deepEqual(errors, []));
await browser.close();
if (failures.length) { console.error('\nSystem list failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll system list checks passed.');
