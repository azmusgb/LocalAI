// Models page: download form, progress and errors. CI has no Ollama, so a real name starts and then fails cleanly.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch();
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS', name) } catch (e) { failed++; console.log('FAIL', name, e.message) } }
const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
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
// The runtime tile ("Loaded list": Live / Unavailable) is diagnostic: it shows only with developer tools on.
await check('the runtime tile shows only with developer tools on', async () => {
  await page.evaluate(() => window.showView('models'));
  await page.waitForSelector('#modelRuntimeSummary .model-runtime-metric');
  const visibleLabels = () => page.locator('#modelRuntimeSummary .model-runtime-metric span').evaluateAll(es => es.filter(e => e.getClientRects().length).map(e => e.textContent.trim()));
  await page.evaluate(() => document.body.classList.add('dev-tools-off'));
  assert.deepEqual(await visibleLabels(), ['Configured default', 'Installed', 'Loaded now']);
  await page.evaluate(() => document.body.classList.remove('dev-tools-off'));
  assert.deepEqual(await visibleLabels(), ['Configured default', 'Installed', 'Loaded now', 'Loaded list']);
});
// An installed model's card: family, size and "Model size" are for the owner; quantization, file format and the
// memory rows (VRAM resident, Context, Unload target) are diagnostic, shown only with developer tools on (critique §3.4).
await check('a model card shows quantization, format and memory details only with developer tools on', async () => {
  const MODELS = { available: true, runtimeAvailable: true, default: 'qwen3:4b', defaultInstalled: true, installedCount: 1, loadedCount: 1,
    installed: [{ name: 'qwen3:4b', loaded: true, sizeBytes: 2.5e9, details: { family: 'qwen3', parameterSize: '4.0B', quantizationLevel: 'Q4_K_M', format: 'gguf' },
      runtime: { name: 'qwen3:4b', sizeVramBytes: 3.9e9, contextLength: 32768, expiresAt: new Date(Date.now() + 3e5).toISOString() } }],
    loaded: [{ name: 'qwen3:4b', sizeVramBytes: 3.9e9, contextLength: 32768 }], protectedModels: ['qwen3:4b'] };
  const p = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  try {
    await p.route(u => u.pathname === '/api/models', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(MODELS) }));
    await p.route(u => u.pathname === '/api/capabilities', async r => {
      const res = await r.fetch().catch(() => null); if (!res) return r.abort().catch(() => {});
      await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...(await res.json()), models: MODELS }) });
    });
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.evaluate(() => window.showView('models'));
    await p.click('#modelRuntimeRefresh');
    await p.waitForSelector('#modelRuntimeList .model-runtime-card');
    // One evaluate on the live DOM: the list is redrawn when the status poll comes back, so a held card can go stale.
    const seen = () => p.evaluate(() => [...document.querySelectorAll('#modelRuntimeList .model-runtime-card .model-runtime-meta .badge, #modelRuntimeList .model-runtime-card .model-runtime-detail > span')].filter(e => e.getClientRects().length).map(e => e.textContent.trim()));
    await p.evaluate(() => document.body.classList.add('dev-tools-off'));
    assert.deepEqual(await seen(), ['qwen3', '4.0B', 'Model size']);
    assert.doesNotMatch(await p.locator('#modelRuntimeList').innerText(), /Q4_K_M|gguf|VRAM|Unload target/);
    await p.evaluate(() => document.body.classList.remove('dev-tools-off'));
    assert.deepEqual(await seen(), ['qwen3', '4.0B', 'Q4_K_M', 'gguf', 'Model size', 'VRAM resident', 'Context', 'Unload target']);
  } finally { await p.close(); }
});
await check('no script errors', async () => assert.deepEqual(errors, []));
await browser.close();
if (failed) { console.log(`${failed} models check(s) failed`); process.exit(1) }
