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

test('edit graphs: whole-image redraw and masked repaint that keeps the rest', () => {
  const [fast, , best] = e.discoverEngines(full).engines;
  const base = { prompt: 'a red balloon', width: 768, height: 512, steps: 25, cfg: 7, seed: 3, denoise: 0.6 };
  const whole = e.buildWorkflow(fast, { ...base, source: { image: 'src.png' } });
  assert.equal(whole[6], undefined);
  assert.deepEqual(whole[7].inputs.latent_image, ['21', 0]);
  assert.equal(whole[7].inputs.denoise, 0.6);
  assert.deepEqual(whole[9].inputs.images, ['8', 0]);
  const masked = e.buildWorkflow(fast, { ...base, source: { image: 'src.png', mask: 'mask.png' }, batch: 2 });
  assert.equal(masked[22].inputs.channel, 'red');
  assert.deepEqual(masked[24].inputs.samples, ['21', 0]);
  assert.deepEqual(masked[25].inputs.samples, ['24', 0]);
  assert.deepEqual(masked[7].inputs.latent_image, ['25', 0]);
  assert.deepEqual(masked[26].inputs.destination, ['20', 0]);
  assert.deepEqual(masked[9].inputs.images, ['26', 0]);
  const fluxEdit = e.buildWorkflow(best, { ...base, source: { image: 'src.png', mask: 'm.png' } });
  assert.deepEqual(fluxEdit[21].inputs.vae, ['3', 0]);
  // New images ignore denoise.
  assert.equal(e.buildWorkflow(fast, base)[7].inputs.denoise, 1);
  for (const g of [whole, masked, fluxEdit]) for (const n of Object.values(g)) for (const v of Object.values(n.inputs)) if (Array.isArray(v)) assert.ok(g[v[0]], `missing node ${v[0]}`);
});

test('variations: one batch for Fast, queued singles for the 1024 px engines', () => {
  const [fast, quality] = e.discoverEngines(full).engines;
  assert.deepEqual(e.batchesFor(fast, 4), [4]);
  assert.deepEqual(e.batchesFor(quality, 4), [1, 1, 1, 1]);
  assert.deepEqual(e.batchesFor(fast, 9), [4]);
  assert.deepEqual(e.batchesFor(fast, 'x'), [1]);
  assert.equal(e.buildWorkflow(fast, { prompt: 'x', width: 512, height: 512, steps: 1, cfg: 1, seed: 1, batch: 4 })[6].inputs.batch_size, 4);
});

test('styles add to the prompt and to what to avoid', () => {
  assert.deepEqual(e.applyStyle('a cat', 'blurry', 'none'), { prompt: 'a cat', negative: 'blurry' });
  const anime = e.applyStyle('a cat', 'blurry', 'anime');
  assert.match(anime.prompt, /^a cat, anime style/);
  assert.match(anime.negative, /^blurry, photo/);
  assert.deepEqual(e.applyStyle('a cat', '', 'unknown'), { prompt: 'a cat', negative: '' });
  assert.equal(e.applyStyle('a cat', '', 'photo').negative.startsWith('illustration'), true);
});

test('a run summary reads as a sentence: count only when several, no model file name', () => {
  assert.equal(e.runSummary({ count: 1, width: 704, height: 1024, engine: 'Quality', editing: true }), 'Image edited with Quality · 704 × 1024');
  assert.equal(e.runSummary({ count: 4, width: 1024, height: 1024, engine: 'Fast', editing: false }), '4 images made with Fast · 1024 × 1024');
});
