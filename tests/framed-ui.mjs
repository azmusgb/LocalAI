import './browser-target-guard.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Pi Hub amendment A4, step 7a (Local AI's half), in a real browser. Playwright answers for two made-up parents: Pi Hub's
// own address (its /assistant page frames Local AI) and another site. Local AI is reached as assistant.… and served by the
// test server, so the browser applies the real frame-ancestors header and sees the real parent origins.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const HUB = 'https://hub.rahe-home.duckdns.org';
const AI = 'https://assistant.rahe-home.duckdns.org';
const parent = src => `<!doctype html><html><body style="margin:0"><script>window.got=[];addEventListener('message',e=>{if(e.origin===${JSON.stringify(AI)})window.got.push(e.data)})</script>
<iframe id="f" title="Assistant" src="${src}" style="border:0;width:100vw;height:100vh"></iframe></body></html>`;
const failures = [];
const check = async (name, fn) => { try { await fn(); console.log('ok -', name); } catch (e) { failures.push(name); console.error('not ok -', name, '\n', e); } };

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await context.route(`${AI}/**`, async route => {
    const u = new URL(route.request().url());
    try { await route.fulfill({ response: await route.fetch({ url: base + u.pathname + u.search, headers: { ...route.request().headers(), ...(route.request().headers().origin ? { origin: base } : {}), 'sec-fetch-site': 'same-origin' } }) }); } catch { /* the browser closed mid-request */ }
  });
  await context.route(`${HUB}/**`, route => route.fulfill({ contentType: 'text/html', body: parent(`${AI}/#work`) }));
  await context.route('https://evil.example/**', route => route.fulfill({ contentType: 'text/html', body: parent(`${AI}/#work`) }));

  const page = await context.newPage();
  await page.goto(`${HUB}/assistant`);
  const frame = () => page.frame({ url: u => u.href.startsWith(AI) });
  await page.waitForFunction(() => window.got.length > 0, null, { timeout: 15000 }).catch(async e => { console.error('frames:', page.frames().map(f => f.url())); throw e; });
  await frame().waitForSelector('#uxFramedStrip', { timeout: 15000 });

  await check('framed by Pi Hub: no top bar, rail, phone bar or "← Pi Hub" bar; the five areas are a strip', async () => {
    const r = await frame().evaluate(() => ({
      framed: document.documentElement.classList.contains('is-framed'),
      shown: ['#uxContextBar', '.app>aside', '#uxMobileNav', '.ui-backbar'].map(s => { const e = document.querySelector(s); return e ? getComputedStyle(e).display !== 'none' : false; }),
      strip: [...document.querySelectorAll('#uxFramedStrip button')].map(b => b.textContent),
      current: document.querySelector('#uxFramedStrip [aria-current="page"]')?.textContent,
    }));
    assert.equal(r.framed, true);
    assert.deepEqual(r.shown, [false, false, false, false]);
    assert.equal(r.strip.length, 5);
    assert.equal(r.current, 'Work');
  });

  await check('route posts reach Pi Hub, and moving inside the frame adds no history entry', async () => {
    const before = await page.evaluate(() => history.length);
    await frame().click('#uxFramedStrip button[data-domain="projects"]');
    await page.waitForFunction(() => window.got.some(m => m.type === 'assistant-route' && m.route.startsWith('projects')), null, { timeout: 10000 });
    await frame().click('#uxFramedStrip button[data-domain="improve"]');
    await page.waitForFunction(() => window.got.some(m => m.type === 'assistant-route' && m.route.startsWith('backlog')), null, { timeout: 10000 });
    assert.equal(await page.evaluate(() => history.length), before);
    assert.equal(await frame().evaluate(() => document.querySelector('#uxFramedStrip [aria-current="page"]')?.textContent), 'Improve');
  });

  await check("Pi Hub's context message opens Home with it over the composer, as text", async () => {
    await page.evaluate(ai => document.getElementById('f').contentWindow.postMessage({ type: 'assistant-context', context: 'Pi Hub › Workshop: <img src=x onerror=parent.pwned=1>printing 42 %' }, ai), AI);
    await frame().waitForFunction(() => !document.getElementById('homeContext')?.hidden, null, { timeout: 10000 });
    const r = await frame().evaluate(() => ({ text: document.getElementById('homeContextText').textContent, imgs: document.querySelectorAll('#homeContext img').length }));
    assert.match(r.text, /^Context: Pi Hub › Workshop: <img src=x onerror=parent\.pwned=1>printing 42 %$/);
    assert.equal(r.imgs, 0);
    assert.equal(await page.evaluate(() => window.pwned), undefined);
  });

  await check('another site cannot frame Local AI (frame-ancestors)', async () => {
    const evil = await context.newPage();
    const blocked = new Promise(resolve => { evil.on('console', m => { if (/frame-ancestors|Refused to frame/i.test(m.text())) resolve(true); }); setTimeout(() => resolve(false), 8000); });
    await evil.goto('https://evil.example/');
    assert.equal(await blocked, true, 'the browser refused the frame');
    const f = evil.frame({ url: u => u.href.startsWith(AI) });
    const loaded = f ? await f.evaluate(() => !!document.querySelector('main')).catch(() => false) : false;
    assert.equal(loaded, false);
    await evil.close();
  });

  await check('opened on its own, Local AI keeps its own chrome', async () => {
    const own = await context.newPage();
    await own.goto(`${AI}/#work`);
    await own.waitForSelector('#uxContextBar', { timeout: 15000 });
    const r = await own.evaluate(() => ({ framed: document.documentElement.classList.contains('is-framed'), bar: getComputedStyle(document.getElementById('uxContextBar')).display, strip: !!document.getElementById('uxFramedStrip') }));
    assert.equal(r.framed, false);
    assert.notEqual(r.bar, 'none');
    assert.equal(r.strip, false);
    await own.close();
  });
  // A7 P2 (L2): in the shell a Pi Hub page is a page in the shell, so its Needs-you row opens in the whole window with
  // no ↗, and says the hub's verb; opened on its own, the same row leaves for Pi Hub in a new tab.
  await check("Home's Needs you: Pi Hub's rows open in the shell, with the hub's verb and no ↗; on its own, in a new tab", async () => {
    await context.route(`${AI}/api/home/hub-needs`, route => route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ items: [{ id: 'pi:Ad blocking', tone: 'warn', title: 'Ad blocking', detail: 'AdGuard is paused.', link: '/network', action: 'open_network' }] }) }));
    const row = async f => {
      await f.waitForSelector('#homeNeedsList [data-hub-need="pi:Ad blocking"] a', { timeout: 15000 });
      return f.evaluate(() => { const a = document.querySelector('#homeNeedsList [data-hub-need="pi:Ad blocking"] a');
        return { href: a.href, target: a.target, action: a.querySelector('.ui-need__action')?.textContent, dense: !!a.closest('.ui-needs--dense') }; });
    };
    await page.goto(`${HUB}/assistant`);
    await page.waitForFunction(() => window.got.length > 0, null, { timeout: 15000 });
    await frame().evaluate(() => window.LocalAIRouter.go('#home', { replace: true }));
    const r = await row(frame());
    assert.deepEqual(r, { href: `${HUB}/network`, target: '_top', action: 'Open Network', dense: true });
    const own = await context.newPage();
    await own.goto(`${AI}/#home`);
    const o = await row(own.mainFrame());
    assert.equal(o.target, '_blank');
    assert.match(o.action, /^Open Network ↗$/);
    await own.close();
  });
  // A7 P1/P2 (L2b): Assistant status ends with "Open in" Pi Hub Health; in the shell that is a page there (no ↗, the top
  // window, the shell's own origin); on its own it opens Pi Hub in a new tab.
  await check('Assistant status: "Open in" Pi Hub Health is a shell page when framed, a new tab on its own', async () => {
    await page.goto(`${HUB}/assistant`);
    await page.waitForFunction(() => window.got.length > 0, null, { timeout: 15000 });
    await frame().evaluate(() => window.LocalAIRouter.go('#status', { replace: true }));
    const link = f => f.evaluate(() => { const a = document.getElementById('statusHubHealth'); return { href: a.href, target: a.target, text: a.textContent }; });
    assert.deepEqual(await link(frame()), { href: `${HUB}/system`, target: '_top', text: 'Pi Hub Health' });
    const own = await context.newPage();
    await own.goto(`${AI}/#status`);
    await own.waitForSelector('#statusHubHealth');
    const o = await link(own.mainFrame());
    assert.equal(o.target, '_blank');
    assert.match(o.text, /↗$/);
    await own.close();
  });
  await check('framed on a phone: the page tabs stick to the top of the frame, with no gap where the hidden top bar was', async () => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto(`${HUB}/assistant`);
    await page.waitForFunction(() => window.got.length > 0, null, { timeout: 15000 });
    await frame().evaluate(() => window.LocalAIRouter.go('#status', { replace: true }));
    await frame().waitForSelector('.ux-page-strip', { state: 'attached', timeout: 10000 });
    assert.equal(await frame().evaluate(() => getComputedStyle(document.querySelector('.ux-page-strip')).top), '0px');
  });
} finally {
  await browser.close();
}
if (failures.length) { console.error(`${failures.length} failed: ${failures.join('; ')}`); process.exit(1); }
console.log('framed-ui: all passed');
