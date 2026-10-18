'use strict';
// Image engines: which open models are installed in ComfyUI, the settings each one is tuned for, and the
// ComfyUI graph that runs it. Pure functions; server.js fetches the model lists and queues the graph.
//
//   fast     SD 1.5 fine-tune (DreamShaper 8 preferred)    ~512 px, 25 steps   ~16 s on a GTX 1660 SUPER
//   quality  SDXL Lightning (DreamShaper XL Lightning)     ~1024 px, 6 steps   ~55 s
//   best     Z-Image Turbo (bf16) when installed            ~1024 px, 8 steps   ~4 min on a GTX 1660 SUPER (234-265 s,
//                                                                               first or later image; compute-bound);
//                                                                               most detailed. A quick preview first:
//                                                                               512 px, 6 steps (previewSettings)
//            else FLUX.1 schnell, GGUF-quantised           ~1024 px, 4 steps   ~3 min; prompt-following and text
//
// Any other checkpoint stays usable through the standard checkpoint graph ("custom").

const ENGINES = {
  fast: {
    label: 'Fast', model: 'Stable Diffusion 1.5', family: 'sd15', base: 512, steps: 25, cfg: 7, sampler: 'dpmpp_2m', scheduler: 'karras',
    negative: 'blurry, low quality, distorted, deformed, extra fingers, text, watermark',
    blurb: 'Quick drafts and illustrations.'
  },
  quality: {
    label: 'Quality', model: 'SDXL Lightning', family: 'sdxl', base: 1024, steps: 6, cfg: 2, sampler: 'dpmpp_sde', scheduler: 'karras',
    negative: 'blurry, low quality, distorted, watermark',
    blurb: 'Detailed, high-resolution images.'
  },
  // Z-Image Turbo and FLUX schnell are distilled to run at cfg 1, where the sampler ignores the negative
  // prompt entirely, so `usesNegative: false` drops a style's "avoid" words instead of pretending to apply them.
  best: {
    label: 'Best', model: 'Z-Image Turbo', family: 'zimage', base: 1024, steps: 8, cfg: 1, sampler: 'res_multistep', scheduler: 'simple',
    shift: 3, negative: '', usesNegative: false,
    blurb: 'Most detailed and realistic; follows long prompts and can draw text.'
  },
  // "Best" when Z-Image Turbo isn't installed.
  bestFlux: {
    label: 'Best', model: 'FLUX.1 schnell', family: 'flux', base: 1024, steps: 4, cfg: 1, sampler: 'euler', scheduler: 'simple',
    negative: '', usesNegative: false,
    blurb: 'Follows long prompts closely and can draw readable text.'
  }
};

// Width x height per aspect ratio, for SD 1.5 (512 base) and SDXL/FLUX (1024 base) training sizes.
const ASPECTS = {
  square: { label: 'Square', 512: [512, 512], 1024: [1024, 1024] },
  portrait: { label: 'Portrait', 512: [512, 768], 1024: [832, 1216] },
  landscape: { label: 'Landscape', 512: [768, 512], 1024: [1216, 832] },
  wide: { label: 'Wide', 512: [896, 512], 1024: [1344, 768] }
};

// Style presets: words added to the prompt (and things to avoid) that steer every engine the same way.
const STYLES = {
  none: { label: 'None', add: '', avoid: '' },
  photo: { label: 'Photo', add: 'professional photograph, natural light, sharp focus, 50mm lens, realistic detail', avoid: 'illustration, painting, cartoon, 3d render' },
  cinematic: { label: 'Cinematic', add: 'cinematic film still, dramatic lighting, shallow depth of field, color graded, anamorphic', avoid: 'cartoon, flat lighting' },
  illustration: { label: 'Illustration', add: 'digital illustration, clean lines, vibrant colors, detailed artwork', avoid: 'photo, photorealistic' },
  anime: { label: 'Anime', add: 'anime style, cel shading, expressive characters, studio quality key visual', avoid: 'photo, photorealistic, 3d render' },
  watercolor: { label: 'Watercolor', add: 'watercolor painting, soft washes, paper texture, delicate brushwork', avoid: 'photo, 3d render, harsh lines' },
  oil: { label: 'Oil painting', add: 'oil painting on canvas, visible brushstrokes, rich colors, classical composition', avoid: 'photo, 3d render' },
  render3d: { label: '3D render', add: '3d render, octane render, soft global illumination, highly detailed, studio lighting', avoid: 'painting, sketch, flat' },
  pixel: { label: 'Pixel art', add: 'pixel art, 16-bit, crisp pixels, limited palette', avoid: 'blurry, photo, smooth gradients' },
  sketch: { label: 'Sketch', add: 'pencil sketch, graphite, cross-hatching, monochrome line art on paper', avoid: 'color, photo, 3d render' }
};

// engine.usesNegative === false (cfg-1 engines) gets no negative at all: it would be ignored by the sampler.
function applyStyle(prompt, negative, styleId, engine = null) {
  const style = STYLES[styleId] || STYLES.none;
  return {
    prompt: style.add ? `${prompt}, ${style.add}` : prompt,
    negative: engine?.usesNegative === false ? '' : [negative, style.avoid].filter(Boolean).join(', ')
  };
}

const lower = (s) => String(s || '').toLowerCase();

function inferCheckpointFamily(name) {
  const n = lower(name);
  if (!n) return 'unknown';
  if (/flux/.test(n)) return 'flux';
  if (/lightning|turbo|hyper/.test(n) && /xl/.test(n)) return 'sdxl-fast';
  if (/sdxl|stable[._ -]?diffusion[._ -]?xl|xl[._ -]?base|\bxl\b|[_-]xl[_.-]/.test(n)) return 'sdxl';
  if (/v1[-._ ]?5|sd1[._ -]?5|stable[._ -]?diffusion[._ -]?1[._ -]?5|\b1[._ -]?5\b|dreamshaper[_ -]?8|realistic[_ -]?vision/.test(n)) return 'sd15';
  return 'unknown';
}

// lists: { checkpoints, unets, clips, vaes, upscalers } as reported by ComfyUI's object_info.
function discoverEngines(lists = {}) {
  const ckpts = lists.checkpoints || [];
  const sd15 = ckpts.filter((c) => inferCheckpointFamily(c) === 'sd15');
  const fastCkpt = sd15.find((c) => /dreamshaper/i.test(c)) || sd15[0] || ckpts.find((c) => inferCheckpointFamily(c) === 'unknown') || null;
  const qualityCkpt = ckpts.find((c) => inferCheckpointFamily(c) === 'sdxl-fast') || null;
  const fluxUnet = (lists.unets || []).find((u) => /flux/i.test(u) && /schnell/i.test(u)) || null;
  const t5 = (lists.clips || []).find((c) => /t5xxl/i.test(c)) || null;
  const clipL = (lists.clips || []).find((c) => /clip_l/i.test(c)) || null;
  const fluxVae = (lists.vaes || []).find((v) => /flux|(^|[\\/])ae\.safetensors$/i.test(v)) || null;
  const upscaler = (lists.upscalers || []).find((u) => /esrgan|ultrasharp|x4|4x/i.test(u)) || null;
  // Z-Image Turbo: its diffusion model (models/diffusion_models), the Qwen3 4B text encoder
  // (models/text_encoders; the plain bf16 file preferred over fp8) and the FLUX "ae" VAE (models/vae).
  const zUnet = (lists.diffusionModels || []).find((u) => /z[_-]?image.*turbo/i.test(u)) || null;
  const qwen = (lists.textEncoders || []).filter((c) => /qwen[_-]?3[_-]?4b/i.test(c));
  const zClip = qwen.find((c) => !/fp8|fp4|gguf|q\d/i.test(c)) || qwen.find((c) => /fp8[_-]?mixed/i.test(c)) || qwen[0] || null;
  const zVae = (lists.vaes || []).find((v) => /(^|[\\/])ae\.safetensors$/i.test(v)) || fluxVae;

  const engines = [];
  if (fastCkpt) engines.push({ id: 'fast', ...ENGINES.fast, files: { checkpoint: fastCkpt } });
  if (qualityCkpt) engines.push({ id: 'quality', ...ENGINES.quality, files: { checkpoint: qualityCkpt } });
  if (zUnet && zClip && zVae) engines.push({ id: 'best', ...ENGINES.best, files: { unet: zUnet, textEncoder: zClip, vae: zVae } });
  else if (fluxUnet && t5 && clipL && fluxVae) engines.push({ id: 'best', ...ENGINES.bestFlux, files: { unet: fluxUnet, t5, clipL, vae: fluxVae } });
  const used = new Set(engines.map((e) => e.files.checkpoint).filter(Boolean));
  const custom = ckpts.filter((c) => !used.has(c) && inferCheckpointFamily(c) !== 'flux');
  return { engines, custom, upscaler, defaultEngine: engines[0]?.id || null };
}

// Settings for a plain checkpoint picked under Advanced: tuned by what its name says it is.
function customEngine(checkpoint) {
  const family = inferCheckpointFamily(checkpoint);
  const like = family === 'sdxl-fast' ? ENGINES.quality : family === 'sdxl' ? { ...ENGINES.quality, steps: 28, cfg: 6.5, sampler: 'dpmpp_2m' } : ENGINES.fast;
  return { id: 'custom', ...like, label: checkpoint, files: { checkpoint } };
}

function sizeFor(engine, aspect, width, height) {
  if (width && height) {
    const max = engine.base >= 1024 ? 1536 : 1024;
    const snap = (v) => Math.max(256, Math.min(max, Math.round(Number(v) / 64) * 64));
    return [snap(width), snap(height)];
  }
  const a = ASPECTS[aspect] || ASPECTS.square;
  return a[engine.base >= 1024 ? 1024 : 512];
}

// The ComfyUI graph for one run. Node "9" is always the final image(s), so the caller can read its output.
//   batch   images drawn at once (one sampler pass; seeds differ per image)
//   source  { image, mask? }: names of files already uploaded to ComfyUI's input folder. Without a mask the
//           whole picture is redrawn at strength `denoise`; with one, only the white area is, and everything
//           outside it is copied back from the original pixel for pixel.
function buildWorkflow(engine, { prompt, negativePrompt, width, height, steps, cfg, seed, upscaler, batch = 1, source = null, denoise = 1 }) {
  const sampler = { seed, steps, cfg, sampler_name: engine.sampler, scheduler: engine.scheduler, denoise: source ? denoise : 1 };
  const flux = engine.family === 'flux';
  let graph, vae, model = ['1', 0];
  if (engine.family === 'zimage') {
    graph = {
      1: { class_type: 'UNETLoader', inputs: { unet_name: engine.files.unet, weight_dtype: 'default' } },
      2: { class_type: 'CLIPLoader', inputs: { clip_name: engine.files.textEncoder, type: 'lumina2', device: 'default' } },
      3: { class_type: 'VAELoader', inputs: { vae_name: engine.files.vae } },
      4: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
      // No negative prompt at cfg 1: an empty conditioning keeps KSampler happy.
      5: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
      6: { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: batch } },
      13: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: engine.shift ?? 3 } }
    };
    vae = ['3', 0];
    model = ['13', 0];
  } else if (flux) {
    graph = {
      1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: engine.files.unet } },
      2: { class_type: 'DualCLIPLoader', inputs: { clip_name1: engine.files.t5, clip_name2: engine.files.clipL, type: 'flux' } },
      3: { class_type: 'VAELoader', inputs: { vae_name: engine.files.vae } },
      4: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
      // FLUX schnell ignores the negative prompt (cfg 1); an empty conditioning keeps KSampler happy.
      5: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
      6: { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: batch } }
    };
    vae = ['3', 0];
  } else {
    graph = {
      1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: engine.files.checkpoint } },
      4: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
      5: { class_type: 'CLIPTextEncode', inputs: { text: negativePrompt ?? engine.negative, clip: ['1', 1] } },
      6: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: batch } }
    };
    vae = ['1', 2];
  }
  let latent = ['6', 0], mask = null;
  if (source) {
    delete graph[6];
    graph[20] = { class_type: 'LoadImage', inputs: { image: source.image } };
    graph[21] = { class_type: 'VAEEncode', inputs: { pixels: ['20', 0], vae } };
    latent = ['21', 0];
    if (source.mask) {
      graph[22] = { class_type: 'LoadImageMask', inputs: { image: source.mask, channel: 'red' } };
      // A slightly larger, soft-edged mask blends the new area into its surroundings.
      graph[23] = { class_type: 'GrowMask', inputs: { mask: ['22', 0], expand: 6, tapered_corners: true } };
      graph[24] = { class_type: 'SetLatentNoiseMask', inputs: { samples: latent, mask: ['23', 0] } };
      latent = ['24', 0];
      mask = ['23', 0];
    }
    if (batch > 1) { graph[25] = { class_type: 'RepeatLatentBatch', inputs: { samples: latent, amount: batch } }; latent = ['25', 0]; }
  }
  graph[7] = { class_type: 'KSampler', inputs: { ...sampler, model, positive: ['4', 0], negative: ['5', 0], latent_image: latent } };
  graph[8] = { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae } };
  let last = ['8', 0];
  if (mask) {
    graph[26] = { class_type: 'ImageCompositeMasked', inputs: { destination: ['20', 0], source: last, x: 0, y: 0, resize_source: false, mask } };
    last = ['26', 0];
  }
  if (upscaler) {
    // Real-ESRGAN works at 4x; scaling back by half gives a sharp 2x image.
    graph[10] = { class_type: 'UpscaleModelLoader', inputs: { model_name: upscaler } };
    graph[11] = { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['10', 0], image: last } };
    graph[12] = { class_type: 'ImageScaleBy', inputs: { image: ['11', 0], upscale_method: 'lanczos', scale_by: 0.5 } };
    last = ['12', 0];
  }
  graph[9] = { class_type: 'SaveImage', inputs: { filename_prefix: 'LocalAI', images: last } };
  return graph;
}

// Fast (SD 1.5, 512 px) draws several images in one pass; the 1024 px engines would run out of the 6 GB, so
// their variations are queued one after another.
function batchesFor(engine, count) {
  const n = Math.max(1, Math.min(4, Math.round(Number(count) || 1)));
  return engine.base >= 1024 ? Array.from({ length: n }, () => 1) : [n];
}

// Best's quick preview (about 4 minutes saved when the idea is wrong): the chosen shape scaled down to 512 x 512 for a
// square, or to fit 576 x 576 otherwise (sides snapped to 16 px, what the latent needs), at 6 steps. The caller keeps
// the seed and prompt, so the full picture made from it afterwards is the same picture, larger and finer.
const PREVIEW = { square: 512, box: 576, steps: 6 };
function previewSettings(width, height, steps) {
  const fewer = Math.min(PREVIEW.steps, Math.max(1, Math.round(Number(steps) || PREVIEW.steps)));
  if (width === height) return { width: PREVIEW.square, height: PREVIEW.square, steps: fewer };
  const k = PREVIEW.box / Math.max(width, height);
  const snap = (v) => Math.max(256, Math.round((v * k) / 16) * 16);
  return { width: snap(width), height: snap(height), steps: fewer };
}
// Only Best is slow enough to be worth a preview; Fast and Quality are already quick.
const previewable = (engine) => engine?.id === 'best';

// The one-line summary a finished image run shows in Work.
function runSummary({ count, width, height, engine, editing, preview }) {
  if (preview) return `Preview made with ${engine} · ${width} × ${height}`;
  const what = count > 1 ? `${count} images` : 'Image';
  return `${what} ${editing ? 'edited' : 'made'} with ${engine} · ${width} × ${height}`;
}

module.exports = { runSummary, previewSettings, previewable, PREVIEW, ENGINES, ASPECTS, STYLES, applyStyle, batchesFor, inferCheckpointFamily, discoverEngines, customEngine, sizeFor, buildWorkflow };
