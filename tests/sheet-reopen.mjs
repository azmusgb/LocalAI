// Shared browser check (not a suite: the runner only picks up *-ui.mjs): a sheet closed and opened again in the same
// task stays open, keeps a Back entry of its own, and leaves no sheet entry behind once it closes.
// A <dialog>'s close event is queued, so after close-then-open it arrives while the new sheet is showing; a close
// handler that releases "the current" history entry then releases the new sheet's and strands the old one.
import assert from 'node:assert/strict';

// `page` shows sheet `id` open. `closeAndReopen` runs in the page: it closes the sheet and opens it again at once.
export async function checkReopenQuickly(page, id, closeAndReopen, { rounds = 3 } = {}) {
  const hash = await page.evaluate(() => location.hash);
  for (let i = 1; i <= rounds; i++) {
    await page.evaluate(closeAndReopen);
    await page.waitForTimeout(600);   // past sheetHistory's 500 ms pop fallback: anything late has landed
    const s = await page.evaluate(id => {
      const top = history.state?.localaiSheet ?? null;
      return { open: !!document.getElementById(id)?.open, top, live: !!window.LocalAIUI?.sheetLive?.(top) };
    }, id);
    assert.equal(s.open, true, `round ${i}: the reopened sheet closed itself`);
    assert.equal(s.live, true, `round ${i}: the reopened sheet has no live Back entry on top (top: ${s.top})`);
  }
  await page.keyboard.press('Escape');
  await page.waitForFunction(id => !document.getElementById(id)?.open, id, { timeout: 3000 });
  const left = await page.waitForFunction(() => !history.state?.localaiSheet, null, { timeout: 2000 }).then(() => null, () => page.evaluate(() => history.state?.localaiSheet));
  assert.equal(left, null, 'closing the sheet left a sheet entry on top of the page');
  assert.equal(await page.evaluate(() => location.hash), hash, 'the page did not change');
}
