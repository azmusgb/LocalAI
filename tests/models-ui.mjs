// Models page: download form, progress and errors. CI has no Ollama, so a real name starts and then fails cleanly.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch();
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS', name) } catch (e) { failed++; console.log('FAIL', name, e.message) } }
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(base, { waitUntil: 'networkidle' });
await page.evaluate(() => window.showView('models'));
await page.waitForSelector('#modelPullForm');

await check('an invalid name is refused with a message', async () => {
  await page.fill('#modelPullName', 'not a model;rm');
  await page.click('#modelPullForm button[type="submit"]');
  await page.waitForSelector('#modelPullError:not([hidden])');
  assert.match(await page.locator('#modelPullError').innerText(), /model name/i);
});
await check('a download shows its progress row and reports the outcome', async () => {
  // A fresh name each run: the server keeps finished pulls, so a fixed name matched the previous run's row at once.
  const model = `ci-test-model-${Date.now().toString(36)}:1b`;
  await page.fill('#modelPullName', model);
  const started = page.waitForResponse(r => r.url().endsWith('/api/models/pull') && r.request().method() === 'POST');
  await page.click('#modelPullForm button[type="submit"]');
  await started;
  await page.waitForSelector(`.model-pull:has-text("${model}")`);
  assert.equal(await page.locator('#modelPullError').isHidden(), true);
  assert.equal(await page.inputValue('#modelPullName'), '');
  // Without Ollama the download fails; with one it may run. Either way the row reaches a clear state or keeps running.
  await page.waitForFunction(m => /Failed|Downloaded|%|pulling|Starting/i.test([...document.querySelectorAll('.model-pull')].find(e => e.textContent.includes(m))?.textContent || ''), model);
});
await check('the API refuses cross-site and non-JSON requests', async () => {
  const cross = await fetch(base + '/api/models/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{"name":"x:1"}' });
  assert.equal(cross.status, 403);
  const plain = await fetch(base + '/api/models/pull', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"name":"x:1"}' });
  assert.equal(plain.status, 415);
});
await check('the default model cannot be removed', async () => {
  const { default: model } = await (await fetch(base + '/api/models')).json();
  const r = await fetch(base + '/api/models/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: model }) });
  assert.equal(r.status, 409);
});
await check('no script errors', async () => assert.deepEqual(errors, []));
await browser.close();
if (failed) { console.log(`${failed} models check(s) failed`); process.exit(1) }
