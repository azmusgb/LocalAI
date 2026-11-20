import './browser-target-guard.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// System › Audit log: a run of restarts (one per update) is one line, so the events around it stay visible.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }
const at = m => new Date(Date.UTC(2026, 9, 16, 12, m)).toISOString();
const started = (v, m) => ({ id: 'a' + m, type: 'system', title: 'Appliance started', detail: `Local AI Appliance v${v} is ready.`, at: at(m), meta: {} });
const ITEMS = [started('2.0.390', 50), started('2.0.388', 40), started('2.0.385', 30),
  { id: 'b1', type: 'image', title: 'Image created', detail: 'A red fox', at: at(20), meta: {} },
  started('2.0.380', 10), { id: 'b2', type: 'chat', title: 'Chat', detail: 'Hello', at: at(5), meta: {} }];

const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
await page.route(u => u.pathname === '/api/activity', r => r.fulfill({ json: { items: ITEMS } }));
await page.goto(base + '/#activity', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#activity.active #activityList .activity-item, #activity.active #activityList > *');

await check('consecutive restarts are one line with the versions they went through; single events stay as they are', async () => {
  await page.waitForFunction(() => document.querySelector('#activityList')?.textContent.includes('Image created'));
  const text = await page.locator('#activityList').innerText();
  assert.match(text, /Appliance updated 3 times[\s\S]*v2\.0\.385 → v2\.0\.390/);
  assert.equal((text.match(/Appliance started/g) || []).length, 1, 'a lone restart keeps its own line');
  assert.match(text, /Image created[\s\S]*Appliance started[\s\S]*Local AI Appliance v2\.0\.380 is ready/);
});
await check('the subtitle points to Work, not the hidden Runs page', async () => {
  assert.doesNotMatch(await page.locator('#activity .topbar .sub').innerText(), /\bRuns\b/);
});

await browser.close();
if (failures.length) { console.error('\nAudit log failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll audit log checks passed.');
