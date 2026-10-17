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
  const context = await browser.newContext({ serviceWorkers: 'block', userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(fakePush(opts), opts);
  const page = await context.newPage({ serviceWorkers: 'block' });
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
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('localai.firstRun.done', '1'));
  const page = await context.newPage({ serviceWorkers: 'block' });
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

// Inbox: an alert body is clamped to four lines; Show more opens the rest (aria-expanded), on a phone and on a desktop.
const LONG_ALERT = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a pasted alert that goes on about disk space, services and what happened overnight.`).join(' ');
for (const [tag, viewport, mobile] of [['phone', { width: 390, height: 844 }, true], ['desktop', { width: 1440, height: 900 }, false]]) await check(`${tag}: a long Inbox alert shows four lines and Show more opens the rest`, async () => {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: mobile, hasTouch: mobile });
  await context.addInitScript(() => localStorage.setItem('localai.firstRun.done', '1'));
  const page = await context.newPage({ serviceWorkers: 'block' });
  const now = new Date().toISOString();
  await page.route(u => u.pathname === '/api/notifications', r => r.fulfill({ json: { unread: 1, items: [
    { id: 'n1', title: 'Disk is nearly full', kind: 'monitor', level: 'warning', detail: LONG_ALERT, read: false, resolved: false, createdAt: now },
    { id: 'n2', title: 'Backup finished', kind: 'automation', level: 'warning', detail: 'One line.', read: false, resolved: false, createdAt: now }] } }));
  await page.goto(base + '/#inbox', { waitUntil: 'networkidle' });
  await page.waitForSelector('#inboxList .item-card');
  const card = page.locator('#inboxList .item-card', { hasText: 'Disk is nearly full' });
  const body = card.locator('.muted').first();
  const lines = async () => body.evaluate(e => ({ h: e.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(e).lineHeight), cut: e.scrollHeight > e.clientHeight + 1 }));
  const before = await lines();
  assert.ok(before.cut && before.h <= before.lh * 4 + 2, `clamped body is ${before.h}px for line height ${before.lh}`);
  const more = card.locator('[aria-expanded]');
  assert.equal(await more.getAttribute('aria-expanded'), 'false');
  assert.match(await more.innerText(), /show more/i);
  assert.ok((await more.boundingBox()).height >= 44, 'Show more is a 44px tap target');
  await more.click();
  assert.equal(await more.getAttribute('aria-expanded'), 'true');
  const after = await lines();
  assert.ok(!after.cut && after.h > before.lh * 5, `opened body is ${after.h}px`);
  assert.match(await more.innerText(), /show less/i);
  // A short alert needs no Show more.
  assert.equal(await page.locator('#inboxList .item-card', { hasText: 'Backup finished' }).locator('[aria-expanded]:visible').count(), 0);
  await context.close();
});

// One count everywhere: the bell, the Inbox pill, the Approvals tab and the Alerts row agree on what is waiting.
await check('two approvals and no alerts: Alerts shows "2 approvals waiting", the tab reads "Approvals · 2", the bell says 2', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('localai.firstRun.done', '1'));
  const page = await context.newPage({ serviceWorkers: 'block' });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/notifications', (route) => route.fulfill({ json: { items: [], unread: 0 } }));
  await page.route('**/api/approvals', (route) => route.fulfill({ json: { items: [{ id: 'a1', status: 'pending', title: 'Run npm install', detail: 'Host command', risk: 'host' }, { id: 'a2', status: 'pending', title: 'Apply change', detail: 'Writes a file', risk: 'medium' }] } }));
  await page.goto(base + '/#inbox', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.showView === 'function');
  await page.evaluate(() => window.showView('inbox'));
  const row = page.locator('#inboxList [data-goto="approvals"]');
  await row.waitFor();
  assert.match(await row.innerText(), /2 approvals waiting/);
  assert.match(await row.innerText(), /Approvals/);
  assert.doesNotMatch(await page.locator('#inboxList').innerText(), /Nothing needs you/);
  assert.equal(await page.locator('#inboxUnread').innerText(), '2 waiting');
  assert.equal(await page.locator('#inbox .ux-tabs [data-ux-tab="approvals"]').innerText(), 'Approvals · 2');
  assert.equal(await page.locator('#uxInboxCount').innerText(), '2');
  await row.click();
  await page.waitForSelector('#approvals.active');
  assert.equal(await page.locator('#approvalCount').innerText(), '2 waiting');
  assert.deepEqual(errors, []);
  await context.close();
});

// Approvals: a list of items, each titled with an <h3>, whose buttons say what they approve; after a decision focus goes
// to the next waiting Approve (or the "Nothing is waiting" line) and the decision is announced.
await check('Approvals are a list with named buttons; Approve moves focus to the next one and says "Approved"', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('localai.firstRun.done', '1'));
  const page = await context.newPage({ serviceWorkers: 'block' });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const items = [{ id: 'a1', status: 'pending', title: 'Run npm install', detail: 'Host command', risk: 'host' }, { id: 'a2', status: 'pending', title: 'Apply change', detail: 'Writes a file', risk: 'medium' }, { id: 'a3', status: 'approved', title: 'Old one', detail: '', risk: 'low' }];
  await page.route('**/api/notifications', (route) => route.fulfill({ json: { items: [], unread: 0 } }));
  await page.route('**/api/approvals', (route) => route.fulfill({ json: { items } }));
  await page.route('**/api/approvals/decide', (route) => { const b = route.request().postDataJSON(); items.find((a) => a.id === b.id).status = b.decision; route.fulfill({ json: { item: {} } }); });
  await page.goto(base + '/#approvals', { waitUntil: 'networkidle' });
  await page.evaluate(() => window.showView('approvals'));
  await page.waitForSelector('#approvalList [data-app-ok]');
  const shape = await page.evaluate(() => [...document.querySelectorAll('#approvalList > ul > li')].map((li) => [li.querySelector('h3')?.textContent, [...li.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent)]));
  assert.deepEqual(shape, [['Run npm install', ['Approve: Run npm install', 'Reject: Run npm install']], ['Apply change', ['Approve: Apply change', 'Reject: Apply change']]]);
  await page.getByRole('button', { name: 'Approve: Run npm install' }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Approve: Apply change', null, { timeout: 4000 });
  await page.waitForFunction(() => /^Approved/.test(document.getElementById('toast').textContent), null, { timeout: 4000 });
  await page.getByRole('button', { name: 'Approve: Apply change' }).click();
  await page.waitForFunction(() => /Nothing is waiting/.test(document.activeElement?.textContent || ''), null, { timeout: 4000 });
  assert.deepEqual(errors, []);
  await context.close();
});

await browser.close();
if (failed) { console.log(`${failed} notifications check(s) failed`); process.exit(1) }
