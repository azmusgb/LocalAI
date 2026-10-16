// Health › Notifications on an iPhone. The browser's push support and /api/push/* are mocked, so nothing here
// contacts a real push service.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch();
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS', name) } catch (e) { failed++; console.log('FAIL', name, e.message) } }
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

// A fake push stack: standalone or not, already subscribed or not.
function fakePush({ standalone, subscribed }) {
  return ({ standalone, subscribed, noWorker }) => {
    let sub = subscribed ? { endpoint: 'https://web.push.apple.com/known' } : null;
    const make = (endpoint) => ({ endpoint, toJSON: () => ({ endpoint, keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } }), unsubscribe: async () => { sub = null; return true; } });
    if (sub) sub = make(sub.endpoint);
    const reg = { pushManager: { getSubscription: async () => sub, subscribe: async () => (sub = make('https://web.push.apple.com/new-' + Date.now())) } };
    Object.defineProperty(navigator, 'standalone', { get: () => standalone });
    Object.defineProperty(navigator, 'serviceWorker', { get: () => ({ ready: noWorker ? new Promise(() => {}) : Promise.resolve(reg), register: async () => reg, addEventListener() {}, controller: null }) });
    window.PushManager = function PushManager() {};
    window.Notification = { permission: 'default', requestPermission: async () => 'granted' };
    localStorage.setItem('localai.firstRun.done', '1');
  };
}
// The appliance side, in memory: devices and every call made.
async function fakeApi(page, devices) {
  const calls = [];
  await page.route('**/api/push/**', async (route) => {
    const url = new URL(route.request().url()), body = route.request().postDataJSON?.() || null;
    calls.push({ path: url.pathname, body });
    const p = url.pathname;
    if (p === '/api/push/key') return route.fulfill({ json: { publicKey: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8' } });
    if (p === '/api/push/devices') return route.fulfill({ json: { devices } });
    if (p === '/api/push/subscribe') { const d = { id: 'd1', name: body.name, endpoint: body.subscription.endpoint, kinds: ['needs-you', 'failed', 'service', 'finished', 'answer'], quiet: { on: true, start: '22:00', end: '07:00' }, lastOkAt: null, lastError: null }; devices.splice(0, devices.length, d); return route.fulfill({ json: { device: d } }); }
    if (p === '/api/push/devices/update') { const d = devices.find((x) => x.id === body.id); Object.assign(d, Object.fromEntries(Object.entries(body).filter(([k, v]) => k !== 'id' && v !== undefined))); return route.fulfill({ json: { device: d } }); }
    if (p === '/api/push/test') return route.fulfill({ json: { sent: 1, removed: 0 } });
    return route.fulfill({ json: { ok: true } });
  });
  return calls;
}
async function openHealth(opts, devices = []) {
  const context = await browser.newContext({ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(fakePush(opts), opts);
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const calls = await fakeApi(page, devices);
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(() => window.showView('status'));
  await page.waitForSelector('#notifications .notify-body *');
  return { page, calls, errors, context };
}

await check('iPhone in Safari: asks for the Home Screen app, no Allow button', async () => {
  const { page, context } = await openHealth({ standalone: false, subscribed: false });
  assert.match(await page.locator('#notifications').innerText(), /Add Local AI to your Home Screen/);
  assert.equal(await page.locator('[data-notify-allow]').count(), 0);
  await context.close();
});

await check('Home Screen app: Allow subscribes as iPhone and shows the settings', async () => {
  const devices = [];
  const { page, calls, errors, context } = await openHealth({ standalone: true, subscribed: false }, devices);
  await page.locator('[data-notify-allow]').click();
  await page.waitForSelector('[data-notify-kind="finished"]');
  assert.equal(calls.find((c) => c.path === '/api/push/subscribe').body.name, 'iPhone');
  for (const k of ['needs-you', 'failed', 'service', 'finished', 'answer']) assert.equal(await page.locator(`[data-notify-kind="${k}"]`).isChecked(), true, k);
  assert.equal(await page.locator('[data-notify-quiet-on]').isChecked(), true);
  assert.equal(await page.inputValue('[data-notify-quiet-start]'), '22:00');
  assert.equal(await page.inputValue('[data-notify-quiet-end]'), '07:00');

  await page.locator('[data-notify-kind="finished"]').uncheck();
  for (let i = 0; i < 50 && !calls.some((c) => c.path === '/api/push/devices/update'); i++) await page.waitForTimeout(100);
  const update = calls.filter((c) => c.path === '/api/push/devices/update').at(-1);
  assert.deepEqual(update.body.kinds, ['needs-you', 'failed', 'service', 'answer']);

  await page.locator('[data-notify-test]').click();
  await page.waitForFunction(() => /Sent/.test(document.querySelector('#notifications .notify-status').textContent));
  assert.ok(calls.some((c) => c.path === '/api/push/test'));
  assert.match(await page.locator('#notifications .notify-devices').innerText(), /iPhone/);
  assert.deepEqual(errors, []);
  await context.close();
});

await check('if the background service never starts, the card says what to do', async () => {
  const { page, context } = await openHealth({ standalone: true, subscribed: false, noWorker: true });
  await page.waitForFunction(() => /didn't start/.test(document.querySelector('#notifications').textContent), null, { timeout: 10000 });
  assert.match(await page.locator('#notifications').innerText(), /Reload Local AI/);
  await context.close();
});

await check('a refused test says so, with the reason', async () => {
  const devices = [{ id: 'd1', name: 'iPhone', endpoint: 'https://web.push.apple.com/known', kinds: ['needs-you', 'failed', 'service', 'finished', 'answer'], quiet: { on: true, start: '22:00', end: '07:00' }, lastOkAt: null, lastError: null }];
  const { page, context } = await openHealth({ standalone: true, subscribed: true }, devices);
  await page.route('**/api/push/test', (route) => route.fulfill({ json: { sent: 0, removed: 0, failed: 1, error: 'HTTP 403' } }));
  await page.locator('[data-notify-test]').click();
  await page.waitForFunction(() => /refused/.test(document.querySelector('#notifications .notify-status').textContent));
  const text = await page.locator('#notifications .notify-status').innerText();
  assert.match(text, /HTTP 403/);
  assert.doesNotMatch(text, /no longer subscribed/);
  await context.close();
});

await check('a subscription the appliance no longer knows says notifications stopped and recovers', async () => {
  const devices = [];
  const { page, calls, context } = await openHealth({ standalone: true, subscribed: true }, devices);
  assert.match(await page.locator('#notifications').innerText(), /Notifications stopped on this device/);
  await page.locator('[data-notify-allow]').click();
  await page.waitForSelector('[data-notify-kind="needs-you"]');
  assert.ok(calls.some((c) => c.path === '/api/push/subscribe'));
  await context.close();
});

await check('notification links open their page', async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => localStorage.setItem('localai.firstRun.done', '1'));
  const page = await context.newPage();
  await page.goto(base + '/?open=status', { waitUntil: 'networkidle' });
  await page.waitForSelector('#status.active');
  assert.equal(new URL(page.url()).search, '');
  // What the service worker's message from a tapped notification calls.
  await page.evaluate(() => window.LocalAIOpen('/?open=claude'));
  await page.waitForSelector('#claude.active');
  // An answer notification's link is #run/<id>: tapping it with the app already open must open that run.
  await page.evaluate(() => { window.__went = []; const go = window.LocalAIRouter.go.bind(window.LocalAIRouter); window.LocalAIRouter.go = (...a) => { window.__went.push(a[0]); return go(...a); }; });
  await page.evaluate(origin => window.LocalAIOpen(origin + '/#run/run_abc'), base);
  assert.deepEqual(await page.evaluate(() => window.__went), ['#run/run_abc']);
  await context.close();
});

await browser.close();
if (failed) { console.log(`${failed} notifications check(s) failed`); process.exit(1) }
