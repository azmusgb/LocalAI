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
