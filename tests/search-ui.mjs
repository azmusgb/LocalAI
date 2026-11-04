import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Search (⌘K on desktop, the magnifier on phones): keyboard use, an empty state, a fresh start on every open.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }
// Pages with a header action (Health, Backlog…) give the phone header to that action, so each check starts on Home.
const open = async page => { await page.evaluate(() => window.showView('home')); await page.waitForSelector('#home.active'); await page.locator('#uxCommandBtn').click(); await page.waitForSelector('#cmdk.show'); };
const items = page => page.locator('#cmdkList .cmdk-item').allInnerTexts();

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  const page = await browser.newPage({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.setItem('localai.devTools', '1'); } catch {} });
  await page.goto(base + '/#home', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && document.querySelector('#uxCommandBtn'));
  const w = viewport.width;

  await check(`${w}px: Enter opens the first match`, async () => {
    await open(page);
    await page.locator('#cmdkInput').fill('model');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#models.active');
    assert.equal(await page.locator('#cmdk').getAttribute('aria-hidden'), 'true');
  });

  await check(`${w}px: every open starts empty with the full list`, async () => {
    await open(page);
    assert.equal(await page.locator('#cmdkInput').inputValue(), '');
    const n = (await items(page)).length;
    await page.keyboard.press('Escape');
    // A phone offers the 8 likeliest pages until you type (mobile-ui.mjs checks which); a desktop lists every page.
    if (w <= 760) assert.equal(n, 8); else assert.ok(n > 10, `${n} pages`);
  });

  await check(`${w}px: arrows move the selection and Enter opens it`, async () => {
    await open(page);
    await page.locator('#cmdkInput').fill('health');
    const first = (await items(page))[0];
    await page.keyboard.press('ArrowDown');
    const selected = await page.locator('#cmdkList [aria-selected="true"]').innerText();
    if ((await items(page)).length > 1) assert.notEqual(selected, first); else assert.equal(selected, first);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#cmdk.show'));
  });

  await check(`${w}px: typing a tool's name finds it from the registry, and Enter opens it in a new tab`, async () => {
    await open(page);
    await page.locator('#cmdkInput').fill('grafana');
    const tool = page.locator('#cmdkList [data-cmd-tool="tool:network"]');
    assert.equal(await tool.count(), 1, 'Grafana is listed');
    assert.equal(await page.locator('#cmdkList [data-cmd-tool="tool:assistant"]').count(), 0, 'not this app');
    await page.context().route(/rahe-home\.duckdns\.org/, r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>stand-in</title>' })); // nothing leaves this machine
    const popup = page.waitForEvent('popup');
    await page.keyboard.press('Enter');
    assert.match((await popup).url(), /^https:\/\/network\.rahe-home\.duckdns\.org\//);
    assert.equal(await page.locator('#cmdk').getAttribute('aria-hidden'), 'true');
  });

  await check(`${w}px: no match says so and offers to search your work`, async () => {
    await open(page);
    await page.locator('#cmdkInput').fill('zzqx');
    assert.match(await page.locator('#cmdkList').innerText(), /No pages match/);
    await page.locator('#cmdkList [data-cmd-work]').click();
    await page.waitForSelector('#work.active');
    await page.waitForFunction(() => document.getElementById('workSearch').value === 'zzqx', null, { timeout: 3000 });
  });

  await check(`${w}px: Escape closes it, hides it from screen readers and returns focus`, async () => {
    await open(page);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#cmdk.show').count(), 0);
    assert.equal(await page.locator('#cmdk').getAttribute('aria-hidden'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'uxCommandBtn');
  });

  await check(`${w}px: the hidden Runs page (a copy of Work) is not offered`, async () => {
    await open(page);
    await page.locator('#cmdkInput').fill('runs');
    assert.ok(!(await items(page)).includes('Runs'), `offered: ${await items(page)}`);
    await page.keyboard.press('Escape');
  });

  await check(`${w}px: hidden and retired pages are not offered; their old names find the page that replaced them`, async () => {
    await open(page);
    const offered = await items(page);
    for (const label of ['Chat', 'Images', 'Missions', 'Runs', 'Change requests', 'Issues', 'Quality signals']) assert.ok(!offered.includes(label), `${label} offered: ${offered}`);
    for (const [typed, label] of [['change requests', 'In progress'], ['quality', 'Signals'], ['missions', 'Work']]) {
      await page.locator('#cmdkInput').fill(typed);
      assert.ok((await items(page)).includes(label), `"${typed}" offers ${label}: ${await items(page)}`);
    }
    await page.keyboard.press('Escape');
  });

  await check(`${w}px: no script errors`, async () => assert.deepEqual(errors, []));
  await page.close();
}
// No developer-tools switch (2 Nov): ⌘K offers every tool, the owner's pages and Tools itself, with nothing switched on.
await check('⌘K offers every tool, Tools and the owner pages without any switch', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  await page.goto(base + '/#home', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && document.querySelector('#uxCommandBtn'));
  await open(page);
  const offered = await items(page);
  assert.ok(offered.includes('Assistant status') && offered.includes('Models') && offered.includes('Claude Code') && offered.includes('Tools'), `owner pages offered: ${offered}`);
  for (const [term, label] of [['files', 'Files'], ['repository', 'Repository'], ['powershell', 'PowerShell'], ['browser', 'Browser & computer'], ['n8n', 'n8n workflows'], ['atlas', 'Architecture']]) {
    await page.locator('#cmdkInput').fill(term);
    assert.ok((await items(page)).includes(label), `${label} offered for "${term}": ${await items(page)}`);
  }
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  await page.close();
});
await browser.close();
if (failures.length) { console.error('\nSearch failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll search checks passed.');
