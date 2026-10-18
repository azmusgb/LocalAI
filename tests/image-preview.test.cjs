'use strict';

// Best's quick preview through the real server and a stand-in ComfyUI: the preview is its own run (meta.preview) made
// small and in 6 steps, kept out of Library; the full picture links to it (meta.previewOf) with the same seed and lands
// in Library; Keep puts a preview in Library and un-keep takes it out.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');

function fakeComfy() {
  const graphs = [];
  const lists = {
    CheckpointLoaderSimple: ['DreamShaper_8_pruned.safetensors'], UNETLoader: ['z_image_turbo_bf16.safetensors'],
    CLIPLoader: ['qwen_3_4b.safetensors'], VAELoader: ['ae.safetensors']
  };
  const inputOf = { CheckpointLoaderSimple: 'ckpt_name', UNETLoader: 'unet_name', CLIPLoader: 'clip_name', VAELoader: 'vae_name' };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const node = /^\/object_info\/(\w+)$/.exec(req.url)?.[1];
      if (node) return res.end(JSON.stringify(lists[node] ? { [node]: { input: { required: { [inputOf[node]]: [lists[node]] } } } } : {}));
      if (req.url === '/prompt' && req.method === 'POST') {
        graphs.push(JSON.parse(body).prompt);
        return res.end(JSON.stringify({ prompt_id: `p${graphs.length}` }));
      }
      const h = /^\/history\/(p\d+)$/.exec(req.url);
      if (h) return res.end(JSON.stringify({ [h[1]]: { status: { status_str: 'success' }, outputs: { 9: { images: [{ filename: `${h[1]}.png`, subfolder: '', type: 'output' }] } } } }));
      res.statusCode = 404; res.end('{}');
    });
  });
  return { server, graphs };
}

test('Best preview: its own run out of Library; the full picture links to it with the same seed', { timeout: 60000 }, async t => {
  const comfy = fakeComfy();
  comfy.server.listen(0, '127.0.0.1');
  await once(comfy.server, 'listening');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-preview-'));
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({
    env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, COMFY_URL: `http://127.0.0.1:${comfy.server.address().port}`, OLLAMA_URL: off, SEARXNG_URL: off, N8N_URL: off, PROXY_URL: off, GRIDCRAFT_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    comfy.server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const get = async p => (await fetch(base + p)).json();
  const libraryImages = async () => (await get('/api/library')).items.filter(x => x.kind === 'image');

  const models = await get('/api/images/models');
  const best = models.engines.find(e => e.id === 'best');
  assert.equal(best.preview, true, 'Best offers a preview');
  assert.ok(!models.engines.find(e => e.id === 'fast').preview, 'Fast does not');

  // The preview: 400 x 576 for a portrait, 6 steps, no Library item.
  const pv = await post('/api/images/generate', { prompt: 'a lighthouse at dusk', engine: 'best', aspect: 'portrait', preview: true, upscale: true });
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.preview, true);
  assert.deepEqual([pv.body.width, pv.body.height, pv.body.steps, pv.body.upscaled], [400, 576, 6, false]);
  const g1 = comfy.graphs.at(-1);
  assert.deepEqual([g1[6].inputs.width, g1[6].inputs.height, g1[7].inputs.steps], [400, 576, 6]);
  assert.equal(g1[7].inputs.seed, pv.body.seed);
  const pvRun = (await get(`/api/runs?id=${pv.body.runId}`)).item;
  assert.equal(pvRun.meta.preview, true);
  assert.deepEqual(pvRun.artifactIds, []);
  assert.match(pvRun.summary || pvRun.card?.summary || '', /Preview made with Best · 400 × 576/);
  assert.deepEqual(await libraryImages(), [], 'a preview is not added to Library');

  // The full picture from it: full size, 8 steps, the preview's seed and prompt, linked by meta.previewOf.
  const full = await post('/api/images/generate', { prompt: 'a lighthouse at dusk', engine: 'best', aspect: 'portrait', previewOf: pv.body.runId, threadId: pv.body.threadId });
  assert.equal(full.status, 200, JSON.stringify(full.body));
  assert.deepEqual([full.body.width, full.body.height, full.body.steps, full.body.seed, full.body.previewOf], [832, 1216, 8, pv.body.seed, pv.body.runId]);
  assert.equal(full.body.preview, undefined);
  const g2 = comfy.graphs.at(-1);
  assert.equal(g2[7].inputs.seed, g1[7].inputs.seed);
  assert.equal(g2[4].inputs.text, g1[4].inputs.text);
  const fullRun = (await get(`/api/runs?id=${full.body.runId}`)).item;
  assert.equal(fullRun.meta.previewOf, pv.body.runId);
  assert.equal(fullRun.meta.preview, undefined);
  assert.equal(fullRun.threadId, pvRun.threadId, 'preview and full picture are versions of one thread');
  let lib = await libraryImages();
  assert.deepEqual(lib.map(x => x.meta.runId), [full.body.runId], 'only the full picture is in Library');

  // A preview asked of another engine is an ordinary image.
  const fast = await post('/api/images/generate', { prompt: 'a cat', engine: 'fast', preview: true });
  assert.deepEqual([fast.body.preview, fast.body.width, fast.body.steps], [undefined, 512, 25]);
  assert.equal((await libraryImages()).length, 2);

  // Keep puts the preview in Library; un-keep takes it out again.
  const keep = await post('/api/library/keep', { runId: pv.body.runId, kept: true });
  assert.equal(keep.status, 200, JSON.stringify(keep.body));
  assert.equal(keep.body.item.meta.preview, true);
  assert.equal((await post('/api/library/keep', { runId: pv.body.runId, kept: true })).body.item.id, keep.body.item.id, 'keeping twice adds it once');
  lib = await libraryImages();
  assert.equal(lib.filter(x => x.meta.runId === pv.body.runId).length, 1);
  assert.equal((await post('/api/library/keep', { runId: pv.body.runId, kept: false })).body.kept, false);
  assert.ok(!(await libraryImages()).some(x => x.meta.runId === pv.body.runId));
  // A full picture is already in Library: it is not kept this way.
  assert.equal((await post('/api/library/keep', { runId: full.body.runId, kept: true })).status, 409);
});
