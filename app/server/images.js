'use strict';

// Images: the engines and checkpoints, generating through ComfyUI (with prompt enhancing and uploads), and serving the pictures.
// Moved from server.js unchanged (the server split: docs/superpowers/specs/2026-10-18-server-split-design.md). ctx holds
// what this code uses from the rest of the server.
function createImages(ctx) {
  const { COMFY_URL, IMAGE_ESTIMATES, IMAGE_PROMPT_MODEL, MODEL, OLLAMA_URL, URL, buildImageModelCatalog, cleanRunId, comfyOptions, fetchWithTimeout, getCheckpointNames, imageEngines, json, modelFetchWithTimeout, readBody, recordActivity, recordArtifact, runLedger, titleFromText, unloadTextModel, warmTextModel } = ctx;
  // Every model list the image engines need, from ComfyUI's object_info. A node type that isn't installed
  // (UnetLoaderGGUF before ComfyUI-GGUF) just yields an empty list. UNETLoader lists models/diffusion_models and
  // CLIPLoader lists models/text_encoders (plus models/clip), which Z-Image Turbo needs.
  async function getImageModelLists() {
    const read = async (node, input) => {
      try {
        const r = await fetchWithTimeout(`${COMFY_URL}/object_info/${node}`, {}, 7000);
        if (!r.ok) return [];
        return comfyOptions((await r.json())?.[node]?.input?.required?.[input]);
      } catch { return []; }
    };
    const [checkpoints, unets, clips, vaes, upscalers, diffusionModels, textEncoders] = await Promise.all([
      getCheckpointNames(), read('UnetLoaderGGUF', 'unet_name'), read('DualCLIPLoader', 'clip_name1'), read('VAELoader', 'vae_name'), read('UpscaleModelLoader', 'model_name'),
      read('UNETLoader', 'unet_name'), read('CLIPLoader', 'clip_name')
    ]);
    return { checkpoints, unets, clips, vaes, upscalers, diffusionModels, textEncoders };
  }
  async function apiImageModels(req, res) {
    try {
      const lists = await getImageModelLists();
      const found = imageEngines.discoverEngines(lists);
      const engines = found.engines.map(({ id, label, blurb, family, base, model }) => ({ id, label, blurb, family, base, model, estimateSec: IMAGE_ESTIMATES[`${id}:${family}`] || null,
        ...(imageEngines.previewable({ id }) ? { preview: true, previewEstimateSec: IMAGE_ESTIMATES[`${id}:${family}:preview`] || null } : {}) }));
      const aspects = Object.entries(imageEngines.ASPECTS).map(([id, a]) => ({ id, label: a.label, sizes: { 512: a[512], 1024: a[1024] } }));
      const styles = Object.entries(imageEngines.STYLES).map(([id, st]) => ({ id, label: st.label }));
      json(res, 200, { ...buildImageModelCatalog(lists.checkpoints), engines, custom: found.custom, upscale: !!found.upscaler, aspects, styles, defaultEngine: found.defaultEngine });
    } catch (e) {
      json(res, 502, { error: String(e.message || e), models: [], families: [], defaultCheckpoint: null, defaultFamily: null });
    }
  }
  async function apiCheckpoints(req, res) {
    try {
      const catalog = buildImageModelCatalog(await getCheckpointNames());
      json(res, 200, { checkpoints: catalog.models.map(x => x.checkpoint), models: catalog.models, families: catalog.families, defaultCheckpoint: catalog.defaultCheckpoint, defaultFamily: catalog.defaultFamily });
    } catch (e) {
      json(res, 502, { error: String(e.message || e), checkpoints: [], models: [], families: [], defaultCheckpoint: null, defaultFamily: null });
    }
  }
  function clampInt(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
  }
  async function pollComfyHistory(promptId, timeoutMs = 180000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      // ComfyUI can stop answering for a while when it loads a big model (Z-Image's 12 GB file on the 6 GB GPU took
      // over 7 s), so a slow or failed check means "not done yet", not a failed image; only `end` gives up.
      try {
        const r = await fetchWithTimeout(`${COMFY_URL}/history/${encodeURIComponent(promptId)}`, {}, 7000);
        if (r.ok) {
          const j = await r.json();
          if (j && j[promptId]) return j[promptId];
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Image generation timed out');
  }
  // Rewrites a short idea into a detailed image prompt with the local language model, then unloads that model
  // so the image model has the GPU to itself (they share 6 GB of VRAM).
  async function enhanceImagePrompt(prompt, engineId) {
    const style = engineId === 'best' ? 'Write natural sentences.' : 'Write a comma-separated list of descriptive phrases.';
    const r = await modelFetchWithTimeout(`${OLLAMA_URL}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: IMAGE_PROMPT_MODEL, stream: false, keep_alive: 0, options: { num_ctx: 2048, temperature: 0.7 },
        messages: [
          { role: 'system', content: `You turn a short idea into one prompt for an image generator. Keep the subject and every detail the user gave; add composition, lighting, setting, style and quality cues. ${style} Under 70 words. Reply with the prompt only, no quotes or preamble.` },
          { role: 'user', content: prompt.slice(0, 1000) }
        ]
      })
    }, 60000);
    if (!r.ok) throw new Error(`Prompt helper HTTP ${r.status}`);
    const text = String((await r.json())?.message?.content || '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
    return text.length >= 8 ? text.slice(0, 1200) : prompt;
  }
  // An image the browser sent for editing (data URL), uploaded into ComfyUI's input folder for LoadImage.
  async function uploadToComfy(dataUrl, name) {
    const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) throw Object.assign(new Error('The image to edit must be a PNG, JPEG or WebP data URL'), { status: 400 });
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > 12 * 1024 * 1024) throw Object.assign(new Error('The image to edit is larger than 12 MB'), { status: 413 });
    const form = new FormData();
    form.append('image', new Blob([bytes], { type: `image/${m[1]}` }), `${name}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
    form.append('type', 'input');
    form.append('overwrite', 'true');
    const r = await fetchWithTimeout(`${COMFY_URL}/upload/image`, { method: 'POST', body: form }, 30000);
    if (!r.ok) throw new Error(`Image service upload HTTP ${r.status}`);
    const j = await r.json();
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
  }
  async function runComfyGraph(workflow, timeoutMs) {
    const queued = await fetchWithTimeout(`${COMFY_URL}/prompt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: 'local-ai-appliance' })
    }, 10000);
    const qraw = await queued.text();
    if (!queued.ok) throw new Error(`Image queue HTTP ${queued.status}: ${qraw.slice(0, 500)}`);
    const q = JSON.parse(qraw);
    if (!q.prompt_id) throw new Error('Image service did not return a prompt ID');
    const history = await pollComfyHistory(q.prompt_id, timeoutMs);
    const failure = history.status?.status_str === 'error' ? (history.status.messages || []).find(m => m[0] === 'execution_error')?.[1] : null;
    if (failure) throw new Error(`ComfyUI: ${failure.exception_message || failure.exception_type || 'execution error'}`.slice(0, 500));
    const outputs = history.outputs || {};
    const images = outputs?.['9']?.images || Object.values(outputs).flatMap(x => Array.isArray(x?.images) ? x.images : []);
    if (!images.length) throw new Error('Image generation completed without an output image');
    return { promptId: q.prompt_id, images };
  }
  // Fire-and-forget: loads the chat model into the GPU. Failures are ignored.
  function warmText() { warmTextModel({ url: OLLAMA_URL, model: MODEL }); }
  // Images and text take turns on the 6 GB GPU: the chat model unloads while ComfyUI works and reloads after the last image job.
  let imageJobsActive = 0;
  async function apiGenerateImage(req, res) {
    let execution = null;
    let tookGpu = false;
    try {
      const body = await readBody(req, 30 * 1024 * 1024);
      const original = String(body.prompt || '').trim();
      if (!original) return json(res, 400, { error: 'prompt is required' });

      const lists = await getImageModelLists();
      const found = imageEngines.discoverEngines(lists);
      // Engine by id; a checkpoint picked under Advanced (or sent by older clients); else the default engine.
      let engine = found.engines.find(e => e.id === body.engine) || null;
      if (!engine && body.checkpoint && lists.checkpoints.includes(body.checkpoint)) engine = found.engines.find(e => e.files.checkpoint === body.checkpoint) || imageEngines.customEngine(body.checkpoint);
      if (!engine) engine = found.engines.find(e => e.id === found.defaultEngine) || (lists.checkpoints[0] ? imageEngines.customEngine(lists.checkpoints[0]) : null);
      if (!engine) throw new Error('No image models were found in ComfyUI');

      const editing = !!body.source;
      const checkpoint = engine.files.checkpoint || engine.files.unet;
      const count = clampInt(body.count, 1, 4, 1);
      // Best's quick preview: its own run, smaller and in fewer steps, kept out of Library unless the owner keeps it.
      // Only for one new Best image; anything else asked as a preview is made as usual.
      const preview = body.preview === true && imageEngines.previewable(engine) && !editing && count === 1;
      // The full picture of a preview: same seed and the same (improved) prompt, so it is that picture made properly.
      const previewRun = !preview && cleanRunId(body.previewOf) ? runLedger.get(body.previewOf) : null;
      const fromPreview = previewRun?.type === 'image' && previewRun.meta?.preview === true && previewRun.output?.images?.length ? previewRun : null;
      // An edit keeps the source picture's own size (sent by the browser); a new image uses the shape's size.
      let [width, height] = editing ? [clampInt(body.sourceWidth, 64, 2048, 512), clampInt(body.sourceHeight, 64, 2048, 512)]
        : imageEngines.sizeFor(engine, body.aspect, body.aspect ? null : body.width, body.aspect ? null : body.height);
      let steps = clampInt(body.steps, 1, 60, engine.steps);
      if (preview) ({ width, height, steps } = imageEngines.previewSettings(width, height, steps));
      const cfg = Math.max(1, Math.min(20, Number(body.cfg) || engine.cfg));
      const seed = Number.isFinite(Number(body.seed)) ? Math.floor(Number(body.seed))
        : fromPreview ? fromPreview.output.images[0].seed : Math.floor(Math.random() * 2147483647);
      const userNegative = body.negativePrompt === undefined || body.negativePrompt === null ? engine.negative : String(body.negativePrompt);
      const style = imageEngines.STYLES[body.style] ? body.style : 'none';
      const upscaler = body.upscale === true && !preview ? found.upscaler : null;
      const enhance = body.enhance === true && !fromPreview;
      const strength = Math.max(0.1, Math.min(1, Number(body.strength) || 0.6));

      execution = runLedger.create({
        type: 'image',
        threadId: body.threadId,
        title: titleFromText(original, editing ? 'Image edit' : 'Image generation'),
        input: { prompt: original.slice(0, 2000), engine: engine.id, checkpoint, family: engine.family, aspect: body.aspect || undefined, width, height, steps, cfg, seed, style, count, upscale: !!upscaler, enhance, edit: editing ? { masked: !!body.mask, strength } : null },
        // Started by voice: the ask sends its own "ready" or "couldn't" notification, so the generic ones stay quiet.
        // meta.preview marks Best's quick preview; meta.previewOf links a full picture to the preview it was made from.
        meta: { ...(body.voice === true ? { voice: true } : {}), ...(preview ? { preview: true } : {}), ...(fromPreview ? { previewOf: fromPreview.id } : {}) },
        // An edit's source image isn't kept with the run, so Retry repeats it as a new image.
        retryRequest: { path: '/api/images/generate', body: { prompt: original, engine: engine.id, checkpoint: engine.id === 'custom' ? checkpoint : undefined, negativePrompt: body.negativePrompt, aspect: body.aspect, width, height, steps, cfg, style, count, upscale: !!upscaler, enhance, preview: preview || undefined, previewOf: fromPreview?.id, seed: fromPreview ? seed : undefined, threadId: cleanRunId(body.threadId) || undefined } }
      });
      runLedger.start(execution.id, editing ? 'Image edit started' : 'Image generation started');
      imageJobsActive++; tookGpu = true;
      await unloadTextModel({ url: OLLAMA_URL, model: MODEL });

      let prompt = fromPreview?.meta?.improvedPrompt || original;
      if (enhance) {
        try { prompt = await enhanceImagePrompt(original, engine.id); runLedger.update(execution.id, { progress: 15 }, 'Prompt improved'); }
        catch (e) { runLedger.update(execution.id, { progress: 15 }, `Prompt helper unavailable; using your prompt (${e.message})`); }
        // The full picture made from a preview reuses this prompt instead of asking for a new one.
        if (preview && prompt !== original) runLedger.update(execution.id, { meta: { improvedPrompt: prompt } });
      }
      const styled = imageEngines.applyStyle(prompt, userNegative, style, engine);

      let source = null;
      if (editing) {
        const tag = `localai-edit-${execution.id}`;
        source = { image: await uploadToComfy(body.source, tag), mask: body.mask ? await uploadToComfy(body.mask, `${tag}-mask`) : null };
        runLedger.update(execution.id, { progress: 25 }, body.mask ? 'Repainting the marked area' : 'Redrawing the image');
      }

      const started = Date.now();
      const timeoutMs = (engine.family === 'flux' || engine.family === 'zimage' ? 900000 : 420000) * count;
      const results = [];
      let n = 0;
      for (const batch of imageEngines.batchesFor(engine, count)) {
        const workflow = imageEngines.buildWorkflow(engine, { prompt: styled.prompt, negativePrompt: styled.negative, width, height, steps, cfg, seed: seed + n, upscaler, batch, source, denoise: strength });
        const run = await runComfyGraph(workflow, timeoutMs);
        // ComfyUI gives each image in a batch the batch seed plus its index.
        run.images.forEach((img, i) => results.push({ img, seed: seed + n + i, promptId: run.promptId }));
        n += batch;
        runLedger.update(execution.id, { progress: Math.min(95, 30 + Math.round((65 * n) / count)), meta: { promptId: run.promptId, checkpoint } }, `${n} of ${count} image${count === 1 ? '' : 's'} done`);
      }
      const elapsedMs = Date.now() - started;
      const outW = upscaler ? width * 2 : width, outH = upscaler ? height * 2 : height;
      const common = { engine: engine.id, engineLabel: engine.label, checkpoint, family: engine.family, style, width: outW, height: outH, steps, cfg, upscaled: !!upscaler, edited: editing, elapsedMs, ...(preview ? { preview: true } : {}), ...(fromPreview ? { previewOf: fromPreview.id } : {}) };
      const images = results.map(({ img, seed: s }) => ({ imageUrl: `/api/images/view?${new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' })}`, seed: s }));

      // A preview stays out of Library (it is in Work) unless the owner keeps it; the full picture arrives as usual.
      const artifactIds = [];
      for (const im of preview ? [] : images) {
        const meta = { ...common, imageUrl: im.imageUrl, seed: im.seed };
        const label = `${outW} × ${outH} · ${engine.label}${style !== 'none' ? ` · ${imageEngines.STYLES[style].label}` : ''}${editing ? ' · edited' : ''}${upscaler ? ' · upscaled' : ''}`;
        const artifact = recordArtifact('image', original, label, { ...meta, runId: execution.id }, { prompt: original, usedPrompt: styled.prompt, negativePrompt: styled.negative, imageUrl: im.imageUrl });
        if (artifact?.id) artifactIds.push(artifact.id);
      }
      recordActivity('image', preview ? 'Made a quick preview' : editing ? 'Edited an image' : count > 1 ? `Created ${images.length} images` : 'Created an image', original.slice(0, 180), { ...common, imageUrl: images[0].imageUrl, seed: images[0].seed, runId: execution.id });
      runLedger.complete(execution.id, {
        summary: imageEngines.runSummary({ count: images.length, width: outW, height: outH, engine: engine.label, editing, preview }),
        output: { ...common, images },
        artifactIds,
        meta: { promptId: results[0].promptId, checkpoint, elapsedMs }
      });
      // A preview has its own estimate: its minute must not make the full picture look quick.
      if (!upscaler && !enhance && !editing && count === 1) IMAGE_ESTIMATES[`${engine.id}:${engine.family}${preview ? ':preview' : ''}`] = Math.round(elapsedMs / 1000);

      json(res, 200, { promptId: results[0].promptId, ...common, imageUrl: images[0].imageUrl, seed: images[0].seed, images, familyLabel: engine.label, prompt: original, usedPrompt: styled.prompt, runId: execution.id, threadId: execution.threadId });
    } catch (e) {
      if (execution) runLedger.fail(execution.id, e);
      const run = execution ? { runId: execution.id } : {};
      if (e.status) return json(res, e.status, { error: e.message, ...run });
      json(res, e.statusCode || 500, { error: String(e.message || e), ...(e.code ? { code: e.code } : {}), ...run });
    }
    finally {
      if (tookGpu && --imageJobsActive === 0) warmText();
    }
  }
  async function apiImageView(req, res, urlObj) {
    try {
      const u = new URL(`${COMFY_URL}/view`);
      // preview=jpeg;<quality> asks ComfyUI for a JPEG (the Workshop display decodes JPEG only).
      for (const key of ['filename', 'subfolder', 'type']) {
        const value = urlObj.searchParams.get(key);
        if (value !== null) u.searchParams.set(key, value);
      }
      const preview = urlObj.searchParams.get('preview');
      if (preview && /^(jpeg|webp);\d{1,3}$/.test(preview)) u.searchParams.set('preview', preview);
      const r = await fetchWithTimeout(u.toString(), {}, 15000);
      if (!r.ok) throw new Error(`Image retrieval HTTP ${r.status}`);
      const contentType = r.headers.get('content-type') || 'image/png';
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=300' });
      res.end(buf);
    } catch (e) {
      json(res, 502, { error: String(e.message || e) });
    }
  }
  return { apiCheckpoints, apiGenerateImage, apiImageModels, apiImageView, getImageModelLists, warmText };
}

module.exports = { createImages };
