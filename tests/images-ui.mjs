// Images page: engines, shapes, options and the request they produce. The image API is mocked, so no GPU is needed.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch();
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS', name) } catch (e) { failed++; console.log('FAIL', name, e.message) } }
const aspects = [['square', 'Square', [512, 512], [1024, 1024]], ['portrait', 'Portrait', [512, 768], [832, 1216]], ['landscape', 'Landscape', [768, 512], [1216, 832]], ['wide', 'Wide', [896, 512], [1344, 768]]]
  .map(([id, label, s, l]) => ({ id, label, sizes: { 512: s, 1024: l } }));
const models = { engines: [{ id: 'fast', label: 'Fast', blurb: 'Quick drafts.', family: 'sd15', base: 512, estimateSec: 16 }, { id: 'quality', label: 'Quality', blurb: 'Detailed.', family: 'sdxl', base: 1024 }, { id: 'best', label: 'Best', blurb: 'Text and long prompts.', family: 'flux', base: 1024 }], custom: ['v1-5-pruned-emaonly.safetensors'], upscale: true, defaultEngine: 'fast', aspects, styles: [{ id: 'none', label: 'None' }, { id: 'photo', label: 'Photo' }, { id: 'anime', label: 'Anime' }] };
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
const errors = [], sent = [];
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => localStorage.setItem('localai.firstRun.done', '1'));
await page.route('**/api/images/models', r => r.fulfill({ json: models }));
await page.route('**/api/images/generate', async r => {
  const body = JSON.parse(r.request().postData()); sent.push(body);
  await new Promise(res => setTimeout(res, 300));
  const images = Array.from({ length: body.count || 1 }, (_, i) => ({ imageUrl: `/api/images/view?filename=x${i}.png&subfolder=&type=output`, seed: 7 + i }));
  r.fulfill({ json: { imageUrl: images[0].imageUrl, images, engine: body.engine, engineLabel: 'Quality', width: 1664, height: 2432, seed: 7, elapsedMs: 51000, upscaled: true, edited: !!body.source, prompt: body.prompt, usedPrompt: body.enhance ? body.prompt + ', golden hour, detailed' : body.prompt } });
});
await page.route('**/api/images/view**', r => r.fulfill({ body: Buffer.from(pixel, 'base64'), contentType: 'image/png' }));
await page.goto(base, { waitUntil: 'networkidle' });
await page.evaluate(() => window.showView('create'));
await page.waitForSelector('[data-engine="fast"]');

await check('engines are offered with the default selected and a time estimate', async () => {
  assert.deepEqual(await page.locator('[data-engine] b').allInnerTexts(), ['Fast', 'Quality', 'Best']);
  assert.equal(await page.locator('[data-engine="fast"]').getAttribute('aria-checked'), 'true');
  assert.match(await page.locator('[data-engine="fast"]').innerText(), /About 16 s/);
});
await check('shape sizes follow the chosen engine', async () => {
  assert.match(await page.locator('[data-aspect="portrait"]').innerText(), /512×768/);
  await page.click('[data-engine="quality"]');
  assert.match(await page.locator('[data-aspect="portrait"]').innerText(), /832×1216/);
});
await check('the request carries engine, shape, upscale and prompt help; the result shows', async () => {
  await page.click('[data-aspect="portrait"]');
  await page.check('#imageUpscale');
  await page.check('#imageEnhance');
  await page.fill('#imagePrompt', 'a lighthouse at dusk');
  await page.click('#generateBtn');
  await page.waitForSelector('.img-working');
  await page.waitForSelector('#imageActions:not([hidden])');
  const b = sent.at(-1);
  assert.deepEqual([b.engine, b.aspect, b.upscale, b.enhance, b.prompt, b.checkpoint], ['quality', 'portrait', true, true, 'a lighthouse at dusk', undefined]);
  assert.match(await page.locator('#imageMeta').innerText(), /Quality · 1664×2432 · 51 s · seed 7 · upscaled/);
  assert.equal(await page.locator('#imageUsedPromptBox').isHidden(), false);
});
await check('Another version repeats the request with a new seed', async () => {
  await page.click('#imageAgain');
  await page.waitForFunction(() => !document.querySelector('#generateBtn').disabled);
  await page.waitForSelector('#imageActions:not([hidden])');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].seed, undefined);
  assert.equal(sent[1].engine, 'quality');
});
await check('a model picked under Advanced is sent instead of the engine', async () => {
  await page.locator('.img-advanced summary').click();
  await page.selectOption('#checkpoint', 'v1-5-pruned-emaonly.safetensors');
  await page.click('#generateBtn');
  await page.waitForFunction(() => !document.querySelector('#generateBtn').disabled);
  assert.deepEqual([sent.at(-1).engine, sent.at(-1).checkpoint], [undefined, 'v1-5-pruned-emaonly.safetensors']);
});
await check('style and count are sent, and several results show as a grid', async () => {
  await page.selectOption('#checkpoint', '');
  await page.click('[data-style="anime"]');
  await page.click('#imageCount [data-count="4"]');
  assert.equal(await page.locator('#generateBtn').innerText(), 'Create 4 images');
  await page.click('#generateBtn');
  await page.waitForSelector('#imageBatch:not([hidden])');
  assert.deepEqual([sent.at(-1).style, sent.at(-1).count], ['anime', 4]);
  assert.equal(await page.locator('#imageBatch .img-thumb').count(), 4);
  await page.locator('#imageBatch [data-batch="2"]').click();
  assert.match(await page.locator('#imageMeta').innerText(), /seed 9/);
});
await check('editing: paint an area, and the image, mask, size and strength are sent', async () => {
  await page.click('#imageCount [data-count="1"]');
  await page.click('#imageEditThis');
  await page.waitForSelector('#imageEditPanel:not([hidden])');
  assert.equal(await page.locator('#imageShapeGroup').isHidden(), true);
  assert.equal(await page.locator('#generateBtn').innerText(), 'Apply edit');
  await page.waitForTimeout(600); // the editor scrolls into view smoothly
  await page.locator('#imageMaskCanvas').scrollIntoViewIfNeeded();
  const box = await page.locator('#imageMaskCanvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 5 }); await page.mouse.up();
  await page.locator('#imageStrength').fill('80');
  await page.fill('#imagePrompt', 'add a red balloon');
  await page.click('#generateBtn');
  await page.waitForFunction(() => !document.querySelector('#generateBtn').disabled);
  const b = sent.at(-1);
  assert.match(b.source, /^data:image\/png;base64,/);
  assert.match(b.mask, /^data:image\/png;base64,/);
  assert.equal(b.strength, 0.8);
  assert.ok(b.sourceWidth >= 8 && b.sourceWidth % 8 === 0 && b.sourceHeight % 8 === 0, `size ${b.sourceWidth}x${b.sourceHeight}`);
  // The mask is white where painted and black elsewhere.
  const px = await page.evaluate(async (m) => { const img = new Image(); img.src = m; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0); const d = x.getImageData(0, 0, img.width, img.height).data; let white = 0, black = 0; for (let i = 0; i < d.length; i += 4) d[i] > 128 ? white++ : black++; return { white, black }; }, b.mask);
  assert.ok(px.white > 0 && px.black > px.white, JSON.stringify(px));
});
await check('Clear marks redraws the whole image; Stop editing returns to new images', async () => {
  await page.click('#imageMaskClear');
  await page.click('#generateBtn');
  await page.waitForFunction(() => !document.querySelector('#generateBtn').disabled);
  assert.equal(sent.at(-1).mask, undefined);
  assert.ok(sent.at(-1).source);
  await page.click('#imageEditCancel');
  assert.equal(await page.locator('#imageEditPanel').isHidden(), true);
  assert.equal(await page.locator('#imageShapeGroup').isHidden(), false);
});
await check('errors are shown in place', async () => {
  await page.unroute('**/api/images/generate');
  await page.route('**/api/images/generate', r => r.fulfill({ status: 500, json: { error: 'ComfyUI: out of memory' } }));
  await page.click('#generateBtn');
  await page.waitForSelector('.img-error');
  assert.match(await page.locator('.img-error').innerText(), /out of memory/);
});
await check('no script errors', async () => assert.deepEqual(errors, []));
await browser.close();
if (failed) { console.log(`${failed} images check(s) failed`); process.exit(1) }
