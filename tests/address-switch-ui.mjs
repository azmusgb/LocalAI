import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';

// app/public/offline-copy.js moving to the appliance's other address on its own (the owner's phone away from home:
// Home Wi-Fi can't be reached, Tailscale can). Same pattern as service-worker-ui.mjs: the service worker is allowed,
// and the page talks to pass-through proxies this test stops and starts. Proxy A stands in for Home Wi-Fi, proxy B
// for Tailscale; both report that pair as the appliance's addresses (offline-copy.js accepts plain http only on
// 127.0.0.1). Runs in Chromium, and in WebKit (Safari's engine) when it is installed. Each phone is a fresh context
// kept short: Playwright's WebKit empties a service worker's cache once the worker has sat idle for about 40 s.
// That is Playwright's WebKit, not sw.js: its contexts are always ephemeral (in memory, like Private Browsing), and it
// drops an origin's CacheStorage entries once nothing of that origin runs. Without any service worker, a cache a page
// made is empty 5 s after the page leaves; Chromium keeps both. A Home Screen app keeps its data on disk. If the cache
// is gone anyway, sw.js still answers with a small "Can't reach Local AI" page (the last check here).
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const upstream = new URL(base);
const T = { timeout: 15000 };
const failures = [];
let addresses = [];

function startProxy(port = 0) {
  const sockets = new Set(), seen = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') seen.push(req.headers['sec-fetch-mode'] || '');
    const up = http.request({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: { ...req.headers, host: upstream.host } }, r => {
      if (req.url !== '/healthz') { res.writeHead(r.statusCode, r.headers); r.pipe(res); return; }
      let raw = ''; r.setEncoding('utf8'); r.on('data', c => { raw += c; });
      r.on('end', () => { const body = JSON.stringify({ ...JSON.parse(raw), addresses }); res.writeHead(r.statusCode, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }); res.end(body); });
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({
    port: server.address().port, seen,
    stop: () => new Promise(done => { server.close(() => done()); for (const s of sockets) s.destroy(); })
  })));
}

// ADDRESS_SWITCH_ENGINES=webkit runs one engine only.
const only = (process.env.ADDRESS_SWITCH_ENGINES || 'chromium,webkit').split(',');
const engines = [['chromium', chromium], ['webkit', webkit]].filter(([n]) => only.includes(n));
if (only.includes('webkit') && !fs.existsSync(webkit.executablePath())) { console.log('SKIP webkit: not installed (npx playwright install webkit)'); engines.pop(); }

for (const [engine, type] of engines) {
  const browser = await type.launch({ headless: true });
  const check = async (name, fn) => {
    try { await fn(); console.log('PASS', engine, name); } catch (error) { failures.push(`${engine} ${name}: ${error.message}`); console.error('FAIL', engine, name, error.message); }
  };
  let a = await startProxy(), b = await startProxy();
  const A = `http://127.0.0.1:${a.port}`, B = `http://127.0.0.1:${b.port}`;
  addresses = [{ label: 'Home Wi-Fi', url: A }, { label: 'Anywhere (Tailscale)', url: B }];
  const restart = async which => { if (which === 'a') { await a.stop(); a = await startProxy(new URL(A).port); } else { await b.stop(); b = await startProxy(new URL(B).port); } };
  const ensure = async (which, on) => { const p = which === 'a' ? a : b; const up = await fetch((which === 'a' ? A : B) + '/healthz').then(() => true, () => false); if (on && !up) await restart(which); if (!on && up) await p.stop(); };

  // A phone that has used Home Wi-Fi: the worker is installed and the page has saved the address list.
  const phone = async (opts = {}) => {
    const ctx = await browser.newContext({ serviceWorkers: 'allow', viewport: { width: 390, height: 844 }, isMobile: engine !== 'firefox', hasTouch: true, ...opts });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(A + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => navigator.serviceWorker.ready.then(r => r.active.state === 'activated'), null, T);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller && !!localStorage.getItem('localai.addresses'), null, T);
    await page.evaluate(() => { location.hash = 'claude'; });
    return { ctx, page, errors };
  };
  // WebKit reports fetches that fail or that a reload cancels as page errors even when the page handles them.
  const noise = e => engine === 'webkit' && /Load failed|access control checks|^\/127\.0\.0\.1:\d+\//.test(e);
  const banner = page => page.locator('#offlineBanner');
  const notice = page => page.locator('.offline-banner__switch');

  await check('nothing happens while this address answers', async () => {
    await ensure('a', true); await ensure('b', true);
    const { ctx, page, errors } = await phone();
    try {
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(4000);
      assert.equal(await banner(page).count(), 0, 'no banner');
      assert.equal(new URL(page.url()).origin, A, 'still on Home Wi-Fi');
      assert.equal(await page.evaluate(() => sessionStorage.getItem('localai.addressSwitch')), null);
      assert.deepEqual(errors.filter(e => !noise(e)), []);
    } finally { await ctx.close(); }
  });

  // Home Wi-Fi down, Tailscale up: the phone moves to Tailscale with the same page. Returns the page there.
  const switched = async page => {
    await a.stop();
    const probesBefore = b.seen.length;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await notice(page).waitFor({ state: 'visible', ...T });
    assert.match(await notice(page).innerText(), /Home Wi-Fi isn't reachable\. Switching to Tailscale…/);
    assert.doesNotMatch(await banner(page).innerText(), /pair/i, 'nothing about pairing');
    assert.ok(b.seen.slice(probesBefore).some(m => m === 'no-cors' || m === ''), `Tailscale was asked without CORS (${b.seen.slice(probesBefore)})`);
    await page.waitForURL(B + '/#claude', T);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('localai.switchedFrom')), A, 'Tailscale knows where it came from');
    await page.waitForFunction(() => typeof window.showView === 'function', null, T);
  };

  await check('Home Wi-Fi unreachable, Tailscale answers: it moves there with the same page, and only once', async () => {
    await ensure('a', true); await ensure('b', true);
    const { ctx, page, errors } = await phone();
    try {
      await switched(page);
      // Back on Home Wi-Fi in the same tab while it still fails: it already moved once, so the banner only.
      await page.goto(A + '/#claude', { waitUntil: 'domcontentloaded' });
      await banner(page).waitFor({ state: 'visible', ...T });
      await page.waitForTimeout(5000);
      assert.equal(new URL(page.url()).origin, A, 'stayed on Home Wi-Fi');
      assert.equal(await notice(page).count(), 0, 'no second move');
      assert.equal(await banner(page).getByRole('link', { name: 'Open over Tailscale' }).count(), 1, 'the manual link is still there');
      assert.deepEqual(errors.filter(e => !noise(e)), []);
    } finally { await ctx.close(); }
  });

  await check('on Tailscale: a quiet link back once Home Wi-Fi answers, never a move back', async () => {
    await ensure('a', true); await ensure('b', true);
    const { ctx, page, errors } = await phone();
    try {
      await switched(page);
      await page.waitForTimeout(3500);
      assert.equal(await page.locator('#addressBack').count(), 0, 'no offer while Home Wi-Fi is down');
      await restart('a');
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      const back = page.locator('#addressBack');
      await back.waitFor({ state: 'visible', ...T });
      assert.match(await back.innerText(), /^Back on home Wi-Fi — open the home address$/);
      assert.ok((await back.getByRole('link').getAttribute('href')).startsWith(A + '/'), 'the link goes to the home address');
      await page.waitForTimeout(2500);
      assert.equal(new URL(page.url()).origin, B, 'never moves back by itself');

      // No loop: Tailscale now fails while Home Wi-Fi answers. The page moved here, so it doesn't move again.
      await page.waitForFunction(() => navigator.serviceWorker.ready.then(r => r.active.state === 'activated'), null, T);
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, T);
      await b.stop();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await banner(page).waitFor({ state: 'visible', ...T });
      await page.waitForTimeout(5000);
      assert.equal(new URL(page.url()).origin, B, 'stayed on Tailscale');
      assert.equal(await notice(page).count(), 0, 'no move notice');
      assert.equal(await banner(page).getByRole('link', { name: 'Open on Home Wi-Fi' }).count(), 1, 'the manual link is still there');
      assert.deepEqual(errors.filter(e => !noise(e)), []);
    } finally { await ctx.close(); }
  });

  await check('Cancel stops the move, and it stays stopped for the session (reduced motion: no countdown animation)', async () => {
    await ensure('a', true); await ensure('b', true);
    const { ctx, page, errors } = await phone({ reducedMotion: 'reduce' });
    try {
      await a.stop();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await notice(page).waitFor({ state: 'visible', ...T });
      assert.equal(await page.locator('.offline-banner__countdown').evaluate(e => getComputedStyle(e).animationName), 'none');
      await notice(page).getByRole('button', { name: 'Cancel' }).click();
      await page.waitForTimeout(3500);
      assert.equal(new URL(page.url()).origin, A, 'did not move');
      assert.equal(await notice(page).count(), 0, 'the notice is gone');
      assert.equal(await page.evaluate(() => sessionStorage.getItem('localai.addressSwitch')), 'cancelled');
      await banner(page).getByRole('link', { name: 'Open over Tailscale' }).waitFor(T);
      assert.equal(await banner(page).getByRole('button', { name: 'Try again' }).isVisible(), true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await banner(page).waitFor({ state: 'visible', ...T });
      await page.waitForTimeout(5000);
      assert.equal(await notice(page).count(), 0, 'not offered again after a reload');
      assert.equal(new URL(page.url()).origin, A);
      assert.deepEqual(errors.filter(e => !noise(e)), []);
    } finally { await ctx.close(); }
  });

  await check('neither address answers: the banner with Try again and the Tailscale hint, no move', async () => {
    await ensure('a', true); await ensure('b', true);
    const { ctx, page, errors } = await phone();
    try {
      await a.stop(); await b.stop();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await banner(page).waitFor({ state: 'visible', ...T });
      await page.waitForTimeout(5000);
      assert.equal(await notice(page).count(), 0);
      assert.equal(new URL(page.url()).origin, A);
      assert.equal(await banner(page).getByRole('button', { name: 'Try again' }).isVisible(), true);
      assert.match(await banner(page).innerText(), /Turn on Tailscale on this phone first\./);
      assert.deepEqual(errors.filter(e => !noise(e)), []);
    } finally { await ctx.close(); }
  });

  // WebKit only: the worker idles out with no page open, so Playwright's WebKit empties its cache (see the top). The
  // phone still hears that Local AI can't be reached, from the worker's own page, with the other address to try.
  if (engine === 'webkit') await check('after the worker sits idle with its cache emptied, the banner still shows', async () => {
    await ensure('a', true); await ensure('b', true);
    const { ctx, page, errors } = await phone();
    try {
      await page.goto('about:blank');
      await page.waitForTimeout(50000);
      await a.stop(); await b.stop();
      await page.goto(A + '/#claude', { waitUntil: 'domcontentloaded' });
      await banner(page).waitFor({ state: 'visible', ...T });
      assert.match(await banner(page).innerText(), /Can't reach Local AI/);
      assert.equal(await banner(page).getByRole('button', { name: 'Try again' }).count(), 1);
      assert.equal(await banner(page).getByRole('link', { name: 'Open over Tailscale' }).getAttribute('href'), B + '/#claude');
      assert.deepEqual(errors.filter(e => !noise(e)), []);
    } finally { await ctx.close(); }
  });

  await browser.close();
  await a.stop().catch(() => {}); await b.stop().catch(() => {});
}

if (failures.length) { console.error('\n' + failures.length + ' failing:\n' + failures.join('\n')); process.exit(1); }
console.log('\nAddress switch tests passed');
