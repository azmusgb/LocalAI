// Loads axe into a page so that axe.run waits for finite animations (a dialog's 160 ms fade-in) to finish first:
// axe reads colours mid-fade otherwise and reports contrast that is not there. Endless animations (spinners) are ignored.
export async function addAxe(page, axePath) {
  await page.addScriptTag({ path: axePath });
  await page.evaluate(() => {
    const run = window.axe.run.bind(window.axe);
    const busy = () => document.getAnimations().some(a => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity);
    window.axe.run = async (...args) => {
      const t = Date.now();
      while (busy() && Date.now() - t < 3000) await new Promise(r => setTimeout(r, 30));
      return run(...args);
    };
  });
}

// Home's composer is pinned over the page, so wherever the page rests a link or button can sit half under it, and axe
// measures a half-covered control as a small target. That is where the scroll stopped, not the control's size. This
// scrolls until no control of the page straddles an edge of the composer, and returns how many still do (0 when settled,
// also when there is no composer on screen). axe then runs on everything, as before.
export async function clearOfComposer(page, composer = '#homeComposer') {
  return page.evaluate(async sel => {
    const box = document.querySelector(sel);
    const cut = () => {
      const c = box?.getBoundingClientRect();
      if (!c || !c.height || !box.offsetParent && getComputedStyle(box).position !== 'fixed') return [];
      return [...document.querySelectorAll('a[href],button,input,select,textarea,[role="button"]')].filter(e => !box.contains(e) && e.offsetParent).map(e => e.getBoundingClientRect())
        .filter(r => r.height && r.right > c.left && r.left < c.right && r.bottom > c.top && r.top < c.bottom && !(r.top >= c.top && r.bottom <= c.bottom));
    };
    for (let i = 0; i < 20; i++) {
      const [r] = cut();
      if (!r) return 0;
      const before = scrollY;
      scrollBy(0, Math.ceil(r.bottom - box.getBoundingClientRect().top));
      await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
      if (scrollY === before) break;   // the page can't move further
    }
    return cut().length;
  }, composer);
}
