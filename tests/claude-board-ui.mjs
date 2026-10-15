// Claude page decisions: one primary action per state, no manual "Start", instant update with Undo, inline notes.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

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
await browser.close();
if (failed) process.exit(1);
