import './browser-target-guard.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Every control on every page is at least 44px to touch, on phones and desktop. A small checkbox counts when its
// label row is 44px. Visible controls only. Run it against real data too (LOCALAI_URL=http://10.0.0.81:3080): lists
// with items show controls an empty server never renders.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  const page = await browser.newPage({ viewport, serviceWorkers: 'block', isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
  await page.addInitScript(() => { try { localStorage.setItem('localai.devTools', '1'); } catch {} });
  await page.goto(base + '/#home', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.showView === 'function');
  // printLab sends the browser to Pi Hub's /lab (step 6, PR 6.4; print-lab-ui checks that): it is no page of Local AI's.
  const views = await page.evaluate(() => [...document.querySelectorAll('section.view')].map(s => s.id).filter(id => id !== 'printLab'));
  await check(`${viewport.width}px: every page's controls are at least 44px to touch`, async () => {
    const small = [];
    for (const v of views) {
      await page.evaluate(v => window.showView(v), v);
      await page.waitForTimeout(300);
      small.push(...await page.evaluate(() => [...document.querySelectorAll('section.view.active :is(a,button,summary,input[type=checkbox])')].flatMap(e => {
        const b = e.getBoundingClientRect();
        if (!b.width || !b.height || getComputedStyle(e).visibility === 'hidden') return [];
        // Exempt, as WCAG 2.5.8 allows: a link inside a sentence, and the replay timeline's packed markers (Previous
        // and Next step through the same points with full-size buttons).
        if (e.tagName === 'A' && [...e.parentElement.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) return [];
        if (e.closest('.awc__replayMarkers')) return [];
        // A run row's title button carries an ::after that covers the whole row: the row is the tap target.
        const after = getComputedStyle(e, '::after');
        if (after.content !== 'none' && after.position === 'absolute' && e.closest('.list-row')?.getBoundingClientRect().height >= 43.5) return [];
        const row = e.closest('label')?.getBoundingClientRect().height || 0;
        const ok = b.height >= 43.5 || (b.width >= 43.5 && b.height >= 32) || row >= 40;
        return ok ? [] : [`${document.querySelector('section.view.active').id}: ${e.id || e.textContent.trim().slice(0, 20) || e.tagName} ${Math.round(b.width)}x${Math.round(b.height)}`];
      })));
    }
    assert.deepEqual(small, []);
  });
  await page.close();
}
await browser.close();
if (failures.length) { console.error('\nTap target failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll tap target checks passed.');
