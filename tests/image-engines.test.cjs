const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('../app/image-engines.js');

const full = { checkpoints: ['v1-5-pruned-emaonly.safetensors', 'DreamShaper_8_pruned.safetensors', 'DreamShaperXL_Lightning.safetensors'], unets: ['flux1-schnell-Q4_K_S.gguf'], clips: ['clip_l.safetensors', 't5xxl_fp8_e4m3fn.safetensors'], vaes: ['flux_ae.safetensors'], upscalers: ['RealESRGAN_x4plus.pth'] };

test('discovers fast, quality and best engines from installed files', () => {
  const d = e.discoverEngines(full);
  assert.deepEqual(d.engines.map(x => x.id), ['fast', 'quality', 'best']);
  assert.equal(d.engines[0].files.checkpoint, 'DreamShaper_8_pruned.safetensors');
  assert.equal(d.engines[1].files.checkpoint, 'DreamShaperXL_Lightning.safetensors');
  assert.deepEqual(d.engines[2].files, { unet: 'flux1-schnell-Q4_K_S.gguf', t5: 't5xxl_fp8_e4m3fn.safetensors', clipL: 'clip_l.safetensors', vae: 'flux_ae.safetensors' });
  assert.deepEqual(d.custom, ['v1-5-pruned-emaonly.safetensors']);
  assert.equal(d.upscaler, 'RealESRGAN_x4plus.pth');
  assert.equal(d.defaultEngine, 'fast');
});

test('only offers what is fully installed', () => {
  assert.deepEqual(e.discoverEngines({ checkpoints: ['v1-5-pruned-emaonly.safetensors'] }).engines.map(x => [x.id, x.files.checkpoint]), [['fast', 'v1-5-pruned-emaonly.safetensors']]);
  // FLUX without its text encoder is not offered.
  assert.deepEqual(e.discoverEngines({ ...full, clips: ['clip_l.safetensors'] }).engines.map(x => x.id), ['fast', 'quality']);
  assert.deepEqual(e.discoverEngines({}).engines, []);
  assert.equal(e.discoverEngines({}).defaultEngine, null);
});

test('checkpoint families', () => {
  assert.equal(e.inferCheckpointFamily('DreamShaperXL_Lightning.safetensors'), 'sdxl-fast');
  assert.equal(e.inferCheckpointFamily('sd_xl_base_1.0.safetensors'), 'sdxl');
  assert.equal(e.inferCheckpointFamily('DreamShaper_8_pruned.safetensors'), 'sd15');
  assert.equal(e.inferCheckpointFamily('flux1-dev.safetensors'), 'flux');
  assert.equal(e.customEngine('sd_xl_base_1.0.safetensors').steps, 28);
});

test('sizes follow the engine’s training resolution', () => {
  const [fast, quality] = e.discoverEngines(full).engines;
  assert.deepEqual(e.sizeFor(fast, 'portrait'), [512, 768]);
  assert.deepEqual(e.sizeFor(quality, 'landscape'), [1216, 832]);
  assert.deepEqual(e.sizeFor(quality, 'nope'), [1024, 1024]);
  assert.deepEqual(e.sizeFor(fast, null, 2000, 100), [1024, 256]);
  assert.deepEqual(e.sizeFor(quality, null, 1000, 1500), [1024, 1472]);
});

test('graphs: checkpoint, FLUX GGUF, and the optional 2x upscale all end in node 9', () => {
  const [fast, , best] = e.discoverEngines(full).engines;
  const base = { prompt: 'a red fox', negativePrompt: undefined, width: 512, height: 512, steps: 25, cfg: 7, seed: 1 };
  const g1 = e.buildWorkflow(fast, base);
  assert.equal(g1[1].inputs.ckpt_name, 'DreamShaper_8_pruned.safetensors');
  assert.equal(g1[5].inputs.text, fast.negative);
  assert.equal(g1[7].inputs.sampler_name, 'dpmpp_2m');
  assert.deepEqual(g1[9].inputs.images, ['8', 0]);
  const g2 = e.buildWorkflow(best, { ...base, steps: 4, cfg: 1 });
  assert.equal(g2[1].class_type, 'UnetLoaderGGUF');
  assert.equal(g2[2].inputs.type, 'flux');
  assert.equal(g2[6].class_type, 'EmptySD3LatentImage');
  const g3 = e.buildWorkflow(fast, { ...base, upscaler: 'RealESRGAN_x4plus.pth' });
  assert.deepEqual(g3[9].inputs.images, ['12', 0]);
  assert.equal(g3[12].inputs.scale_by, 0.5);
  // Every reference points at a node in the graph.
  for (const g of [g1, g2, g3]) for (const n of Object.values(g)) for (const v of Object.values(n.inputs)) if (Array.isArray(v)) assert.ok(g[v[0]], `missing node ${v[0]}`);
});
