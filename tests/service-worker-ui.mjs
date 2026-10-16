import { chromium } from 'playwright';
import assert from 'node:assert/strict';
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

await browser.close();
if (failures.length) { console.error('\n' + failures.length + ' failing:\n' + failures.join('\n')); process.exit(1); }
console.log('\nService worker smoke test passed');
