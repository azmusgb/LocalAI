// Home's dense Needs-you rows stay inside their card: a long one-line detail is cut with an ellipsis and every row's
// verb ("Open printer") is in view. The kit's list had one unsized grid column, so a long row widened it past the card
// and the verb and the ellipsis were clipped out of sight (seen on the appliance, 18 Nov 2026).
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const LONG = 'geometry mesh differs (E-026-A vs E-028-ANCHOR) — declare it as a dependent adjustment or fix the plan; '
  + '95.5 / 45 min per test; 44.1 / 25 g per test; 115.9 + 95.5 / 180 min for Q-007';
const ITEMS = [
  { id: 'pi:printer', tone: 'bad', title: 'Printer needs attention (0x2000b)', detail: 'It pauses the print. Alert 0x2000b.', link: '/workshop', action: 'open_printer' },
  { id: 'pi:lab:rift:E-028', tone: 'warn', title: 'E-028: Fix the plan', detail: LONG, link: '/lab', action: 'fix_plan' }
];

const browser = await chromium.launch({ headless: true });
const failures = [];
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
    await ctx.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
    const page = await ctx.newPage();
    await page.route(u => u.pathname === '/api/home/hub-needs', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: ITEMS }) }));
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#homeNeedsList .ui-needs--dense .ui-need__action', { timeout: 15000 });
    const rows = await page.$$eval('#homeNeedsList .ui-needs--dense > li', (lis) => {
      const card = document.querySelector('#homeNeedsList').getBoundingClientRect();
      return lis.filter((li) => li.querySelector('.ui-need__action')).map((li) => {
        const r = li.getBoundingClientRect(), a = li.querySelector('.ui-need__action').getBoundingClientRect(), d = li.querySelector('.ui-need__detail');
        return { title: li.querySelector('.ui-need__title')?.textContent, rowRight: r.right, actionRight: a.right, cardRight: card.right, cut: d ? d.scrollWidth > d.clientWidth : false };
      });
    });
    const where = `${viewport.width} px`;
    if (!rows.length) failures.push(`${where}: no row with a verb`);
    for (const row of rows) {
      if (row.rowRight > row.cardRight + 1) failures.push(`${where}: "${row.title}" runs ${Math.round(row.rowRight - row.cardRight)} px past the card`);
      if (row.actionRight > row.cardRight + 1) failures.push(`${where}: "${row.title}" has its verb out of sight`);
    }
    const long = rows.find((row) => row.title === 'E-028: Fix the plan');
    if (long && !long.cut) failures.push(`${where}: the long detail is not cut with an ellipsis`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
assert.deepEqual(failures, [], failures.join('\n'));
console.log('PASS home needs rows fit their card at 390 and 1440');
