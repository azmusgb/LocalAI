import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
// Requests a service worker makes are reported only with this set (read at browser launch).
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

// Smoke test for app/public/sw.js, the one script no other suite runs (they all block service workers): it installs
// with every SHELL file, activates, takes the page over, and serves / from the network (so a deploy shows on the next load).
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const T = { timeout: 10000 };
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}

await check('the service worker installs every shell file, activates, and serves / from the network', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  const reg = await page.evaluate(() => Promise.race([navigator.serviceWorker.ready.then(r => ({ url: r.active && r.active.scriptURL })), new Promise(r => setTimeout(() => r({ url: 'about:never-ready' }), 8000))]));
  assert.equal(new URL(reg.url).pathname, '/sw.js', 'the worker installed and became active');
  await page.waitForFunction(() => navigator.serviceWorker.ready.then(r => r.active.state === 'activated'), null, T);
  // install's cache.addAll fails as a whole if any SHELL file is missing, so a full cache means every listed file loaded
  const cached = await page.evaluate(async () => { const keys = await caches.keys(); const c = await caches.open(keys[0]); return { names: keys, paths: (await c.keys()).map(r => new URL(r.url).pathname) }; });
  assert.equal(cached.names.length, 1, 'one shell cache: ' + cached.names.join());
  for (const p of ['/', '/index.html', '/app.js', '/router.js', '/work.js', '/home.js', '/run-bodies.js', '/components.js', '/ui.js', '/app.css']) assert.ok(cached.paths.includes(p), `${p} is in the shell cache`);
  // reload: the worker now controls the page, and its fetch handler goes to the network for /
  const fromNet = [];
  ctx.on('request', r => { if (r.serviceWorker() && new URL(r.url()).pathname === '/') fromNet.push(r.url()); });
  const res = await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(res.status(), 200);
  assert.equal(res.fromServiceWorker(), true, 'the navigation went through the worker');
  assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true);
  assert.ok(fromNet.length >= 1, 'the worker fetched / from the network');
  await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIRouter, null, T);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// A phone that can't reach Local AI (offline, an untrusted certificate, a deploy restart) gets the worker's saved copy.
// The page must say so instead of passing an old copy off as current. To make Local AI really unreachable for the
// worker as well as the page, the page talks to a pass-through proxy that this test stops and starts.
const upstream = new URL(base);
function startProxy(port = 0) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const up = http.request({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: { ...req.headers, host: upstream.host } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({
    port: server.address().port,
    stop: () => new Promise(done => { server.close(() => done()); for (const s of sockets) s.destroy(); })
  })));
}

await check('unreachable: the saved copy says so, Health says the device cannot reach Local AI, and it recovers on its own', async () => {
  let proxy = await startProxy();
  const port = proxy.port, origin = `http://127.0.0.1:${port}`;
  const ctx = await browser.newContext({ serviceWorkers: 'allow', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  try {
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => navigator.serviceWorker.ready.then(r => r.active.state === 'activated'), null, T);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, T);
    assert.equal(await page.locator('#offlineBanner').count(), 0, 'no banner while Local AI answers');

    await proxy.stop();
    const res = await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(res.fromServiceWorker(), true, 'the worker answered');
    assert.ok(res.headers()['x-localai-offline-copy'], 'the saved copy is marked');
    const banner = page.locator('#offlineBanner');
    await banner.waitFor({ state: 'visible', ...T });
    assert.equal(await banner.getAttribute('role'), 'status');
    assert.match(await banner.innerText(), /Can't reach Local AI\. You're looking at a saved copy from /);
    assert.equal(await banner.getByRole('button', { name: 'Try again' }).count(), 1);
    const box = await banner.boundingBox();
    assert.ok(box && box.y < 10, `the banner is at the top (y=${box && box.y})`);

    await page.waitForFunction(() => typeof window.showView === 'function', null, T);
    await page.evaluate(() => window.showView('status'));
    await page.locator('#serviceList .status-error', { hasText: "Can't reach Local AI from this device." }).waitFor(T);
    const secure = page.locator('.secure-card');
    await secure.waitFor(T);
    await page.waitForFunction(() => document.querySelector('.secure-card')?.dataset.state === 'unknown', null, T);
    assert.match(await secure.innerText(), /Can't check: Local AI isn't reachable/);

    // Local AI comes back: within one 15 s check the page reloads by itself, once, and the banner is gone.
    let loads = 0;
    page.on('load', () => { loads++; });
    proxy = await startProxy(port);
    await page.waitForEvent('load', { timeout: 25000 });
    await page.waitForFunction(() => typeof window.showView === 'function', null, T);
    assert.equal(await page.locator('#offlineBanner').count(), 0, 'the banner is gone after the reload');
    await page.waitForTimeout(2500);
    assert.equal(loads, 1, 'it reloaded once');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
    await proxy.stop();
  }
});

await check('a page from another build reloads itself once, and only once', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  try {
    await ctx.route(u => u.pathname === '/healthz', r => r.fulfill({ json: { status: 'ok', appliance: 'Local AI', version: '9.9.999', releaseCommit: 'f'.repeat(40) } }));
    let loads = 0;
    page.on('load', () => { loads++; });
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => { try { return !!sessionStorage.getItem('localai.buildReload'); } catch { return false; } }, null, T);
    await page.waitForTimeout(4000);
    assert.equal(loads, 2, `loaded ${loads} times: the first load and one reload`);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('localai.buildReload')), '9.9.999@' + 'f'.repeat(40));
  } finally {
    await ctx.close();
  }
});

await browser.close();
if (failures.length) { console.error('\n' + failures.length + ' failing:\n' + failures.join('\n')); process.exit(1); }
console.log('\nService worker smoke test passed');
