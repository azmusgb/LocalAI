// Images › Fix a part: circle a part of a finished picture (a tap or a drag), say what to change (or pick a chip), get
// two versions beside the original and keep one. First against a mocked image API (request shape, mask, chips, Keep,
// the iPhone layout), then end to end through a real server and a stand-in ComfyUI, as tests/image-preview.test.cjs does.
// SHOTS=<dir> saves screenshots there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const { spawnAppServer } = createRequire(import.meta.url)('./spawn-server.cjs');
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const shots = process.env.SHOTS || '';
const browser = await chromium.launch();
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS', name) } catch (e) { failed++; console.log('FAIL', name, e.message) } }
const shot = async (page, name) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, name), fullPage: false }); } };

// A real picture to edit: a 256 x 256 gradient PNG (the editor reads its size from it).
function png(w, h) {
  const crc = b => zlib.crc32(b), chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data])) >>> 0); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = x; raw[o + 1] = y; raw[o + 2] = 160; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const picture = png(256, 256);
// What the page sent as a mask, read back in the browser: red levels at points (fractions of the size), and counts.
async function readMask(page, dataUrl, points) {
  return page.evaluate(async ({ m, points }) => {
    const img = new Image(); img.src = m; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, img.width, img.height).data; let white = 0, soft = 0, opaque = true, grey = true;
    for (let i = 0; i < d.length; i += 4) { if (d[i] === 255) white++; else if (d[i] > 0) soft++; if (d[i + 3] !== 255) opaque = false; if (d[i] !== d[i + 1] || d[i] !== d[i + 2]) grey = false; }
    const at = ([fx, fy]) => d[(Math.floor(fy * img.height) * img.width + Math.floor(fx * img.width)) * 4];
    return { w: img.width, h: img.height, white, soft, opaque, grey, red: points.map(at) };
  }, { m: dataUrl, points });
}
const models = { engines: [{ id: 'fast', label: 'Fast', blurb: 'Quick drafts.', family: 'sd15', base: 512 }, { id: 'best', label: 'Best', blurb: 'Most detailed.', family: 'zimage', base: 1024, preview: true }], custom: [], upscale: false, defaultEngine: 'best', aspects: [{ id: 'square', label: 'Square', sizes: { 512: [512, 512], 1024: [1024, 1024] } }], styles: [{ id: 'none', label: 'None' }, { id: 'photo', label: 'Photo' }] };
const errors = [];

// ---- 1. Mocked image API ----
async function mockedPage(viewport, extra = {}) {
  const page = await browser.newPage({ serviceWorkers: 'block', viewport, ...extra });
  const sent = [], deleted = [], library = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { localStorage.setItem('localai.firstRun.done', '1'); localStorage.setItem('localai.images.bestPreview', '0'); });
  await page.route('**/api/images/models', r => r.fulfill({ json: models }));
  await page.route('**/api/library', r => r.fulfill({ json: { items: library, counts: {}, total: library.length } }));
  await page.route('**/api/items/delete', r => { deleted.push(JSON.parse(r.request().postData())); r.fulfill({ json: { ok: true, trashId: 'trash-1' } }); });
  await page.route('**/api/images/generate', async r => {
    const body = JSON.parse(r.request().postData()); sent.push(body); const n = sent.length;
    await new Promise(res => setTimeout(res, 200));
    const images = Array.from({ length: body.count || 1 }, (_, i) => ({ imageUrl: `/api/images/view?filename=r${n}-${i}.png&subfolder=&type=output`, seed: 100 * n + i }));
    images.forEach((im, i) => library.unshift({ id: `lib-${n}-${i}`, kind: 'image', title: body.prompt, meta: { imageUrl: im.imageUrl, seed: im.seed, runId: `run-${n}` }, data: { prompt: body.prompt } }));
    r.fulfill({ json: { imageUrl: images[0].imageUrl, images, engine: body.engine, engineLabel: 'Best', style: body.style, width: 256, height: 256, seed: images[0].seed, elapsedMs: 9000, edited: !!body.source, prompt: body.prompt, usedPrompt: body.prompt, runId: `run-${n}`, threadId: 't-1' } });
  });
  await page.route('**/api/images/view**', r => r.fulfill({ body: picture, contentType: 'image/png' }));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(() => window.showView('create'));
  await page.waitForSelector('[data-engine="best"][aria-checked="true"]');
  await page.click('[data-style="photo"]');
  await page.fill('#imagePrompt', 'a fox girl in a forest');
  await page.click('#generateBtn');
  await page.waitForSelector('#imageActions:not([hidden])');
  return { page, sent, deleted, library };
}
const canvasBox = async page => { await page.locator('#imageMaskCanvas').scrollIntoViewIfNeeded(); return page.locator('#imageMaskCanvas').boundingBox(); };
const openFix = async page => { await page.click('#imageFixPart'); await page.waitForSelector('#imageFixTools:not([hidden])'); await page.waitForFunction(() => document.getElementById('imageMaskCanvas').width === 256); };

{
  const { page, sent, deleted } = await mockedPage({ width: 1280, height: 900 });
  await check('Fix a part sits next to Edit this image and opens the editor in its own mode', async () => {
    const ids = await page.locator('#imageActions > *').evaluateAll(els => els.map(e => e.id));
    assert.equal(ids.indexOf('imageFixPart'), ids.indexOf('imageEditThis') + 1, ids.join());
    await openFix(page);
    assert.equal(await page.locator('#imageEditTitle').innerText(), 'Fix a part');
    assert.equal(await page.locator('#imageStrengthOut').innerText(), '100%');
    for (const id of ['#imagePrompt', '#generateBtn', '#imageEngines']) assert.equal(await page.locator(id).isVisible(), false, `${id} is out of the way`);
    assert.equal(await page.locator('#imageFixMode').isVisible(), true);
    assert.equal(await page.locator('[data-fix-mode="circle"]').getAttribute('aria-checked'), 'true');
    assert.match(await page.locator('#imageEditHint').innerText(), /Tap the part to fix, or drag around it/);
  });
  await check('nothing is sent until a part is circled and a change is named', async () => {
    const before = sent.length;
    await page.click('#imageFixGo');
    assert.match(await page.locator('#imageEditHint').innerText(), /Tap or circle the part to fix first/);
    assert.equal(sent.length, before);
  });
  await check('chips fill the change box with plain words, and typing your own clears the chip', async () => {
    assert.deepEqual(await page.locator('[data-fix-preset]').allInnerTexts(), ['Hands', 'Face', 'Ears', 'Remove object']);
    await page.click('[data-fix-preset="ears"]');
    assert.equal(await page.inputValue('#imageFixPrompt'), 'bigger, clearer ears');
    assert.equal(await page.locator('[data-fix-preset="ears"]').getAttribute('aria-pressed'), 'true');
    await page.click('[data-fix-preset="remove"]');
    assert.equal(await page.inputValue('#imageFixPrompt'), 'nothing here, same background as around it');
    assert.equal(await page.locator('[data-fix-preset="ears"]').getAttribute('aria-pressed'), 'false');
    await page.fill('#imageFixPrompt', 'bigger fennec ears, no hat');
    assert.equal(await page.locator('[data-fix-preset][aria-pressed="true"]').count(), 0);
  });
  await check('a drag around the part sends a soft-edged mask, full strength, two versions, the change before the scene', async () => {
    const box = await canvasBox(page);
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.2);
    await page.mouse.down();
    for (const [fx, fy] of [[0.5, 0.15], [0.7, 0.2], [0.7, 0.4], [0.5, 0.45], [0.3, 0.4]]) await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 3 });
    await shot(page, 'desktop-1-circling.png');
    await page.mouse.up();
    assert.match(await page.locator('#imageEditHint').innerText(), /Circled/);
    await shot(page, 'desktop-2-circled.png');
    await page.click('#imageFixGo');
    await page.waitForSelector('#imageFixCompare:not([hidden])');
    const b = sent.at(-1);
    assert.equal(b.prompt, 'bigger fennec ears, no hat. a fox girl in a forest');
    assert.deepEqual([b.count, b.strength, b.engine, b.style, b.enhance, b.upscale, b.sourceWidth, b.sourceHeight, b.threadId], [2, 1, 'best', 'photo', false, false, 256, 256, 't-1']);
    assert.match(b.source, /^data:image\/png;base64,/);
    const m = await readMask(page, b.mask, [[0.5, 0.3], [0.05, 0.95], [0.95, 0.95]]);
    assert.deepEqual([m.w, m.h], [256, 256]);
    assert.deepEqual(m.red, [255, 0, 0], 'white in the circled part, black far from it');
    assert.ok(m.soft > 200, `a feathered edge (${m.soft} grey pixels)`);
    assert.ok(m.opaque && m.grey, 'opaque grey levels, read from the red channel');
  });
  await check('the results show the original beside both versions; tapping one shows it large', async () => {
    assert.deepEqual(await page.locator('#imageFixCompare figcaption').allInnerTexts(), ['Original', 'Fix 1', 'Fix 2']);
    assert.equal(await page.locator('#imageFixCompare [data-fix-keep]').count(), 2);
    assert.equal(await page.locator('#imageBatch').isHidden(), true);
    const tops = await page.locator('#imageFixCompare figure').evaluateAll(f => f.map(e => Math.round(e.getBoundingClientRect().top)));
    assert.equal(new Set(tops).size, 1, `side by side: ${tops}`);
    await page.click('[data-fix-show="1"]');
    assert.match(await page.locator('#generatedImage').getAttribute('src'), /r2-1\.png/);
    await page.locator('#imageFixCompare').scrollIntoViewIfNeeded();
    await shot(page, 'desktop-3-results.png');
  });
  await check('Keep keeps that one: the other version leaves Library (with Undo) and the kept one is the picture', async () => {
    await page.click('[data-fix-keep="0"]');
    await page.waitForSelector('#imageFixCompare', { state: 'hidden' });
    assert.deepEqual(deleted.at(-1), { items: [{ kind: 'library', id: 'lib-2-1' }] });
    assert.match(await page.locator('#toast').innerText(), /Deleted 1 item/);
    assert.match(await page.locator('#generatedImage').getAttribute('src'), /r2-0\.png/);
    assert.equal(await page.locator('#imageEditPanel').isHidden(), true);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('img-fixing')), false);
    assert.equal(await page.locator('#imagePrompt').isVisible(), true);
  });
  await check('a second fix keeps the scene: the brush alone marks an area, and the prompt still ends with the scene', async () => {
    await openFix(page);
    await page.click('[data-fix-mode="brush"]');
    assert.match(await page.locator('#imageEditHint').innerText(), /Paint to add/);
    const box = await canvasBox(page);
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.8); await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.8, { steps: 4 }); await page.mouse.up();
    await page.click('[data-fix-preset="remove"]');
    await page.click('#imageFixGo');
    await page.waitForSelector('#imageFixCompare:not([hidden])');
    const b = sent.at(-1);
    assert.equal(b.prompt, 'nothing here, same background as around it. a fox girl in a forest');
    const m = await readMask(page, b.mask, [[0.3, 0.8], [0.5, 0.3]]);
    assert.deepEqual(m.red, [255, 0]);
  });
  await check('Clear marks clears the circle; Edit this image afterwards is a plain edit again', async () => {
    await page.click('#imageMaskClear');
    await page.click('#imageFixGo');
    assert.match(await page.locator('#imageEditHint').innerText(), /circle the part to fix first/);
    await page.click('#imageEditCancel');
    await page.click('#imageEditThis');
    await page.waitForSelector('#imageEditPanel:not([hidden])');
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#imageEditTitle').innerText(), 'Editing an image');
    assert.equal(await page.locator('#imageFixTools').isHidden(), true);
    assert.equal(await page.locator('#imageFixMode').isVisible(), false);
    assert.equal(await page.locator('#imageStrengthOut').innerText(), '60%');
    assert.match(await page.locator('#imageEditHint').innerText(), /Paint over the part to change/);
    await page.click('#imageEditCancel');
  });
  // Review (2026-10-19): Keep on one version, then a quick Keep on the other before the first finished, deleted both.
  await check('two quick Keep taps keep one: both Keeps are disabled once one is tapped, and only the other version is deleted', async () => {
    await openFix(page);
    const box = await canvasBox(page);
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.click('[data-fix-preset="hands"]');
    const n = sent.length + 1, before = deleted.length;
    await page.click('#imageFixGo');
    await page.waitForSelector(`#imageFixCompare:not([hidden]) img[src*="r${n}-1.png"]`); // this fix's versions, not the last one's
    const disabled = await page.evaluate(() => { const [a, b] = document.querySelectorAll('#imageFixCompare [data-fix-keep]'); a.click(); const d = [a.disabled, b.disabled]; b.click(); return d; });
    assert.deepEqual(disabled, [true, true], 'both Keeps wait while one is kept');
    await page.waitForSelector('#imageFixCompare', { state: 'hidden' });
    await page.waitForTimeout(300);
    assert.deepEqual(deleted.slice(before), [{ items: [{ kind: 'library', id: `lib-${n}-1` }] }], 'only the version not kept');
    assert.match(await page.locator('#generatedImage').getAttribute('src'), new RegExp(`r${n}-0\\.png`));
  });
  await page.close();
}

// iPhone 15 width: tap to circle, 44 px targets, nothing wider than the screen.
{
  const { page, sent } = await mockedPage({ width: 393, height: 852 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const small = sel => page.locator(sel).evaluateAll(els => els.filter(e => { const r = e.getBoundingClientRect(); return r.width && r.height && (r.width < 44 || r.height < 44); }).map(e => `${e.id || e.dataset.fixPreset || e.dataset.fixMode || e.dataset.fixKeep || e.textContent.trim()} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`));
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth);
  await check('iPhone: Fix a part is in reach and the editor fits the screen with 44 px controls', async () => {
    assert.deepEqual(await small('#imageActions button'), []);
    await page.tap('#imageFixPart');
    await page.waitForSelector('#imageFixTools:not([hidden])');
    await page.waitForFunction(() => document.getElementById('imageMaskCanvas').width === 256);
    assert.deepEqual(await small('#imageEditPanel button, #imageFixPrompt'), []);
    assert.ok(await wide() <= 393, `page is ${await wide()} px wide`);
    const r = await page.locator('#imageEditPanel').boundingBox();
    assert.ok(r.x >= 0 && r.x + r.width <= 393, JSON.stringify(r));
  });
  await check('iPhone: one tap circles the part', async () => {
    const box = await canvasBox(page);
    await page.touchscreen.tap(box.x + box.width * 0.5, box.y + box.height * 0.3);
    assert.match(await page.locator('#imageEditHint').innerText(), /Circled/);
    await page.tap('[data-fix-preset="hands"]');
    await shot(page, 'iphone-1-tap-circled.png');
    await page.tap('#imageFixGo');
    await page.waitForSelector('#imageFixCompare:not([hidden])');
    const b = sent.at(-1);
    assert.equal(b.prompt, 'natural hands with five fingers each. a fox girl in a forest');
    const m = await readMask(page, b.mask, [[0.5, 0.3], [0.5, 0.95]]);
    assert.deepEqual(m.red, [255, 0]);
    assert.ok(m.soft > 100, `soft edge: ${m.soft}`);
  });
  await check('iPhone: the original and both versions sit side by side on screen, Keep buttons 44 px', async () => {
    await page.locator('#imageFixCompare').scrollIntoViewIfNeeded();
    const figs = await page.locator('#imageFixCompare figure').evaluateAll(f => f.map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), Math.round(r.top)]; }));
    assert.equal(figs.length, 3);
    assert.equal(new Set(figs.map(f => f[2])).size, 1, JSON.stringify(figs));
    assert.ok(figs.every(([l, r]) => l >= 0 && r <= 393), JSON.stringify(figs));
    assert.deepEqual(await small('#imageFixCompare button'), []);
    assert.ok(await wide() <= 393);
    await shot(page, 'iphone-2-results.png');
  });
  await page.close();
}

// ---- 2. End to end: the real server and a stand-in ComfyUI ----
function fakeComfy() {
  const graphs = [], uploads = [];
  const lists = { CheckpointLoaderSimple: ['DreamShaper_8_pruned.safetensors'], UNETLoader: ['z_image_turbo_bf16.safetensors'], CLIPLoader: ['qwen_3_4b.safetensors'], VAELoader: ['ae.safetensors'] };
  const inputOf = { CheckpointLoaderSimple: 'ckpt_name', UNETLoader: 'unet_name', CLIPLoader: 'clip_name', VAELoader: 'vae_name' };
  const server = http.createServer((req, res) => {
    const parts = []; req.on('data', c => parts.push(c));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      const node = /^\/object_info\/(\w+)$/.exec(req.url)?.[1];
      if (node) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(lists[node] ? { [node]: { input: { required: { [inputOf[node]]: [lists[node]] } } } } : {})); }
      if (req.url === '/upload/image' && req.method === 'POST') {
        // multipart: keep the file's name and bytes
        const s = body.toString('latin1'), name = /filename="([^"]+)"/.exec(s)?.[1] || 'x.png', start = s.indexOf('\r\n\r\n', s.indexOf('filename=')) + 4, end = s.indexOf('\r\n--', start);
        uploads.push({ name, bytes: body.subarray(start, end) });
        res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ name, subfolder: '', type: 'input' }));
      }
      if (req.url === '/prompt' && req.method === 'POST') { graphs.push(JSON.parse(body).prompt); res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ prompt_id: `p${graphs.length}` })); }
      const h = /^\/history\/(p\d+)$/.exec(req.url);
      if (h) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ [h[1]]: { status: { status_str: 'success' }, outputs: { 9: { images: [{ filename: `${h[1]}.png`, subfolder: '', type: 'output' }] } } } })); }
      if (req.url.startsWith('/view')) { res.setHeader('Content-Type', 'image/png'); return res.end(picture); }
      res.statusCode = 404; res.end('{}');
    });
  });
  return { server, graphs, uploads };
}
{
  const comfy = fakeComfy(); comfy.server.listen(0, '127.0.0.1'); await once(comfy.server, 'listening');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-fixpart-')), off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, COMFY_URL: `http://127.0.0.1:${comfy.server.address().port}`, OLLAMA_URL: off, SEARXNG_URL: off, N8N_URL: off, PROXY_URL: off, GRIDCRAFT_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, LOCALAI_WORKSHOP_URL: off } });
  try {
    const url = await ready;
    const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => { localStorage.setItem('localai.firstRun.done', '1'); localStorage.setItem('localai.images.bestPreview', '0'); });
    const libraryImages = async () => (await (await fetch(url + '/api/library')).json()).items.filter(x => x.kind === 'image').map(x => x.meta.imageUrl);
    await check('end to end: a Best picture, then Fix a part repaints only the circled area, twice, at full strength', async () => {
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.evaluate(() => window.showView('create'));
      await page.waitForSelector('[data-engine="best"]');
      await page.click('[data-engine="best"]');
      await page.fill('#imagePrompt', 'a fox girl in a forest');
      await page.click('#generateBtn');
      await page.waitForSelector('#imageActions:not([hidden])', { timeout: 30000 });
      assert.equal(comfy.graphs.length, 1);
      await openFix(page);
      const box = await canvasBox(page);
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.25);
      await page.click('[data-fix-preset="ears"]');
      await page.click('#imageFixGo');
      await page.waitForSelector('#imageFixCompare:not([hidden])', { timeout: 30000 });
      const fixes = comfy.graphs.slice(1);
      assert.equal(fixes.length, 2, 'Best draws the two versions one after another');
      for (const g of fixes) {
        assert.equal(g[4].inputs.text, 'bigger, clearer ears. a fox girl in a forest');
        assert.equal(g[7].inputs.denoise, 1);
        assert.deepEqual([g[22].class_type, g[22].inputs.channel, g[23].class_type], ['LoadImageMask', 'red', 'GrowMask']);
        assert.equal(g[26].class_type, 'ImageCompositeMasked');
      }
      assert.notEqual(fixes[0][7].inputs.seed, fixes[1][7].inputs.seed);
      const mask = comfy.uploads.find(u => /-mask\.png$/.test(u.name));
      assert.ok(mask, comfy.uploads.map(u => u.name).join());
      const m = await readMask(page, `data:image/png;base64,${mask.bytes.toString('base64')}`, [[0.5, 0.25], [0.5, 0.9]]);
      assert.deepEqual(m.red, [255, 0]);
      assert.ok(m.soft > 100, `soft edge in the uploaded mask: ${m.soft}`);
      const lib = await libraryImages();
      assert.equal(lib.length, 3, 'the original and both versions arrived in Library');
    });
    await check('end to end: Keep the second version; the first leaves Library, the original stays', async () => {
      const urls = await page.locator('#imageFixCompare [data-fix-show] img').evaluateAll(i => i.map(e => new URL(e.getAttribute('src'), location.href).searchParams.get('filename')));
      await page.click('[data-fix-keep="1"]');
      await page.waitForSelector('#imageFixCompare', { state: 'hidden' });
      const lib = (await libraryImages()).map(u => new URL(u, url).searchParams.get('filename'));
      assert.deepEqual(lib.sort(), [urls[0], urls[2]].sort(), `kept ${lib} of ${urls}`);
      assert.match(await page.locator('#generatedImage').getAttribute('src'), new RegExp(urls[2].replace('.', '\\.')));
    });
    await page.close();
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    comfy.server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
await check('no script errors', async () => assert.deepEqual(errors, []));
await browser.close();
if (failed) { console.log(`${failed} fix-a-part check(s) failed`); process.exit(1) }
