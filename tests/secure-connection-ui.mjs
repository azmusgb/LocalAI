import { chromium, devices } from 'playwright';
import assert from 'node:assert/strict';

// The page must look like another device on the LAN (not localhost), so map a test name to the server.
const base = new URL(process.env.LOCALAI_URL || 'http://127.0.0.1:3080');
const name = 'localai.test';
const browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${name} ${base.hostname}`] });
const failures = [];
async function check(label, fn) { try { await fn(); console.log('PASS', label); } catch (e) { failures.push(`${label}: ${e.message}`); console.error('FAIL', label, e.message); } }

const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
// A test server has no release history, which hides What's new; give it one so the card's position is checked.
await page.route('**/api/releases', route => route.fulfill({ json: { current: { version: '2.0.1', commit: 'a'.repeat(40), deployedAt: new Date().toISOString() }, repoUrl: 'https://example.invalid', history: [{ version: '2.0.1', deployedAt: new Date().toISOString(), notes: [{ title: 'Test release', pr: 1 }] }] } }));
const probes = [];
page.on('request', r => { if (r.url().startsWith(`https://${name}/`)) probes.push(r.url()); });
await page.goto(`http://${name}:${base.port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.showView === 'function');
await page.waitForTimeout(1500);

await check('no HTTPS trust probe while Health is closed', async () => {
  assert.deepEqual(probes, []);
});

await check('opening Health probes once, and reopening it does not probe again', async () => {
  await page.evaluate(() => window.showView('status'));
  await page.waitForSelector('#status.active .secure-card[data-state]');
  assert.equal(probes.length, 1);
  await page.evaluate(() => window.showView('home'));
  await page.evaluate(() => window.showView('status'));
  await page.waitForTimeout(500);
  assert.equal(probes.length, 1);
});

await check('the setup steps are folded and the card sits below the service list', async () => {
  assert.equal(await page.locator('.secure-card').getAttribute('data-state'), 'todo');
  assert.equal(await page.locator('.secure-setup').evaluate(d => d.open), false);
  assert.equal(await page.locator('.secure-steps').isVisible(), false);
  const below = await page.evaluate(() => {
    const services = document.getElementById('serviceList').closest('.card');
    return !!(services.compareDocumentPosition(document.querySelector('.secure-card')) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  assert.ok(below, 'secure card should follow the service list');
  const order = await page.evaluate(() => [...document.querySelectorAll('#status > *, #status > .two > *')].filter(e => e.getBoundingClientRect().height > 0).map(e => e.id || e.className.split(' ').find(c => /status-overview|whatsnew|secure|dev-tools/.test(c)) || (e.querySelector('#serviceList') ? 'services' : '')).filter(Boolean));
  assert.ok(order.indexOf('services') >= 0 && order.indexOf('services') < order.indexOf('whatsNew'), `What's new should follow the health results: ${order}`);
  await page.locator('.secure-setup > summary').click();
  assert.equal(await page.locator('.secure-steps').isVisible(), true);
});

await page.close();

// An iPhone on plain HTTP: Home points at the setup, which opens with the iPhone's own steps first.
const phoneCtx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
await phoneCtx.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
const phone = await phoneCtx.newPage();
await phone.goto(`http://${name}:${base.port}/#home`, { waitUntil: 'load' });
await phone.waitForFunction(() => typeof window.showView === 'function');
const nudge = phone.locator('#homeNeedsList .ui-need', { hasText: 'Use the secure address on this device' });

await check('phone on plain HTTP: Home asks to use the secure address', async () => {
  await nudge.waitFor({ state: 'visible', timeout: 8000 });
});

await check('phone: Set up opens Health with the setup unfolded and the iPhone steps first', async () => {
  await nudge.click();
  await phone.waitForFunction(() => location.hash === '#status?secure=1', null, { timeout: 6000 });
  await phone.waitForSelector('#status.active .secure-card[data-state="todo"]', { timeout: 8000 });
  await phone.waitForFunction(() => document.querySelector('.secure-setup')?.open === true, null, { timeout: 6000 });
  assert.match(await phone.locator('.secure-steps dt').first().innerText(), /iPhone or iPad\s*This device/);
  assert.equal(await phone.locator('.secure-phone').count(), 0, 'a phone gets no codes to scan with itself');
});

await check('phone: "Don\'t remind me" removes the Home item on this device', async () => {
  await phone.locator('.secure-nudge-off').click();
  await phone.locator('.secure-setup', { hasText: "Home won't remind you" }).waitFor({ timeout: 4000 });
  await phone.evaluate(() => window.LocalAIRouter.open('home'));
  await phone.waitForSelector('#home.active');
  await phone.waitForTimeout(800);
  assert.equal(await nudge.count(), 0);
});
await phoneCtx.close();

// A computer opened by the network address shows codes a phone can scan: the certificate, then the secure page.
const desk = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
await desk.goto(`http://${name}:${base.port}/#status`, { waitUntil: 'load' });

await check('computer: Set up a phone shows scannable codes for the certificate and the secure address', async () => {
  await desk.waitForSelector('#status.active .secure-card[data-state]', { timeout: 8000 });
  await desk.locator('.secure-phone > summary').click();
  const codes = desk.locator('.secure-phone svg.qr');
  assert.equal(await codes.count(), 2);
  // The drawn modules must be exactly the codes for these two addresses (qr.test.cjs proves the encoder reads back).
  const expected = await desk.evaluate(n => [`http://${n}/localai-ca.crt`, `https://${n}/`].map(u => /d="([^"]+)"/.exec(window.LocalAIQR.svg(u))[1]), name);
  assert.deepEqual(await codes.evaluateAll(list => list.map(x => x.querySelector('path').getAttribute('d'))), expected);
  const box = await codes.first().boundingBox();
  assert.ok(box.width >= 150 && box.height >= 150, 'big enough to scan');
  assert.equal(await desk.locator('.secure-phone__away').count(), 0, 'no away-from-home code without Tailscale');
});
await desk.close();

// With Tailscale set up on the host, a third code opens the Tailscale address.
const away = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
await away.route(u => u.pathname === '/api/access', r => r.fulfill({ json: { remoteName: 'localai-pc.tail1234.ts.net' } }));
await away.goto(`http://${name}:${base.port}/#status`, { waitUntil: 'load' });
await check('computer with Tailscale: an away-from-home code opens the Tailscale address', async () => {
  await away.waitForSelector('#status.active .secure-card[data-state]', { timeout: 8000 });
  await away.locator('.secure-phone > summary').click();
  assert.equal(await away.locator('.secure-phone svg.qr').count(), 3);
  assert.match(await away.locator('.secure-phone__away').innerText(), /Tailscale app.*https:\/\/localai-pc\.tail1234\.ts\.net\//s);
  const expected = await away.evaluate(() => /d="([^"]+)"/.exec(window.LocalAIQR.svg('https://localai-pc.tail1234.ts.net/'))[1]);
  assert.equal(await away.locator('.secure-phone__away path').getAttribute('d'), expected);
});
await away.close();

// Health lists both addresses and says which one to put on the Home Screen to use Local AI anywhere.
const both = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await both.route(u => u.pathname === '/api/access', r => r.fulfill({ json: { remoteName: 'localai-pc.tail1234.ts.net', addresses: [{ label: 'Home Wi-Fi', url: 'https://10.0.0.21' }, { label: 'Anywhere (Tailscale)', url: 'https://localai-pc.tail1234.ts.net' }] } }));
await both.goto(`http://${name}:${base.port}/#status`, { waitUntil: 'load' });
await check('Health › Secure connection shows both addresses and the one icon that works everywhere', async () => {
  await both.waitForSelector('#status.active .secure-card .secure-addresses', { timeout: 8000 });
  const box = both.locator('.secure-addresses');
  assert.match(await box.innerText(), /Home Wi-Fi\s*https:\/\/10\.0\.0\.21.*Anywhere \(Tailscale\)\s*https:\/\/localai-pc\.tail1234\.ts\.net/s);
  assert.match(await box.innerText(), /Add to Home Screen from the Tailscale address to use Local AI anywhere/);
  assert.equal(await box.locator('a[href="https://localai-pc.tail1234.ts.net/"]').count(), 1);
  assert.ok(await both.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll');
});
await both.close();

const local = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
await local.goto(`${base.origin}/#home`, { waitUntil: 'load' });
await check('the computer itself (localhost) gets no Home reminder', async () => {
  await local.waitForFunction(() => typeof window.showView === 'function');
  await local.waitForTimeout(1200);
  assert.equal(await local.locator('#homeNeedsList .ui-need', { hasText: 'secure address' }).count(), 0);
});
await local.close();

await browser.close();
if (failures.length) { console.error('\nSecure connection failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll secure connection checks passed.');
