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

// Z-Image Turbo as installed on the owner's ComfyUI: diffusion_models, text_encoders and vae.
const zimage = { diffusionModels: ['z_image_turbo_bf16.safetensors'], textEncoders: ['qwen_3_4b_fp8_mixed.safetensors', 'qwen_3_4b.safetensors', 'clip_l.safetensors'], vaes: ['ae.safetensors', 'flux_ae.safetensors'] };

test('Best runs Z-Image Turbo when its three files are installed, else FLUX schnell, else nothing', () => {
  const both = e.discoverEngines({ ...full, ...zimage, vaes: ['flux_ae.safetensors', 'ae.safetensors'] });
  const best = both.engines.find(x => x.id === 'best');
  assert.equal(best.family, 'zimage');
  assert.equal(best.label, 'Best');
  assert.equal(best.model, 'Z-Image Turbo');
  // The plain bf16 text encoder wins over fp8_mixed; the "ae" VAE wins over flux_ae.
  assert.deepEqual(best.files, { unet: 'z_image_turbo_bf16.safetensors', textEncoder: 'qwen_3_4b.safetensors', vae: 'ae.safetensors' });
  assert.deepEqual(both.engines.map(x => x.id), ['fast', 'quality', 'best']);
  // Only fp8_mixed installed: that one is used.
  assert.equal(e.discoverEngines({ ...zimage, textEncoders: ['qwen_3_4b_fp8_mixed.safetensors'] }).engines[0].files.textEncoder, 'qwen_3_4b_fp8_mixed.safetensors');
  // A flux_ae-only VAE folder still works (same file).
  assert.equal(e.discoverEngines({ ...zimage, vaes: ['flux_ae.safetensors'] }).engines[0].files.vae, 'flux_ae.safetensors');
  // Partial Z-Image installs fall back to FLUX for Best.
  for (const partial of [{ diffusionModels: [] }, { textEncoders: ['clip_l.safetensors'] }]) {
    const d = e.discoverEngines({ ...full, ...zimage, ...partial });
    const fallback = d.engines.find(x => x.id === 'best');
    assert.equal(fallback.family, 'flux');
    assert.equal(fallback.model, 'FLUX.1 schnell');
    assert.equal(fallback.files.unet, 'flux1-schnell-Q4_K_S.gguf');
  }
  // Partial Z-Image and no FLUX: no Best at all.
  assert.deepEqual(e.discoverEngines({ checkpoints: full.checkpoints, ...zimage, diffusionModels: [] }).engines.map(x => x.id), ['fast', 'quality']);
  assert.deepEqual(e.discoverEngines({ ...zimage, vaes: ['sdxl_vae.safetensors'] }).engines, []);
});

test('Z-Image graph: UNETLoader, Qwen3 text encoder, AuraFlow shift 3, 8 steps at cfg 1, no negative text', () => {
  const best = e.discoverEngines(zimage).engines[0];
  assert.deepEqual([best.base, best.steps, best.cfg, best.sampler, best.scheduler, best.shift], [1024, 8, 1, 'res_multistep', 'simple', 3]);
  assert.deepEqual(e.sizeFor(best, 'portrait'), [832, 1216]);
  const g = e.buildWorkflow(best, { prompt: 'a lighthouse', negativePrompt: 'ignored', width: 1024, height: 1024, steps: 8, cfg: 1, seed: 7 });
  assert.deepEqual(g[1], { class_type: 'UNETLoader', inputs: { unet_name: 'z_image_turbo_bf16.safetensors', weight_dtype: 'default' } });
  assert.deepEqual(g[2], { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'lumina2', device: 'default' } });
  assert.deepEqual(g[3].inputs, { vae_name: 'ae.safetensors' });
  assert.deepEqual(g[13], { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3 } });
  assert.deepEqual(g[4].inputs, { text: 'a lighthouse', clip: ['2', 0] });
  assert.deepEqual(g[5], { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } });
  assert.equal(g[6].class_type, 'EmptySD3LatentImage');
  assert.deepEqual(g[7].inputs, { seed: 7, steps: 8, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1, model: ['13', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0] });
  assert.deepEqual(g[8].inputs, { samples: ['7', 0], vae: ['3', 0] });
  assert.deepEqual(g[9].inputs.images, ['8', 0]);
  // The only text in the graph is the prompt: the negative never reaches it.
  assert.ok(!JSON.stringify(g).includes('ignored'));
  assert.deepEqual(Object.values(g).map(n => n.class_type).sort(), ['CLIPLoader', 'CLIPTextEncode', 'ConditioningZeroOut', 'EmptySD3LatentImage', 'KSampler', 'ModelSamplingAuraFlow', 'SaveImage', 'UNETLoader', 'VAEDecode', 'VAELoader']);
  // Edits encode with the Z-Image VAE; batches stay one at a time at 1024 px.
  const edit = e.buildWorkflow(best, { prompt: 'x', width: 1024, height: 1024, steps: 8, cfg: 1, seed: 1, source: { image: 'src.png', mask: 'm.png' }, denoise: 0.6 });
  assert.deepEqual(edit[21].inputs.vae, ['3', 0]);
  assert.deepEqual(edit[7].inputs.model, ['13', 0]);
  assert.deepEqual(e.batchesFor(best, 3), [1, 1, 1]);
  for (const graph of [g, edit]) for (const n of Object.values(graph)) for (const v of Object.values(n.inputs)) if (Array.isArray(v)) assert.ok(graph[v[0]], `missing node ${v[0]}`);
});

test('cfg-1 engines (Z-Image, FLUX) drop style "avoid" words; the others keep them', () => {
  const zi = e.discoverEngines(zimage).engines[0];
  const [fast, , flux] = e.discoverEngines(full).engines;
  assert.deepEqual(e.applyStyle('a cat', 'blurry', 'photo', zi), { prompt: `a cat, ${e.STYLES.photo.add}`, negative: '' });
  assert.equal(e.applyStyle('a cat', '', 'anime', flux).negative, '');
  assert.match(e.applyStyle('a cat', 'blurry', 'anime', fast).negative, /^blurry, photo/);
});

test('Best preview: 512 square or the shape scaled into 576, 6 steps, and the graph keeps the seed and prompt', () => {
  const best = e.discoverEngines(zimage).engines[0];
  const [fast, quality] = e.discoverEngines(full).engines;
  assert.equal(e.previewable(best), true);
  assert.equal(e.previewable(fast), false);
  assert.equal(e.previewable(quality), false);
  assert.deepEqual(e.previewSettings(...e.sizeFor(best, 'square'), best.steps), { width: 512, height: 512, steps: 6 });
  // Other shapes keep their proportions, longest side 576, sides a multiple of 16.
  assert.deepEqual(e.previewSettings(...e.sizeFor(best, 'portrait'), 8), { width: 400, height: 576, steps: 6 });
  assert.deepEqual(e.previewSettings(...e.sizeFor(best, 'landscape'), 8), { width: 576, height: 400, steps: 6 });
  assert.deepEqual(e.previewSettings(...e.sizeFor(best, 'wide'), 8), { width: 576, height: 336, steps: 6 });
  // Never more steps than the full picture (FLUX schnell runs 4).
  assert.equal(e.previewSettings(1024, 1024, 4).steps, 4);
  const p = e.previewSettings(1024, 1024, best.steps);
  const preview = e.buildWorkflow(best, { prompt: 'a lighthouse', width: p.width, height: p.height, steps: p.steps, cfg: 1, seed: 4242 });
  const fullGraph = e.buildWorkflow(best, { prompt: 'a lighthouse', width: 1024, height: 1024, steps: best.steps, cfg: 1, seed: 4242 });
  assert.deepEqual(preview[6].inputs, { width: 512, height: 512, batch_size: 1 });
  assert.equal(preview[7].inputs.steps, 6);
  assert.equal(fullGraph[7].inputs.steps, 8);
  assert.equal(preview[7].inputs.seed, fullGraph[7].inputs.seed);
  assert.deepEqual(preview[4].inputs, fullGraph[4].inputs);
  assert.deepEqual(preview[13], fullGraph[13]);
  assert.equal(e.runSummary({ count: 1, width: 512, height: 512, engine: 'Best', preview: true }), 'Preview made with Best · 512 × 512');
});
