'use strict';

// Health probes, capability snapshots, web research (SearXNG) and the Models page (runtime status, pulls, removal).
// Moved from server.js unchanged (the server split: docs/superpowers/specs/2026-10-18-server-split-design.md). ctx holds
// what this code uses from the rest of the server.
function createStatus(ctx) {
  const { APP_VERSION, CAPABILITY_CACHE_MS, COMFY_URL, LOCAL_UI_PORT, MAC_AI_HOME_URL, MAC_DSH_URL, MODEL, N8N_URL, OLLAMA_URL, POWERSHELL_BRIDGE_TOKEN, PROXY_URL, REPORT_PATH, SEARXNG_URL, STATUS_STORE, URL, agentRunStore, buildImageModelCatalog, changeStore, createModelPulls, effectiveEngineeringRuns, fetchWithTimeout, fs, getImageModelLists, imageEngines, issueStore, json, listenPort, loadOllamaModelRuntime, notifier, notifyLib, projectStore, readBody, readState, recordActivity, release, sameOriginJson, storageError, watchdog, writeState } = ctx;
  const capabilityCache = { expiresAt: 0, value: null, reset() { this.expiresAt = 0; this.value = null; } };

  async function probe(name, label, url, goodCodes = [200], timeoutMs = 3000, required = true) {
    const started = Date.now();
    try {
      const r = await fetchWithTimeout(url, { method: 'GET' }, timeoutMs);
      const latencyMs = Date.now() - started;
      return {
        name, label, required,
        state: goodCodes.includes(r.status) ? 'HEALTHY' : 'DEGRADED',
        statusCode: r.status,
        latencyMs,
        checkedAt: new Date().toISOString()
      };
    } catch (e) {
      return {
        name, label, required, state: 'DOWN', statusCode: null,
        latencyMs: Date.now() - started,
        error: String(e.message || e),
        checkedAt: new Date().toISOString()
      };
    }
  }

  function overallState(services) {
    const core = services.filter(x => x.required !== false);
    if (core.some(x => x.state === 'DOWN')) return 'DOWN';
    if (core.some(x => x.state === 'DEGRADED')) return 'DEGRADED';
    return 'HEALTHY';
  }

  // What stops working when a core service is down, in the owner's words (Home › Needs you shows it).
  const SERVICE_IMPACT = {
    ollama: 'Chat, research and missions are unavailable.',
    comfy: 'Images are unavailable.',
    n8n: 'Workflows and scheduled automations are paused.',
    proxy: 'Apps that talk to Local AI through its compatible endpoint are cut off.',
    search: 'Research and current facts are unavailable.'
  };

  function presentService(service) {
    const optional = service.required === false;
    const available = service.state === 'HEALTHY';
    return {
      ...service,
      availability: available ? 'available' : 'unavailable',
      displayState: optional && !available ? 'OPTIONAL_OFFLINE' : service.state,
      severity: available ? 'ok' : optional ? 'info' : service.state === 'DEGRADED' ? 'warning' : 'critical',
      impact: optional && !available ? 'Core appliance unaffected' : available ? 'Ready' : SERVICE_IMPACT[service.name] || 'Part of Local AI is unavailable.'
    };
  }

  function certificationInfo() {
    try {
      const content = fs.readFileSync(REPORT_PATH, 'utf8');
      const stat = fs.statSync(REPORT_PATH);
      const overall = /OVERALL:\s*(PASS|WARN|FAIL)/i.exec(content);
      const summary = /OVERALL:\s*(PASS|WARN|FAIL)\s*\|\s*([^\r\n]+)/i.exec(content);
      return {
        available: true,
        result: overall ? overall[1].toUpperCase() : 'UNKNOWN',
        summary: summary ? summary[2].trim() : null,
        modifiedAt: stat.mtime.toISOString()
      };
    } catch {
      return { available: false, result: 'UNKNOWN', summary: null, modifiedAt: null };
    }
  }

  // Web research: up is SearXNG's /healthz, which costs the search engines nothing (a real search every health tick got
  // them rate-limiting us). Whether searches find anything comes from the last real one; with none for SEARCH_CHECK_MS,
  // one test search runs in the background. A search that found nothing marks research DEGRADED, naming the engines that
  // did not answer.
  const SEARCH_CHECK_MS = Math.max(1000, Number(process.env.SEARCH_CHECK_MS) || 6 * 60 * 60 * 1000);
  let searchOutcome = null, searchTest = null;
  function noteSearch(j) {
    const unresponsive = (Array.isArray(j?.unresponsive_engines) ? j.unresponsive_engines : []).map(x => String(Array.isArray(x) ? x[0] : x));
    searchOutcome = { at: Date.now(), results: Array.isArray(j?.results) ? j.results.length : null, unresponsive };
  }
  async function searchProbe() {
    const up = await probe('search', 'Web research', `${SEARXNG_URL}/healthz`, [200], 5000);
    if (up.state !== 'HEALTHY') return up;
    if (!searchTest && (!searchOutcome || Date.now() - searchOutcome.at > SEARCH_CHECK_MS)) {
      searchTest = searxSearch('weather today').catch(() => {}).finally(() => { searchTest = null; });
    }
    if (searchOutcome?.results !== 0) return up;
    const engines = searchOutcome.unresponsive.length ? ` (not answering: ${searchOutcome.unresponsive.join(', ')})` : '';
    return { ...up, state: 'DEGRADED', error: `Searches find nothing${engines}` };
  }

  const HEALTH_SETTLE_MS = Number(process.env.HEALTH_SETTLE_MS || 120000);
  async function getStatusAndRecordTransition() {
    const services = await Promise.all([
      probe('ollama', 'Intelligence', `${OLLAMA_URL}/api/tags`, [200]),
      probe('comfy', 'Image generation', `${COMFY_URL}/system_stats`, [200]),
      probe('n8n', 'Automation engine', `${N8N_URL}/healthz`, [200]),
      probe('proxy', 'Conversation compatibility', `${PROXY_URL}/healthz`, [200]),
      searchProbe(),
      probe('home', 'Companion home', `${MAC_AI_HOME_URL}/`, [200], 3000, false),
      probe('dsh', 'Developer assistant', `${MAC_DSH_URL}/`, [200, 401], 3000, false)
    ]);

    const overall = overallState(services);
    const previous = readState(STATUS_STORE, {});
    const now = new Date();
    // A slow probe can flip health for one check. Record a change only once the new state has held for
    // HEALTH_SETTLE_MS, so the Audit log and Inbox show real outages instead of a flicker every minute.
    if (!previous.overall || previous.overall === overall) {
      writeState(STATUS_STORE, { overall, checkedAt: now.toISOString() });
    } else if (previous.pending !== overall) {
      writeState(STATUS_STORE, { ...previous, pending: overall, pendingSince: now.toISOString(), checkedAt: now.toISOString() });
    } else if (now - new Date(previous.pendingSince) >= HEALTH_SETTLE_MS) {
      if (overall === 'HEALTHY') {
        recordActivity('recovery', 'System recovered', `Health returned to normal from ${previous.overall}.`, { previous: previous.overall, current: overall });
        notifier.notify(notifyLib.serviceEvent(overall));
      } else {
        const affected = services.filter(x => x.required !== false && x.state !== 'HEALTHY').map(x => x.label);
        recordActivity('system', 'System needs attention', affected.join(', ') || `Health changed to ${overall}.`, { previous: previous.overall, current: overall });
        notifier.notify(notifyLib.serviceEvent(overall, affected));
      }
      writeState(STATUS_STORE, { overall, checkedAt: now.toISOString() });
    }

    return {
      appliance: 'Local AI',
      overall,
      checkedAt: new Date().toISOString(),
      services: services.map(presentService),
      serviceSummary: {
        core: services.filter(x => x.required !== false).length,
        optional: services.filter(x => x.required === false).length,
        coreUnhealthy: services.filter(x => x.required !== false && x.state !== 'HEALTHY').length,
        optionalUnhealthy: services.filter(x => x.required === false && x.state !== 'HEALTHY').length
      },
      certification: require('../release').deployCheck(certificationInfo(), release)
    };
  }

  async function apiStatus(req, res) {
    json(res, 200, await getStatusAndRecordTransition());
  }

  // Downloads and removals from the Models page. Models Local AI itself uses can't be removed: the default chat
  // model and the GridCraft bridge's model (GRIDCRAFT_MODEL, as in host/gridcraft-bridge.py); PROTECTED_MODELS adds more.
  const PROTECTED_MODELS = () => [...new Set([MODEL, process.env.GRIDCRAFT_MODEL || 'qwen3:4b-instruct', ...String(process.env.PROTECTED_MODELS || '').split(',').map(x => x.trim()).filter(Boolean)])];
  const modelPulls = createModelPulls({
    baseUrl: OLLAMA_URL,
    protectedModels: PROTECTED_MODELS,
    onFinish: p => {
      capabilityCache.reset();
      if (p.state === 'done') recordActivity('model', 'Model downloaded', p.name);
      else if (p.state === 'failed') recordActivity('model', 'Model download failed', `${p.name}: ${p.error}`);
    }
  });
  async function apiModelPulls(req, res) { json(res, 200, { items: modelPulls.list() }); }
  async function apiModelPull(req, res) {
    if (!sameOriginJson(req, res)) return;
    try { const b = await readBody(req); json(res, 202, { item: modelPulls.start(b.name) }); }
    catch (e) { json(res, e.status || 400, { error: e.message }); }
  }
  async function apiModelPullCancel(req, res) {
    if (!sameOriginJson(req, res)) return;
    try { const b = await readBody(req); json(res, 200, { item: modelPulls.cancel(b.name) }); }
    catch (e) { json(res, e.status || 400, { error: e.message }); }
  }
  async function apiModelDelete(req, res) {
    if (!sameOriginJson(req, res)) return;
    try {
      const b = await readBody(req);
      const result = await modelPulls.remove(b.name);
      capabilityCache.reset();
      recordActivity('model', 'Model removed', result.name);
      json(res, 200, result);
    } catch (e) { json(res, e.status || 502, { error: e.message }); }
  }

  async function apiModels(req, res) {
    try {
      const runtime = await loadOllamaModelRuntime({
        baseUrl: OLLAMA_URL,
        fetchWithTimeout,
        defaultModel: MODEL,
        timeoutMs: 5000
      });
      json(res, 200, { ...runtime, protectedModels: PROTECTED_MODELS() });
    } catch (e) {
      const error = String(e.message || e);
      json(res, 502, {
        error,
        available: false,
        default: MODEL,
        models: [MODEL],
        installed: [],
        loaded: [],
        installedCount: 0,
        loadedCount: 0,
        runtimeAvailable: false,
        runtimeError: error,
        defaultInstalled: false,
        defaultLoaded: false
      });
    }
  }

  async function searxSearch(query, signal = null) {
    const u = new URL(`${SEARXNG_URL}/search`);
    u.searchParams.set('q', query);
    u.searchParams.set('format', 'json');
    const r = await fetchWithTimeout(u.toString(), { signal }, 8000);
    if (!r.ok) throw new Error(`Web research returned HTTP ${r.status}`);
    const j = await r.json();
    noteSearch(j);
    return (j.results || []).slice(0, 6).map(x => ({
      title: x.title || '',
      url: x.url || '',
      content: x.content || ''
    }));
  }

  // A source the snapshot could not read is "unknown (the check failed)", never "none", 0 or unavailable: the model
  // repeats what it is given, so a failed read written as an empty one becomes a false statement about the appliance.
  // answering: the model on this PC that will write the answer. The snapshot is read before it is asked, so it can be
  // missing from the loaded list while it is the one answering; it is added, marked, so the list is true when read.
  function capabilityPrompt(snapshot, { answering = '' } = {}) {
    const failed = name => snapshot?.sources?.[name] === 'failed';
    const UNKNOWN = 'unknown (the check failed this turn)';
    const count = v => (Number.isFinite(v) ? String(v) : 'unknown');
    const images = snapshot?.images?.models || [];
    const imageEngineList = snapshot?.images?.engines || [];
    const textModels = snapshot?.models || {};
    const installedText = Array.isArray(textModels.installed) ? textModels.installed : [];
    const loadedText = Array.isArray(textModels.loaded) ? textModels.loaded : [];
    const loadedNames = loadedText.map(x => `${x.name}${x.contextLength ? ` [ctx ${x.contextLength}]` : ''}`);
    const tagged = name => (String(name).includes(':') ? String(name) : `${name}:latest`); // Ollama lists a tagless name as :latest
    const answeringNow = answering && !loadedText.some(x => tagged(x.name) === tagged(answering)) ? `${answering} (answering this turn)` : '';
    const loadedLine = failed('models') ? `${UNKNOWN}${answeringNow ? `, apart from ${answeringNow}` : ''}`
      : [...loadedNames, answeringNow].filter(Boolean).join(', ') || 'none when this was checked (a model loads when it is asked to answer)';
    const serviceText = (snapshot?.services || []).map(x => `${x.name}:${x.state}${x.required === false ? ':optional' : ':core'}`).join(', ');
    return [
      'RUNTIME CAPABILITY SNAPSHOT (authoritative for this response):',
      `Local AI version: ${snapshot?.version || APP_VERSION}`,
      `Configured local model: ${snapshot?.model || MODEL}`,
      `Appliance state: ${failed('status') ? UNKNOWN : snapshot?.overall || 'UNKNOWN'}`,
      `Services: ${failed('status') ? UNKNOWN : serviceText || 'unknown (none reported)'}`,
      `Installed text models: ${failed('models') ? UNKNOWN : installedText.length ? installedText.map(x => x.name).join(', ') : 'none verified'}`,
      `Loaded text models: ${loadedLine}`,
      `Model runtime detail: ${textModels.runtimeAvailable ? 'available' : 'unavailable'}`,
      `Image engines (Images page): ${failed('images') ? UNKNOWN : imageEngineList.length ? imageEngineList.map(x => `${x.label} = ${x.model} (${x.files.join(', ')})`).join('; ') : 'none discovered'}`,
      `Installed image checkpoints: ${failed('images') ? UNKNOWN : images.length ? images.map(x => `${x.checkpoint} [${x.familyLabel || x.family}]`).join(', ') : 'none discovered'}`,
      `Projects: ${count(snapshot?.projects?.count)}`,
      `Engineering: ${count(snapshot?.engineering?.active)} active; ${count(snapshot?.engineering?.awaitingApproval)} awaiting approval`,
      `Changes: ${count(snapshot?.changes?.pending)} pending`,
      `Issues: ${count(snapshot?.issues?.open)} open`,
      `PowerShell Workbench: ${snapshot?.powershell?.configured ? 'configured on the appliance (a separate page; this conversation cannot use it)' : 'not configured'}`,
      'A line that says unknown is unknown: say you could not check it, and never fill it in.',
      'Use this snapshot instead of guessing. Never claim a text or image model is installed unless it appears above. A text model can be installed without being currently loaded because Ollama may unload idle models. Never report a hard-coded appliance version. Image models are not Ollama models: they are files in ComfyUI on the Windows computer (its models folders: checkpoints, diffusion_models, text_encoders, vae), so never suggest installing one with Ollama. Image generation is available only when a discovered image engine or supported checkpoint is present. Local AI can prepare self-changes through Engineering -> Change Intelligence -> approval -> host self-update; never claim a change was applied unless the runtime reports it.'
    ].join('\n');
  }

  async function getCapabilitiesSnapshot(force = false) {
    if (!force && capabilityCache.value && capabilityCache.expiresAt > Date.now()) return capabilityCache.value;
    const [statusResult, imageResult, modelResult] = await Promise.allSettled([
      getStatusAndRecordTransition(),
      getImageModelLists().then(lists => ({
        ...buildImageModelCatalog(lists.checkpoints),
        engines: imageEngines.discoverEngines(lists).engines.map(e => ({ id: e.id, label: e.label, model: e.model, files: Object.values(e.files) }))
      })),
      loadOllamaModelRuntime({
        baseUrl: OLLAMA_URL,
        fetchWithTimeout,
        defaultModel: MODEL,
        timeoutMs: 5000
      })
    ]);
    const status = statusResult.status === 'fulfilled' ? statusResult.value : { overall: 'UNKNOWN', services: [] };
    const imageCatalog = imageResult.status === 'fulfilled' ? imageResult.value : { models: [], families: [], engines: [], defaultCheckpoint: null, defaultFamily: null };
    const modelRuntime = modelResult.status === 'fulfilled'
      ? modelResult.value
      : {
          available: false,
          default: MODEL,
          models: [],
          installed: [],
          loaded: [],
          installedCount: 0,
          loadedCount: 0,
          runtimeAvailable: false,
          runtimeError: String(modelResult.reason?.message || modelResult.reason || 'Model runtime unavailable'),
          defaultInstalled: false,
          defaultLoaded: false
        };
    const changes = changeStore();
    const issues = issueStore();
    const engineeringRuns = effectiveEngineeringRuns();
    const read = r => (r.status === 'fulfilled' ? 'ok' : 'failed');
    const snapshot = {
      appliance: 'Local AI', version: APP_VERSION, model: MODEL,
      sources: { status: read(statusResult), images: read(imageResult), models: read(modelResult) },
      overall: status.overall, services: status.services || [], serviceSummary: status.serviceSummary || {},
      models: modelRuntime,
      images: { ...imageCatalog, available: imageCatalog.models.some(x => x.supported) || imageCatalog.engines.length > 0 },
      projects: { count: projectStore().length },
      agents: { running: agentRunStore().filter(x => x.status === 'running').length },
      changes: { pending: changes.filter(x => ['planned','patch_failed','validation_failed','staged','awaiting_approval','approved','apply_requested'].includes(x.status)).length },
      issues: { open: issues.filter(x => x.status === 'open').length },
      engineering: { active: engineeringRuns.filter(x => x.status === 'running').length, awaitingApproval: engineeringRuns.filter(x => x.status === 'awaiting_approval').length },
      powershell: { configured: !!POWERSHELL_BRIDGE_TOKEN, localOnly: true, localPort: LOCAL_UI_PORT || listenPort() },
      watch: watchdog.list()
    };
    capabilityCache.value = snapshot;
    capabilityCache.expiresAt = Date.now() + CAPABILITY_CACHE_MS;
    return snapshot;
  }

  async function apiCapabilities(req, res) {
    try { json(res, 200, await getCapabilitiesSnapshot(true)); }
    catch (e) { storageError(res, e, 500); }
  }

  return { apiCapabilities, apiModelDelete, apiModelPull, apiModelPullCancel, apiModelPulls, apiModels, apiStatus, capabilityCache, capabilityPrompt, modelPulls, protectedModels: PROTECTED_MODELS, getCapabilitiesSnapshot, getStatusAndRecordTransition, searxSearch };
}

module.exports = { createStatus };
