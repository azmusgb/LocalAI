import './browser-target-guard.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// One button kit (plan E4) on every page, phone and desktop: at most one primary action on a page (the one the page
// exists for; rows and sheets have their own), every kit button at least 44 px tall and in one type size, and no old
// .btn / .iconbtn outside Missions (being redesigned on its own).
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }

for (const vp of [{ width: 390, height: 844, mobile: true }, { width: 1280, height: 900, mobile: false }]) {
  const page = await browser.newPage({ viewport: vp, isMobile: vp.mobile, hasTouch: vp.mobile, serviceWorkers: 'block' });
  await page.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  await page.goto(base + '/#home', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIViews);
  // printLab sends the browser to Pi Hub's /lab (step 6, PR 6.4; print-lab-ui checks that): it is no page of Local AI's.
  const ids = await page.evaluate(() => window.LocalAIViews.VIEWS.filter(v => v.id !== 'agents' && v.id !== 'printLab' && document.getElementById(v.id)).map(v => v.id));
  await check(`${vp.width}px: one primary per page, kit buttons 44 px and one size, no old buttons`, async () => {
    const wrong = [];
    for (const id of ids) {
      await page.evaluate(i => window.showView(i), id);
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => {
        const v = document.querySelector('main .view.active'); if (!v) return null;
        const vis = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
        const kit = [...v.querySelectorAll('.btn-primary,.btn-outline,.btn-danger')].filter(vis);
        return {
          id: v.id,
          primaries: kit.filter(e => e.classList.contains('btn-primary') && !e.closest('.list-row,.run-card,.item-card,.artifact,dialog,.improve-row')).map(e => e.textContent.trim()),
          short: kit.filter(e => e.getBoundingClientRect().height < 43.5).map(e => `${e.textContent.trim()} ${Math.round(e.getBoundingClientRect().height)}px`),
          sizes: [...new Set(kit.map(e => getComputedStyle(e).fontSize))],
          old: [...v.querySelectorAll('.btn,.iconbtn')].filter(vis).map(e => e.textContent.trim())
        };
      });
      if (!r) continue;
      if (r.primaries.length > 1) wrong.push(`${r.id}: ${r.primaries.length} primaries (${r.primaries.join(', ')})`);
      if (r.short.length) wrong.push(`${r.id}: short ${r.short.join(', ')}`);
      if (r.sizes.length > 1) wrong.push(`${r.id}: type sizes ${r.sizes.join(', ')}`);
      if (r.old.length) wrong.push(`${r.id}: old buttons ${r.old.join(', ')}`);
    }
    assert.deepEqual(wrong, []);
  });
  await page.close();
  await check(`${vp.width}px: Home's Get started card has one primary, the next step`, async () => {
    const fresh = await browser.newPage({ viewport: vp, isMobile: vp.mobile, hasTouch: vp.mobile, serviceWorkers: 'block' });
    await fresh.goto(base + '/#home', { waitUntil: 'domcontentloaded' });
    await fresh.waitForSelector('#home .first-run [data-first-run-dismiss]', { timeout: 10000 });
    await fresh.waitForTimeout(500);
    const prim = await fresh.locator('#home .btn-primary').evaluateAll(b => b.filter(e => e.getBoundingClientRect().width > 0).map(e => e.textContent.trim()));
    assert.ok(prim.length <= 1, prim.join(', '));
    assert.equal(await fresh.locator('.first-run-foot [data-first-run-dismiss]').getAttribute('class'), 'btn-outline');
    await fresh.close();
  });
}

await browser.close();
if (failures.length) { console.error('\nButton kit failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nButton kit: all passed.');
