'use strict';
// Image engines: which open models are installed in ComfyUI, the settings each one is tuned for, and the
// ComfyUI graph that runs it. Pure functions; server.js fetches the model lists and queues the graph.
//
//   fast     SD 1.5 fine-tune (DreamShaper 8 preferred)    ~512 px, 25 steps   ~16 s on a GTX 1660 SUPER
//   quality  SDXL Lightning (DreamShaper XL Lightning)     ~1024 px, 6 steps   ~55 s
//   best     FLUX.1 schnell, GGUF-quantised                 ~1024 px, 4 steps   ~3 min; best prompt-following and text
//
// Any other checkpoint stays usable through the standard checkpoint graph ("custom").

const ENGINES = {
  fast: {
    label: 'Fast', family: 'sd15', base: 512, steps: 25, cfg: 7, sampler: 'dpmpp_2m', scheduler: 'karras',
    negative: 'blurry, low quality, distorted, deformed, extra fingers, text, watermark',
    blurb: 'Quick drafts and illustrations.'
  },
  quality: {
    label: 'Quality', family: 'sdxl', base: 1024, steps: 6, cfg: 2, sampler: 'dpmpp_sde', scheduler: 'karras',
    negative: 'blurry, low quality, distorted, watermark',
    blurb: 'Detailed, high-resolution images.'
  },
  best: {
    label: 'Best', family: 'flux', base: 1024, steps: 4, cfg: 1, sampler: 'euler', scheduler: 'simple',
    negative: '',
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

  const engines = [];
  if (fastCkpt) engines.push({ id: 'fast', ...ENGINES.fast, files: { checkpoint: fastCkpt } });
  if (qualityCkpt) engines.push({ id: 'quality', ...ENGINES.quality, files: { checkpoint: qualityCkpt } });
  if (fluxUnet && t5 && clipL && fluxVae) engines.push({ id: 'best', ...ENGINES.best, files: { unet: fluxUnet, t5, clipL, vae: fluxVae } });
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

// The ComfyUI graph for one image. Node "9" is always the final image, so the caller can read its output.
function buildWorkflow(engine, { prompt, negativePrompt, width, height, steps, cfg, seed, upscaler }) {
  const sampler = { seed, steps, cfg, sampler_name: engine.sampler, scheduler: engine.scheduler, denoise: 1 };
  let graph;
  if (engine.family === 'flux') {
    graph = {
      1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: engine.files.unet } },
      2: { class_type: 'DualCLIPLoader', inputs: { clip_name1: engine.files.t5, clip_name2: engine.files.clipL, type: 'flux' } },
      3: { class_type: 'VAELoader', inputs: { vae_name: engine.files.vae } },
      4: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
      // FLUX schnell ignores the negative prompt (cfg 1); an empty conditioning keeps KSampler happy.
      5: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
      6: { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: 1 } },
      7: { class_type: 'KSampler', inputs: { ...sampler, model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0] } },
      8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } }
    };
  } else {
    graph = {
      1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: engine.files.checkpoint } },
      4: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
      5: { class_type: 'CLIPTextEncode', inputs: { text: negativePrompt ?? engine.negative, clip: ['1', 1] } },
      6: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
      7: { class_type: 'KSampler', inputs: { ...sampler, model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0] } },
      8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['1', 2] } }
    };
  }
  let last = ['8', 0];
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

module.exports = { ENGINES, ASPECTS, inferCheckpointFamily, discoverEngines, customEngine, sizeFor, buildWorkflow };
