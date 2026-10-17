const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3080);
// Second listener for host-only tools (PowerShell Workbench). Docker publishes it on 127.0.0.1 only, so a request
// that arrives on this port came from the Windows host itself; unlike the Host header, a LAN client cannot fake that.
const LOCAL_UI_PORT = Number(process.env.LOCAL_UI_PORT || 0);
const MODEL = process.env.MODEL || 'qwen3:4b-instruct-32k';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
const { TEXT_NUM_CTX, TEXT_NUM_CTX_LARGE, LARGE_ANSWER_RESERVE, TEXT_KEEP_ALIVE, ANSWER_RESERVE, fitMessages, warmTextModel, unloadTextModel } = require('./text-context');
const COMFY_URL = process.env.COMFY_URL || 'http://host.docker.internal:8188';
const N8N_URL = process.env.N8N_URL || 'http://local-ai-n8n:5678';
const PROXY_URL = process.env.PROXY_URL || 'http://local-ai-ollama-responses-proxy:8080';
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://local-ai-searxng:8080';
const MAC_AI_HOME_URL = process.env.MAC_AI_HOME_URL || 'http://10.0.0.16:3083';
const MAC_DSH_URL = process.env.MAC_DSH_URL || 'http://10.0.0.16:3084';
// GridCraft host bridge. The browser reaches it only through /api/gridcraft/*, so the bridge can stay off the LAN.
const GRIDCRAFT_URL = process.env.GRIDCRAFT_URL || 'http://host.docker.internal:8787';
const GRIDCRAFT_RUN_TIMEOUT_MS = 330000;
const REPORT_PATH = process.env.REPORT_PATH || '/reports/LocalAI-Certification-latest.txt';
const DATA_DIR = process.env.DATA_DIR || '/data';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SELF_APP_ROOT = process.env.SELF_APP_ROOT || '/app';
const ENGINEERING_MODEL_TIMEOUT_MS = Math.max(60000, Math.min(1800000, Number(process.env.ENGINEERING_MODEL_TIMEOUT_MS || 600000)));
const CHAT_MODEL_TIMEOUT_MS = Math.max(30000, Math.min(900000, Number(process.env.CHAT_MODEL_TIMEOUT_MS || 180000)));
const CAPABILITY_CACHE_MS = Math.max(5000, Math.min(300000, Number(process.env.CAPABILITY_CACHE_MS || 30000)));
let capabilityCache = { expiresAt: 0, value: null };
const POWERSHELL_BRIDGE_TOKEN = String(process.env.POWERSHELL_BRIDGE_TOKEN || '');
const POWERSHELL_UI_TOKEN = String(process.env.POWERSHELL_UI_TOKEN || '');

const ACTIVITY_STORE = 'activity';
const STATUS_STORE = 'status';
const LIBRARY_STORE = 'library';
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

const crypto = require('crypto');
const { Storage } = require('./storage');
const { RunLedger, cleanId: cleanRunId } = require('./run-ledger');
const improve = require('./improve');
const { runCard, workKind, WORK_CHIPS } = require('./run-cards');
const { loadOllamaModelRuntime } = require('./model-runtime');
const { createModelPulls } = require('./model-pulls');
const imageEngines = require('./image-engines');
const plainText = require('./plain-text');
// Last measured seconds per engine on this machine, shown as an estimate in the Images page.
const IMAGE_ESTIMATES = {};
const IMAGE_PROMPT_MODEL = process.env.IMAGE_PROMPT_MODEL || process.env.GRIDCRAFT_MODEL || 'qwen3:4b-instruct';
const release = require('./release').readRelease(__dirname);
// A staged copy (self-change smoke test) passes its own APP_VERSION; otherwise the release decides.
const APP_VERSION = /-stage$/.test(process.env.APP_VERSION || '') ? process.env.APP_VERSION : require('./release').appVersion(__dirname, release);
const storage = new Storage({ dataDir: DATA_DIR });
// Phone notifications (Web Push): app/push.js sends, app/notify.js decides; docs/OPERATIONS.md › Notifications.
const pushLib = require('./push');
const notifyLib = require('./notify');
const glance = require('./glance');
const voice = require('./voice');
const { voiceFacts } = require('./voice-context');
const weather = require('./weather');
const notifier = notifyLib.createNotifier({
  storage, sendPush: pushLib.sendPush, vapid: pushLib.loadOrCreateVapid(storage),
  subject: process.env.VAPID_SUBJECT || 'https://github.com/azmusgb/LocalAI'
});
// LOCALAI_NOTIFY_LOG (tests only): also append each notify() call as a JSON line to this file.
if (process.env.LOCALAI_NOTIFY_LOG) {
  const realNotify = notifier.notify;
  notifier.notify = event => { try { fs.appendFileSync(process.env.LOCALAI_NOTIFY_LOG, JSON.stringify(event) + '\n'); } catch {} return realNotify(event); };
}
const runLedger = new RunLedger({ storage, onTransition: (run, previous) => { const e = notifyLib.runEvent(run, previous); if (e) notifier.notify(e); } });
const activeRunControllers = new Map();
const claudeChat = require('./claude-chat').createClaudeChat({ storage, dataDir: DATA_DIR, json, readBody });

function json(res, status, value) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(value));
}

function storageError(res, error, defaultStatus = 400) {
  return json(res, error.statusCode || defaultStatus, { error: String(error.message || error), ...(error.code ? { code: error.code } : {}) });
}

function text(res, status, value, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': contentType, ...extraHeaders });
  res.end(value);
}

function readState(collection, fallback) {
  return collection === STATUS_STORE ? storage.readSetting('status', fallback) : storage.list(collection);
}

// History and log collections are capped; user-owned data (projects, conversations, knowledge, memory,
// approvals, library, …) is never pruned.
const RETENTION = Object.freeze({ activity: 2000, notifications: 500, automationRuns: 500, qualityEvents: 500, qualityScans: 100, agentRuns: 300, engineeringRuns: 300, powerShellJobs: 250 });
function prependRecord(collection, item) { return storage.prepend(collection, item, RETENTION[collection]); }

function writeState(collection, value, previous = value) {
  if (collection === STATUS_STORE) return storage.writeSetting('status', value);
  return storage.save(collection, value, previous);
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', chunk => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > maxBytes) {
        // Keep draining instead of destroying the socket so the handler can still answer 413.
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON request body'));
      }
    });
    req.on('error', reject);
  });
}

function activityStore() {
  const value = readState(ACTIVITY_STORE, []);
  return Array.isArray(value) ? value : [];
}

function recordActivity(type, title, detail = '', meta = {}) {
  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    type,
    title,
    detail,
    at: new Date().toISOString(),
    meta
  };
  prependRecord(ACTIVITY_STORE, item);
  return item;
}

function libraryStore() {
  const value = readState(LIBRARY_STORE, []);
  return Array.isArray(value) ? value : [];
}

function titleFromText(value, fallback = 'Untitled') {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  return clean.length <= 72 ? clean : `${clean.slice(0, 69).trim()}…`;
}

function recordArtifact(kind, title, summary = '', meta = {}, data = {}) {
  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 9)}`,
    kind: String(kind || 'artifact'),
    title: titleFromText(title, 'Untitled artifact'),
    summary: String(summary || '').slice(0, 1200),
    createdAt: new Date().toISOString(),
    pinned: false,
    meta: meta && typeof meta === 'object' ? meta : {},
    data: data && typeof data === 'object' ? data : {}
  };
  prependRecord(LIBRARY_STORE, item);
  return item;
}

function updateArtifact(id, patch = {}) {
  const items = libraryStore();
  const index = items.findIndex(x => x && x.id === id);
  if (index < 0) return null;
  if (typeof patch.pinned === 'boolean') items[index].pinned = patch.pinned;
  if (typeof patch.title === 'string' && patch.title.trim()) items[index].title = titleFromText(patch.title);
  writeState(LIBRARY_STORE, items);
  return items[index];
}

function deleteArtifact(id) {
  const items = libraryStore();
  const next = items.filter(x => x && x.id !== id);
  if (next.length === items.length) return false;
  writeState(LIBRARY_STORE, next, items);
  return true;
}


function migrateLegacyActivityToLibrary() {
  const items = libraryStore();
  const seen = new Set(items.map(x => x?.meta?.imageUrl).filter(Boolean));
  let changed = false;
  for (const a of activityStore()) {
    if (a?.type !== 'image' || !a?.meta?.imageUrl || seen.has(a.meta.imageUrl)) continue;
    items.push({
      id: `migrated-${a.id || Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      kind: 'image',
      title: titleFromText(a.detail || 'Generated image'),
      summary: 'Imported from v1.1 image activity',
      createdAt: a.at || new Date().toISOString(),
      pinned: false,
      meta: { ...a.meta, migratedFromActivity: true },
      data: { prompt: a.detail || '', imageUrl: a.meta.imageUrl }
    });
    seen.add(a.meta.imageUrl);
    changed = true;
  }
  if (changed) {
    items.sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    writeState(LIBRARY_STORE, items);
  }
}
async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const externalSignal = options?.signal || null;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
  const done = () => {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  };
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    done();
    throw error;
  }
  // fetch resolves at the headers; keep the deadline armed until the body has been read too.
  if (!response.body) done();
  else for (const method of ['text', 'json', 'arrayBuffer', 'blob', 'formData']) {
    const read = response[method].bind(response);
    response[method] = () => read().finally(done);
  }
  return response;
}

async function probe(name, label, url, goodCodes = [200], timeoutMs = 3000, required = true) {
  const started = Date.now();
  try {
    const r = await fetchWithTimeout(url, { method: 'GET' }, timeoutMs);
    const latencyMs = Date.now() - started;
    return {
      name, label, required,
      state: goodCodes.includes(r.status) ? 'HEALTHY' : 'DEGRADED',
      statusCode: r.status,
      latencyMs
    };
  } catch (e) {
    return {
      name, label, required, state: 'DOWN', statusCode: null,
      latencyMs: Date.now() - started,
      error: String(e.message || e)
    };
  }
}

function overallState(services) {
  const core = services.filter(x => x.required !== false);
  if (core.some(x => x.state === 'DOWN')) return 'DOWN';
  if (core.some(x => x.state === 'DEGRADED')) return 'DEGRADED';
  return 'HEALTHY';
}

function presentService(service) {
  const optional = service.required === false;
  const available = service.state === 'HEALTHY';
  return {
    ...service,
    availability: available ? 'available' : 'unavailable',
    displayState: optional && !available ? 'OPTIONAL_OFFLINE' : service.state,
    severity: available ? 'ok' : optional ? 'info' : service.state === 'DEGRADED' ? 'warning' : 'critical',
    impact: optional && !available ? 'Core appliance unaffected' : available ? 'Ready' : 'Core capability affected'
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

const HEALTH_SETTLE_MS = Number(process.env.HEALTH_SETTLE_MS || 120000);
async function getStatusAndRecordTransition() {
  const services = await Promise.all([
    probe('ollama', 'Intelligence', `${OLLAMA_URL}/api/tags`, [200]),
    probe('comfy', 'Image generation', `${COMFY_URL}/system_stats`, [200]),
    probe('n8n', 'Automation engine', `${N8N_URL}/healthz`, [200]),
    probe('proxy', 'Conversation compatibility', `${PROXY_URL}/healthz`, [200]),
    probe('search', 'Web research', `${SEARXNG_URL}/search?q=health&format=json`, [200], 5000),
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
    certification: require('./release').deployCheck(certificationInfo(), release)
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
    capabilityCache = { expiresAt: 0, value: null };
    if (p.state === 'done') recordActivity('model', 'Model downloaded', p.name);
    else if (p.state === 'failed') recordActivity('model', 'Model download failed', `${p.name}: ${p.error}`);
  }
});
// Another site open in the browser could otherwise post here (a text/plain form needs no preflight).
function sameOriginJson(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) { json(res, 403, { error: 'Origin not allowed' }); return false; }
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') { json(res, 415, { error: 'Content-Type must be application/json' }); return false; }
  return true;
}
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
    capabilityCache = { expiresAt: 0, value: null };
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
  return (j.results || []).slice(0, 6).map(x => ({
    title: x.title || '',
    url: x.url || '',
    content: x.content || ''
  }));
}

function sanitizeMessages(messages) {
  return (Array.isArray(messages) ? messages.slice(-16) : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, 26000) }));
}

function capabilityPrompt(snapshot) {
  const images = snapshot?.images?.models || [];
  const textModels = snapshot?.models || {};
  const installedText = Array.isArray(textModels.installed) ? textModels.installed : [];
  const loadedText = Array.isArray(textModels.loaded) ? textModels.loaded : [];
  const serviceText = (snapshot?.services || []).map(x => `${x.name}:${x.state}${x.required === false ? ':optional' : ':core'}`).join(', ');
  return [
    'RUNTIME CAPABILITY SNAPSHOT (authoritative for this response):',
    `Local AI version: ${snapshot?.version || APP_VERSION}`,
    `Configured local model: ${snapshot?.model || MODEL}`,
    `Appliance state: ${snapshot?.overall || 'UNKNOWN'}`,
    `Services: ${serviceText || 'unavailable'}`,
    `Installed text models: ${installedText.length ? installedText.map(x => x.name).join(', ') : 'none verified'}`,
    `Loaded text models: ${loadedText.length ? loadedText.map(x => `${x.name}${x.contextLength ? ` [ctx ${x.contextLength}]` : ''}`).join(', ') : 'none currently resident'}`,
    `Model runtime detail: ${textModels.runtimeAvailable ? 'available' : 'unavailable'}`,
    `Installed image models: ${images.length ? images.map(x => `${x.checkpoint} [${x.familyLabel || x.family}]`).join(', ') : 'none discovered'}`,
    `Projects: ${snapshot?.projects?.count ?? 0}`,
    `Engineering: ${snapshot?.engineering?.active ?? 0} active; ${snapshot?.engineering?.awaitingApproval ?? 0} awaiting approval`,
    `Changes: ${snapshot?.changes?.pending ?? 0} pending`,
    `Issues: ${snapshot?.issues?.open ?? 0} open`,
    `PowerShell Workbench: ${snapshot?.powershell?.configured ? 'configured' : 'not configured'}`,
    'Use this snapshot instead of guessing. Never claim a text or image model is installed unless it appears above. A text model can be installed without being currently loaded because Ollama may unload idle models. Never report a hard-coded appliance version. Image generation is available only when a supported discovered model is present. Local AI can prepare self-changes through Engineering -> Change Intelligence -> approval -> host self-update; never claim a change was applied unless the runtime reports it.'
  ].join('\n');
}

async function getCapabilitiesSnapshot(force = false) {
  if (!force && capabilityCache.value && capabilityCache.expiresAt > Date.now()) return capabilityCache.value;
  const [statusResult, imageResult, modelResult] = await Promise.allSettled([
    getStatusAndRecordTransition(),
    getCheckpointNames().then(names => buildImageModelCatalog(names)),
    loadOllamaModelRuntime({
      baseUrl: OLLAMA_URL,
      fetchWithTimeout,
      defaultModel: MODEL,
      timeoutMs: 5000
    })
  ]);
  const status = statusResult.status === 'fulfilled' ? statusResult.value : { overall: 'UNKNOWN', services: [] };
  const imageCatalog = imageResult.status === 'fulfilled' ? imageResult.value : { models: [], families: [], defaultCheckpoint: null, defaultFamily: null };
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
  const snapshot = {
    appliance: 'Local AI', version: APP_VERSION, model: MODEL,
    overall: status.overall, services: status.services || [], serviceSummary: status.serviceSummary || {},
    models: modelRuntime,
    images: { ...imageCatalog, available: imageCatalog.models.some(x => x.supported) },
    projects: { count: projectStore().length },
    agents: { running: agentRunStore().filter(x => x.status === 'running').length },
    changes: { pending: changes.filter(x => ['planned','patch_failed','validation_failed','staged','awaiting_approval','approved','apply_requested'].includes(x.status)).length },
    issues: { open: issues.filter(x => x.status === 'open').length },
    engineering: { active: engineeringRuns.filter(x => x.status === 'running').length, awaitingApproval: engineeringRuns.filter(x => x.status === 'awaiting_approval').length },
    powershell: { configured: !!POWERSHELL_BRIDGE_TOKEN, localOnly: true, localPort: LOCAL_UI_PORT || PORT }
  };
  capabilityCache = { value: snapshot, expiresAt: Date.now() + CAPABILITY_CACHE_MS };
  return snapshot;
}

// Spoken summaries for Siri Shortcuts (docs/APPLE-WATCH.md). ?topic=health for "Is Local AI OK?", otherwise
// "What needs me?". ?format=text returns just the sentence, which a shortcut can speak without parsing JSON.
async function apiGlance(req, res, urlObj) {
  try {
    const snapshot = await getCapabilitiesSnapshot();
    const health = glance.healthSummary({ services: snapshot.services || [], version: APP_VERSION });
    const dayAgo = Date.now() - 86400000;
    const recentFailed = runLedger.list({ status: 'failed', limit: 200 }).filter(r => Date.parse(r.finishedAt || r.updatedAt) >= dayAgo);
    const running = ['running', 'streaming'].reduce((n, status) => n + runLedger.list({ status, limit: 200 }).length, 0);
    const needs = glance.needsYouSummary({
      approvals: approvalStore().filter(a => a.status === 'pending').length,
      changes: Number(snapshot.changes?.pending || 0),
      findings: claudeFindings().filter(f => f.status === 'proposed').length,
      failedToday: recentFailed.length,
      running
    }, health);
    const topic = urlObj.searchParams.get('topic') === 'health' ? 'health' : 'needs';
    const speech = topic === 'health' ? health.speech : needs.speech;
    if (urlObj.searchParams.get('format') === 'text') return text(res, 200, speech, 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' });
    json(res, 200, { topic, speech, needsYou: { count: needs.count, items: needs.items }, health: { ok: health.ok, down: health.down, total: health.total }, version: APP_VERSION });
  } catch (e) { storageError(res, e, 500); }
}

// "Ask Local AI" from Siri (GET ?q= or POST {text}): a rules-only router picks the answer, the model only
// handles open questions, and every reply is plain text that is safe to read aloud. Siri speaks the body
// whatever the status, so errors are sentences, never JSON.
const voiceThreads = voice.createVoiceThreads({
  // LOCALAI_TEST_NOW_FILE (tests only): a file holding the clock in ms, so tests can move time.
  now: () => { const f = process.env.LOCALAI_TEST_NOW_FILE; if (f) { try { return Number(fs.readFileSync(f, 'utf8')) || Date.now(); } catch {} } return Date.now(); },
  windowMs: 300000
});
const VOICE_BUDGET_MS = Number(process.env.LOCALAI_VOICE_BUDGET_MS) || 8000;
const VOICE_HANDOFF = "Still working on that \u2014 I'll send it to your phone.";
const VOICE_QUEUE_WAIT_MS = Number(process.env.LOCALAI_VOICE_QUEUE_WAIT_MS) || 6000;
const VOICE_DOWN = "Local AI can't answer right now. Try again in a minute.";
const VOICE_REFUSAL = "That needs your phone \u2014 I've put it in Needs you.";
const VOICE_POST_ONLY = 'Use the Ask Local AI shortcut to start that.';
const voiceTimeZone = () => process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const VOICE_FACT_MS = 3000;

// searxSearch, but gives up (and cancels the request) after ms.
async function searxWithin(query, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await searxSearch(query, controller.signal); } finally { clearTimeout(timer); }
}

let lastWeather = null; // { threadId, loc: {lat, lon, place, timeZone} }

function voiceHome() { return storage.readSetting('voice-home', null) || {}; }

async function voiceWeather(question, here, threadId) {
  const q = question.toLowerCase();
  const when = /\btomorrow\b/.test(q) ? 'tomorrow' : /\btonight\b/.test(q) ? 'tonight' : /\btoday\b/.test(q) ? 'today' : 'now';
  let lat = Number(here.lat), lon = Number(here.lon), place = null, timeZone = null;
  if (here.lat != null && here.lat !== '' && here.lon != null && here.lon !== '' && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    place = undefined; // looked up below, alongside the forecast
  } else if (lastWeather?.threadId === threadId && voice.timeOnly(question)) {
    ({ lat, lon, place, timeZone } = lastWeather.loc);
  } else {
    const home = voiceHome();
    if (!Number.isFinite(home.lat) || !Number.isFinite(home.lon)) return "Set your home location on Local AI's Health page.";
    ({ lat, lon, place, timeZone } = home);
  }
  try {
    const [f, name] = await Promise.all([weather.forecast(lat, lon, { timeZone }), place === undefined ? weather.reverse(lat, lon) : place]);
    lastWeather = { threadId, loc: { lat, lon, place: name, timeZone } };
    const sentence = weather.weatherSentence(f, { when, place: name });
    return sentence ? voice.speakable(sentence) : "I couldn't get the weather right now.";
  } catch { return "I couldn't get the weather right now."; }
}

async function apiVoiceHome(req, res) {
  if (req.method === 'GET') return json(res, 200, voiceHome());
  const body = await readBody(req).catch(() => ({}));
  let found;
  try { found = await weather.geocode(typeof body?.place === 'string' ? body.place : ''); }
  catch { return json(res, 503, { error: "Couldn't reach the place lookup. Try again in a minute." }); }
  if (!found) return json(res, 400, { error: "Couldn't find that place." });
  const home = { place: found.name, lat: found.lat, lon: found.lon, timeZone: found.timeZone };
  storage.writeSetting('voice-home', home);
  json(res, 200, home);
}

async function voiceNeedsSentence() {
  const snapshot = await getCapabilitiesSnapshot();
  const dayAgo = Date.now() - 86400000;
  // Approved changes are with Claude or waiting for a PR merge (they ship as pull requests); they don't need you.
  const pendingChange = new Set(['planned', 'patch_failed', 'validation_failed', 'staged', 'awaiting_approval']);
  return glance.needsYouSentence(glance.needsYouItems({
    approvals: approvalStore().filter(a => a.status === 'pending'),
    // A change's Improve item has the short title (from its request); the change's own summary is the model's prose.
    changes: (() => { const titles = new Map(claudeFindings().filter(f => f.changeId).map(f => [f.changeId, f.title])); return changeStore().filter(c => pendingChange.has(c.status)).map(c => ({ title: titles.get(c.id) || c.summary || c.request })); })(),
    findings: claudeFindings().filter(f => f.status === 'proposed'),
    failedRuns: runLedger.list({ status: 'failed', limit: 200 }).filter(r => Date.parse(r.finishedAt || r.updatedAt) >= dayAgo),
    downServices: (snapshot.services || []).filter(s => s && s.required !== false && s.state !== 'HEALTHY')
  }));
}

// A notification for a spoken ask or the job it started. The tag is the run's, else a fresh one, so the repeat
// filter never drops one.
function voiceNotify(title, body, runId) {
  notifier.notify({ kind: 'answer', title, body, url: runId ? `#run/${runId}` : '/', tag: runId ? `answer:${runId}` : `answer:voice:${require('node:crypto').randomBytes(6).toString('hex')}` });
}

// "Make an image of…", "start a mission to…", "research…": start the job, reply as soon as it has started, and
// never wait for it to finish. Images and research report back by notification; missions use the run's own.
async function voiceAction({ action, subject }) {
  if (action === 'image') {
    if (!subject) return 'What should the image show?';
    // Through the server's own route, so the image is made exactly as one asked for in the app.
    fetchWithTimeout(`http://127.0.0.1:${PORT}/api/images/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: subject, voice: true }) }, 900000)
      .then(async r => {
        const j = await r.json().catch(() => ({}));
        if (r.ok) voiceNotify('Your image is ready', subject, j.runId);
        else voiceNotify("Couldn't make the image", 'Tap to see what went wrong.', j.runId);
      }, () => voiceNotify("Couldn't make the image", 'Tap to see what went wrong.'));
    return `Started an image of ${subject}. I'll notify you when it's ready.`;
  }
  if (action === 'mission') {
    if (!subject) return 'What should the mission do?';
    if (!featureAtLeast(4)) return "Missions aren't available on this Local AI.";
    startMissionRun(subject, '', undefined);
    return `Started a mission: ${subject}.`;
  }
  // research: a full answer for the app, not a spoken one; the notification carries its start.
  chatOnce({ messages: [{ role: 'user', content: subject }], webSearch: true, voiceRun: true }).then(
    result => voiceNotify('Research ready', voice.speakable(result.message.content) || 'Tap to read it.', result.runId),
    err => voiceNotify("Couldn't finish the research", 'Tap to see what went wrong.', err?.runId)
  );
  return `Researching ${subject}. I'll send you the answer.`;
}

async function apiGlanceAsk(req, res, urlObj) {
  const say = (status, value) => text(res, status, value, 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' });
  try {
    let textIn = '';
    let here = { lat: urlObj.searchParams.get('lat'), lon: urlObj.searchParams.get('lon') };
    if (req.method === 'GET') textIn = String(urlObj.searchParams.get('q') || '');
    else { const b = await readBody(req).catch(e => { if (e.statusCode === 413) throw e; return {}; }); textIn = typeof b?.text === 'string' ? b.text : ''; if (b?.lat != null && b?.lon != null) here = { lat: b.lat, lon: b.lon }; }
    textIn = textIn.trim().slice(0, 4000);
    const reset = voice.stripReset(textIn);
    const route = voice.classify(reset.text);
    if (route.intent === 'empty') {
      if (reset.fresh) { voiceThreads.take(textIn); return say(200, 'Okay. What is your question?'); }
      return say(200, "I didn't catch that.");
    }
    // Images, missions and research start only from the shortcut's POST, which the cross-site guard covers. Any web
    // page can make the owner's browser load a GET, so a GET that asks to start work starts nothing.
    if (route.intent === 'action' && req.method !== 'POST') return say(200, VOICE_POST_ONLY);
    const question = reset.text;
    const { threadId } = voiceThreads.take(textIn);
    // Every answer is a turn in the thread; only chat asks hand the earlier turns to the model.
    const turn = async build => {
      const answer = await build();
      voiceThreads.record(threadId, question, answer);
      return answer;
    };
    // "and tomorrow?" right after a weather answer on this thread is weather for the same place.
    const followUpWeather = lastWeather?.threadId === threadId && ['chat', 'current'].includes(route.intent) && voice.timeOnly(question);
    let runId = null;
    const asked = voiceThreads.run(threadId, () => {
      if (route.intent === 'time') return turn(async () => voice.speakable(voiceFacts({ now: new Date(), timeZone: voiceTimeZone() })));
      if (route.intent === 'needs') return turn(async () => voice.speakable(await voiceNeedsSentence()));
      if (route.intent === 'health') {
        return turn(async () => {
          const snapshot = await getCapabilitiesSnapshot();
          return voice.speakable(glance.healthSummary({ services: snapshot.services || [], version: APP_VERSION }).speech);
        });
      }
      if (route.intent === 'weather' || followUpWeather) return turn(() => voiceWeather(question, here, threadId));
      if (route.intent === 'current') {
        return turn(async () => {
          let sources;
          try { sources = (await searxWithin(question, VOICE_FACT_MS)).slice(0, 3); } catch { return "I couldn't look that up right now."; }
          if (!sources.length) return "I couldn't find anything on that.";
          const messages = [...voiceThreads.history(threadId), { role: 'user', content: question }];
          const result = await chatOnce({ messages, brief: true, voice: true, threadId, presetSources: sources, sourceHost: voice.siteName(sources[0].url) });
          runId = result.runId;
          const host = voice.siteName(sources[0].url);
          let said = String(result.message.content || '').trim();
          // The model is asked to cite; make sure the spoken answer names the site either way.
          if (said && host && !said.toLowerCase().includes(host.toLowerCase())) said = `According to ${host}, ${/^[A-Z][a-z]/.test(said) ? said[0].toLowerCase() + said.slice(1) : said}`;
          return voice.speakable(said) || "I didn't catch that.";
        });
      }
      // Approving, applying, deploying, deleting and PowerShell never happen by voice; nothing is called.
      if (route.intent === 'refuse') return turn(async () => VOICE_REFUSAL);
      if (route.intent === 'action') return turn(() => voiceAction(route));
      return turn(async () => {
        const messages = [...voiceThreads.history(threadId), { role: 'user', content: question }];
        const result = await chatOnce({ messages, brief: true, voice: true, threadId });
        runId = result.runId;
        return voice.speakable(result.message.content) || "I didn't catch that.";
      });
    }, { waitMs: VOICE_QUEUE_WAIT_MS });
    // The budget covers the whole ask, queue wait included. Past it the run carries on and the answer is pushed.
    const outcome = await voice.withBudget(asked, VOICE_BUDGET_MS);
    if (outcome.done) return say(200, outcome.value);
    const handoff = (title, body, id) => voiceNotify(title, body, id || runId);
    outcome.later.then(
      late => handoff('Local AI answered', String(late)),
      err => handoff("Local AI couldn't answer", "Tap to see what went wrong.", err?.runId)
    );
    say(200, VOICE_HANDOFF);
  } catch (e) { say(e.statusCode === 413 ? 413 : 503, e.statusCode === 413 ? 'That was too long for me.' : VOICE_DOWN); }
}

async function apiCapabilities(req, res) {
  try { json(res, 200, await getCapabilitiesSnapshot(true)); }
  catch (e) { storageError(res,e,500); }
}

function systemPrompt(researchContext = '', capabilityContext = '', brief = false, facts = '', sourceHost = '') {
  return {
    role: 'system',
    content:
      'You are the assistant inside a private local AI appliance. Be concise, technically precise, useful, and action-oriented. ' +
      'Do not expose infrastructure implementation details unless the user asks. Do not claim an action was executed unless it actually was. ' +
      'When discussing this appliance, use the supplied runtime capability snapshot as authoritative and do not invent installed models, versions, services, or completed actions.' +
      (capabilityContext ? `\n\n${capabilityContext}` : '') +
      (facts ? `\n\n${facts}` : '') +
      (researchContext
        ? `\n\nCurrent metasearch results are below. Use them when relevant and cite source numbers like [1].\n\n${researchContext}`
        : '') +
      // Siri Shortcuts on a phone or watch read the answer aloud (docs/APPLE-WATCH.md).
      (brief ? '\n\nThis answer will be read aloud on a watch: reply in at most two short sentences of plain text, with no lists, markdown, links or source numbers.' : '') +
      (brief && sourceHost ? ` Start the answer with "According to ${sourceHost},".` : '')
  };
}

// The messages for the text model: system prompt, research sources (trimmed first), then the conversation, fitted to the shared context.
function chatMessages(prep) {
  const system = systemPrompt('', prep.capabilityContext, prep.brief, prep.voice ? voiceFacts({ now: new Date(), timeZone: voiceTimeZone(), includeZone: true }) : '', prep.sourceHost);
  const sources = prep.researchContext
    ? [{ role: 'system', kind: 'sources', content: `Current metasearch results are below. Use them when relevant and cite source numbers like [1].\n\n${prep.researchContext}` }]
    : [];
  return fitMessages([system, ...sources, ...prep.messages], { numCtx: TEXT_NUM_CTX, reserve: ANSWER_RESERVE });
}

async function prepareChat(body, signal = null) {
  const throwIfAborted = () => {
    if (!signal?.aborted) return;
    const error = new Error('Run cancelled');
    error.name = 'AbortError';
    throw error;
  };
  throwIfAborted();
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : MODEL;
  const messages = sanitizeMessages(body.messages);
  if (!messages.length) throw new Error('messages[] is required');

  let sources = [];
  let researchContext = '';
  if (Array.isArray(body.presetSources) && body.presetSources.length) {
    // Voice "current facts": the sources were already fetched (and timed) by the caller.
    sources = body.presetSources.map(x => ({ title: String(x.title || ''), url: String(x.url || ''), content: String(x.content || '') }));
    researchContext = sources.map((x, i) => `[${i + 1}] ${x.title}\n${x.content}\n${x.url}`).join('\n\n');
  } else if (body.webSearch === true) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (lastUser) {
      sources = await searxSearch(lastUser.content, signal);
      throwIfAborted();
      researchContext = sources.map((s, i) =>
        `[${i + 1}] ${s.title}\n${s.content}\n${s.url}`
      ).join('\n\n');
    }
  }

  let capabilityContext = '';
  try {
    capabilityContext = capabilityPrompt(await getCapabilitiesSnapshot());
    throwIfAborted();
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  throwIfAborted();
  return { model, messages, sources, researchContext, capabilityContext, brief: body.brief === true, voice: body.voice === true, sourceHost: typeof body.sourceHost === 'string' ? body.sourceHost : '' };
}

async function apiChat(req, res) {
  try { json(res, 200, await chatOnce(await readBody(req))); }
  catch (e) { storageError(res,e,500); }
}

// One non-streaming chat turn as a run; shared by /api/chat and /api/glance/ask.
async function chatOnce(body) {
  let execution = null;
  try {
    execution = createChatExecution(body, false);
    runLedger.start(execution.id, body.webSearch === true ? 'Research run started' : 'Chat run started');
    const prep = await prepareChat(body);
    const started = Date.now();

    const r = await fetchWithTimeout(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: prep.model,
        messages: chatMessages(prep),
        stream: false,
        keep_alive: TEXT_KEEP_ALIVE,
        options: { num_ctx: TEXT_NUM_CTX }
      })
    }, CHAT_MODEL_TIMEOUT_MS);

    const raw = await r.text();
    if (!r.ok) throw new Error(`Intelligence service HTTP ${r.status}: ${raw.slice(0, 500)}`);
    const j = JSON.parse(raw);
    const content = j?.message?.content || '';
    const elapsedMs = Date.now() - started;
    const lastUser = [...prep.messages].reverse().find(m => m.role === 'user');

    recordActivity(
      body.webSearch === true ? 'research' : 'chat',
      body.webSearch === true ? 'Researched with AI' : 'Asked AI',
      (lastUser?.content || '').slice(0, 180),
      { model: prep.model, elapsedMs, sources: prep.sources.length, runId: execution.id }
    );
    const artifact = recordArtifact(
      body.webSearch === true ? 'research' : 'conversation',
      lastUser?.content || (body.webSearch === true ? 'Research' : 'Conversation'),
      content.slice(0, 420),
      { model: prep.model, elapsedMs, sources: prep.sources.length, runId: execution.id },
      { prompt: lastUser?.content || '', response: content.slice(0, 40000), sources: prep.sources }
    );
    runLedger.complete(execution.id, {
      summary: content.slice(0, 420),
      output: { text: content.slice(0, 40000), model: prep.model, elapsedMs, sources: prep.sources },
      artifactIds: artifact?.id ? [artifact.id] : [],
      meta: { model: prep.model, elapsedMs, sources: prep.sources.length, ...(body.voice === true || body.voiceRun === true ? { voice: true } : {}) }
    });

    return {
      message: { role: 'assistant', content },
      model: prep.model,
      elapsedMs,
      sources: prep.sources,
      runId: execution.id
    };
  } catch (e) {
    if (execution) { runLedger.fail(execution.id, e); try { e.runId = execution.id; } catch {} }
    throw e;
  }
}

async function apiChatStream(req, res) {
  let execution = null;
  let controller = null;
  // Ollama can stall while loading a model or mid-stream; abort when no output arrives for CHAT_MODEL_TIMEOUT_MS.
  let idleTimer = null;
  let stalled = false;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stalled = true;
      controller?.abort(new Error(`No model output for ${Math.round(CHAT_MODEL_TIMEOUT_MS / 1000)}s`));
    }, CHAT_MODEL_TIMEOUT_MS);
  };
  try {
    const body = await readBody(req);
    execution = createChatExecution(body, true);
    runLedger.start(execution.id, body.webSearch === true ? 'Research run started' : 'Chat run started');
    controller = new AbortController();
    activeRunControllers.set(execution.id, controller);
    res.on('close', () => {
      if (!res.writableEnded) {
        runLedger.cancel(execution.id, 'Client disconnected');
        if (!controller.signal.aborted) controller.abort(new Error('Client disconnected'));
      }
    });

    const prep = await prepareChat(body, controller.signal);
    if (controller.signal.aborted || runLedger.get(execution.id)?.status === 'cancelled') {
      throw new Error('Run cancelled');
    }
    const started = Date.now();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send('meta', { model: prep.model, sources: prep.sources, runId: execution.id });

    armIdle();
    const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: prep.model,
        messages: chatMessages(prep),
        stream: true,
        keep_alive: TEXT_KEEP_ALIVE,
        options: { num_ctx: TEXT_NUM_CTX }
      })
    });

    if (!upstream.ok || !upstream.body) {
      const raw = await upstream.text();
      throw new Error(`Intelligence service HTTP ${upstream.status}: ${raw.slice(0, 500)}`);
    }

    runLedger.stream(execution.id, 'Streaming model output');
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      armIdle();
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        let item;
        try { item = JSON.parse(line); } catch { continue; }
        const chunk = item?.message?.content || '';
        if (chunk) {
          full += chunk;
          send('token', { text: chunk });
        }
      }
    }

    const elapsedMs = Date.now() - started;
    const lastUser = [...prep.messages].reverse().find(m => m.role === 'user');
    recordActivity(
      body.webSearch === true ? 'research' : 'chat',
      body.webSearch === true ? 'Researched with AI' : 'Asked AI',
      (lastUser?.content || '').slice(0, 180),
      { model: prep.model, elapsedMs, sources: prep.sources.length, runId: execution.id }
    );
    const artifact = recordArtifact(
      body.webSearch === true ? 'research' : 'conversation',
      lastUser?.content || (body.webSearch === true ? 'Research' : 'Conversation'),
      full.slice(0, 420),
      { model: prep.model, elapsedMs, sources: prep.sources.length, runId: execution.id },
      { prompt: lastUser?.content || '', response: full.slice(0, 40000), sources: prep.sources }
    );
    runLedger.complete(execution.id, {
      summary: full.slice(0, 420),
      output: { text: full.slice(0, 40000), model: prep.model, elapsedMs, sources: prep.sources },
      artifactIds: artifact?.id ? [artifact.id] : [],
      meta: { model: prep.model, elapsedMs, sources: prep.sources.length }
    });

    send('done', { elapsedMs, model: prep.model, sources: prep.sources, runId: execution.id });
    res.end();
  } catch (e) {
    const current = execution ? runLedger.get(execution.id) : null;
    const cancelled = !stalled && (current?.status === 'cancelled' || (controller?.signal.aborted && current?.status !== 'failed'));
    if (execution && !cancelled) runLedger.fail(execution.id, e);
    if (!res.headersSent) {
      if (!res.destroyed) {
        if (cancelled) json(res, 409, { error: 'Run cancelled', runId: execution?.id || null });
        else storageError(res,e,500);
      }
    } else {
      try {
        res.write(`event: ${cancelled ? 'cancelled' : 'error'}\ndata: ${JSON.stringify(cancelled ? { runId: execution.id } : { error: String(e.message || e), runId: execution?.id || null })}\n\n`);
        res.end();
      } catch {}
    }
  } finally {
    clearTimeout(idleTimer);
    if (execution) activeRunControllers.delete(execution.id);
  }
}

function recentEngineeringRequest(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== 'user') continue;
    const text = String(m.content || '').trim();
    if (!text) continue;
    const r = routeIntent(text, 'auto', [], true);
    if (r.intent === 'engineering') return text;
  }
  return '';
}

function routeIntent(textValue, requestedMode = 'auto', messages = [], skipContinuation = false) {
  const text = String(textValue || '').trim();
  const mode = String(requestedMode || 'auto').toLowerCase();
  if (['ask', 'create', 'research', 'automate', 'engineering'].includes(mode)) {
    return { intent: mode, target: mode === 'engineering' ? 'self' : null, confidence: 1, reason: 'explicit-mode', effectiveRequest: text };
  }

  const t = text.toLowerCase();
  const continuation = !skipContinuation && /^(do it|implement it|apply that|apply it|make those changes|go ahead|use your recommendation|proceed|make it so)[.!\s]*$/i.test(text);
  if (continuation) {
    const previous = recentEngineeringRequest(messages);
    if (previous) return { intent: 'engineering', target: 'self', confidence: 0.98, reason: 'engineering-continuation', effectiveRequest: previous };
  }

  // Capability questions are informational even when they mention image/create features.
  if (/\b(what|which|show|list|tell me|are there|do i have)\b.*\b(models?|capabilit(?:y|ies)|services?|version|installed|running)\b/.test(t)) {
    return { intent: 'ask', target: null, confidence: 0.96, reason: 'capability-question', effectiveRequest: text };
  }

  const selfObject = /\b(local ai|this (?:site|app|application|ui|page|navigation|dashboard)|your (?:ui|navigation|site|app)|create page|home page|sidebar|menu|workbench|engineer|powershell|status page|ui|interface)\b/.test(t);
  const engineeringVerb = /\b(improve|fix|update|upgrade|refactor|patch|implement|modify|change|enhance|adjust|rewrite|redesign|rethink|add|remove|build|make)\b/.test(t);
  const codeArtifact = /\b(html|css|javascript|js|frontend|backend|endpoint|route|navigation|dashboard|component|layout|code|feature)\b/.test(t);
  const explicitEngineering = /\b(generate|create)\b.*\b(html|css|javascript|code|component|dashboard|page|navigation|endpoint)\b/.test(t);
  const informational = /^(how|what|why|which|where|when|explain|describe|tell me|show me how|can you explain|could you explain)\b/.test(t);
  if (!informational && ((engineeringVerb && (selfObject || codeArtifact)) || explicitEngineering)) {
    return { intent: 'engineering', target: 'self', confidence: 0.97, reason: 'software-modification', effectiveRequest: text };
  }

  // Visual-content language is evaluated only after engineering intent.
  if (/\b(generate|create|render|draw|illustrate|make)\b.*\b(image|picture|photo|artwork|portrait|scene|logo|poster|visual)\b/.test(t) || /\b(image|picture|photo|artwork)\b.*\b(of|showing|depicting)\b/.test(t)) {
    return { intent: 'create', target: null, confidence: 0.94, reason: 'visual-content', effectiveRequest: text };
  }
  if (/\b(workflow|automation|automate|n8n|trigger|webhook|schedule|data table)\b/.test(t)) {
    return { intent: 'automate', target: null, confidence: 0.9, reason: 'automation-language', effectiveRequest: text };
  }
  if (/\b(latest|today|current|news|search the web|web search|research online|look up)\b/.test(t)) {
    return { intent: 'research', target: null, confidence: 0.86, reason: 'fresh-information-language', effectiveRequest: text };
  }
  return { intent: 'ask', target: null, confidence: 0.7, reason: 'default', effectiveRequest: text };
}

async function apiRoute(req, res) {
  try {
    const body = await readBody(req);
    const route = routeIntent(body.text, body.mode, sanitizeMessages(body.messages));
    json(res, 200, route);
  } catch (e) {
    storageError(res,e,400);
  }
}

async function apiActivity(req, res) {
  const items = activityStore();
  json(res, 200, { items: items.slice(0, 100) });
}

async function apiActivityClear(req, res) {
  const items = activityStore();
  const kept = items.filter(x => x && (x.type === 'system' || x.type === 'recovery'));
  writeState(ACTIVITY_STORE, kept, items);
  recordActivity('system', 'User activity cleared', 'User-generated activity was cleared; system and recovery audit events were preserved.');
  json(res, 200, { ok: true, preserved: kept.length });
}

async function apiLibrary(req, res) {
  const items = libraryStore();
  const counts = items.reduce((acc, item) => {
    const key = item?.kind || 'artifact';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  json(res, 200, { items: items.slice(0, 250), counts, total: items.length });
}

async function apiLibraryUpdate(req, res) {
  try {
    const body = await readBody(req);
    const id = String(body.id || '');
    if (!id) return json(res, 400, { error: 'id is required' });
    const item = updateArtifact(id, body);
    if (!item) return json(res, 404, { error: 'Artifact not found' });
    json(res, 200, { ok: true, item });
  } catch (e) {
    storageError(res,e,400);
  }
}

async function apiLibraryDelete(req, res) {
  try {
    const body = await readBody(req);
    const id = String(body.id || '');
    if (!id) return json(res, 400, { error: 'id is required' });
    const deleted = deleteArtifact(id);
    if (!deleted) return json(res, 404, { error: 'Artifact not found' });
    recordActivity('system', 'Library item removed', 'An artifact was removed from the workspace library.');
    json(res, 200, { ok: true });
  } catch (e) {
    storageError(res,e,400);
  }
}

async function apiWorkspace(req, res) {
  const activity = activityStore();
  const library = libraryStore();
  const byKind = library.reduce((acc, item) => {
    const key = item?.kind || 'artifact';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  json(res, 200, {
    activity: activity.slice(0, 8),
    recent: library.slice(0, 8),
    pinned: library.filter(x => x?.pinned).slice(0, 6),
    totals: { activity: activity.length, library: library.length, byKind }
  });
}

// ComfyUI describes a file picker as [[...names]] or, in newer nodes, ["COMBO", {options: [...names]}].
function comfyOptions(spec) {
  if (!Array.isArray(spec)) return [];
  if (Array.isArray(spec[0])) return spec[0];
  if (spec[0] === 'COMBO' && Array.isArray(spec[1]?.options)) return spec[1].options;
  return [];
}

async function getCheckpointNames() {
  const r = await fetchWithTimeout(`${COMFY_URL}/object_info/CheckpointLoaderSimple`, {}, 7000);
  if (!r.ok) throw new Error(`Image service returned HTTP ${r.status}`);
  const j = await r.json();
  return comfyOptions(j?.CheckpointLoaderSimple?.input?.required?.ckpt_name);
}

function inferImageFamily(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return 'unknown';
  if (/\bflux\b/.test(n)) return 'flux';
  if (/sdxl|stable[._ -]?diffusion[._ -]?xl|xl[._ -]?base|\bxl\b/.test(n)) return 'sdxl';
  if (/v1[-._ ]?5|sd1[._ -]?5|stable[._ -]?diffusion[._ -]?1[._ -]?5|\b1[._ -]?5\b/.test(n)) return 'sd15';
  return 'unknown';
}

function imageFamilyLabel(family) {
  return ({ sd15: 'SD 1.5', sdxl: 'SDXL', flux: 'FLUX', unknown: 'Unknown' })[family] || family;
}

function imageModelInfo(name) {
  const family = inferImageFamily(name);
  if (family === 'flux') {
    return { checkpoint: name, family, familyLabel: imageFamilyLabel(family), supported: false, workflow: 'requires-custom-graph', reason: 'FLUX checkpoints require a dedicated ComfyUI workflow graph in this appliance release.' };
  }
  if (family === 'sdxl') {
    return { checkpoint: name, family, familyLabel: imageFamilyLabel(family), supported: true, workflow: 'checkpoint-basic', reason: 'Supported by the standard checkpoint workflow.' };
  }
  if (family === 'sd15') {
    return { checkpoint: name, family, familyLabel: imageFamilyLabel(family), supported: true, workflow: 'checkpoint-basic', reason: 'Supported by the standard checkpoint workflow.' };
  }
  return { checkpoint: name, family, familyLabel: imageFamilyLabel(family), supported: true, workflow: 'checkpoint-basic', reason: 'Unknown family; generation will use the standard checkpoint workflow on a best-effort basis.' };
}

function buildImageModelCatalog(names) {
  const models = (Array.isArray(names) ? names : []).map(imageModelInfo);
  const order = ['sd15', 'sdxl', 'flux', 'unknown'];
  const families = order
    .map(family => {
      const group = models.filter(x => x.family === family);
      if (!group.length) return null;
      return {
        family,
        familyLabel: imageFamilyLabel(family),
        supported: group.some(x => x.supported),
        reason: group.some(x => x.supported) ? null : group[0].reason,
        models: group
      };
    })
    .filter(Boolean);
  const defaultModel = models.find(x => x.supported) || models[0] || null;
  return {
    models,
    families,
    defaultCheckpoint: defaultModel ? defaultModel.checkpoint : null,
    defaultFamily: defaultModel ? defaultModel.family : null
  };
}

// Every model list the image engines need, from ComfyUI's object_info. A node type that isn't installed
// (UnetLoaderGGUF before ComfyUI-GGUF) just yields an empty list.
async function getImageModelLists() {
  const read = async (node, input) => {
    try {
      const r = await fetchWithTimeout(`${COMFY_URL}/object_info/${node}`, {}, 7000);
      if (!r.ok) return [];
      return comfyOptions((await r.json())?.[node]?.input?.required?.[input]);
    } catch { return []; }
  };
  const [checkpoints, unets, clips, vaes, upscalers] = await Promise.all([
    getCheckpointNames(), read('UnetLoaderGGUF', 'unet_name'), read('DualCLIPLoader', 'clip_name1'), read('VAELoader', 'vae_name'), read('UpscaleModelLoader', 'model_name')
  ]);
  return { checkpoints, unets, clips, vaes, upscalers };
}

async function apiImageModels(req, res) {
  try {
    const lists = await getImageModelLists();
    const found = imageEngines.discoverEngines(lists);
    const engines = found.engines.map(({ id, label, blurb, family, base }) => ({ id, label, blurb, family, base, estimateSec: IMAGE_ESTIMATES[id] || null }));
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
    const r = await fetchWithTimeout(`${COMFY_URL}/history/${encodeURIComponent(promptId)}`, {}, 7000);
    if (r.ok) {
      const j = await r.json();
      if (j && j[promptId]) return j[promptId];
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Image generation timed out');
}

// Rewrites a short idea into a detailed image prompt with the local language model, then unloads that model
// so the image model has the GPU to itself (they share 6 GB of VRAM).
async function enhanceImagePrompt(prompt, engineId) {
  const style = engineId === 'best' ? 'Write natural sentences.' : 'Write a comma-separated list of descriptive phrases.';
  const r = await fetchWithTimeout(`${OLLAMA_URL}/api/chat`, {
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
    // An edit keeps the source picture's own size (sent by the browser); a new image uses the shape's size.
    const [width, height] = editing ? [clampInt(body.sourceWidth, 64, 2048, 512), clampInt(body.sourceHeight, 64, 2048, 512)]
      : imageEngines.sizeFor(engine, body.aspect, body.aspect ? null : body.width, body.aspect ? null : body.height);
    const steps = clampInt(body.steps, 1, 60, engine.steps);
    const cfg = Math.max(1, Math.min(20, Number(body.cfg) || engine.cfg));
    const seed = Number.isFinite(Number(body.seed)) ? Math.floor(Number(body.seed)) : Math.floor(Math.random() * 2147483647);
    const userNegative = body.negativePrompt === undefined || body.negativePrompt === null ? engine.negative : String(body.negativePrompt);
    const style = imageEngines.STYLES[body.style] ? body.style : 'none';
    const upscaler = body.upscale === true ? found.upscaler : null;
    const count = clampInt(body.count, 1, 4, 1);
    const strength = Math.max(0.1, Math.min(1, Number(body.strength) || 0.6));

    execution = runLedger.create({
      type: 'image',
      threadId: body.threadId,
      title: titleFromText(original, editing ? 'Image edit' : 'Image generation'),
      input: { prompt: original.slice(0, 2000), engine: engine.id, checkpoint, family: engine.family, width, height, steps, cfg, style, count, upscale: !!upscaler, enhance: body.enhance === true, edit: editing ? { masked: !!body.mask, strength } : null },
      // Started by voice: the ask sends its own "ready" or "couldn't" notification, so the generic ones stay quiet.
      meta: body.voice === true ? { voice: true } : {},
      // An edit's source image isn't kept with the run, so Retry repeats it as a new image.
      retryRequest: { path: '/api/images/generate', body: { prompt: original, engine: engine.id, checkpoint: engine.id === 'custom' ? checkpoint : undefined, negativePrompt: body.negativePrompt, aspect: body.aspect, width, height, steps, cfg, style, count, upscale: !!upscaler, enhance: body.enhance === true, threadId: cleanRunId(body.threadId) || undefined } }
    });
    runLedger.start(execution.id, editing ? 'Image edit started' : 'Image generation started');
    imageJobsActive++; tookGpu = true;
    await unloadTextModel({ url: OLLAMA_URL, model: MODEL });

    let prompt = original;
    if (body.enhance === true) {
      try { prompt = await enhanceImagePrompt(original, engine.id); runLedger.update(execution.id, { progress: 15 }, 'Prompt improved'); }
      catch (e) { runLedger.update(execution.id, { progress: 15 }, `Prompt helper unavailable; using your prompt (${e.message})`); }
    }
    const styled = imageEngines.applyStyle(prompt, userNegative, style);

    let source = null;
    if (editing) {
      const tag = `localai-edit-${execution.id}`;
      source = { image: await uploadToComfy(body.source, tag), mask: body.mask ? await uploadToComfy(body.mask, `${tag}-mask`) : null };
      runLedger.update(execution.id, { progress: 25 }, body.mask ? 'Repainting the marked area' : 'Redrawing the image');
    }

    const started = Date.now();
    const timeoutMs = (engine.family === 'flux' ? 900000 : 420000) * count;
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
    const common = { engine: engine.id, engineLabel: engine.label, checkpoint, family: engine.family, style, width: outW, height: outH, steps, cfg, upscaled: !!upscaler, edited: editing, elapsedMs };
    const images = results.map(({ img, seed: s }) => ({ imageUrl: `/api/images/view?${new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' })}`, seed: s }));

    const artifactIds = [];
    for (const im of images) {
      const meta = { ...common, imageUrl: im.imageUrl, seed: im.seed };
      const label = `${outW} × ${outH} · ${engine.label}${style !== 'none' ? ` · ${imageEngines.STYLES[style].label}` : ''}${editing ? ' · edited' : ''}${upscaler ? ' · upscaled' : ''}`;
      const artifact = recordArtifact('image', original, label, { ...meta, runId: execution.id }, { prompt: original, usedPrompt: styled.prompt, negativePrompt: styled.negative, imageUrl: im.imageUrl });
      if (artifact?.id) artifactIds.push(artifact.id);
    }
    recordActivity('image', editing ? 'Edited an image' : count > 1 ? `Created ${images.length} images` : 'Created an image', original.slice(0, 180), { ...common, imageUrl: images[0].imageUrl, seed: images[0].seed, runId: execution.id });
    runLedger.complete(execution.id, {
      summary: imageEngines.runSummary({ count: images.length, width: outW, height: outH, engine: engine.label, editing }),
      output: { ...common, images },
      artifactIds,
      meta: { promptId: results[0].promptId, checkpoint, elapsedMs }
    });
    if (!upscaler && body.enhance !== true && !editing && count === 1) IMAGE_ESTIMATES[engine.id] = Math.round(elapsedMs / 1000);

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

async function apiGridcraftHealth(req, res) {
  try {
    const r = await fetchWithTimeout(`${GRIDCRAFT_URL}/health`, { cache: 'no-store' }, 4000);
    const data = await r.json().catch(() => ({}));
    // Only what the UI shows: the bridge also reports host file paths.
    json(res, r.ok ? 200 : 502, { ok: r.ok && data.ok === true, gridcraftConnected: data.gridcraftConnected === true, ...(data.model ? { model: String(data.model) } : {}) });
  } catch (e) {
    json(res, 502, { ok: false, error: `GridCraft bridge unavailable: ${e.message || e}` });
  }
}
async function apiGridcraftRun(req, res) {
  // Same rules the bridge applies to browsers: same-origin only, JSON only.
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return json(res, 403, { ok: false, error: 'Origin not allowed' });
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return json(res, 415, { ok: false, error: 'Content-Type must be application/json' });
  try {
    const b = await readBody(req, 64 * 1024);
    const r = await fetchWithTimeout(`${GRIDCRAFT_URL}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: String(b.prompt || '') }) }, GRIDCRAFT_RUN_TIMEOUT_MS);
    const data = await r.json().catch(() => ({ ok: false, error: `Bridge returned HTTP ${r.status}` }));
    if (r.ok) recordActivity('gridcraft', 'GridCraft request', String(b.prompt || '').slice(0, 180), { durationSec: data.durationSec });
    json(res, r.status, data);
  } catch (e) {
    json(res, 502, { ok: false, error: `GridCraft bridge unavailable: ${e.message || e}` });
  }
}
async function apiImageView(req, res, urlObj) {
  try {
    const u = new URL(`${COMFY_URL}/view`);
    for (const key of ['filename', 'subfolder', 'type']) {
      const value = urlObj.searchParams.get(key);
      if (value !== null) u.searchParams.set(key, value);
    }
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

function apiConfig(req, res) {
  json(res, 200, {
    appliance: 'Local AI',
    subtitle: 'Private Intelligence Hub',
    version: APP_VERSION,
    model: MODEL,
    localUiPort: LOCAL_UI_PORT || PORT,
    // An install that has used the Build tools keeps them in the menu by default; a new one starts without them.
    developerHistory: changeStore().length > 0 || engineeringRunStore().length > 0 || claudeFindings().length > 0,
    chatTimeoutMs: CHAT_MODEL_TIMEOUT_MS,
    engineeringTimeoutMs: ENGINEERING_MODEL_TIMEOUT_MS,
    capabilityCacheMs: CAPABILITY_CACHE_MS,
    links: {
      automationBuilder: '/go/n8n-assistant',
      workflows: '/go/n8n',
      imageAdvanced: '/go/comfy'
    }
  });
}

function redirectFor(req, res, pathname) {
  const host = (req.headers.host || '').split(':')[0] || '127.0.0.1';
  let target;
  if (pathname === '/go/n8n') target = `http://${host}:5678/`;
  else if (pathname === '/go/n8n-assistant') target = `http://${host}:5678/settings/assistant`;
  else if (pathname === '/go/comfy') target = `http://${host}:8188/mobile/`;
  else return false;
  res.writeHead(302, { Location: target });
  res.end();
  return true;
}

// index.html carries the build it came from, so a copy the service worker saved knows its release and a page from an
// older build can see that /healthz now reports another one (app/public/offline-copy.js).
function withBuildMeta(html) {
  const attr = v => String(v ?? '').replace(/[&"<>]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]));
  const meta = `<meta name="localai-version" content="${attr(APP_VERSION)}"><meta name="localai-release" content="${attr(release?.commit || '')}">`;
  return Buffer.from(String(html).replace('<head>', `<head>\n${meta}`));
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, normalized);
  if (!file.startsWith(PUBLIC_DIR)) return text(res, 403, 'Forbidden');

  fs.readFile(file, (err, data) => {
    if (err) {
      if (pathname !== '/' && !pathname.includes('.')) {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
          if (e2) return text(res, 404, 'Not found');
          text(res, 200, withBuildMeta(d2), 'text/html; charset=utf-8');
        });
        return;
      }
      return text(res, 404, 'Not found');
    }
    const ext = path.extname(file).toLowerCase();
    if (file === path.join(PUBLIC_DIR, 'index.html')) data = withBuildMeta(data);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.woff2': 'font/woff2'
    };
    // App code must update the moment a release is deployed: browsers revalidate with the ETag each load
    // and get a 304 when nothing changed. Images can be reused for a day.
    const etag = `"${crypto.createHash('sha1').update(data).digest('base64url').slice(0, 22)}"`;
    const headers = { 'Cache-Control': ['.png', '.ico', '.svg', '.woff2'].includes(ext) ? 'public, max-age=86400' : 'no-cache', ETag: etag };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    text(res, 200, data, types[ext] || 'application/octet-stream', headers);
  });
}


// ===== CUMULATIVE PRODUCT PLATFORM (v1.3+) ===================================
// parseInt so suffixed versions such as the staged smoke server's '1.18-stage' keep their level.
// Features are gated by the 1.x minor version. A 2.x (or later) release includes every 1.x feature.
function featureLevelFor(version) { const [major, minor] = String(version || '1.2').split('.'); return Number(major) >= 2 ? 99 : (parseInt(minor, 10) || 2); }
const FEATURE_LEVEL = featureLevelFor(APP_VERSION);
const PROJECTS_STORE = 'projects';
const CONVERSATIONS_STORE = 'conversations';
const KNOWLEDGE_STORE = 'knowledge';
const AUTOMATIONS_STORE = 'automations';
const RUNS_STORE = 'agentRuns';
const AUTOMATION_RUNS_STORE = 'automationRuns';
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/workspace';

function featureAtLeast(level) { return FEATURE_LEVEL >= level; }
function objectStore(file) { const v = readState(file, []); return Array.isArray(v) ? v : []; }
function saveStore(collection, items, _legacyMax, previous = items) { const saved = storage.save(collection, items, previous); if (RETENTION[collection]) storage.prune(collection, RETENTION[collection]); return saved; }
function makeId(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 9)}`; }
function createChatExecution(body,streaming){
  const messages=sanitizeMessages(body?.messages);const prompt=[...messages].reverse().find(m=>m.role==='user')?.content||'Chat';
  const model=typeof body?.model==='string'&&body.model.trim()?body.model.trim():MODEL;
  const retryBody={messages,model,webSearch:body?.webSearch===true,threadId:cleanRunId(body?.threadId)||undefined,brief:body?.brief===true||undefined};
  return runLedger.create({type:body?.webSearch===true?'research':'chat',title:titleFromText(prompt,body?.webSearch===true?'Research':'Chat'),input:{prompt:prompt.slice(0,4000),model,webSearch:body?.webSearch===true,messageCount:messages.length},cancellable:streaming===true,threadId:body?.threadId,retryRequest:{path:'/api/chat',body:retryBody},meta:{streaming:streaming===true,...(body?.voice===true||body?.voiceRun===true?{voice:true}:{})}});
}
function normalizedExecutionStatus(value){
  const s=String(value||'').toLowerCase();
  if(['complete','completed','applied','success','succeeded'].includes(s))return 'completed';
  if(['error','failed','needs_attention','validation_failed','patch_failed','deploy_failed','rejected'].includes(s))return 'failed';
  if(['cancelled','canceled'].includes(s))return 'cancelled';
  if(s==='awaiting_approval')return 'awaiting_approval';
  if(['running','approved','apply_requested','staged'].includes(s))return 'running';
  return 'queued';
}
function executionProgress(status,steps=[]){
  if(status==='completed')return 100;if(status==='failed'||status==='cancelled')return 0;if(status==='awaiting_approval')return 65;
  const list=Array.isArray(steps)?steps:[];if(list.length){const done=list.filter(x=>['complete','completed','success'].includes(String(x?.state||x?.status||'').toLowerCase())).length;return Math.max(5,Math.min(95,Math.round(done/list.length*100)))}return status==='running'?30:0;
}
function legacyEvents(item){
  const steps=Array.isArray(item?.steps)?item.steps:Array.isArray(item?.plan)?item.plan:[];
  if(steps.length)return steps.map(step=>({at:step.at||item.updatedAt||item.createdAt||item.startedAt||nowIso(),status:normalizedExecutionStatus(step.state||step.status),detail:String(step.detail||step.name||step.kind||step.state||'Step').slice(0,1200)}));
  const events=[];const start=item.startedAt||item.createdAt;if(start)events.push({at:start,status:'running',detail:'Run started'});const terminal=normalizedExecutionStatus(item.status);if(['completed','failed','cancelled'].includes(terminal))events.push({at:item.finishedAt||item.updatedAt||start,status:terminal,detail:terminal==='completed'?'Run completed':terminal==='failed'?'Run failed':'Run cancelled'});return events;
}
function legacyUnifiedRuns() {
  const items = [];
  for (const run of agentRunStore().slice(0, 200)) {
    const status = normalizedExecutionStatus(run.status);
    items.push({
      id: 'legacy-agent:' + run.id,
      type: 'agent',
      title: titleFromText(run.goal, 'Agent run'),
      status,
      progress: executionProgress(status, run.plan),
      createdAt: run.createdAt || null,
      startedAt: run.createdAt || null,
      updatedAt: run.updatedAt || run.createdAt || null,
      finishedAt: ['completed','failed','cancelled'].includes(status) ? (run.updatedAt || null) : null,
      summary: String(run.answer || run.error || '').slice(0, 1200),
      input: { goal: String(run.goal || '').slice(0, 4000), projectId: run.projectId || '' },
      output: run.answer || null,
      error: run.error || null,
      artifactIds: [],
      source: { kind: 'agent', id: run.id },
      meta: { sources: Array.isArray(run.sources) ? run.sources.length : 0 },
      cancellable: false,
      retryable: ['completed','failed'].includes(status),
      attempt: Number.isSafeInteger(Number(run.attempt)) && Number(run.attempt) > 0 ? Number(run.attempt) : 1,
      retryOf: run.retryOf || null,
      events: legacyEvents(run)
    });
  }
  for (const run of automationRunStore().slice(0, 200)) {
    const status = normalizedExecutionStatus(run.status);
    items.push({
      id: 'legacy-automation:' + run.id,
      type: 'automation',
      title: titleFromText(run.name, 'Automation run'),
      status,
      progress: executionProgress(status),
      createdAt: run.startedAt || null,
      startedAt: run.startedAt || null,
      updatedAt: run.finishedAt || run.startedAt || null,
      finishedAt: ['completed','failed','cancelled'].includes(status) ? (run.finishedAt || null) : null,
      summary: String(run.output || run.error || '').slice(0, 1200),
      input: { automationId: run.automationId || '' },
      output: run.output || null,
      error: run.error || null,
      artifactIds: [],
      source: { kind: 'automation', id: run.id },
      meta: { automationId: run.automationId || '' },
      cancellable: false,
      retryable: ['completed','failed'].includes(status),
      attempt: Number.isSafeInteger(Number(run.attempt)) && Number(run.attempt) > 0 ? Number(run.attempt) : 1,
      retryOf: run.retryOf || null,
      events: legacyEvents(run)
    });
  }
  for (const run of effectiveEngineeringRuns().slice(0, 200)) {
    const status = normalizedExecutionStatus(run.status);
    items.push({
      id: 'legacy-engineering:' + run.id,
      type: 'engineering',
      title: titleFromText(run.request, 'Engineering run'),
      status,
      progress: executionProgress(status, run.steps),
      createdAt: run.createdAt || null,
      startedAt: run.createdAt || null,
      updatedAt: run.updatedAt || run.createdAt || null,
      finishedAt: ['completed','failed','cancelled'].includes(status) ? (run.updatedAt || null) : null,
      summary: String(run.error || run.changeStatus || '').slice(0, 1200),
      input: { request: String(run.request || '').slice(0, 4000), target: run.target || '', root: run.root || '' },
      output: run.finalChangeId ? { changeId: run.finalChangeId, changeStatus: run.changeStatus || null } : null,
      error: run.error || null,
      artifactIds: [],
      source: { kind: 'engineering', id: run.id },
      meta: { attempt: run.attempt || 0, maxAttempts: run.maxAttempts || 0, changeId: run.finalChangeId || null },
      cancellable: false,
      retryable: false,
      attempt: run.attempt || 1,
      retryOf: run.retryOf || null,
      events: legacyEvents(run)
    });
  }
  return items;
}
function unifiedRunItems(limit=120,filter=null){
  const paged=!!filter?.threads; // a threads timeline pages through everything, so it reads the whole ledger, not its newest 500
  const native=runLedger.list({limit:500,all:paged,projectId:filter?.projectId,threadId:filter?.threadId});const legacy=legacyUnifiedRuns();
  let all=[...native,...legacy];
  if(filter?.projectId)all=all.filter(x=>x.projectId===filter.projectId);
  if(filter?.threadId)all=all.filter(x=>(x.threadId||x.id)===filter.threadId);
  const byUpdate=(a,b)=>String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||''))||String(b.id).localeCompare(String(a.id));
  const byCreate=(a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))||String(b.id).localeCompare(String(a.id));
  if(filter?.threads){
    // One row per thread: its latest run by (createdAt, id), with `turns` = runs in the thread. Dedupe first, then page by that same key.
    const by=new Map();
    for(const x of all){const k=x.threadId||x.id,e=by.get(k);if(!e)by.set(k,{run:x,turns:1});else{e.turns++;if(byCreate(x,e.run)<0)e.run=x}}
    all=[...by.values()].map(e=>({...e.run,turns:e.turns}));
    if(filter.kind)all=all.filter(x=>workKind(x)===filter.kind); // Work's chip: the thread's row (its latest run) decides, as on screen
    if(filter.before)all=all.filter(x=>byCreate(x,filter.before)>0);
    return all.sort(byCreate).slice(0,Math.max(1,Math.min(500,Number(limit)||120)));
  }
  return all.sort(byUpdate).slice(0,Math.max(1,Math.min(500,Number(limit)||120)));
}
function retryRequestForRunId(id){
  const native=runLedger.retryRequest(id);if(native)return native;
  if(String(id).startsWith('legacy-agent:')){const sourceId=String(id).slice('legacy-agent:'.length),run=agentRunStore().find(x=>x.id===sourceId);if(run&&['complete','error','completed','failed'].includes(String(run.status)))return {path:'/api/agents/run',body:{goal:run.goal,projectId:run.projectId||''}}}
  if(String(id).startsWith('legacy-automation:')){const sourceId=String(id).slice('legacy-automation:'.length),run=automationRunStore().find(x=>x.id===sourceId);if(run&&['complete','error','completed','failed'].includes(String(run.status)))return {path:'/api/automations/run',body:{id:run.automationId}}}
  return null;
}
async function apiRuns(req,res,urlObj){
  try{const id=String(urlObj.searchParams.get('id')||'');const pid=String(urlObj.searchParams.get('projectId')||''),tid=String(urlObj.searchParams.get('threadId')||''),threads=urlObj.searchParams.get('threads')==='1';const kind=String(urlObj.searchParams.get('kind')||'');if(kind&&kind!=='all'&&!WORK_CHIPS.includes(kind))return json(res,400,{error:'Unknown kind'});const beforeId=String(urlObj.searchParams.get('before')||'');let before=null;if(beforeId){if(!cleanRunId(beforeId))return json(res,400,{error:'Invalid run id'});const ref=runLedger.get(beforeId)||legacyUnifiedRuns().find(x=>x.id===beforeId);if(!ref)return json(res,404,{error:'Run not found'});before={createdAt:ref.createdAt,id:ref.id}}let items=unifiedRunItems(urlObj.searchParams.get('limit')||120,{projectId:pid,threadId:tid,threads,before,kind:threads&&kind!=='all'?kind:''});const pending=approvalStore().filter(a=>a.status==='pending'),changes=changeStore();const cardOpts={approvalFor:r=>r.meta?.changeId&&pending.find(a=>a.meta?.changeId===r.meta.changeId)||null,changeFor:cid=>changes.find(c=>c.id===cid)||null};if(id){const item=items.find(x=>x.id===id)||runLedger.get(id)||(id.startsWith('legacy-')?legacyUnifiedRuns().find(x=>x.id===id):null);if(!item)return json(res,404,{error:'Run not found'});return json(res,200,{item:{...item,card:runCard(item,cardOpts)}})}const status=String(urlObj.searchParams.get('status')||''),type=String(urlObj.searchParams.get('type')||'');if(status)items=items.filter(x=>x.status===status);if(type)items=items.filter(x=>x.type===type);items=items.map(x=>({...x,card:runCard(x,cardOpts)}));json(res,200,{items,summary:{total:items.length,active:items.filter(x=>['queued','running','streaming','awaiting_approval'].includes(x.status)).length,failed:items.filter(x=>x.status==='failed').length,awaitingApproval:items.filter(x=>x.status==='awaiting_approval').length}})}catch(e){storageError(res,e,500)}
}
async function apiRunCancel(req,res){
  try{const b=await readBody(req),id=String(b.id||''),run=runLedger.get(id);if(!run)return json(res,404,{error:'Run not found or is managed by a legacy executor'});if(!run.cancellable)return json(res,409,{error:'This run is not cancellable'});if(!['queued','running','streaming','awaiting_approval'].includes(run.status))return json(res,409,{error:`Run cannot be cancelled from status ${run.status}`});runLedger.cancel(id,'Cancelled by user');const controller=activeRunControllers.get(id);if(controller&&!controller.signal.aborted)controller.abort();recordActivity('run','Run cancelled',run.title,{runId:id,type:run.type});json(res,200,{item:runLedger.get(id)})}catch(e){storageError(res,e,400)}
}
async function apiRunUpdate(req, res) {
  try {
    const b = await readBody(req), id = String(b.id || '');
    if (!cleanRunId(id) && !id.startsWith('legacy-')) return json(res, 400, { error: 'Invalid run id' });
    if (id.startsWith('legacy-')) return json(res, 409, { error: 'This run is managed by its own page and cannot be filed yet' });
    const patch = {};
    if (b.pinned !== undefined) { if (typeof b.pinned !== 'boolean') return json(res, 400, { error: 'pinned must be true or false' }); patch.pinned = b.pinned; }
    if (b.projectId !== undefined) {
      if (b.projectId !== null) {
        if (!cleanRunId(b.projectId)) return json(res, 400, { error: 'Invalid project id' });
        if (!projectStore().some(p => p.id === b.projectId)) return json(res, 404, { error: 'Project not found' });
      }
      patch.projectId = b.projectId;
    }
    const item = runLedger.get(id) && runLedger.file(id, patch);
    if (!item) return json(res, 404, { error: 'Run not found' });
    json(res, 200, { item });
  } catch (e) { storageError(res, e, 400); }
}
async function apiRunRetry(req, res) {
  try {
    const b = await readBody(req);
    const id = String(b.id || '');
    const replay = retryRequestForRunId(id);
    if (!replay) return json(res, 409, { error: 'This run does not support retry' });
    const allowed = new Set(['/api/chat','/api/images/generate','/api/agents/run','/api/automations/run']);
    if (!allowed.has(replay.path)) return json(res, 409, { error: 'Retry target is not allowed' });

    const parent = unifiedRunItems(500).find(x => x.id === id) || runLedger.get(id);
    const nextAttempt = Math.max(1, Number(parent?.attempt) || 1) + 1;
    const response = await fetchWithTimeout(`http://127.0.0.1:${PORT}${replay.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(replay.body || {})
    }, 900000);
    const raw = await response.text();
    let result;
    try { result = raw ? JSON.parse(raw) : {}; } catch { result = { text: raw.slice(0, 8000) }; }
    if (!response.ok) throw new Error(result.error || `Retry HTTP ${response.status}`);

    let newRunId = null;
    if (result?.runId) {
      const updated = runLedger.update(result.runId, { attempt: nextAttempt, retryOf: id }, `Retried from ${id}`);
      newRunId = updated?.id || result.runId;
    } else if (replay.path === '/api/agents/run' && result?.run?.id) {
      const runs = agentRunStore();
      const retry = runs.find(x => x.id === result.run.id);
      if (retry) {
        retry.attempt = nextAttempt;
        retry.retryOf = id;
        retry.updatedAt = retry.updatedAt || nowIso();
        saveStore(RUNS_STORE, runs, 300);
        newRunId = 'legacy-agent:' + retry.id;
      }
    } else if (replay.path === '/api/automations/run' && result?.run?.id) {
      const runs = automationRunStore();
      const retry = runs.find(x => x.id === result.run.id);
      if (retry) {
        retry.attempt = nextAttempt;
        retry.retryOf = id;
        saveStore(AUTOMATION_RUNS_STORE, runs, 500);
        newRunId = 'legacy-automation:' + retry.id;
      }
    }

    recordActivity('run', 'Run retried', id, { runId: id, newRunId, path: replay.path, attempt: nextAttempt });
    json(res, 200, { ok: true, replayedFrom: id, runId: newRunId, attempt: nextAttempt, result });
  } catch (e) {
    storageError(res, e, 500);
  }
}
function nowIso() { return new Date().toISOString(); }
function normalizeTitle(v, fallback) { return titleFromText(String(v || ''), fallback); }
function requireFeature(res, level) { if (!featureAtLeast(level)) { json(res, 404, { error: `Requires v1.${level}+` }); return false; } return true; }

function projectStore(){ return objectStore(PROJECTS_STORE); }
function conversationStore(){ return objectStore(CONVERSATIONS_STORE); }
function knowledgeStore(){ return objectStore(KNOWLEDGE_STORE); }
function automationStore(){ return objectStore(AUTOMATIONS_STORE); }
function agentRunStore(){ return objectStore(RUNS_STORE); }
function automationRunStore(){ return objectStore(AUTOMATION_RUNS_STORE); }

function statePage(collection, urlObj, defaultLimit) {
  const rawLimit = urlObj.searchParams.get('limit');
  const rawOffset = urlObj.searchParams.get('offset');
  const limit = rawLimit === null ? defaultLimit : Number(rawLimit);
  const offset = rawOffset === null ? 0 : Number(rawOffset);
  if ((rawLimit !== null && !/^\d+$/.test(rawLimit)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000 ||
      (rawOffset !== null && !/^\d+$/.test(rawOffset)) || !Number.isSafeInteger(offset) || offset < 0) {
    const error = new Error('limit must be 1..1000 and offset must be a nonnegative integer');
    error.statusCode = 400; throw error;
  }
  const projectId = urlObj.searchParams.get('projectId') || undefined;
  return { items: storage.list(collection,{projectId,limit,offset}), total:storage.count(collection,projectId),limit,offset };
}

function publicProject(p){
  const conv = storage.count('conversations',p.id);
  const docs = storage.count('knowledge',p.id);
  const artifacts = storage.count('library',p.id);
  return {...p, counts:{conversations:conv, knowledge:docs, artifacts}};
}

async function apiProjects(req,res,urlObj){
  if(!requireFeature(res,3)) return;
  const page=statePage('projects',urlObj,250);
  json(res,200,{...page,items:page.items.map(publicProject)});
}
async function apiProjectsCreate(req,res){
  if(!requireFeature(res,3)) return;
  try{
    const b=await readBody(req); const name=String(b.name||'').trim();
    if(!name) return json(res,400,{error:'name is required'});
    const items=projectStore(); const item={id:makeId('prj'),name:normalizeTitle(name,'Project'),description:String(b.description||'').slice(0,1200),createdAt:nowIso(),updatedAt:nowIso(),pinned:false};
    items.unshift(item); saveStore(PROJECTS_STORE,items,250); recordActivity('project','Created project',item.name,{projectId:item.id});
    json(res,201,{item:publicProject(item)});
  }catch(e){storageError(res,e,400)}
}
async function apiProjectsUpdate(req,res){
  if(!requireFeature(res,3)) return;
  try{
    const b=await readBody(req); const items=projectStore(); const i=items.findIndex(x=>x.id===b.id); if(i<0)return json(res,404,{error:'Project not found'});
    if(typeof b.name==='string'&&b.name.trim())items[i].name=normalizeTitle(b.name,'Project');
    if(typeof b.description==='string')items[i].description=b.description.slice(0,1200);
    if(typeof b.pinned==='boolean')items[i].pinned=b.pinned; items[i].updatedAt=nowIso(); saveStore(PROJECTS_STORE,items,250); json(res,200,{item:publicProject(items[i])});
  }catch(e){storageError(res,e,400)}
}

async function apiConversations(req,res,urlObj){
  if(!requireFeature(res,3)) return;
  json(res,200,statePage('conversations',urlObj,300));
}
async function apiConversationSave(req,res){
  if(!requireFeature(res,3)) return;
  try{
    const b=await readBody(req,2*1024*1024); const messages=(Array.isArray(b.messages)?b.messages:[]).filter(m=>m&&(m.role==='user'||m.role==='assistant')&&typeof m.content==='string').map(m=>({role:m.role,content:m.content})); if(!messages.length)return json(res,400,{error:'messages[] is required'});
    const items=conversationStore(); let item=items.find(x=>x.id===b.id);
    const firstUser=messages.find(x=>x.role==='user')?.content||'Conversation';
    if(!item){item={id:makeId('chat'),createdAt:nowIso(),pinned:false};items.unshift(item)}
    item.projectId=String(b.projectId||item.projectId||''); item.title=normalizeTitle(b.title||item.title||firstUser,'Conversation'); item.updatedAt=nowIso(); item.messages=messages; item.webSearch=!!b.webSearch;
    saveStore(CONVERSATIONS_STORE,items,500); recordActivity('conversation','Saved conversation',item.title,{conversationId:item.id,projectId:item.projectId});
    json(res,200,{item});
  }catch(e){storageError(res,e,400)}
}
async function apiConversationDelete(req,res){
  if(!requireFeature(res,3)) return;
  try{const b=await readBody(req);const items=conversationStore();const next=items.filter(x=>x.id!==b.id);if(next.length===items.length)return json(res,404,{error:'Conversation not found'});saveStore(CONVERSATIONS_STORE,next,500,items);json(res,200,{ok:true})}catch(e){storageError(res,e,400)}
}

function chunkText(textValue, chunkSize=1800){
  const t=String(textValue||'').replace(/\r/g,'').trim(); const out=[]; if(!t)return out;
  for(let i=0;i<t.length;i+=chunkSize){out.push(t.slice(i,i+chunkSize))} return out;
}
function tokens(s){return String(s||'').toLowerCase().match(/[a-z0-9_\-.]{2,}/g)||[]}
function knowledgeScore(query,textValue){
  const q=[...new Set(tokens(query))]; if(!q.length)return 0; const t=String(textValue||'').toLowerCase(); let score=0; for(const w of q){if(t.includes(w))score+=1+(t.split(w).length-2)*0.08} return score/q.length;
}
async function apiKnowledge(req,res,urlObj){
  if(!requireFeature(res,3)) return; const page=statePage('knowledge',urlObj,500); json(res,200,{...page,items:page.items.map(x=>({...x,chunks:undefined,content:undefined}))});
}
async function apiKnowledgeImport(req,res){
  if(!requireFeature(res,3)) return;
  try{
    const b=await readBody(req,6*1024*1024); const content=String(b.content||''); const name=String(b.name||'').trim(); if(!name||!content.trim())return json(res,400,{error:'name and content are required'});
    const items=knowledgeStore(); const chunks=chunkText(content); const item={id:makeId('doc'),projectId:String(b.projectId||''),name:normalizeTitle(name,'Document'),mimeType:String(b.mimeType||'text/plain'),size:Buffer.byteLength(content,'utf8'),createdAt:nowIso(),updatedAt:nowIso(),chunks,preview:content.slice(0,800)};
    items.unshift(item);saveStore(KNOWLEDGE_STORE,items,500);recordActivity('knowledge','Indexed knowledge source',item.name,{projectId:item.projectId,chunks:chunks.length});json(res,201,{item:{...item,chunks:undefined}});
  }catch(e){storageError(res,e,400)}
}
async function apiKnowledgeDelete(req,res){if(!requireFeature(res,3))return;try{const b=await readBody(req);const items=knowledgeStore();const next=items.filter(x=>x.id!==b.id);if(next.length===items.length)return json(res,404,{error:'Knowledge source not found'});saveStore(KNOWLEDGE_STORE,next,500,items);json(res,200,{ok:true})}catch(e){storageError(res,e,400)}}
async function apiKnowledgeSearch(req,res){
  if(!requireFeature(res,3)) return; try{const b=await readBody(req);const query=String(b.query||'').trim();if(!query)return json(res,400,{error:'query is required'});let docs=knowledgeStore();if(b.projectId)docs=docs.filter(x=>x.projectId===b.projectId);const hits=[];for(const d of docs){(d.chunks||[]).forEach((c,i)=>{const score=knowledgeScore(query,c);if(score>0)hits.push({documentId:d.id,name:d.name,projectId:d.projectId,chunk:i,score:Number(score.toFixed(3)),text:c})})}hits.sort((a,b)=>b.score-a.score);json(res,200,{query,hits:hits.slice(0,10)})}catch(e){storageError(res,e,400)}
}

async function runLocalModel(prompt, system='You are a concise local AI assistant.', timeoutMs=180000, model=MODEL){
  const selectedModel=String(model||MODEL).trim()||MODEL;
  const r=await fetchWithTimeout(`${OLLAMA_URL}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:selectedModel,messages:fitMessages([{role:'system',content:system},{role:'user',content:String(prompt).slice(0,50000)}]),stream:false,keep_alive:TEXT_KEEP_ALIVE,options:{num_ctx:TEXT_NUM_CTX}})},timeoutMs);
  const raw=await r.text(); if(!r.ok)throw new Error(`Intelligence service HTTP ${r.status}: ${raw.slice(0,400)}`); const j=JSON.parse(raw); return j?.message?.content||'';
}
async function runEngineeringPlannerModel(prompt, system, timeoutMs=ENGINEERING_MODEL_TIMEOUT_MS){
  const started=Date.now();
  let watchdogAborted=false;
  const payload=Buffer.from(JSON.stringify({
    model:MODEL,
    // The planner is rare and code-heavy, so it gets the large context; the reload cost when switching is accepted.
    messages:fitMessages([
      {role:'system',content:system},
      {role:'user',content:String(prompt).slice(0,50000)}
    ],{numCtx:TEXT_NUM_CTX_LARGE,reserve:LARGE_ANSWER_RESERVE}),
    stream:true,
    keep_alive:TEXT_KEEP_ALIVE,
    options:{num_ctx:TEXT_NUM_CTX_LARGE}
  }),'utf8');
  const endpoint=new URL(`${OLLAMA_URL}/api/chat`);
  const transport=endpoint.protocol==='https:'
    ? require('node:https')
    : require('node:http');
  return await new Promise((resolve,reject)=>{
    let settled=false;
    let timer=null;
    let req=null;
    const finish=(fn,value)=>{
      if(settled)return;
      settled=true;
      if(timer)clearTimeout(timer);
      fn(value);
    };
    const fail=(e)=>{
      const elapsedMs=Date.now()-started;
      const code=e?.cause?.code||e?.code||'';
      const aborted=watchdogAborted||e?.name==='AbortError';
      console.warn(`Engineering planner transport: ${e?.name||'Error'}: ${e?.message||e}${code?`; code=${code}`:''}; elapsedMs=${elapsedMs}; watchdogAborted=${aborted}`);
      finish(reject,new Error(plainText.plannerError({aborted,timeoutMs,code,message:e?.message||e})));
    };
    try{
      req=transport.request({
        protocol:endpoint.protocol,
        hostname:endpoint.hostname,
        port:endpoint.port||undefined,
        path:`${endpoint.pathname}${endpoint.search}`,
        method:'POST',
        headers:{
          'Content-Type':'application/json',
          'Content-Length':payload.length
        }
      },res=>{
        if(res.statusCode<200||res.statusCode>=300){
          let errorBody='';
          res.setEncoding('utf8');
          res.on('data',chunk=>{
            errorBody+=chunk;
            if(errorBody.length>4000)errorBody=errorBody.slice(0,4000);
          });
          res.on('end',()=>{
            fail(new Error(
              `Intelligence service HTTP ${res.statusCode}: ${errorBody.slice(0,400)}`
            ));
          });
          res.on('error',fail);
          return;
        }
        res.setEncoding('utf8');
        let buffer='';
        let content='';
        let done=false;
        const acceptLine=(line)=>{
          if(!line.trim())return;
          let item;
          try{
            item=JSON.parse(line);
          }catch(e){
            throw new Error(`Malformed Ollama planner NDJSON: ${e.message}`);
          }
          if(item.error){
            throw new Error(`Ollama planner error: ${item.error}`);
          }
          if(item?.message?.content){
            content+=item.message.content;
          }
          if(item.done===true){
            done=true;
          }
        };
        res.on('data',chunk=>{
          if(settled)return;
          try{
            buffer+=chunk;
            let nl;
            while((nl=buffer.indexOf('\n'))>=0){
              const line=buffer.slice(0,nl);
              buffer=buffer.slice(nl+1);
              acceptLine(line);
            }
          }catch(e){
            try{req.destroy()}catch{}
            fail(e);
          }
        });
        res.on('end',()=>{
          if(settled)return;
          try{
            if(buffer.trim()){
              acceptLine(buffer);
            }
            if(!done){
              throw new Error('Ollama planner stream ended before done:true');
            }
            finish(resolve,content);
          }catch(e){
            fail(e);
          }
        });
        res.on('aborted',()=>{
          fail(new Error('Ollama planner response aborted'));
        });
        res.on('error',fail);
      });
      req.on('error',fail);
      timer=setTimeout(()=>{
        if(settled)return;
        watchdogAborted=true;
        req.destroy(
          new Error(`Engineering planner watchdog exceeded ${timeoutMs} ms`)
        );
      },timeoutMs);
      req.write(payload);
      req.end();
    }catch(e){
      fail(e);
    }
  });
}
function buildAgentPlan(goal){
  const t=String(goal||'').toLowerCase(); const steps=[{name:'Understand goal',kind:'plan'}];
  if(/latest|research|web|compare|news|look up/.test(t))steps.push({name:'Research sources',kind:'research'});
  if(/file|code|repo|project|fix|implement|debug/.test(t))steps.push({name:'Inspect workspace context',kind:'workspace'});
  steps.push({name:'Reason and synthesize',kind:'model'}); steps.push({name:'Produce result',kind:'compose'}); return steps;
}
async function executeAgentGoal(goal,projectId=''){
  const plan=buildAgentPlan(goal); const sources=[]; let context='';
  for(const s of plan){s.state='pending'}; plan[0].state='complete';
  const researchStep=plan.find(x=>x.kind==='research'); if(researchStep){researchStep.state='running';try{const rs=await searxSearch(goal);sources.push(...rs);context+='\n\nWEB SOURCES:\n'+rs.map((x,i)=>`[${i+1}] ${x.title}\n${x.content}\n${x.url}`).join('\n\n');researchStep.state='complete'}catch(e){researchStep.state='error';researchStep.error=String(e.message||e)}}
  if(projectId){const hits=[];for(const d of knowledgeStore().filter(x=>x.projectId===projectId)){for(const c of d.chunks||[]){const score=knowledgeScore(goal,c);if(score>0)hits.push({score,name:d.name,text:c})}}hits.sort((a,b)=>b.score-a.score);if(hits.length)context+='\n\nPROJECT KNOWLEDGE:\n'+hits.slice(0,5).map((x,i)=>`[K${i+1}] ${x.name}\n${x.text}`).join('\n\n')}
  const modelStep=plan.find(x=>x.kind==='model'); if(modelStep)modelStep.state='running'; const answer=await runLocalModel(`${goal}${context}`,'You are an execution agent inside a private local appliance. Use available context, state uncertainties, and return a concrete result.'); if(modelStep)modelStep.state='complete'; const compose=plan.find(x=>x.kind==='compose'); if(compose)compose.state='complete'; return {plan,answer,sources};
}
let specialistOrchestrator=null;
function getSpecialistOrchestrator(){
 if(specialistOrchestrator)return specialistOrchestrator;
 specialistOrchestrator=require('./agent-orchestrator')({
  dataDir:DATA_DIR,storage,ollamaUrl:OLLAMA_URL,defaultModel:MODEL,fetchWithTimeout,runLocalModel,
  knowledgeStore,knowledgeScore,searxSearch,recordActivity,
  projectRoot:__dirname,
  // Missions are rare and code-heavy like the planner, so agent turns share its large context and keep-alive.
  runAgentTurn:require('./agent-runtime').createOllamaTurn({ollamaUrl:OLLAMA_URL,numCtx:TEXT_NUM_CTX_LARGE,keepAlive:TEXT_KEEP_ALIVE}),
  agentLimits:{maxContextChars:Math.floor((TEXT_NUM_CTX_LARGE-LARGE_ANSWER_RESERVE)*3.5)}
 });
 return specialistOrchestrator;
}
async function apiAgentCatalog(req,res){if(!requireFeature(res,4))return;json(res,200,{items:getSpecialistOrchestrator().catalog})}
async function apiAgentModels(req,res){if(!requireFeature(res,4))return;try{json(res,200,{items:await getSpecialistOrchestrator().models()})}catch(e){json(res,503,{error:String(e.message||e)})}}
async function apiSpecialistRun(req,res){if(!requireFeature(res,4))return;try{const b=await readBody(req),goal=String(b.goal||'').trim();if(!goal)return json(res,400,{error:'goal is required'});json(res,200,{run:await getSpecialistOrchestrator().specialist(String(b.agentId||''),goal,String(b.projectId||''))})}catch(e){storageError(res,e,400)}}
async function apiAgentDispatch(req,res){if(!requireFeature(res,4))return;try{const b=await readBody(req),goal=String(b.goal||'').trim();if(!goal)return json(res,400,{error:'goal is required'});json(res,200,{routing:await getSpecialistOrchestrator().dispatch(goal,Array.isArray(b.agentIds)?b.agentIds:undefined)})}catch(e){storageError(res,e,400)}}
async function apiAgentMissions(req,res){if(!requireFeature(res,4))return;json(res,200,{items:getSpecialistOrchestrator().missions(200)})}
async function apiAgentMission(req,res,urlObj){if(!requireFeature(res,4))return;const id=String(urlObj.searchParams.get('id')||''),m=getSpecialistOrchestrator().getMission(id);if(!m)return json(res,404,{error:'Mission not found'});json(res,200,{mission:m})}
// A mission started with async:true is a ledger run from the first moment: 202 now, the run follows the mission's own events.
// Mission statuses: running | complete | needs_attention | error (the last two end the run failed).
function startMissionRun(goal,projectId,ids,allowWeb=false){
  const orch=getSpecialistOrchestrator();
  const run=runLedger.create({type:'agent',title:titleFromText(goal,'Mission'),input:{goal:goal.slice(0,4000),projectId,agentIds:ids||[],webSearch:allowWeb},projectId,meta:{},cancellable:true});
  runLedger.start(run.id,'Mission started');
  const controller=new AbortController();activeRunControllers.set(run.id,controller);
  let missionId='',off=()=>{},ended=false,last='';
  const apply=m=>{
    if(ended||m.id!==missionId)return;
    const ws=m.workers||[],done=ws.filter(w=>w.state==='complete').length,pct=ws.length?Math.max(5,Math.min(95,Math.round(done/ws.length*100))):5;
    if(m.status==='running'){const sig=pct+':'+done;if(sig===last)return;last=sig;runLedger.update(run.id,{status:'running',progress:pct},'Mission progress: '+done+' of '+ws.length+' steps');return}
    ended=true;off();activeRunControllers.delete(run.id);
    if(m.status==='complete')runLedger.complete(run.id,{summary:String(m.answer||'Mission complete').replace(/\s+/g,' ').trim().slice(0,600),output:{missionId:m.id,outcome:m.status},meta:{missionId:m.id}});
    else runLedger.update(run.id,{status:'failed',error:String(m.error||'The mission needs attention.').slice(0,8000),output:{missionId:m.id,outcome:m.status},meta:{missionId:m.id}},'Mission '+m.status);
  };
  orch.mission(goal,projectId,ids,{signal:controller.signal,allowWeb,onCreated:m=>{missionId=m.id;orch.events.on('mission',apply);off=()=>orch.events.off('mission',apply);runLedger.update(run.id,{meta:{missionId:m.id}},'Mission created')}})
    .then(m=>apply(m),e=>{activeRunControllers.delete(run.id);if(ended)return;ended=true;off();runLedger.fail(run.id,e)});
  return run;
}
async function apiAgentMissionStart(req,res){if(!requireFeature(res,4))return;try{const b=await readBody(req),goal=String(b.goal||'').trim();if(!goal)return json(res,400,{error:'goal is required'});const ids=Array.isArray(b.agentIds)&&b.agentIds.length?b.agentIds:undefined;const allowWeb=b.webSearch===true;if(b.async===true){const run=startMissionRun(goal,String(b.projectId||''),ids,allowWeb);return json(res,202,{runId:run.id,threadId:run.threadId})}json(res,200,{mission:await getSpecialistOrchestrator().mission(goal,String(b.projectId||''),ids,{allowWeb})})}catch(e){storageError(res,e,400)}}
const SSE_KEEPALIVE_MS=Math.max(1000,Number(process.env.SSE_KEEPALIVE_MS)||25000);
async function apiAgentMissionEvents(req,res,urlObj){if(!requireFeature(res,4))return;res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});const wanted=String(urlObj.searchParams.get('missionId')||'');const send=m=>{if(!wanted||m.id===wanted)res.write('data: '+JSON.stringify(m)+'\n\n')};const orch=getSpecialistOrchestrator();orch.events.on('mission',send);res.write(': connected\n\n');
  // A comment every 25 s keeps phones and proxies from dropping a quiet stream.
  const keepAlive=setInterval(()=>res.write(': keepalive\n\n'),SSE_KEEPALIVE_MS);req.on('close',()=>{clearInterval(keepAlive);orch.events.off('mission',send)})}
async function apiAgents(req,res){if(!requireFeature(res,4))return;json(res,200,{items:agentRunStore().slice(0,200)})}
async function apiAgentRun(req,res){
  if(!requireFeature(res,4))return; try{const b=await readBody(req);const goal=String(b.goal||'').trim();if(!goal)return json(res,400,{error:'goal is required'});const runs=agentRunStore();const run={id:makeId('agent'),goal,projectId:String(b.projectId||''),status:'running',createdAt:nowIso(),updatedAt:nowIso(),plan:buildAgentPlan(goal)};runs.unshift(run);saveStore(RUNS_STORE,runs,300);recordActivity('agent','Agent started',goal.slice(0,180),{runId:run.id});try{const result=await executeAgentGoal(goal,run.projectId);run.status='complete';run.plan=result.plan;run.answer=result.answer;run.sources=result.sources;run.updatedAt=nowIso()}catch(e){run.status='error';run.error=String(e.message||e);run.updatedAt=nowIso()}saveStore(RUNS_STORE,runs,300);recordActivity('agent',run.status==='complete'?'Agent completed':'Agent failed',goal.slice(0,180),{runId:run.id,status:run.status});json(res,200,{run})}catch(e){storageError(res,e,400)}
}

function nextRunFor(schedule,from=new Date()){
  const d=new Date(from); if(schedule==='hourly'){d.setMinutes(0,0,0);d.setHours(d.getHours()+1);return d.toISOString()} if(schedule==='daily'){d.setSeconds(0,0);d.setDate(d.getDate()+1);return d.toISOString()} return null;
}
async function executeAutomation(a){
  const runs=automationRunStore(); const run={id:makeId('autorun'),automationId:a.id,name:a.name,status:'running',startedAt:nowIso()};runs.unshift(run);saveStore(AUTOMATION_RUNS_STORE,runs,500);
  try{if(a.kind==='health'){const s=await getStatusAndRecordTransition();run.output=`Overall: ${s.overall}. ${s.services.map(x=>`${x.label}: ${x.state}`).join('; ')}`;}else if(a.kind==='research'){const rs=await searxSearch(a.prompt);run.output=await runLocalModel(`${a.prompt}\n\n${rs.map((x,i)=>`[${i+1}] ${x.title}\n${x.content}\n${x.url}`).join('\n\n')}`,'Summarize the research with source numbers.');}else{run.output=await runLocalModel(a.prompt||a.name)}run.status='complete'}catch(e){run.status='error';run.error=String(e.message||e)}run.finishedAt=nowIso();saveStore(AUTOMATION_RUNS_STORE,runs,500);recordActivity('automation',`Automation ${run.status}`,a.name,{automationId:a.id,runId:run.id});return run;
}
async function apiAutomations(req,res){if(!requireFeature(res,4))return;json(res,200,{items:automationStore(),runs:automationRunStore().slice(0,100)})}
async function apiAutomationCreate(req,res){if(!requireFeature(res,4))return;try{const b=await readBody(req);const name=String(b.name||'').trim();if(!name)return json(res,400,{error:'name is required'});const items=automationStore();const schedule=['manual','hourly','daily'].includes(b.schedule)?b.schedule:'manual';const item={id:makeId('auto'),name:normalizeTitle(name,'Automation'),kind:['prompt','research','health'].includes(b.kind)?b.kind:'prompt',prompt:String(b.prompt||'').slice(0,10000),schedule,enabled:b.enabled!==false,createdAt:nowIso(),updatedAt:nowIso(),nextRunAt:schedule==='manual'?null:nextRunFor(schedule)};items.unshift(item);saveStore(AUTOMATIONS_STORE,items,250);json(res,201,{item})}catch(e){storageError(res,e,400)}}
async function apiAutomationUpdate(req,res){if(!requireFeature(res,4))return;try{const b=await readBody(req);const items=automationStore();const i=items.findIndex(x=>x.id===b.id);if(i<0)return json(res,404,{error:'Automation not found'});if(typeof b.enabled==='boolean')items[i].enabled=b.enabled;if(typeof b.name==='string'&&b.name.trim())items[i].name=normalizeTitle(b.name,'Automation');if(['manual','hourly','daily'].includes(b.schedule)){items[i].schedule=b.schedule;items[i].nextRunAt=b.schedule==='manual'?null:nextRunFor(b.schedule)}items[i].updatedAt=nowIso();saveStore(AUTOMATIONS_STORE,items,250);json(res,200,{item:items[i]})}catch(e){storageError(res,e,400)}}
async function apiAutomationRun(req,res){if(!requireFeature(res,4))return;try{const b=await readBody(req);const a=automationStore().find(x=>x.id===b.id);if(!a)return json(res,404,{error:'Automation not found'});json(res,200,{run:await executeAutomation(a)})}catch(e){storageError(res,e,400)}}

function safeWorkspacePath(rel=''){
  const clean=String(rel||'').replace(/\\/g,'/').replace(/^\/+/, ''); const root=path.resolve(WORKSPACE_ROOT); const full=path.resolve(root,clean); if(full!==root&&!full.startsWith(root+path.sep))throw new Error('Path escapes workspace'); return full;
}
function workspaceRel(full){return path.relative(path.resolve(WORKSPACE_ROOT),full).replace(/\\/g,'/')}
function treeDir(full,depth=2){const out=[];if(depth<0||!fs.existsSync(full))return out;for(const e of fs.readdirSync(full,{withFileTypes:true}).slice(0,250)){if(e.name==='.git'||e.name==='node_modules')continue;const p=path.join(full,e.name);const item={name:e.name,path:workspaceRel(p),type:e.isDirectory()?'directory':'file'};if(e.isDirectory()&&depth>0)item.children=treeDir(p,depth-1);else if(e.isFile())try{item.size=fs.statSync(p).size}catch{}out.push(item)}return out}
async function apiWorkbenchTree(req,res,urlObj){if(!requireFeature(res,5))return;try{const rel=urlObj.searchParams.get('path')||'';json(res,200,{root:WORKSPACE_ROOT,path:rel,items:treeDir(safeWorkspacePath(rel),2)})}catch(e){storageError(res,e,400)}}
async function apiWorkbenchRead(req,res,urlObj){if(!requireFeature(res,5))return;try{const rel=urlObj.searchParams.get('path')||'';const full=safeWorkspacePath(rel);const st=fs.statSync(full);if(!st.isFile())return json(res,400,{error:'Not a file'});if(st.size>2*1024*1024)return json(res,413,{error:'File too large for editor'});json(res,200,{path:rel,content:fs.readFileSync(full,'utf8'),size:st.size,modifiedAt:st.mtime.toISOString()})}catch(e){storageError(res,e,400)}}
function simpleDiff(before,after){const a=String(before).split('\n'),b=String(after).split('\n');let start=0;while(start<a.length&&start<b.length&&a[start]===b[start])start++;let ae=a.length-1,be=b.length-1;while(ae>=start&&be>=start&&a[ae]===b[be]){ae--;be--}const lines=[`@@ -${start+1},${Math.max(0,ae-start+1)} +${start+1},${Math.max(0,be-start+1)} @@`];for(let i=start;i<=ae;i++)lines.push('-'+a[i]);for(let i=start;i<=be;i++)lines.push('+'+b[i]);return lines.join('\n')}
async function apiWorkbenchDiff(req,res){if(!requireFeature(res,5))return;try{const b=await readBody(req,3*1024*1024);const full=safeWorkspacePath(b.path);const before=fs.existsSync(full)?fs.readFileSync(full,'utf8'):'';const after=String(b.content||'');json(res,200,{path:b.path,diff:simpleDiff(before,after),changed:before!==after})}catch(e){storageError(res,e,400)}}
async function apiWorkbenchWrite(req,res){if(!requireFeature(res,5))return;try{const b=await readBody(req,3*1024*1024);if(b.approved!==true)return json(res,409,{error:'Explicit approval is required',approvalRequired:true});const full=safeWorkspacePath(b.path);fs.mkdirSync(path.dirname(full),{recursive:true});let backup=null;if(fs.existsSync(full)){backup=`${full}.localai-${Date.now()}.bak`;fs.copyFileSync(full,backup)}fs.writeFileSync(full,String(b.content||''),'utf8');recordActivity('workbench','Workspace file written',String(b.path),{backup:backup?workspaceRel(backup):null});json(res,200,{ok:true,path:b.path,backup:backup?workspaceRel(backup):null,size:Buffer.byteLength(String(b.content||''),'utf8')})}catch(e){storageError(res,e,400)}}
async function apiWorkbenchSearch(req,res){if(!requireFeature(res,5))return;try{const b=await readBody(req);const query=String(b.query||'').toLowerCase().trim();if(!query)return json(res,400,{error:'query is required'});const root=safeWorkspacePath(b.path||'');const results=[];let scannedBytes=0;const limited=()=>results.length>=100||scannedBytes>=64*1024*1024;function walk(dir,depth){if(depth>5||limited())return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(limited())return;if(['.git','node_modules','.venv','bin','obj'].includes(e.name))continue;const p=path.join(dir,e.name);if(e.isDirectory())walk(p,depth+1);else if(e.isFile()){if(e.name.toLowerCase().includes(query))results.push({path:workspaceRel(p),match:'filename'});else{try{const st=fs.statSync(p);if(st.size<512000){scannedBytes+=st.size;const txt=fs.readFileSync(p,'utf8');const idx=txt.toLowerCase().indexOf(query);if(idx>=0)results.push({path:workspaceRel(p),match:'content',snippet:txt.slice(Math.max(0,idx-100),idx+query.length+160).replace(/\s+/g,' ')})}}catch{}}}if(results.length>=100)return}}walk(root,0);json(res,200,{results,truncated:limited()})}catch(e){storageError(res,e,400)}}

function validateExternalUrl(raw){const u=new URL(String(raw||''));if(!['http:','https:'].includes(u.protocol))throw new Error('Only http/https URLs are allowed');return u}
function stripHtml(html){return String(html||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim()}
async function apiBrowserFetch(req,res){if(!requireFeature(res,6))return;try{const b=await readBody(req);const u=validateExternalUrl(b.url);const r=await fetchWithTimeout(u.toString(),{headers:{'User-Agent':'LocalAI-Appliance/1.6'}},15000);const raw=await r.text();const ct=r.headers.get('content-type')||'';const title=/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.replace(/\s+/g,' ').trim()||u.hostname;const content=ct.includes('html')?stripHtml(raw):raw;recordActivity('browser','Fetched web page',u.toString(),{status:r.status});json(res,200,{url:u.toString(),status:r.status,title,contentType:ct,text:content.slice(0,40000),truncated:content.length>40000})}catch(e){storageError(res,e,400)}}
async function apiHttpCheck(req,res){if(!requireFeature(res,6))return;try{const b=await readBody(req);const u=validateExternalUrl(b.url);const started=Date.now();const r=await fetchWithTimeout(u.toString(),{method:String(b.method||'GET').toUpperCase()==='HEAD'?'HEAD':'GET'},10000);json(res,200,{url:u.toString(),status:r.status,ok:r.ok,latencyMs:Date.now()-started,contentType:r.headers.get('content-type')||''})}catch(e){storageError(res,e,400)}}
async function apiComputerBatch(req,res){if(!requireFeature(res,6))return;try{const b=await readBody(req,5*1024*1024);if(b.approved!==true)return json(res,409,{error:'Explicit approval is required',approvalRequired:true});const ops=Array.isArray(b.operations)?b.operations.slice(0,30):[];const results=[];for(const op of ops){try{if(op.type==='mkdir'){fs.mkdirSync(safeWorkspacePath(op.path),{recursive:true});results.push({type:op.type,path:op.path,ok:true})}else if(op.type==='write'){const full=safeWorkspacePath(op.path);fs.mkdirSync(path.dirname(full),{recursive:true});let backup=null;if(fs.existsSync(full)){backup=`${full}.localai-${Date.now()}.bak`;fs.copyFileSync(full,backup)}fs.writeFileSync(full,String(op.content||''),'utf8');results.push({type:op.type,path:op.path,ok:true,backup:backup?workspaceRel(backup):null})}else if(op.type==='copy'){const src=safeWorkspacePath(op.from),dst=safeWorkspacePath(op.to);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst);results.push({type:op.type,from:op.from,to:op.to,ok:true})}else{results.push({type:op.type,ok:false,error:'Unsupported operation'})}}catch(e){results.push({type:op.type,path:op.path,ok:false,error:String(e.message||e)})}}recordActivity('computer','Approved computer action batch',`${results.filter(x=>x.ok).length}/${results.length} operations completed`,{});json(res,200,{results})}catch(e){storageError(res,e,400)}}

// Runs can outlast the 30s tick, so ticks never overlap and each automation's next run is claimed before it starts.
let automationTickRunning=false;
function automationDue(a){return a.enabled&&a.nextRunAt&&new Date(a.nextRunAt)<=new Date()}
async function automationSchedulerTick(){if(!featureAtLeast(4)||automationTickRunning)return;automationTickRunning=true;try{for(const {id} of automationStore().filter(automationDue)){const items=automationStore();const a=items.find(x=>x.id===id);if(!a||!automationDue(a))continue;a.nextRunAt=nextRunFor(a.schedule);a.updatedAt=nowIso();saveStore(AUTOMATIONS_STORE,items,250);await executeAutomation(a)}}finally{automationTickRunning=false}}
setInterval(()=>automationSchedulerTick().catch(e=>console.error(`${nowIso()} Automation scheduler failed:`,e)),30000).unref?.();
// ===== END CUMULATIVE PRODUCT PLATFORM =======================================


// ===== PRODUCT EVOLUTION PLATFORM (v1.7+) ==================================
const NOTIFICATIONS_STORE = 'notifications';
const MEMORY_STORE = 'memory';
const APPROVALS_STORE = 'approvals';
const MONITORS_STORE = 'monitors';
const { spawn } = require('child_process');

function notificationStore(){ return objectStore(NOTIFICATIONS_STORE); }
function memoryStore(){ return objectStore(MEMORY_STORE); }
function approvalStore(){ return objectStore(APPROVALS_STORE); }
function monitorStore(){ return objectStore(MONITORS_STORE); }

function addNotification(kind,title,detail='',meta={},level='attention'){
  const item={id:makeId('note'),kind,level,title:normalizeTitle(title,'Notification'),detail:String(detail||'').slice(0,2000),createdAt:nowIso(),read:false,resolved:false,meta};
  prependRecord(NOTIFICATIONS_STORE,item);
  const e=notifyLib.noticeEvent(kind,item.title,item.detail,level,meta);if(e)notifier.notify(meta.approvalId?{...e,tag:`approval:${meta.approvalId}`}:e);
  return item;
}
// Info notices (a release went live, a backup finished, a monitor recovered) stay in the Inbox but don't count
// toward its badge; only things that need the owner do. Older deploy notices predate `level`, hence the meta check.
const isInfoNotice=x=>x.level==='info'||(x.kind==='deploy'&&x.meta?.outcome==='deployed');
async function apiNotifications(req,res){
  if(!requireFeature(res,7))return;
  // Host notices stored before hostDetail() existed still carry PowerShell's filler lines; clean them on the way out.
  const items=notificationStore().map(x=>isInfoNotice(x)&&!x.level?{...x,level:'info'}:x).map(x=>x.meta?.source==='host'&&/RemoteException/.test(x.detail||'')?{...x,detail:hostDetail(x.detail)}:x);
  json(res,200,{items,unread:items.filter(x=>!x.read&&!x.resolved&&!isInfoNotice(x)).length});
}
async function apiNotificationUpdate(req,res){
  if(!requireFeature(res,7))return;
  try{const b=await readBody(req);const items=notificationStore();const i=items.findIndex(x=>x.id===b.id);if(i<0)return json(res,404,{error:'Notification not found'});
    if(typeof b.read==='boolean')items[i].read=b.read;if(typeof b.resolved==='boolean')items[i].resolved=b.resolved;
    saveStore(NOTIFICATIONS_STORE,items,500);json(res,200,{item:items[i]});
  }catch(e){storageError(res,e,400)}
}
// Windows PowerShell 5.1 turns a blank stderr line from a native command into the text
// "System.Management.Automation.RemoteException"; it says nothing, so it never reaches the Inbox.
function hostDetail(detail){
  return String(detail||'').split('\n').map(l=>l.replace(/(?:\s*System\.Management\.Automation\.RemoteException)+\s*$/g,'').trimEnd()).filter(l=>l.trim()).join('\n').slice(0,2000);
}
// A failed update is over once a later one goes live: resolve it, so it stops counting on the Inbox and the bell.
function resolveDeployFailures(by){
  let n=0;
  storage.transaction(()=>{const items=notificationStore();for(const x of items){if(x.kind==='deploy'&&!x.resolved&&x.meta?.outcome==='failed'){x.resolved=true;x.read=true;x.meta={...x.meta,resolvedBy:`Resolved by ${by}`};n++}}if(n)saveStore(NOTIFICATIONS_STORE,items,500)});
  return n;
}
// Host-side jobs (auto-deploy, backups, monitors) report to the Inbox. Same LAN trust model as the rest of the API.
const HOST_NOTIFICATION_KINDS=new Set(['deploy','backup','monitor']);
async function apiNotificationSystem(req,res){
  try{const b=await readBody(req,64*1024);const kind=String(b.kind||'');if(!HOST_NOTIFICATION_KINDS.has(kind))return json(res,400,{error:`kind must be one of ${[...HOST_NOTIFICATION_KINDS].join(', ')}`});
    const title=String(b.title||'').trim().slice(0,200);if(!title)return json(res,400,{error:'title is required'});
    const meta=b.meta&&typeof b.meta==='object'&&!Array.isArray(b.meta)?Object.fromEntries(Object.entries(b.meta).slice(0,12).map(([k,v])=>[String(k).slice(0,40),String(v).slice(0,300)])):{};
    // Only a known success is information; anything else (failures, alerts without an outcome) needs the owner.
    const level=/^(deployed|ok|success|succeeded|recovered|done)$/i.test(meta.outcome||'')?'info':'attention';
    const item=addNotification(kind,title,hostDetail(b.detail),{source:'host',...meta},level);
    if(kind==='deploy'&&meta.outcome==='deployed')resolveDeployFailures(title.replace(/^Local AI updated to\s*/i,'')||'a later update');
    json(res,201,{item})}catch(e){storageError(res,e,400)}
}
async function apiNotificationSeed(req,res){
  if(!requireFeature(res,7))return;
  const item=addNotification('system','Notification center ready','Local AI v1.7 notification state is active.');
  json(res,201,{item});
}

async function apiMemory(req,res,urlObj){
  if(!requireFeature(res,8))return;
  const projectId=urlObj.searchParams.get('projectId')||'';
  let items=memoryStore(); if(projectId)items=items.filter(x=>x.projectId===projectId);
  json(res,200,{items});
}
async function apiMemoryAdd(req,res){
  if(!requireFeature(res,8))return;
  try{const b=await readBody(req);const textValue=String(b.text||'').trim();if(!textValue)return json(res,400,{error:'text is required'});
    const items=memoryStore();const item={id:makeId('mem'),projectId:String(b.projectId||''),category:String(b.category||'note'),text:textValue.slice(0,4000),pinned:!!b.pinned,createdAt:nowIso(),updatedAt:nowIso()};
    items.unshift(item);saveStore(MEMORY_STORE,items,1000);recordActivity('memory','Saved project memory',item.text.slice(0,160),{projectId:item.projectId});json(res,201,{item});
  }catch(e){storageError(res,e,400)}
}
async function apiMemoryUpdate(req,res){
  if(!requireFeature(res,8))return;
  try{const b=await readBody(req);const items=memoryStore();const i=items.findIndex(x=>x.id===b.id);if(i<0)return json(res,404,{error:'Memory not found'});
    if(typeof b.text==='string'&&b.text.trim())items[i].text=b.text.slice(0,4000);if(typeof b.pinned==='boolean')items[i].pinned=b.pinned;if(typeof b.category==='string')items[i].category=b.category;
    items[i].updatedAt=nowIso();saveStore(MEMORY_STORE,items,1000);json(res,200,{item:items[i]});
  }catch(e){storageError(res,e,400)}
}
async function apiMemoryDelete(req,res){
  if(!requireFeature(res,8))return;
  try{const b=await readBody(req);const items=memoryStore();const next=items.filter(x=>x.id!==b.id);if(next.length===items.length)return json(res,404,{error:'Memory not found'});saveStore(MEMORY_STORE,next,1000,items);json(res,200,{ok:true})}catch(e){storageError(res,e,400)}
}
async function apiProjectIntelligence(req,res,urlObj){
  if(!requireFeature(res,8))return;
  const projectId=urlObj.searchParams.get('projectId')||'';
  const p=projectStore().find(x=>x.id===projectId); if(!p)return json(res,404,{error:'Project not found'});
  const mem=memoryStore().filter(x=>x.projectId===projectId);
  const docs=knowledgeStore().filter(x=>x.projectId===projectId);
  const conv=conversationStore().filter(x=>x.projectId===projectId);
  json(res,200,{project:publicProject(p),memory:mem.slice(0,30),summary:{knowledge:docs.length,conversations:conv.length,pinnedMemory:mem.filter(x=>x.pinned).length}});
}

async function apiApprovals(req,res){
  if(!requireFeature(res,9))return;
  json(res,200,{items:approvalStore()});
}
async function apiApprovalCreate(req,res){
  if(!requireFeature(res,9))return;
  try{const b=await readBody(req);const items=approvalStore();const item={id:makeId('approval'),title:normalizeTitle(b.title,'Approval required'),detail:String(b.detail||'').slice(0,4000),risk:String(b.risk||'medium'),status:'pending',createdAt:nowIso(),updatedAt:nowIso(),meta:b.meta||{}};items.unshift(item);saveStore(APPROVALS_STORE,items,500);addNotification('approval',item.title,item.detail,{approvalId:item.id});json(res,201,{item})}catch(e){storageError(res,e,400)}
}
async function apiApprovalDecide(req,res){
  if(!requireFeature(res,9))return;
  try{const b=await readBody(req);const items=approvalStore();const i=items.findIndex(x=>x.id===b.id);if(i<0)return json(res,404,{error:'Approval not found'});
    if(!['approved','rejected'].includes(b.decision))return json(res,400,{error:'decision must be approved or rejected'});
    // An approval for a change decides the change as well; otherwise approving it here left the change waiting forever.
    const changeId=items[i].meta?.changeId;
    if(changeId&&items[i].status==='pending'){const changes=changeStore(),c=changes.find(x=>x.id===changeId);
      if(c&&c.status==='awaiting_approval'){decideChange(changes,c,b.decision);recordActivity('approval',`Approval ${b.decision}`,items[i].title,{approvalId:items[i].id,changeId});return json(res,200,{item:approvalStore().find(x=>x.id===b.id)||items[i]})}}
    items[i].status=b.decision;items[i].updatedAt=nowIso();saveStore(APPROVALS_STORE,items,500);recordActivity('approval',`Approval ${b.decision}`,items[i].title,{approvalId:items[i].id});json(res,200,{item:items[i]});
  }catch(e){storageError(res,e,400)}
}
async function apiAgentPlan(req,res){
  if(!requireFeature(res,9))return;
  try{const b=await readBody(req);const goal=String(b.goal||'').trim();if(!goal)return json(res,400,{error:'goal is required'});const plan=buildAgentPlan(goal);
    const risky=/\b(write|modify|delete|remove|restart|execute|run command|deploy)\b/i.test(goal);
    let approval=null;if(risky){const items=approvalStore();approval={id:makeId('approval'),title:'Agent action approval',detail:goal.slice(0,3000),risk:'medium',status:'pending',createdAt:nowIso(),updatedAt:nowIso(),meta:{goal}};items.unshift(approval);saveStore(APPROVALS_STORE,items,500);addNotification('approval',approval.title,approval.detail,{approvalId:approval.id})}
    json(res,200,{goal,plan,approval});
  }catch(e){storageError(res,e,400)}
}

function findGitRoot(start){
  let cur=safeWorkspacePath(start||'');
  for(let i=0;i<8;i++){if(fs.existsSync(path.join(cur,'.git')))return cur;const parent=path.dirname(cur);if(parent===cur||!parent.startsWith(path.resolve(WORKSPACE_ROOT)))break;cur=parent}
  return null;
}
async function apiRepoInspect(req,res,urlObj){
  if(!requireFeature(res,10))return;
  try{const rel=urlObj.searchParams.get('path')||'';const root=findGitRoot(rel);if(!root)return json(res,200,{isRepo:false,path:rel});
    const gitDir=path.join(root,'.git');let head='';try{head=fs.readFileSync(path.join(gitDir,'HEAD'),'utf8').trim()}catch{}
    let branch=head.startsWith('ref: refs/heads/')?head.slice('ref: refs/heads/'.length):'(detached)';
    let commit='';if(head.startsWith('ref:')){try{commit=fs.readFileSync(path.join(gitDir,head.slice(5)),'utf8').trim()}catch{}}else commit=head;
    json(res,200,{isRepo:true,path:workspaceRel(root),branch,commit:commit.slice(0,12)});
  }catch(e){storageError(res,e,400)}
}
// Child processes run model- or user-supplied commands; never hand them the appliance's secrets.
const SECRET_ENV=/TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL/i;
function childEnv(extra={}){const env={};for(const [k,v] of Object.entries(process.env))if(!SECRET_ENV.test(k))env[k]=v;return {...env,...extra}}
function allowedCommand(cmd){return ['node','npm','npx','git','python3','pytest'].includes(cmd)}
async function apiWorkbenchCommand(req,res){
  if(!requireFeature(res,10))return;
  try{const b=await readBody(req);if(b.approved!==true)return json(res,409,{error:'Explicit approval is required',approvalRequired:true});
    const cmd=String(b.command||'').trim();if(!allowedCommand(cmd))return json(res,400,{error:'Command is not allow-listed'});
    const args=Array.isArray(b.args)?b.args.map(x=>String(x)).slice(0,30):[];const cwd=safeWorkspacePath(b.cwd||'');
    const result=await new Promise((resolve,reject)=>{const child=spawn(cmd,args,{cwd,env:childEnv({CI:'1'}),shell:false});let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Command timed out'))},120000);child.stdout.on('data',d=>stdout+=d.toString());child.stderr.on('data',d=>stderr+=d.toString());child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,stdout:stdout.slice(-60000),stderr:stderr.slice(-60000)})})});
    recordActivity('workbench','Approved command executed',`${cmd} ${args.join(' ')}`.trim(),{cwd:b.cwd||'',code:result.code});json(res,200,result);
  }catch(e){storageError(res,e,400)}
}

async function apiMonitors(req,res){
  if(!requireFeature(res,11))return;
  json(res,200,{items:monitorStore()});
}
async function apiMonitorCreate(req,res){
  if(!requireFeature(res,11))return;
  try{const b=await readBody(req);const items=monitorStore();const item={id:makeId('monitor'),name:normalizeTitle(b.name,'Monitor'),kind:String(b.kind||'health'),enabled:b.enabled!==false,createdAt:nowIso(),updatedAt:nowIso(),lastRunAt:null,lastState:'unknown'};items.unshift(item);saveStore(MONITORS_STORE,items,250);json(res,201,{item})}catch(e){storageError(res,e,400)}
}
async function runHealthMonitor(item){
  const s=await getStatusAndRecordTransition();const bad=s.services.filter(x=>x.state!=='HEALTHY');
  item.lastRunAt=nowIso();item.lastState=bad.length?'attention':'healthy';item.updatedAt=nowIso();
  if(bad.length)addNotification('monitor',`${item.name}: attention needed`,bad.map(x=>x.label).join(', '),{monitorId:item.id});
  return {overall:s.overall,affected:bad.map(x=>x.label)};
}
async function apiMonitorRun(req,res){
  if(!requireFeature(res,11))return;
  try{const b=await readBody(req);const items=monitorStore();const i=items.findIndex(x=>x.id===b.id);if(i<0)return json(res,404,{error:'Monitor not found'});const result=await runHealthMonitor(items[i]);saveStore(MONITORS_STORE,items,250);json(res,200,{item:items[i],result})}catch(e){storageError(res,e,400)}
}
async function apiMorningBrief(req,res){
  if(!requireFeature(res,11))return;
  const s=await getStatusAndRecordTransition();const notes=notificationStore().filter(x=>!x.resolved).slice(0,8);const acts=activityStore().slice(0,8);
  json(res,200,{generatedAt:nowIso(),health:s.overall,notifications:notes,activity:acts});
}
async function monitorSchedulerTick(){
  if(!featureAtLeast(11))return;
  const items=monitorStore();let changed=false;const now=Date.now();
  for(const m of items){if(!m.enabled||m.kind!=='health')continue;const last=m.lastRunAt?new Date(m.lastRunAt).getTime():0;if(now-last<15*60*1000)continue;await runHealthMonitor(m);changed=true}
  if(changed)saveStore(MONITORS_STORE,items,250);
}
setInterval(()=>monitorSchedulerTick().catch(()=>{}),60000).unref?.();
// ===== END PRODUCT EVOLUTION PLATFORM ======================================




// ===== CHANGE INTELLIGENCE / SELF-DEVELOPMENT (v1.13+) ======================
const CHANGES_STORE = 'changes';
const CHANGE_STAGE_ROOT = path.join(DATA_DIR, 'change-staging');

function changeStore(){ return objectStore(CHANGES_STORE); }
function saveChanges(items){ saveStore(CHANGES_STORE, items, 300); if (typeof runImproveReconcile === 'function') runImproveReconcile(); }
function publicChange(item){
  if(!item) return null;
  const copy={...item};
  delete copy.stageRoot;
  return copy;
}
function cleanRelPath(value){
  const rel=String(value||'').replace(/\\/g,'/').replace(/^\/+/, '');
  const normalized=path.posix.normalize(rel);
  if(!rel || normalized==='.' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error('Invalid relative path');
  return normalized;
}
function ensureInside(base,rel){
  const root=path.resolve(base); const full=path.resolve(root,cleanRelPath(rel));
  if(full===root || !full.startsWith(root+path.sep)) throw new Error('Path escapes change target');
  return full;
}
function copyTree(src,dst){
  fs.statSync(src); fs.mkdirSync(dst,{recursive:true}); // statSync: a missing src throws before dst is created
  for(const e of fs.readdirSync(src,{withFileTypes:true})){
    if(['node_modules','.git','.venv','bin','obj'].includes(e.name)) continue;
    const a=path.join(src,e.name), b=path.join(dst,e.name);
    if(e.isDirectory()) copyTree(a,b); else if(e.isFile()){fs.mkdirSync(path.dirname(b),{recursive:true});fs.copyFileSync(a,b)}
  }
}
function candidateTextFiles(rootDir,request){
  const words=[...new Set(String(request||'').toLowerCase().match(/[a-z0-9_.-]{3,}/g)||[])].slice(0,24);
  const exts=new Set(['.js','.mjs','.cjs','.html','.css','.json','.md','.txt','.ps1','.cs','.csproj','.py','.ts','.tsx','.jsx','.yml','.yaml']);
  // Score at most 600 files / 40 MB without keeping their text; only the top 10 are read again for context.
  const found=[];let scannedBytes=0;
  const full=()=>found.length>=600||scannedBytes>=40*1024*1024;
  function walk(dir,depth){
    if(depth>5 || full()) return;
    let entries=[]; try{entries=fs.readdirSync(dir,{withFileTypes:true})}catch{return}
    for(const e of entries){
      if(full()) return;
      if(['node_modules','.git','.venv','bin','obj','dist','build','.next'].includes(e.name)) continue;
      const file=path.join(dir,e.name);
      if(e.isDirectory()){walk(file,depth+1);continue}
      if(!e.isFile() || !exts.has(path.extname(e.name).toLowerCase())) continue;
      let st; try{st=fs.statSync(file)}catch{continue}; if(st.size>900000) continue;
      let txt=''; try{txt=fs.readFileSync(file,'utf8')}catch{continue}
      scannedBytes+=st.size;
      const low=txt.toLowerCase(), name=e.name.toLowerCase(); let score=0;
      for(const w of words){if(name.includes(w))score+=8;const idx=low.indexOf(w);if(idx>=0)score+=2}
      if(/server\.js|app\.js|index\.html|readme|package\.json/i.test(e.name)) score+=2;
      found.push({full:file,rel:path.relative(rootDir,file).replace(/\\/g,'/'),score,size:st.size});
    }
  }
  walk(rootDir,0); found.sort((a,b)=>b.score-a.score||a.size-b.size);
  return found.slice(0,10).flatMap(f=>{try{return [{...f,txt:fs.readFileSync(f.full,'utf8')}]}catch{return []}});
}
function excerptForRequest(txt,request,max=9000){
  const words=[...new Set(String(request||'').toLowerCase().match(/[a-z0-9_.-]{3,}/g)||[])]; const low=txt.toLowerCase();
  let idx=-1; for(const w of words){idx=low.indexOf(w);if(idx>=0)break}
  if(idx<0) return txt.slice(0,max);
  const start=Math.max(0,idx-Math.floor(max/3)); return txt.slice(start,start+max);
}
function buildChangeContext(rootDir,request){
  return candidateTextFiles(rootDir,request).map(f=>`FILE: ${f.rel}\n---\n${excerptForRequest(f.txt,request)}\n---`).join('\n\n').slice(0,70000);
}
function extractJsonObject(raw){
  const text=String(raw||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'');
  try{return JSON.parse(text)}catch{}
  const a=text.indexOf('{'), z=text.lastIndexOf('}'); if(a>=0&&z>a){try{return JSON.parse(text.slice(a,z+1))}catch{}}
  throw new Error('The model did not return valid patch JSON');
}
function safeIdentifier(value){return /^[A-Za-z_$][\w$]*$/.test(String(value||''))?String(value):''}
function normalizePatchPlan(plan){
  const files=Array.isArray(plan?.files)?plan.files.slice(0,10):[]; const out=[];
  for(const f of files){
    let rel; try{rel=cleanRelPath(f.path)}catch{continue}
    const ops=[]; for(const op of (Array.isArray(f.operations)?f.operations.slice(0,30):[])){
      const type=String(op.type||'replace');
      if(type==='replace' && typeof op.find==='string' && typeof op.replace==='string' && op.find.length>0 && op.find.length<=12000 && op.replace.length<=120000) ops.push({type,find:op.find,replace:op.replace});
      else if(type==='replace_function' && safeIdentifier(op.name) && typeof op.content==='string' && op.content.length<=160000) ops.push({type,name:op.name,content:op.content});
      else if(type==='insert_after_function' && safeIdentifier(op.name) && typeof op.content==='string' && op.content.length<=120000) ops.push({type,name:op.name,content:op.content});
      else if(type==='insert_after_text' && typeof op.anchor==='string' && op.anchor.length>0 && op.anchor.length<=8000 && typeof op.content==='string' && op.content.length<=120000) ops.push({type,anchor:op.anchor,content:op.content});
      else if(type==='replace_between_markers' && typeof op.startMarker==='string' && typeof op.endMarker==='string' && op.startMarker.length && op.endMarker.length && typeof op.content==='string') ops.push({type,startMarker:op.startMarker,endMarker:op.endMarker,content:op.content.slice(0,160000)});
      else if(type==='replace_regex' && typeof op.pattern==='string' && op.pattern.length>0 && op.pattern.length<=5000 && typeof op.replacement==='string' && op.replacement.length<=120000) ops.push({type,pattern:op.pattern,flags:String(op.flags||'m').replace(/[^ims]/g,''),replacement:op.replacement});
      else if(type==='append' && typeof op.content==='string' && op.content.length<=100000) ops.push({type,content:op.content});
      else if(type==='create' && typeof op.content==='string' && op.content.length<=240000) ops.push({type,content:op.content});
    }
    if(ops.length) out.push({path:rel,operations:ops});
  }
  return {summary:String(plan?.summary||'Proposed change').slice(0,1200),notes:String(plan?.notes||'').slice(0,5000),files:out};
}
async function generatePatchPlan(request,targetRoot){
  const context=buildChangeContext(targetRoot,request);
  const system=`You are the Patch Intelligence planner inside Local AI. Return JSON only. You may modify only files shown in context. Produce minimal, source-aware patches. For JavaScript named functions, strongly prefer replace_function or insert_after_function instead of replacing large exact strings. Use exact replace only for small unique snippets copied verbatim from context. Never append executable statements outside a valid function merely to satisfy a request. Never invent shell commands. Never add fake validation code, hard-coded PASS values, or validators that simply return true; the existing staging validator is the source of truth. Keep browser-only APIs (document, window, localStorage, client state) out of server.js. Keep Node-only APIs (fs, process.env, require) out of public/app.js. Do not bypass approval, staging, backups, rollback, or the self-update host. Schema: {"summary":"...","notes":"...","files":[{"path":"relative/path","operations":[{"type":"replace_function","name":"functionName","content":"complete function declaration"},{"type":"insert_after_function","name":"functionName","content":"new declaration(s)"},{"type":"insert_after_text","anchor":"EXACT small anchor","content":"text"},{"type":"replace_between_markers","startMarker":"...","endMarker":"...","content":"replacement between markers"},{"type":"replace_regex","pattern":"...","flags":"m","replacement":"literal replacement"},{"type":"replace","find":"EXACT existing text","replace":"replacement text"},{"type":"create","content":"full new file"}]}]}. If context is insufficient, return files:[] and explain why.`;
  const raw=await runEngineeringPlannerModel(`CHANGE REQUEST:\n${request}\n\nAVAILABLE SOURCE CONTEXT:\n${context}`,system,ENGINEERING_MODEL_TIMEOUT_MS);
  return normalizePatchPlan(extractJsonObject(raw));
}
function findFunctionRange(textValue,name){
  const safe=safeIdentifier(name); if(!safe) throw new Error(`Invalid function name: ${name}`);
  const rx=new RegExp(`(?:async\\s+)?function\\s+${safe.replace(/[$]/g,'\\$&')}\\s*\\([^)]*\\)\\s*\\{`,'m');
  const m=rx.exec(textValue); if(!m) throw new Error(`function ${safe} was not found`);
  const open=textValue.indexOf('{',m.index); let depth=0,quote='',esc=false,lineComment=false,blockComment=false;
  for(let i=open;i<textValue.length;i++){
    const c=textValue[i],n=textValue[i+1];
    if(lineComment){if(c==='\n')lineComment=false;continue}
    if(blockComment){if(c==='*'&&n==='/'){blockComment=false;i++}continue}
    if(quote){if(esc){esc=false;continue}if(c==='\\'){esc=true;continue}if(c===quote){quote='';continue}continue}
    if(c==='/'&&n==='/'){lineComment=true;i++;continue}
    if(c==='/'&&n==='*'){blockComment=true;i++;continue}
    if(c==='"'||c==="'"||c==='`'){quote=c;continue}
    if(c==='{')depth++; else if(c==='}'){depth--;if(depth===0)return {start:m.index,end:i+1}}
  }
  throw new Error(`function ${safe} has an unmatched body`);
}
function uniqueIndex(textValue,needle,label){
  const first=textValue.indexOf(needle); if(first<0) throw new Error(`${label} was not found`);
  const second=textValue.indexOf(needle,first+needle.length); if(second>=0) throw new Error(`${label} is not unique`);
  return first;
}
function applyOpsToText(before,ops,rel){
  let textValue=before;
  for(const op of ops){
    if(op.type==='replace'){
      const first=uniqueIndex(textValue,op.find,`${rel}: replacement source text`);
      textValue=textValue.slice(0,first)+op.replace+textValue.slice(first+op.find.length);
    } else if(op.type==='replace_function'){
      const r=findFunctionRange(textValue,op.name); textValue=textValue.slice(0,r.start)+op.content+textValue.slice(r.end);
    } else if(op.type==='insert_after_function'){
      const r=findFunctionRange(textValue,op.name); textValue=textValue.slice(0,r.end)+'\n'+op.content+textValue.slice(r.end);
    } else if(op.type==='insert_after_text'){
      const i=uniqueIndex(textValue,op.anchor,`${rel}: insertion anchor`);const pos=i+op.anchor.length;textValue=textValue.slice(0,pos)+op.content+textValue.slice(pos);
    } else if(op.type==='replace_between_markers'){
      const a=uniqueIndex(textValue,op.startMarker,`${rel}: start marker`);const from=a+op.startMarker.length;const b=textValue.indexOf(op.endMarker,from);if(b<0)throw new Error(`${rel}: end marker was not found`);if(textValue.indexOf(op.endMarker,b+op.endMarker.length)>=0 && textValue.indexOf(op.startMarker,a+op.startMarker.length)>=0)throw new Error(`${rel}: marker pair is ambiguous`);textValue=textValue.slice(0,from)+op.content+textValue.slice(b);
    } else if(op.type==='replace_regex'){
      let rx;try{rx=new RegExp(op.pattern,op.flags||'m')}catch(e){throw new Error(`${rel}: invalid replacement regex: ${e.message}`)}
      const g=new RegExp(op.pattern,[...new Set(`${op.flags||'m'}g`.split(''))].join(''));const matches=[...textValue.matchAll(g)];if(matches.length!==1)throw new Error(`${rel}: replacement regex matched ${matches.length} locations; expected 1`);textValue=textValue.replace(rx,()=>op.replacement);
    } else if(op.type==='append') textValue += op.content;
    else if(op.type==='create') textValue=op.content;
  }
  return textValue;
}
function duplicateTopLevelFunctions(textValue){
  const rx=/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm, seen=new Set(), dup=new Set(); let m;
  while((m=rx.exec(String(textValue||'')))){if(seen.has(m[1]))dup.add(m[1]);seen.add(m[1])} return [...dup];
}
function duplicateHtmlIds(textValue){
  const rx=/\bid=["']([^"']+)["']/g, seen=new Set(), dup=new Set(); let m;
  while((m=rx.exec(String(textValue||'')))){if(seen.has(m[1]))dup.add(m[1]);seen.add(m[1])} return [...dup];
}
function domReferenceFailures(stageRoot){
  const htmlPath=path.join(stageRoot,'public','index.html'),jsPath=path.join(stageRoot,'public','app.js');if(!fs.existsSync(htmlPath)||!fs.existsSync(jsPath))return [];
  const html=fs.readFileSync(htmlPath,'utf8'),js=fs.readFileSync(jsPath,'utf8');const ids=new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(x=>x[1]));const refs=new Set([...js.matchAll(/\$\(["']([^"']+)["']\)/g)].map(x=>x[1]));return [...refs].filter(x=>!ids.has(x));
}
function runtimeBoundaryFailures(rel,ops){
  const out=[];const textValue=(ops||[]).map(op=>String(op.content||op.replace||op.replacement||'')).join('\n');
  if(/(^|\/)server\.js$/i.test(rel)){
    if(/\bdocument\.|\bwindow\.|\blocalStorage\b|\bstate\.imageModels\b/.test(textValue))out.push('server.js patch contains browser-only runtime references');
    if(/validationChecks\.every[\s\S]{0,2500}return\s+true/.test(textValue))out.push('server.js patch appears to contain hard-coded validation success logic');
  }
  if(/public\/app\.js$/i.test(rel) && /\brequire\(["'](?:fs|path|child_process)["']\)|\bprocess\.env\b/.test(textValue))out.push('public/app.js patch contains Node-only runtime references');
  return out;
}
async function runProcess(cmd,args,cwd,timeoutMs=45000,env={}){
  return await new Promise((resolve,reject)=>{const child=spawn(cmd,args,{cwd,env:childEnv({...env,CI:'1'}),shell:false});let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Validation command timed out'))},timeoutMs);child.stdout?.on('data',d=>stdout+=d.toString());child.stderr?.on('data',d=>stderr+=d.toString());child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,stdout:stdout.slice(-20000),stderr:stderr.slice(-20000)})})});
}
function functionSource(textValue,name){
  const r=findFunctionRange(textValue,name);
  return textValue.slice(r.start,r.end);
}
function requiredTextFailures(label,beforeText,afterText,required){
  const failures=[];
  for(const item of required){
    if(beforeText.includes(item) && !afterText.includes(item)){
      failures.push(`${label} removed required contract reference: ${item}`);
    }
  }
  return failures;
}
function replacedFunctionContractFailures(change,sourceRoot,stageRoot){
  const failures=[];
  for(const f of change.files||[]){
    if(!Array.isArray(f.operations))continue;
    const replacementOps=f.operations.filter(op=>op.type==='replace_function');
    if(!replacementOps.length)continue;
    const originalPath=ensureInside(sourceRoot,f.path);
    const stagedPath=ensureInside(stageRoot,f.path);
    if(!fs.existsSync(originalPath) || !fs.existsSync(stagedPath))continue;
    const originalText=fs.readFileSync(originalPath,'utf8');
    const stagedText=fs.readFileSync(stagedPath,'utf8');
    for(const op of replacementOps){
      let beforeFn='';
      let afterFn='';
      try{
        beforeFn=functionSource(originalText,op.name);
        afterFn=functionSource(stagedText,op.name);
      }catch(e){
        failures.push(`${f.path}:${op.name}: ${String(e.message||e)}`);
        continue;
      }
      if(op.name==='engineeringRunText'){
        if(!afterFn.includes('return')){
          failures.push('engineeringRunText replacement no longer returns a value');
        }
        if(beforeFn.includes('run.status') && !afterFn.includes('run.status')){
          failures.push(
            'engineeringRunText replacement removed run.status lifecycle handling'
          );
        }
        if(beforeFn.includes('run.steps') && !afterFn.includes('run.steps')){
          failures.push(
            'engineeringRunText replacement removed run.steps detail handling'
          );
        }
        if(
          beforeFn.includes('run.finalChangeId') &&
          !afterFn.includes('run.finalChangeId')
        ){
          failures.push(
            'engineeringRunText replacement removed finalChangeId output'
          );
        }
      }
      if(op.name==='pollEngineeringIntent'){
        const required=[
          "evoApi('/api/engineering/runs')",
          "find(x=>x.id===runId)",
          "$('engineeringState')",
          "$('engineeringStatus')",
          'state.messages[assistantIndex]',
          '.content',
          '.streaming',
          '.action',
          'renderMessages',
          'loadEngineeringRuns',
          'persistMessages',
          'loadChanges',
          'loadApprovals',
          'loadInbox',
          'loadActivity',
          'loadWorkspace',
          'loadHomeCapabilities',
          'setPhase',
          'toast',
          'setTimeout'
        ];
        failures.push(
          ...requiredTextFailures(
            'pollEngineeringIntent',
            beforeFn,
            afterFn,
            required
          )
        );
        if(
          beforeFn.includes('setTimeout(()=>pollEngineeringIntent') &&
          !afterFn.includes('setTimeout(()=>pollEngineeringIntent')
        ){
          failures.push(
            'pollEngineeringIntent replacement removed polling/retry scheduling'
          );
        }
        if(
          beforeFn.includes('m.content=') &&
          afterFn.includes('state.messages[assistantIndex]=')
        ){
          failures.push(
            'pollEngineeringIntent replacement appears to replace the message object instead of mutating m.content'
          );
        }
        if(
          afterFn.includes('/api/engineering/runs/${runId}')
        ){
          failures.push(
            'pollEngineeringIntent replacement invented a per-run Engineering API endpoint'
          );
        }
        const suspicious=[
          'loadIn0box',
          'updateAskThreadMessage',
          'refreshCapabilities'
        ];
        for(const token of suspicious){
          if(afterFn.includes(token) && !beforeFn.includes(token)){
            failures.push(
              `pollEngineeringIntent replacement introduced unknown/suspicious reference: ${token}`
            );
          }
        }
      }
    }
  }
  return failures;
}

async function validateStagedChange(change,stageRoot){  const sourceRoot =
    change.target === 'self'
      ? SELF_APP_ROOT
      : safeWorkspacePath(change.root || '');
  const checks=[]; const add=(name,ok,detail='')=>checks.push({name,result:ok?'PASS':'FAIL',detail:String(detail||'').slice(0,4000)});
  for(const f of change.files||[]){
    const full=ensureInside(stageRoot,f.path); if(!fs.existsSync(full)){add(`exists ${f.path}`,false,'staged file missing');continue}
    const textValue=fs.readFileSync(full,'utf8');
    if(/\.js$/i.test(f.path)){const r=await runProcess('node',['--check',full],stageRoot);add(`syntax ${f.path}`,r.code===0,r.stderr||r.stdout)}
    if(/app\.js$/i.test(f.path)){const dup=duplicateTopLevelFunctions(textValue);add(`duplicate functions ${f.path}`,dup.length===0,dup.join(', '))}
    if(/\.html$/i.test(f.path)){const dup=duplicateHtmlIds(textValue);add(`duplicate ids ${f.path}`,dup.length===0,dup.join(', '))}
    const boundary=runtimeBoundaryFailures(f.path,f.operations);add(`runtime boundary ${f.path}`,boundary.length===0,boundary.join('; '));
  }
  const contractFailures =
    replacedFunctionContractFailures(
      change,
      sourceRoot,
      stageRoot
    );
  add(
    'replaced function contract',
    contractFailures.length===0,
    contractFailures.join('; ')
  );  if(change.target==='self'){
    for(const rel of ['server.js','public/app.js','public/sw.js']){const full=path.join(stageRoot,rel);if(fs.existsSync(full)){const r=await runProcess('node',['--check',full],stageRoot);add(`core syntax ${rel}`,r.code===0,r.stderr||r.stdout)}}
    const html=path.join(stageRoot,'public','index.html');if(fs.existsSync(html)){const dup=duplicateHtmlIds(fs.readFileSync(html,'utf8'));add('core duplicate HTML ids',dup.length===0,dup.join(', '))}
    const dom=domReferenceFailures(stageRoot);add('DOM reference contract',dom.length===0,dom.length?`Missing IDs: ${dom.join(', ')}`:'all referenced IDs resolved');
    const smokePort=3200+Math.floor(Math.random()*300); const stageData=path.join(CHANGE_STAGE_ROOT,change.id,'smoke-data');fs.rmSync(stageData,{recursive:true,force:true});fs.mkdirSync(stageData,{recursive:true});
    const child=spawn('node',[path.join(stageRoot,'server.js')],{cwd:stageRoot,env:childEnv({PORT:String(smokePort),LOCAL_UI_PORT:'',APP_VERSION:`${APP_VERSION}-stage`,DATA_DIR:stageData}),shell:false}); let stderr='';child.stderr?.on('data',d=>stderr+=d.toString());
    let healthy=false,imageModelsOk=false,imageDetail=''; try{for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,250));try{const r=await fetch(`http://127.0.0.1:${smokePort}/healthz`);if(r.ok){const j=await r.json();if(j.status==='ok'){healthy=true;break}}}catch{}}if(healthy){try{const r=await fetchWithTimeout(`http://127.0.0.1:${smokePort}/api/images/models`,{},10000);imageModelsOk=r.ok;if(r.ok){const j=await r.json();imageDetail=`${Array.isArray(j.models)?j.models.length:0} model(s) discovered`}else imageDetail=`HTTP ${r.status}`}catch(e){imageDetail=String(e.message||e)}}}finally{child.kill('SIGTERM')}
    add('staged server smoke test',healthy,healthy?'health endpoint responded':stderr.slice(-1800));
    add('staged image model discovery',imageModelsOk,imageDetail||'image model API unavailable');
  }
  return {checks,passed:checks.every(x=>x.result==='PASS')};
}
function repairContextForChange(change,sourceRoot,errorText){
  const blocks=[];for(const f of change.files||[]){try{const full=ensureInside(sourceRoot,f.path);if(fs.existsSync(full)){const txt=fs.readFileSync(full,'utf8');blocks.push(`CURRENT FILE: ${f.path}\n---\n${excerptForRequest(txt,errorText,12000)}\n---`)}}catch{}}
  return `PATCH/STAGING FAILURE:\n${String(errorText||'unknown failure').slice(0,6000)}\n\nACTUAL CURRENT SOURCE:\n${blocks.join('\n\n').slice(0,36000)}`;
}
// Staging deletes and rebuilds the stage tree and then validates for a while; a second concurrent stage of the
// same change would wipe the tree under the first.
const stagingChangeIds=new Set();
async function stageChangeById(changeId){
  if(stagingChangeIds.has(changeId))throw Object.assign(new Error('This change is already being staged'),{statusCode:409});
  stagingChangeIds.add(changeId);
  try{return await stageChangeByIdUnlocked(changeId)}finally{stagingChangeIds.delete(changeId)}
}
async function stageChangeByIdUnlocked(changeId){
  const items=changeStore();const i=items.findIndex(x=>x.id===changeId);if(i<0)throw new Error('Change not found');const c=items[i];if(!['planned','validation_failed','patch_failed'].includes(c.status))throw new Error(`Change cannot be staged from status ${c.status}`);const sourceRoot=c.target==='self'?SELF_APP_ROOT:safeWorkspacePath(c.root||'');const base=path.join(CHANGE_STAGE_ROOT,c.id);const stageRoot=path.join(base,c.target==='self'?'app':'workspace');fs.rmSync(base,{recursive:true,force:true});fs.mkdirSync(stageRoot,{recursive:true});if(c.target==='self')copyTree(sourceRoot,stageRoot);const diffs=[];
  try{
    for(const f of c.files||[]){const src=ensureInside(sourceRoot,f.path),dst=ensureInside(stageRoot,f.path);let before='';if(fs.existsSync(src)){before=fs.readFileSync(src,'utf8');if(c.target!=='self'){fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst)}}else if(!f.operations.some(x=>x.type==='create'))throw new Error(`${f.path}: source file does not exist`);const after=applyOpsToText(before,f.operations,f.path);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.writeFileSync(dst,after,'utf8');diffs.push({path:f.path,diff:simpleDiff(before,after),changed:before!==after})}
  }catch(e){c.status='patch_failed';c.updatedAt=nowIso();c.patchError=String(e.message||e);c.validation={passed:false,checks:[{name:'patch application',result:'FAIL',detail:c.patchError}]};saveChanges(items);throw e}
  c.diffs=diffs;c.stageRoot=stageRoot;c.validation=await validateStagedChange(c,stageRoot);c.updatedAt=nowIso();
  storage.transaction(()=>{if(c.validation.passed){c.status='awaiting_approval';const approvals=approvalStore();const approval={id:makeId('approval'),title:plainText.approvalTitle(c),detail:`${c.summary}\n\n${c.files.length} file(s) staged and validated.`,risk:c.target==='self'?'high':'medium',status:'pending',createdAt:nowIso(),updatedAt:nowIso(),meta:{changeId:c.id,target:c.target,type:'change'}};approvals.unshift(approval);saveStore(APPROVALS_STORE,approvals,500);c.approvalId=approval.id;addNotification('approval',approval.title,approval.detail,{approvalId:approval.id,changeId:c.id})}else c.status='validation_failed';saveChanges(items);recordActivity('change',c.validation.passed?'Change staged':'Change validation failed',c.summary,{changeId:c.id});});return c;
}
async function apiChanges(req,res,urlObj){
  if(!requireFeature(res,13))return; const id=urlObj.searchParams.get('id'); const items=changeStore();
  if(id){const item=items.find(x=>x.id===id);if(!item)return json(res,404,{error:'Change not found'});return json(res,200,{item:publicChange(item)})}
  json(res,200,{items:items.map(publicChange),pending:items.filter(x=>['planned','patch_failed','validation_failed','staged','awaiting_approval','approved','apply_requested'].includes(x.status)).length});
}
async function apiChangeCapabilities(req,res){
  if(!requireFeature(res,17))return;json(res,200,{patchIntelligence:true,plannerTimeoutMs:ENGINEERING_MODEL_TIMEOUT_MS,retryPatchApplicationFailures:true,operations:['replace_function','insert_after_function','insert_after_text','replace_between_markers','replace_regex','replace','create'],validation:['javascript syntax','duplicate browser functions','duplicate HTML ids','DOM reference contract','runtime boundary checks','staged server health','image model discovery']});
}
// Plans a change request. With itemId, links that Improve item in the same transaction, before the save runs
// reconcile, so the new change is never mistaken for an unlinked one.
async function planChange({request,target:rawTarget,root},{itemId}={}){
  const target=rawTarget==='workspace'?'workspace':'self';const rootRel=String(root||'').trim();const targetRoot=target==='self'?SELF_APP_ROOT:safeWorkspacePath(rootRel);
  const plan=await generatePatchPlan(request,targetRoot);
  const item={id:makeId('chg'),target,root:target==='self'?'app':rootRel,request,summary:plan.summary,notes:plan.notes,files:plan.files,status:plan.files.length?'planned':'needs_context',createdAt:nowIso(),updatedAt:nowIso(),validation:null,diffs:[]};
  storage.transaction(()=>{
    if(itemId){const key=CLAUDE_FINDING_PREFIX+itemId,f=storage.readSetting(key,null);if(f)storage.writeSetting(key,{...f,changeId:item.id,status:'approved',updatedAt:nowIso()})}
    const items=changeStore();items.unshift(item);saveChanges(items);
  });
  recordActivity('change','Change plan created',request.slice(0,180),{changeId:item.id,target});
  return item;
}
async function apiChangePlan(req,res){
  if(!requireFeature(res,13))return;
  try{const b=await readBody(req);const request=String(b.request||'').trim();if(!request)return json(res,400,{error:'request is required'});const item=await planChange({request,target:b.target,root:b.root});json(res,201,{item:publicChange(item)})}catch(e){storageError(res,e,500)}
}
async function apiChangeStage(req,res){
  if(!requireFeature(res,13))return;
  try{const b=await readBody(req);const c=await stageChangeById(String(b.id||''));json(res,200,{item:publicChange(c)})}catch(e){storageError(res,e,400)}
}
async function apiChangeApprove(req,res){
  if(!requireFeature(res,13))return;
  try{const b=await readBody(req);const decision=String(b.decision||'');if(!['approved','rejected'].includes(decision))return json(res,400,{error:'decision must be approved or rejected'});const items=changeStore();const i=items.findIndex(x=>x.id===b.id);if(i<0)return json(res,404,{error:'Change not found'});const c=items[i];if(c.status!=='awaiting_approval')return json(res,409,{error:`Change is not awaiting approval (${c.status})`});decideChange(items,c,decision);json(res,200,{item:publicChange(c)})}catch(e){storageError(res,e,400)}
}
// Approving or rejecting a change, from Change requests or from its approval (Approvals page, run view, a notification):
// the change and its approval move together.
function decideChange(items,c,decision){
  storage.transaction(()=>{c.status=decision==='approved'?'approved':'rejected';c.updatedAt=nowIso();if(c.approvalId){const approvals=approvalStore();const ai=approvals.findIndex(x=>x.id===c.approvalId);if(ai>=0){approvals[ai].status=decision;approvals[ai].updatedAt=nowIso();saveStore(APPROVALS_STORE,approvals,500)}}saveChanges(items);recordActivity('change',`Change ${decision}`,c.summary,{changeId:c.id});});
}
async function apiChangeRequestApply(req,res){
  if(!requireFeature(res,13))return;
  try{const b=await readBody(req);const items=changeStore();const i=items.findIndex(x=>x.id===b.id);if(i<0)return json(res,404,{error:'Change not found'});const c=items[i];if(c.status!=='approved')return json(res,409,{error:`Change must be approved before apply (${c.status})`});if(c.target==='workspace'){const sourceRoot=safeWorkspacePath(c.root||'');const stageRoot=c.stageRoot;if(!stageRoot||!fs.existsSync(stageRoot))return json(res,409,{error:'Staged change is unavailable; stage it again'});const backups=[];for(const f of c.files){const src=ensureInside(stageRoot,f.path),dst=ensureInside(sourceRoot,f.path);fs.mkdirSync(path.dirname(dst),{recursive:true});if(fs.existsSync(dst)){const backup=`${dst}.localai-${Date.now()}.bak`;fs.copyFileSync(dst,backup);backups.push(workspaceRel(backup))}fs.copyFileSync(src,dst)}c.status='applied';c.appliedAt=nowIso();c.backups=backups;recordActivity('change','Workspace change applied',c.summary,{changeId:c.id,files:c.files.length});}
    else if(c.shipVia!=='pr'){markChangeForPr(c);}c.updatedAt=nowIso();saveChanges(items);const shipped=c.target==='self'?shipChangeAsPr(c):null;json(res,200,{item:publicChange(c),shipVia:c.target==='self'?'pr':'workspace',improveItemId:shipped?.id||null})}catch(e){storageError(res,e,400)}
}
async function apiChangeDeployResult(req,res){
  if(!requireFeature(res,13))return;
  try{const b=await readBody(req);const status=String(b.status||'');if(!['applied','rolled_back','deploy_failed'].includes(status))return json(res,400,{error:'invalid deployment status'});const items=changeStore();const i=items.findIndex(x=>x.id===b.id);if(i<0)return json(res,404,{error:'Change not found'});items[i].status=status;items[i].deploymentDetail=String(b.detail||'').slice(0,4000);items[i].updatedAt=nowIso();if(status==='applied')items[i].appliedAt=nowIso();saveChanges(items);recordActivity('change',status==='applied'?'Self-update applied':'Self-update rollback/failure',items[i].summary,{changeId:items[i].id,status});json(res,200,{item:publicChange(items[i])})}catch(e){storageError(res,e,400)}
}
// ===== END CHANGE INTELLIGENCE =============================================



// ===== QUALITY INTELLIGENCE (v1.14+) =========================================
const QUALITY_EVENTS_STORE = 'qualityEvents';
const QUALITY_SCANS_STORE = 'qualityScans';
function qualityEventStore(){return objectStore(QUALITY_EVENTS_STORE)}
function qualityScanStore(){return objectStore(QUALITY_SCANS_STORE)}
function qualitySeverity(type,message){
  const t=String(type||'').toLowerCase(),m=String(message||'').toLowerCase();
  if(t==='error'||/uncaught|syntaxerror|referenceerror|typeerror|failed to load/.test(m))return 'high';
  if(t==='rejection'||/timeout|degraded|warning/.test(m))return 'medium';
  return 'low';
}
async function apiQualityClientEvent(req,res){
  if(!requireFeature(res,14))return;
  try{
    const b=await readBody(req,256*1024);const message=String(b.message||'').slice(0,4000);if(!message)return json(res,400,{error:'message is required'});
    // Opaque cross-origin errors carry no file, line or stack and can't be acted on (older cached pages still send them).
    if(/^Script error\.?$/.test(message.trim())&&!b.stack&&!Number(b.line))return json(res,202,{ignored:true,reason:'opaque script error'});
    const item={id:makeId('qevt'),type:String(b.type||'error').slice(0,40),severity:qualitySeverity(b.type,message),message,source:String(b.source||'').slice(0,1000),line:Number(b.line)||null,column:Number(b.column)||null,stack:String(b.stack||'').slice(0,12000),url:String(b.url||'').slice(0,1200),userAgent:String(req.headers['user-agent']||'').slice(0,300),createdAt:nowIso()};
    prependRecord(QUALITY_EVENTS_STORE,item);recordActivity('quality','Client quality event',message.slice(0,180),{qualityEventId:item.id,severity:item.severity});json(res,201,{item});
  }catch(e){storageError(res,e,400)}
}
function referencedDomIds(jsText){const ids=new Set();const rx=/\$\(['"]([^'"]+)['"]\)/g;let m;while((m=rx.exec(String(jsText||''))))ids.add(m[1]);return [...ids]}
function htmlIds(htmlText){const ids=new Set();const rx=/\bid=["']([^"']+)["']/g;let m;while((m=rx.exec(String(htmlText||''))))ids.add(m[1]);return ids}
async function runQualityScan(){
  const checks=[];const add=(name,result,detail='')=>{const normalized=typeof result==='string'?result:(result?'PASS':'FAIL');checks.push({name,result:['PASS','WARN','FAIL'].includes(normalized)?normalized:'FAIL',detail:String(detail||'').slice(0,3000)})};
  const serverFile=path.join(__dirname,'server.js'),appFile=path.join(PUBLIC_DIR,'app.js'),swFile=path.join(PUBLIC_DIR,'sw.js'),htmlFile=path.join(PUBLIC_DIR,'index.html');
  for(const [name,file] of [['server.js',serverFile],['app.js',appFile],['sw.js',swFile]]){if(fs.existsSync(file)){const r=await runProcess('node',['--check',file],__dirname);add(`syntax ${name}`,r.code===0,r.stderr||r.stdout)}else add(`syntax ${name}`,false,'file missing')}
  if(fs.existsSync(appFile)){const app=fs.readFileSync(appFile,'utf8');const dup=duplicateTopLevelFunctions(app);add('duplicate browser functions',dup.length===0,dup.join(', '));if(fs.existsSync(htmlFile)){const html=fs.readFileSync(htmlFile,'utf8'),ids=htmlIds(html),refs=referencedDomIds(app);const uiFile=path.join(PUBLIC_DIR,'ui.js');if(fs.existsSync(uiFile)){const ui=fs.readFileSync(uiFile,'utf8');for(const id of htmlIds(ui))ids.add(id);for(const m of ui.matchAll(/\.id\s*=\s*['"]([^'"]+)['"]/g))ids.add(m[1])}const missing=refs.filter(x=>!ids.has(x));add('DOM reference contract',missing.length===0,missing.length?`Missing IDs: ${missing.slice(0,40).join(', ')}`:`${refs.length} referenced IDs resolved`)}}
  if(fs.existsSync(htmlFile)){const dup=duplicateHtmlIds(fs.readFileSync(htmlFile,'utf8'));add('duplicate HTML ids',dup.length===0,dup.join(', '))}
  try{const st=await getStatusAndRecordTransition();const coreBad=st.services.filter(x=>x.required!==false&&x.state!=='HEALTHY'),optionalBad=st.services.filter(x=>x.required===false&&x.state!=='HEALTHY');if(coreBad.length)add('service health','FAIL',coreBad.map(x=>`${x.label}:${x.state}`).join(', '));else if(optionalBad.length)add('service health','WARN',`Optional: ${optionalBad.map(x=>`${x.label}:${x.state}`).join(', ')}`);else add('service health','PASS',st.overall)}catch(e){add('service health','FAIL',String(e.message||e))}
  const recent=qualityEventStore().filter(x=>Date.now()-new Date(x.createdAt).getTime()<24*60*60*1000);const high=recent.filter(x=>x.severity==='high'&&!issueSettled(issueStore(),'browser-runtime',x.message,x.createdAt));add('browser runtime 24h',high.length===0,high.length?`${high.length} unresolved high-severity event(s)`:`${recent.length} event(s), no unresolved high-severity errors`);
  const scan={id:makeId('qscan'),createdAt:nowIso(),passed:checks.every(x=>x.result!=='FAIL'),checks,summary:{pass:checks.filter(x=>x.result==='PASS').length,warn:checks.filter(x=>x.result==='WARN').length,fail:checks.filter(x=>x.result==='FAIL').length,events24h:recent.length,high24h:high.length}};
  prependRecord(QUALITY_SCANS_STORE,scan);return scan;
}
async function apiQuality(req,res){if(!requireFeature(res,14))return;const scans=qualityScanStore(),events=qualityEventStore();json(res,200,{latest:scans[0]||null,scans:scans.slice(0,20),events:events.slice(0,80),summary:{events:events.length,high:events.filter(x=>x.severity==='high').length}})}
async function apiQualityScan(req,res){if(!requireFeature(res,14))return;try{const scan=await runQualityScan();recordActivity('quality',scan.passed?'Quality scan passed':'Quality scan found issues',`${scan.summary.pass} pass / ${scan.summary.warn||0} warn / ${scan.summary.fail} fail`,{scanId:scan.id});json(res,200,{scan})}catch(e){storageError(res,e,500)}}
// ===== END QUALITY INTELLIGENCE =============================================



// ===== AUTONOMOUS ISSUE DETECTION (v1.15+) ==================================
const ISSUES_STORE = 'issues';
function issueStore(){return objectStore(ISSUES_STORE)}
function saveIssues(items){saveStore(ISSUES_STORE,items,500)}
function issueKey(kind,name){return `${String(kind||'issue').toLowerCase()}:${String(name||'unknown').toLowerCase().replace(/\s+/g,' ').slice(0,240)}`}
// When an issue was closed: by the operator (resolvedAt), by a passing scan (autoResolvedAt), or ignored.
function issueClosedAt(item){return item.resolvedAt||item.autoResolvedAt||(item.status==='ignored'?item.updatedAt:null)||item.updatedAt}
// True when this occurrence was already counted, or happened before the issue was resolved or ignored.
function issueSettled(items,kind,name,seenAt){
  const item=items.find(x=>x.key===issueKey(kind,name));if(!item||!seenAt)return false;
  if(item.lastEventAt&&seenAt<=item.lastEventAt&&item.status!=='open')return true;
  return ['resolved','ignored'].includes(item.status)&&seenAt<=issueClosedAt(item);
}
// spec.seenAt is when the problem happened (a browser error's time); scans that re-read old events pass it so a
// past error is counted once and does not reopen an issue resolved after it.
function upsertIssue(items,spec){
  const key=issueKey(spec.kind,spec.name),seenAt=spec.seenAt||nowIso();let item=items.find(x=>x.key===key&&x.status!=='ignored');
  if(item){
    if(item.lastEventAt&&seenAt<=item.lastEventAt)return item;
    if(item.status==='resolved'&&seenAt<=issueClosedAt(item))return item;
    item.lastSeenAt=seenAt;item.lastEventAt=seenAt;item.occurrences=(item.occurrences||1)+1;item.detail=String(spec.detail||item.detail||'').slice(0,5000);item.severity=spec.severity||item.severity;item.updatedAt=nowIso();if(item.status==='resolved'){item.status='open';delete item.resolvedAt}return item}
  if(items.some(x=>x.key===key&&x.status==='ignored'&&seenAt<=issueClosedAt(x)))return null;
  item={id:makeId('issue'),key,kind:spec.kind||'quality',name:String(spec.name||'Issue').slice(0,500),detail:String(spec.detail||'').slice(0,5000),severity:spec.severity||'medium',status:'open',occurrences:1,createdAt:nowIso(),updatedAt:nowIso(),lastSeenAt:seenAt,lastEventAt:seenAt,changeId:null};items.unshift(item);return item;
}
async function detectIssues(){
  const scan=await runQualityScan();const items=issueStore();const seen=[];
  for(const c of scan.checks.filter(x=>x.result==='FAIL')){const sev=/service health|syntax|duplicate|DOM/.test(c.name)?'high':'medium';const item=upsertIssue(items,{kind:'quality-check',name:c.name,detail:c.detail,severity:sev});if(item)seen.push(item.id)}
  const recent=qualityEventStore().filter(x=>Date.now()-new Date(x.createdAt).getTime()<24*60*60*1000&&x.severity==='high').slice(0,50);
  // Oldest first, so each event is compared with the ones counted before it.
  for(const e of [...recent].reverse()){const item=upsertIssue(items,{kind:'browser-runtime',name:e.message.slice(0,220),detail:`${e.source||''}${e.line?`:${e.line}`:''}\n${e.stack||''}`.trim(),severity:'high',seenAt:e.createdAt});if(item)seen.push(item.id)}
  for(const item of items){if(item.kind==='quality-check'&&item.status==='open'&&!seen.includes(item.id)){item.status='resolved';item.autoResolvedAt=nowIso();item.updatedAt=nowIso()}}
  saveIssues(items);runImproveReconcile();return {scan,items:items.slice(0,200),detected:seen.length,open:items.filter(x=>x.status==='open').length};
}
async function apiIssues(req,res){if(!requireFeature(res,15))return;const items=issueStore();json(res,200,{items:items.slice(0,250),open:items.filter(x=>x.status==='open').length,high:items.filter(x=>x.status==='open'&&x.severity==='high').length})}
async function apiIssuesScan(req,res){if(!requireFeature(res,15))return;try{const r=await detectIssues();recordActivity('issue',r.open?'Issue scan complete':'Issue scan clear',`${r.open} open issue(s)`,{detected:r.detected});if(r.open)addNotification('issue','Quality issues detected',`${r.open} issue(s) are open; ${r.items.filter(x=>x.status==='open'&&x.severity==='high').length} high severity.`,{});json(res,200,r)}catch(e){storageError(res,e,500)}}
async function apiIssueUpdate(req,res){if(!requireFeature(res,15))return;try{const b=await readBody(req);const items=issueStore(),i=items.findIndex(x=>x.id===b.id);if(i<0)return json(res,404,{error:'Issue not found'});if(['open','resolved','ignored'].includes(b.status)){items[i].status=b.status;if(b.status==='resolved')items[i].resolvedAt=nowIso();else delete items[i].resolvedAt}items[i].updatedAt=nowIso();saveIssues(items);json(res,200,{item:items[i]})}catch(e){storageError(res,e,400)}}
async function apiIssuePrepareChange(req,res){
  if(!requireFeature(res,15))return;
  try{const b=await readBody(req);const issues=issueStore(),ii=issues.findIndex(x=>x.id===b.id);if(ii<0)return json(res,404,{error:'Issue not found'});const issue=issues[ii];const request=`Fix this Local AI issue while preserving existing behavior.\nIssue: ${issue.name}\nSeverity: ${issue.severity}\nDetails:\n${issue.detail}`;const plan=await generatePatchPlan(request,SELF_APP_ROOT);const changes=changeStore();const item={id:makeId('chg'),target:'self',root:'app',request,summary:plan.summary,notes:`Prepared from issue ${issue.id}. ${plan.notes||''}`.trim(),files:plan.files,status:plan.files.length?'planned':'needs_context',createdAt:nowIso(),updatedAt:nowIso(),validation:null,diffs:[],sourceIssueId:issue.id};changes.unshift(item);saveChanges(changes);issue.changeId=item.id;issue.updatedAt=nowIso();saveIssues(issues);recordActivity('issue','Issue promoted to change',issue.name,{issueId:issue.id,changeId:item.id});json(res,201,{issue,item:publicChange(item)})}catch(e){storageError(res,e,500)}
}
async function issueSchedulerTick(){if(!featureAtLeast(15))return;try{await detectIssues()}catch{}}
setInterval(()=>issueSchedulerTick(),5*60*1000).unref?.();
// ===== END AUTONOMOUS ISSUE DETECTION =======================================



// ===== ENGINEERING AGENT RUNTIME (v1.16+) ===================================
const ENGINEERING_RUNS_STORE = 'engineeringRuns';
function engineeringRunStore(){return objectStore(ENGINEERING_RUNS_STORE)}
function saveEngineeringRuns(items){saveStore(ENGINEERING_RUNS_STORE,items,300)}
function engineeringStep(run,name,state='pending',detail=''){const item={name,state,detail:String(detail||'').slice(0,6000),at:nowIso()};run.steps.push(item);run.updatedAt=nowIso();return item}
function createEngineeringChange(request,target,rootRel,runId,attempt){
  const targetRoot=target==='self'?SELF_APP_ROOT:safeWorkspacePath(rootRel);return generatePatchPlan(request,targetRoot).then(plan=>{const changes=changeStore();const item={id:makeId('chg'),target,root:target==='self'?'app':rootRel,request,summary:plan.summary,notes:`Engineering run ${runId}, attempt ${attempt}. ${plan.notes||''}`.trim(),files:plan.files,status:plan.files.length?'planned':'needs_context',createdAt:nowIso(),updatedAt:nowIso(),validation:null,diffs:[],sourceEngineeringRunId:runId,engineeringAttempt:attempt};changes.unshift(item);saveChanges(changes);return item})
}
async function internalStageChange(changeId){return await stageChangeById(changeId)}
function effectiveEngineeringRun(run,changesById){
  const out={
    ...run,
    steps:Array.isArray(run.steps)
      ? run.steps.map(step=>({...step}))
      : []
  };
  if(!run.finalChangeId)return out;
  const change=changesById.get(run.finalChangeId);
  if(!change)return out;
  const lifecycleMap={
    awaiting_approval:'awaiting_approval',
    approved:'approved',
    apply_requested:'apply_requested',
    applied:'applied',
    rejected:'needs_attention',
    deploy_failed:'needs_attention',
    rolled_back:'needs_attention'
  };
  const effective=lifecycleMap[change.status];
  if(!effective)return out;
  out.status=effective;
  out.changeStatus=change.status;
  out.changeUpdatedAt=change.updatedAt||null;
  const approvalStep=out.steps.find(
    step=>step.name==='Human approval required' && step.state==='waiting'
  );
  if(approvalStep && effective!=='awaiting_approval'){
    approvalStep.state='complete';
    approvalStep.at=change.updatedAt||approvalStep.at;
    if(effective==='approved'){
      approvalStep.detail=`Change ${change.id} was approved.`;
    }else if(effective==='apply_requested'){
      approvalStep.detail=`Change ${change.id} was approved and queued for deployment.`;
    }else if(effective==='applied'){
      approvalStep.detail=`Change ${change.id} was approved and deployed.`;
    }else{
      approvalStep.detail=`Change ${change.id} ended with deployment state ${change.status}.`;
    }
  }
  if(effective==='apply_requested'){
    out.steps.push({
      name:'Deployment',
      state:'waiting',
      detail:`Change ${change.id} is queued for the self-update host.`,
      at:change.applyRequestedAt||change.updatedAt||out.updatedAt
    });
  }
  if(effective==='applied'){
    out.steps.push({
      name:'Deployment',
      state:'complete',
      detail:`Change ${change.id} was applied successfully.`,
      at:change.appliedAt||change.updatedAt||out.updatedAt
    });
  }
  if(effective==='needs_attention'){
    out.steps.push({
      name:'Deployment',
      state:'error',
      detail:change.deploymentDetail ||
        `Change ${change.id} ended with status ${change.status}.`,
      at:change.updatedAt||out.updatedAt
    });
    if(!out.error){
      out.error=change.deploymentDetail ||
        `Linked change ${change.id} ended with status ${change.status}.`;
    }
  }
  if(change.updatedAt){
    out.updatedAt=change.updatedAt;
  }
  return out;
}
function effectiveEngineeringRuns(){
  const changesById=new Map(
    changeStore().map(change=>[change.id,change])
  );
  return engineeringRunStore().map(
    run=>effectiveEngineeringRun(run,changesById)
  );
}
async function apiEngineeringRuns(req,res){
  if(!requireFeature(res,16))return;
  const items=effectiveEngineeringRuns();
  json(res,200,{
    items:items.slice(0,200),
    active:items.filter(x=>x.status==='running').length,
    awaitingApproval:items.filter(x=>x.status==='awaiting_approval').length
  });
}
function createEngineeringRunRecord(request,target,rootRel,maxAttempts){
  const runs=engineeringRunStore();
  const run={id:makeId('eng'),request,target,root:target==='self'?'app':rootRel,maxAttempts,status:'running',createdAt:nowIso(),updatedAt:nowIso(),attempt:0,steps:[],changeIds:[],finalChangeId:null,error:null};
  runs.unshift(run);saveEngineeringRuns(runs);recordActivity('engineering','Engineering run started',request.slice(0,180),{runId:run.id,target});return run;
}
function refreshEngineeringRun(run){const runs=engineeringRunStore();const i=runs.findIndex(x=>x.id===run.id);if(i>=0)runs[i]=run;else runs.unshift(run);saveEngineeringRuns(runs)}
async function executeEngineeringRun(run){
  let workingRequest=run.request,lastError='';
  for(let attempt=1;attempt<=run.maxAttempts;attempt++){
    run.attempt=attempt;const planStep=engineeringStep(run,`Attempt ${attempt}: plan`,'running');refreshEngineeringRun(run);
    let change;
    try{change=await createEngineeringChange(workingRequest,run.target,run.target==='self'&&run.root==='app'?'repos':run.root,run.id,attempt)}catch(e){lastError=String(e.message||e);planStep.state='error';planStep.detail=lastError;refreshEngineeringRun(run);if(attempt<run.maxAttempts){workingRequest=`${run.request}\n\nPrevious planning attempt failed. Retry with a smaller source-aware patch. Failure:\n${lastError}`;engineeringStep(run,`Attempt ${attempt}: repair feedback`,'complete',lastError);refreshEngineeringRun(run);continue}break}
    run.changeIds.push(change.id);planStep.state=change.files.length?'complete':'error';planStep.detail=change.files.length?`${change.files.length} file(s) planned`:'No patch operations produced';refreshEngineeringRun(run);
    if(!change.files.length){lastError='Patch planner produced no patch operations';if(attempt<run.maxAttempts){workingRequest=`${run.request}\n\nThe previous planner produced no usable operations. Inspect the supplied source and produce a minimal source-aware patch using replace_function/insert_after_function where possible.`;engineeringStep(run,`Attempt ${attempt}: repair feedback`,'complete',lastError);refreshEngineeringRun(run);continue}break}
    const st=engineeringStep(run,`Attempt ${attempt}: stage + validate`,'running');refreshEngineeringRun(run);let staged;
    try{staged=await internalStageChange(change.id)}catch(e){lastError=String(e.message||e);st.state='error';st.detail=lastError;refreshEngineeringRun(run);if(attempt<run.maxAttempts){const targetRoot=run.target==='self'?SELF_APP_ROOT:safeWorkspacePath(run.root);const context=repairContextForChange(change,targetRoot,lastError);workingRequest=`${run.request}\n\nThe previous patch could not be applied. Do not repeat the brittle operation. Use the actual current source below and create a corrected structural patch.\n\n${context}`;engineeringStep(run,`Attempt ${attempt}: repair feedback`,'complete',context.slice(0,6000));refreshEngineeringRun(run);continue}break}
    st.state=staged.validation?.passed?'complete':'error';st.detail=staged.validation?.passed?'All staging checks passed':(staged.validation?.checks||[]).filter(x=>x.result==='FAIL').map(x=>`${x.name}: ${x.detail}`).join('\n').slice(0,6000);refreshEngineeringRun(run);
    if(staged.validation?.passed){run.status='awaiting_approval';run.finalChangeId=change.id;run.error=null;engineeringStep(run,'Human approval required','waiting',`Validated change ${change.id} is ready for review.`);run.updatedAt=nowIso();refreshEngineeringRun(run);recordActivity('engineering','Engineering run validated',run.request.slice(0,180),{runId:run.id,changeId:change.id,attempt});return run}
    lastError=st.detail||'Validation failed';if(attempt<run.maxAttempts){const targetRoot=run.target==='self'?SELF_APP_ROOT:safeWorkspacePath(run.root);const context=repairContextForChange(change,targetRoot,lastError);workingRequest=`${run.request}\n\nPrevious patch staged but failed real validation. Produce a corrected patch, do not add fake validators, and preserve the approval boundary.\n\n${context}`;engineeringStep(run,`Attempt ${attempt}: repair feedback`,'complete',lastError);refreshEngineeringRun(run)}
  }
  run.status='needs_attention';run.updatedAt=nowIso();run.error=lastError||`Unable to produce a validated patch within ${run.maxAttempts} attempt(s).`;engineeringStep(run,'Stopped safely','error',run.error);refreshEngineeringRun(run);addNotification('engineering','Engineering run needs attention',`${run.request.slice(0,180)} — ${run.error}`,{runId:run.id});recordActivity('engineering','Engineering run stopped',run.error,{runId:run.id});return run;
}
async function apiEngineeringRun(req,res){
  if(!requireFeature(res,16))return;
  try{const b=await readBody(req);const request=String(b.request||'').trim();if(!request)return json(res,400,{error:'request is required'});const target=b.target==='workspace'?'workspace':'self',rootRel=String(b.root||'repos').trim(),maxAttempts=Math.max(1,Math.min(3,Number(b.maxAttempts)||3));const run=createEngineeringRunRecord(request,target,rootRel,maxAttempts);await executeEngineeringRun(run);json(res,200,{run})}catch(e){storageError(res,e,500)}
}
async function apiEngineeringStart(req,res){
  if(!requireFeature(res,16))return;
  try{const b=await readBody(req);const request=String(b.request||'').trim();if(!request)return json(res,400,{error:'request is required'});const target=b.target==='workspace'?'workspace':'self',rootRel=String(b.root||'repos').trim(),maxAttempts=Math.max(1,Math.min(3,Number(b.maxAttempts)||3));const run=createEngineeringRunRecord(request,target,rootRel,maxAttempts);json(res,202,{run});setImmediate(()=>executeEngineeringRun(run).catch(e=>{run.status='needs_attention';run.error=String(e.message||e);run.updatedAt=nowIso();engineeringStep(run,'Stopped safely','error',run.error);refreshEngineeringRun(run)}))}catch(e){storageError(res,e,500)}
}
// ===== END ENGINEERING AGENT RUNTIME ========================================



// ===== POWERSHELL WORKBENCH / HOST BRIDGE (v1.17+) ==========================
const POWERSHELL_JOBS_STORE = 'powerShellJobs';
function powerShellJobStore(){return objectStore(POWERSHELL_JOBS_STORE)}
function savePowerShellJobs(items){saveStore(POWERSHELL_JOBS_STORE,items,250)}
// The port proves the request came from the host (see LOCAL_UI_PORT); the Host check still blocks DNS-rebinding pages.
function localUiRequest(req){if(LOCAL_UI_PORT&&req.socket?.localPort!==LOCAL_UI_PORT)return false;const raw=String(req.headers.host||'').toLowerCase();const host=raw.startsWith('[')?raw.slice(1,raw.indexOf(']')):raw.split(':')[0];return host==='127.0.0.1'||host==='localhost'||host==='::1'}
function requireLocalUi(req,res){if(!localUiRequest(req)){json(res,403,{error:`PowerShell Workbench is available only from http://localhost:${LOCAL_UI_PORT||PORT} on the Windows host.`});return false}if(!POWERSHELL_UI_TOKEN||String(req.headers['x-localai-powershell-token']||'')!==POWERSHELL_UI_TOKEN){json(res,401,{error:'PowerShell Workbench is locked. Enter the local UI token from C:\\LocalAI\\powershell-bridge\\ui-token.txt.'});return false}return true}
function hostBridgeAuthorized(req){if(!POWERSHELL_BRIDGE_TOKEN)return false;const auth=String(req.headers.authorization||'');return auth===`Bearer ${POWERSHELL_BRIDGE_TOKEN}`}
function normalizeWindowsCwd(value){let v=String(value||'C:\\Projects').trim().replace(/\//g,'\\');if(/\.\.(?:\\|$)/.test(v))throw new Error('Working directory may not contain ..');const low=v.toLowerCase();const roots=['c:\\projects','c:\\repos','c:\\localai'];if(!roots.some(r=>low===r||low.startsWith(r+'\\')))throw new Error('Working directory must be under C:\\Projects, C:\\repos, or C:\\LocalAI');return v}
function powerShellRisk(script){const s=String(script||'').toLowerCase();if(/format-volume|clear-disk|remove-item\s+[^\r\n]*-recurse|stop-computer|restart-computer|docker\s+(?:rm|system\s+prune)|remove-netfirewallrule/.test(s))return 'high';if(/set-content|add-content|copy-item|move-item|remove-item|new-item|docker\s+(?:restart|stop|start)|invoke-webrequest|invoke-restmethod/.test(s))return 'medium';return 'low'}
async function apiPowerShellJobs(req,res){if(!requireFeature(res,17)||!requireLocalUi(req,res))return;const items=powerShellJobStore();json(res,200,{items:items.slice(0,100),bridgeConfigured:!!POWERSHELL_BRIDGE_TOKEN,localOnly:true})}
async function apiPowerShellCreate(req,res){if(!requireFeature(res,17)||!requireLocalUi(req,res))return;try{const b=await readBody(req,512*1024);const script=String(b.script||'');if(!script.trim())return json(res,400,{error:'script is required'});if(script.length>150000)return json(res,413,{error:'script is too large'});const item={id:makeId('ps'),script,cwd:normalizeWindowsCwd(b.cwd),timeoutSec:Math.max(5,Math.min(600,Number(b.timeoutSec)||120)),risk:powerShellRisk(script),status:'pending_approval',createdAt:nowIso(),updatedAt:nowIso(),stdout:'',stderr:'',exitCode:null};const items=powerShellJobStore();items.unshift(item);savePowerShellJobs(items);recordActivity('powershell','PowerShell script prepared',`${item.risk} risk · ${item.cwd}`,{jobId:item.id});json(res,201,{item})}catch(e){storageError(res,e,400)}}
async function apiPowerShellApprove(req,res){if(!requireFeature(res,17)||!requireLocalUi(req,res))return;try{const b=await readBody(req);const items=powerShellJobStore();const item=items.find(x=>x.id===b.id);if(!item)return json(res,404,{error:'PowerShell job not found'});if(item.status!=='pending_approval')return json(res,409,{error:`Job is not awaiting approval (${item.status})`});const decision=String(b.decision||'');if(!['approved','rejected'].includes(decision))return json(res,400,{error:'decision must be approved or rejected'});item.status=decision;item.updatedAt=nowIso();savePowerShellJobs(items);recordActivity('powershell',`PowerShell job ${decision}`,item.id,{jobId:item.id,risk:item.risk});json(res,200,{item})}catch(e){storageError(res,e,400)}}
async function apiPowerShellRequestRun(req,res){if(!requireFeature(res,17)||!requireLocalUi(req,res))return;try{const b=await readBody(req);if(String(b.confirmation||'')!=='RUN')return json(res,409,{error:'Type RUN to queue an approved PowerShell job'});const items=powerShellJobStore();const item=items.find(x=>x.id===b.id);if(!item)return json(res,404,{error:'PowerShell job not found'});if(item.status!=='approved')return json(res,409,{error:`Job must be approved before queueing (${item.status})`});if(!POWERSHELL_BRIDGE_TOKEN)return json(res,503,{error:'PowerShell host bridge is not configured'});const signature=String(b.signature||'').toLowerCase();if(!/^[a-f0-9]{64}$/.test(signature))return json(res,400,{error:'An approval signature is required (enter the approval key from C:\\LocalAI\\powershell-bridge\\approval-key.txt)'});item.approvalSignature=signature;item.status='run_requested';item.runRequestedAt=nowIso();item.updatedAt=nowIso();savePowerShellJobs(items);recordActivity('powershell','PowerShell job queued',item.id,{jobId:item.id});json(res,200,{item})}catch(e){storageError(res,e,400)}}
async function apiPowerShellCancel(req,res){if(!requireFeature(res,17)||!requireLocalUi(req,res))return;try{const b=await readBody(req);const items=powerShellJobStore();const item=items.find(x=>x.id===b.id);if(!item)return json(res,404,{error:'PowerShell job not found'});if(!['pending_approval','approved','run_requested'].includes(item.status))return json(res,409,{error:`Job cannot be cancelled from ${item.status}`});item.status='cancelled';item.updatedAt=nowIso();savePowerShellJobs(items);json(res,200,{item})}catch(e){storageError(res,e,400)}}
async function apiPowerShellHostNext(req,res){if(!requireFeature(res,17))return;if(!hostBridgeAuthorized(req))return json(res,401,{error:'Unauthorized host bridge'});const items=powerShellJobStore();const item=[...items].reverse().find(x=>x.status==='run_requested');if(!item)return json(res,200,{item:null});item.status='running';item.hostStartedAt=nowIso();item.updatedAt=nowIso();savePowerShellJobs(items);json(res,200,{item:{id:item.id,script:item.script,cwd:item.cwd,timeoutSec:item.timeoutSec,risk:item.risk,signature:item.approvalSignature||''}})}
async function apiPowerShellHostResult(req,res){if(!requireFeature(res,17))return;if(!hostBridgeAuthorized(req))return json(res,401,{error:'Unauthorized host bridge'});try{const b=await readBody(req,512*1024);const items=powerShellJobStore();const item=items.find(x=>x.id===b.id);if(!item)return json(res,404,{error:'PowerShell job not found'});if(item.status!=='running')return json(res,409,{error:`Job is not running (${item.status})`});item.exitCode=Number.isFinite(Number(b.exitCode))?Number(b.exitCode):-1;item.stdout=String(b.stdout||'').slice(-120000);item.stderr=String(b.stderr||'').slice(-120000);item.durationMs=Math.max(0,Number(b.durationMs)||0);item.status=item.exitCode===0?'completed':'failed';item.completedAt=nowIso();item.updatedAt=nowIso();savePowerShellJobs(items);recordActivity('powershell',item.status==='completed'?'PowerShell job completed':'PowerShell job failed',`${item.id} · exit ${item.exitCode}`,{jobId:item.id});json(res,200,{ok:true,item})}catch(e){storageError(res,e,400)}}
// ===== END POWERSHELL WORKBENCH =============================================

// ===== CLAUDE BOARD ==========================================================
// Progress and review findings reported by Claude Code sessions, ranked by severity, operator votes and
// decisions. Claude reads the ranking back from /api/claude/priorities. Rows live in settings under
// per-kind key prefixes (newest key first), so no schema change is needed.
const CLAUDE_SESSION_PREFIX='claude-session/',CLAUDE_EVENT_PREFIX='claude-event/',CLAUDE_FINDING_PREFIX='claude-finding/';
const CLAUDE_LIVE_WORKING_MS=2*60*1000,CLAUDE_LIVE_WINDOW_MS=30*60*1000,CLAUDE_LIVE_SCAN_EVENTS=500,CLAUDE_STOP_TITLE='Finished responding';
const CLAUDE_MAX_EVENTS=3000,CLAUDE_MAX_FINDINGS=1000;
const CLAUDE_SEVERITY_WEIGHT={high:30,medium:15,low:5};
const CLAUDE_STATUS={proposed:{label:'Proposed',boost:0},approved:{label:'Approved',boost:20},in_progress:{label:'In progress',boost:25},deferred:{label:'Deferred',boost:-25},rejected:{label:'Rejected',boost:-100},fixed:{label:'Fixed',boost:-200}};
const CLAUDE_EVENT_STATUS=new Set(['started','running','done','failed','info']);
let claudeKeySeq=0,claudeKeyMs=0;
// Keys sort by time: zero-padded milliseconds plus a per-process sequence for same-millisecond writes.
function claudeTimeKey(){const now=Math.max(Date.now(),claudeKeyMs);claudeKeySeq=now===claudeKeyMs?claudeKeySeq+1:0;claudeKeyMs=now;return `${String(now).padStart(14,'0')}-${claudeKeySeq.toString(36).padStart(3,'0')}`}
function claudeSlug(value,fallback){const s=String(value||'').toLowerCase().replace(/[^a-z0-9_.:-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80);return s||fallback}
function claudeText(value,max){return String(value??'').slice(0,max)}
function claudeScore(f){const votes=(f.votes?.up||0)-(f.votes?.down||0);return (CLAUDE_SEVERITY_WEIGHT[f.severity]||10)+votes*6+(CLAUDE_STATUS[f.status]?.boost||0)+(Number(f.priorityBoost)||0)}
function claudeRanked(findings){return findings.map(f=>({...f,score:claudeScore(f)})).sort((a,b)=>b.score-a.score||String(a.createdAt).localeCompare(String(b.createdAt))).map((f,i)=>({...f,rank:i+1}))}
function claudeFindings(){return storage.listSettings(CLAUDE_FINDING_PREFIX,{limit:CLAUDE_MAX_FINDINGS})}
// ===== IMPROVE (roadmap sub-project 4): the board's findings are the backlog; see app/improve.js =====
const IMPROVE_FIELDS=['source','signalId','changeId','handedToClaude','handedAt','shipped'];
// Everything automatic (promote signals, resolve, ship applied changes, stamp the release, link old changes) in one
// idempotent pass. Called at start-up, after a scan saves, and whenever a change request is saved.
function runImproveReconcile({startup=false}={}){
  const at=nowIso();let written=0;
  storage.transaction(()=>{
    const {upserts}=improve.reconcile({items:claudeFindings(),changes:changeStore(),signals:issueStore(),release:release?{version:release.version||APP_VERSION,commit:release.commit}:null,startup,at});
    for(const u of upserts){const key=CLAUDE_FINDING_PREFIX+u.id,prev=storage.readSetting(key,null);
      // A whole new item (it has createdAt) never replaces a stored one: reconcile sees only the newest findings.
      if(prev&&u.createdAt)continue;
      storage.writeSetting(key,prev?{...prev,...u}:{sessionId:'improve',category:'other',votes:{up:0,down:0},priorityBoost:0,decidedAt:null,file:'',area:'',scenario:'',fix:'',pr:'',...u});written++}
  });
  return written;
}
const IMPROVE_ACTIONS=['start','handToClaude','moveToTop','defer','reject','retry','backToBacklog','discard'];
function improveRead(id){return storage.readSetting(CLAUDE_FINDING_PREFIX+claudeSlug(id,''),null)}
function improveWrite(f){f.updatedAt=nowIso();storage.writeSetting(CLAUDE_FINDING_PREFIX+f.id,f);return f}
// A validated change to Local AI itself ships the way every change does: a pull request, CI, the owner's merge and
// Safe Deploy. There is no host updater. Approving it hands its Improve item to Claude (In progress, boosted in
// /api/claude/priorities) with what to do; the session reports the deploy through /api/changes/deploy-result,
// which marks the change applied and Improve moves the item to Shipped.
function markChangeForPr(c){c.shipVia='pr';c.handedAt=nowIso();addNotification('change','Handed to Claude to ship',`${c.summary||'Change'}. A Claude session opens a pull request with the staged change; it deploys when you merge it.`,{changeId:c.id})}
function shipChangeAsPr(c){
  const at=nowIso();
  const existing=claudeFindings().find(f=>f.changeId===c.id);
  const line=String(c.request||'').split('\n').map(l=>l.trim()).find(Boolean);
  const item=existing||{id:`idea-change-${c.id}`,sessionId:'improve',source:'idea',changeId:c.id,category:'idea',severity:'medium',status:'approved',
    title:String(c.summary&&!['Proposed change','Change request'].includes(c.summary)?c.summary:(line||'Change request')).slice(0,120),summary:String(c.request||c.summary||'').slice(0,2000),
    votes:{up:0,down:0},priorityBoost:0,decidedAt:null,file:'',area:'',scenario:'',pr:'',createdAt:at};
  const fix=`Ship staged change ${c.id} as a pull request: GET /api/changes lists it with its files and diffs. After the merge deploys, POST /api/changes/deploy-result {"id":"${c.id}","status":"applied"}.`;
  return improveWrite({...item,...(item.handedToClaude?{}:improve.handToClaude(item,at)),fix});
}
// Before this, approved self changes waited at apply_requested for an updater that was never built. Hand those over once.
function shipQueuedSelfChanges(){
  const items=changeStore();let moved=0;
  for(const c of items)if(c.target==='self'&&c.status==='apply_requested'){c.status='approved';markChangeForPr(c);c.updatedAt=nowIso();moved++}
  if(!moved)return 0;
  saveChanges(items);
  for(const c of items)if(c.shipVia==='pr'&&c.status==='approved')shipChangeAsPr(c);
  return moved;
}
function improveChangeRequest(f){return [f.title,f.summary,f.fix].filter(Boolean).join('\n\n')}
// Changes past approval are being shipped (a pull request for self changes); Improve must not retire them.
const IMPROVE_LOCKED_CHANGE=['approved','apply_requested'];
// Retires a change Improve no longer wants (rejected), and its pending approval with it.
function improveRetireChange(changeId){
  storage.transaction(()=>{const items=changeStore(),i=items.findIndex(c=>c.id===changeId);if(i<0)return;const c=items[i];
    c.status='rejected';c.updatedAt=nowIso();
    if(c.approvalId){const approvals=approvalStore(),ai=approvals.findIndex(a=>a.id===c.approvalId&&a.status==='pending');if(ai>=0){approvals[ai].status='rejected';approvals[ai].updatedAt=nowIso();saveStore(APPROVALS_STORE,approvals,500)}}
    saveChanges(items)});
}
async function apiImproveItems(req,res){
  try{runImproveReconcile();const changes=changeStore(),byId=new Map(changes.map(c=>[c.id,c]));
    const ranked=claudeRanked(claudeFindings().map(f=>({...f,source:f.source||'claude'})));
    const order={backlog:0,inProgress:1,shipped:2,setAside:3};
    const items=ranked.map(f=>{const c=f.changeId?byId.get(f.changeId):null;return {...f,stage:improve.stageOf(f,byId),change:c?{id:c.id,status:c.status,summary:c.summary||''}:null}})
      .sort((a,b)=>order[a.stage]-order[b.stage]||(a.stage==='shipped'?String(b.updatedAt).localeCompare(String(a.updatedAt)):a.rank-b.rank));
    json(res,200,{items,signals:issueStore().slice(0,250)})}catch(e){storageError(res,e,500)}
}
async function apiImproveIdea(req,res){
  try{const b=await readBody(req,512*1024);const item=improve.ideaItem(b.text,nowIso());if(!item)return json(res,400,{error:'Describe the change first.'});
    storage.writeSetting(CLAUDE_FINDING_PREFIX+item.id,{sessionId:'owner',votes:{up:0,down:0},priorityBoost:0,decidedAt:null,file:'',area:'',scenario:'',fix:'',pr:'',...item});
    if(b.start!==true)return json(res,201,{item});
    // The idea is saved either way; if planning fails, say so and let the owner retry from the Backlog.
    try{const change=await planChange({request:improveChangeRequest(item),target:'self'},{itemId:item.id});json(res,201,{item:improveRead(item.id),change:publicChange(change)})}
    catch(e){json(res,201,{item:improveRead(item.id),error:`Saved to your backlog, but planning failed: ${e.message}`})}}catch(e){storageError(res,e,500)}
}
async function apiImproveItem(req,res){
  try{const b=await readBody(req);if(!IMPROVE_ACTIONS.includes(b.action))return json(res,400,{error:`action must be one of ${IMPROVE_ACTIONS.join(', ')}`});
    const f=improveRead(b.id);if(!f)return json(res,404,{error:'Item not found'});
    const changes=changeStore(),change=f.changeId?changes.find(c=>c.id===f.changeId):null,live=!!change&&improve.LIVE_CHANGE.includes(change.status);
    const at=nowIso(),stage=improve.stageOf(f,new Map(changes.map(c=>[c.id,c])));
    // Each action belongs to a stage; anything else is refused rather than quietly moving the item.
    const where={backlog:'in the Backlog',inProgress:'in progress',shipped:'shipped',setAside:'set aside'}[stage];
    const refuse=()=>json(res,409,{error:`That isn't available for an item that is ${where}.`});
    if(['handToClaude','moveToTop','start'].includes(b.action)&&stage!=='backlog')return refuse();
    if(b.action==='retry'&&!(live&&['patch_failed','validation_failed'].includes(change.status)))return json(res,409,{error:'Retry needs a change that failed.'});
    if(['defer','reject','backToBacklog'].includes(b.action)&&stage==='shipped')return refuse();
    if(['defer','reject'].includes(b.action)&&change&&live){
      if(IMPROVE_LOCKED_CHANGE.includes(change.status))return json(res,409,{error:'This change is already approved and being shipped as a pull request.'});
      improveRetireChange(change.id);
    }
    switch(b.action){
      case 'start':case 'retry':{
        const failed=live&&['patch_failed','validation_failed'].includes(change.status);
        if(live&&!(b.action==='retry'&&failed))return json(res,409,{error:'A change for this item is already running.'});
        if(failed)improveRetireChange(change.id);
        await planChange({request:improveChangeRequest(f),target:'self'},{itemId:f.id});return json(res,200,{item:improveRead(f.id)});
      }
      case 'handToClaude':return json(res,200,{item:improveWrite({...f,...improve.handToClaude(f,at)})});
      case 'moveToTop':{const open=claudeFindings().filter(x=>!['fixed','rejected','deferred'].includes(x.status));return json(res,200,{item:improveWrite({...f,priorityBoost:improve.moveToTopBoost(f,open,claudeScore)})})}
      case 'defer':case 'reject':return json(res,200,{item:improveWrite({...f,status:b.action==='defer'?'deferred':'rejected',decidedAt:at})});
      case 'backToBacklog':case 'discard':{
        if(change&&IMPROVE_LOCKED_CHANGE.includes(change.status))return json(res,409,{error:'This change is already approved and being shipped as a pull request.'});
        if(change&&live)improveRetireChange(change.id);
        // Back in the Backlog means you're reconsidering it, so a hand-off to Claude is withdrawn too.
        const unhand=x=>x.handedToClaude?{handedToClaude:false,priorityBoost:Math.max(0,(Number(x.priorityBoost)||0)-30)}:{};
        if(b.action==='backToBacklog'){const cur=improveRead(f.id);return json(res,200,{item:improveWrite({...cur,...unhand(cur),status:'approved',changeId:null})})}
        const aside=b.then==='aside',cur=improveRead(f.id);return json(res,200,{item:improveWrite({...cur,...unhand(cur),status:aside?'deferred':'approved',changeId:aside?f.changeId:null})});
      }
    }
  }catch(e){storageError(res,e,500)}
}
async function apiImproveSignal(req,res){
  try{const b=await readBody(req);if(!['promote','dismiss'].includes(b.action))return json(res,400,{error:'action must be promote or dismiss'});
    const issues=issueStore(),i=issues.findIndex(x=>x.id===b.id);if(i<0)return json(res,404,{error:'Signal not found'});
    if(b.action==='dismiss'){issues[i].status='ignored';issues[i].updatedAt=nowIso();saveIssues(issues);
      // Its backlog item, if it was promoted and not yet started, is closed with it.
      const promoted=improveRead(improve.signalItemId(issues[i].id));
      if(promoted&&improve.stageOf(promoted,new Map(changeStore().map(c=>[c.id,c])))==='backlog')improveWrite({...promoted,status:'rejected',decisionNote:'Signal dismissed',decidedAt:nowIso()});
      return json(res,200,{signal:issues[i]})}
    const id=improve.signalItemId(issues[i].id);const existing=improveRead(id);if(existing)return json(res,200,{item:existing});
    const item=improve.promoteSignal(issues[i],nowIso());storage.writeSetting(CLAUDE_FINDING_PREFIX+id,{sessionId:'improve',votes:{up:0,down:0},priorityBoost:0,decidedAt:null,file:'',area:'',scenario:'',fix:'',pr:'',...item});
    json(res,200,{item})}catch(e){storageError(res,e,500)}
}
function claudeSaveSession(input,at){
  const id=claudeSlug(input.sessionId||input.id,'default');const key=CLAUDE_SESSION_PREFIX+id;const prev=storage.readSetting(key,null)||{id,startedAt:at,eventCount:0};
  const session={...prev,id,title:claudeText(input.sessionTitle||input.title||prev.title||'Claude session',200),cwd:claudeText(input.cwd||prev.cwd||'',300),status:['active','idle','done','failed'].includes(input.sessionStatus)?input.sessionStatus:(prev.status||'active'),updatedAt:at};
  storage.writeSetting(key,session);return session;
}
function claudeNormalizeEvent(e,at){
  const status=CLAUDE_EVENT_STATUS.has(e.status)?e.status:'info';
  return {sessionId:claudeSlug(e.sessionId,'default'),at,kind:['action','phase','note','decision'].includes(e.kind)?e.kind:'action',tool:claudeText(e.tool,60),title:claudeText(e.title||e.tool||'Action',240),detail:claudeText(e.detail,1200),status,phase:claudeText(e.phase,120)};
}
function claudeNormalizeFinding(f,prev,at){
  const severity=['high','medium','low'].includes(f.severity)?f.severity:(prev?.severity||'medium');
  const status=Object.hasOwn(CLAUDE_STATUS,f.status)?f.status:(prev?.status||'proposed');
  return {
    id:claudeSlug(f.id,`finding-${claudeTimeKey()}`),sessionId:claudeSlug(f.sessionId||prev?.sessionId,'default'),
    title:claudeText(f.title||prev?.title||'Untitled finding',240),category:claudeSlug(f.category||prev?.category,'other'),severity,status,
    area:claudeText(f.area??prev?.area??'',120),file:claudeText(f.file??prev?.file??'',300),summary:claudeText(f.summary??prev?.summary??'',2000),
    scenario:claudeText(f.scenario??prev?.scenario??'',2000),fix:claudeText(f.fix??prev?.fix??'',2000),pr:claudeText(f.pr??prev?.pr??'',120),
    // Operator state survives re-reports.
    votes:prev?.votes||{up:0,down:0},priorityBoost:prev?.priorityBoost||0,decidedAt:prev?.decidedAt||null,...(prev?.decisionNote?{decisionNote:prev.decisionNote}:{}),
    // Improve's backlog fields are set only by the server, so they come from the stored item, never the request.
    ...Object.fromEntries(IMPROVE_FIELDS.filter(k=>prev&&prev[k]!==undefined).map(k=>[k,prev[k]])),
    createdAt:prev?.createdAt||at,updatedAt:at
  };
}
// Live sessions from each session's newest event: working while it is under 2 minutes old and not a Stop, otherwise
// waiting (idle) until 30 minutes pass, then gone. Pure: pass the clock in.
function claudeLive(sessions,events,now){
  const latest=new Map();
  for(const e of events){const t=Date.parse(e.at);if(Number.isFinite(t)&&(!latest.has(e.sessionId)||t>latest.get(e.sessionId).t))latest.set(e.sessionId,{t,title:e.title})}
  const live=[];
  for(const s of sessions){
    const last=latest.get(s.id);if(!last)continue; // events only: findings also bump updatedAt
    const age=now-last.t;if(age>=CLAUDE_LIVE_WINDOW_MS)continue;
    const stop=last.title===CLAUDE_STOP_TITLE;
    live.push({id:s.id,title:`${s.title||'Claude session'} · ${s.id.replace(/^cc-/,'')}`,state:!stop&&age<CLAUDE_LIVE_WORKING_MS?'working':'waiting',lastEvent:last.title,at:new Date(last.t).toISOString()});
  }
  return live.sort((a,b)=>(a.state==='working'?0:1)-(b.state==='working'?0:1)||b.at.localeCompare(a.at));
}
async function apiClaudeBoard(req,res,urlObj){
  const sessionId=urlObj.searchParams.get('session')||'';const limit=Math.max(1,Math.min(500,Number(urlObj.searchParams.get('events'))||150));
  const sessions=storage.listSettings(CLAUDE_SESSION_PREFIX).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const events=storage.listSettings(CLAUDE_EVENT_PREFIX,{limit:sessionId?2000:limit,...(sessionId?{where:{sessionId}}:{})}).slice(0,limit);
  const findings=claudeRanked(claudeFindings().filter(f=>!sessionId||f.sessionId===sessionId));
  const byStatus={},byCategory={};
  for(const f of findings){byStatus[f.status]=(byStatus[f.status]||0)+1;const c=byCategory[f.category]||(byCategory[f.category]={high:0,medium:0,low:0,open:0,total:0});c[f.severity]++;c.total++;if(!['fixed','rejected'].includes(f.status))c.open++}
  const live=claudeLive(sessions,storage.listSettings(CLAUDE_EVENT_PREFIX,{limit:CLAUDE_LIVE_SCAN_EVENTS}),Date.now());
  json(res,200,{sessions,events,live,findings,summary:{total:findings.length,byStatus,byCategory},statuses:Object.fromEntries(Object.entries(CLAUDE_STATUS).map(([k,v])=>[k,v.label]))});
}
async function apiClaudeEvents(req,res){
  try{const b=await readBody(req,512*1024);const list=Array.isArray(b.events)?b.events.slice(0,200):[b];const at=nowIso();
    storage.transaction(()=>{const touched=new Map();for(const raw of list){const e=claudeNormalizeEvent({...raw,sessionId:raw.sessionId||b.sessionId},at);storage.writeSetting(CLAUDE_EVENT_PREFIX+claudeTimeKey(),e);touched.set(e.sessionId,(touched.get(e.sessionId)||0)+1)}
      for(const [id,count] of touched){const s=claudeSaveSession({...b,sessionId:id},at);s.eventCount=(s.eventCount||0)+count;s.lastEvent=list.at(-1)?.title||'';storage.writeSetting(CLAUDE_SESSION_PREFIX+id,s)}
      storage.pruneSettings(CLAUDE_EVENT_PREFIX,CLAUDE_MAX_EVENTS)});
    json(res,201,{ok:true,accepted:list.length})}catch(e){storageError(res,e,400)}
}
async function apiClaudeFindings(req,res){
  try{const b=await readBody(req,1024*1024);const list=Array.isArray(b.findings)?b.findings.slice(0,300):[b];const at=nowIso();const saved=[],fresh=[];
    storage.transaction(()=>{if(b.sessionId)claudeSaveSession(b,at);for(const raw of list){const id=claudeSlug(raw.id,'');const prev=id?storage.readSetting(CLAUDE_FINDING_PREFIX+id,null):null;
      // signal-* and idea-* ids are Improve's: Claude may update those items, never create them.
      if(/^(signal|idea)-/.test(id)&&!prev)continue;const f=claudeNormalizeFinding({...raw,sessionId:raw.sessionId||b.sessionId},prev,at);storage.writeSetting(CLAUDE_FINDING_PREFIX+f.id,f);saved.push(f);if(!prev&&f.status==='proposed')fresh.push(f)}});
    // A new finding waiting for the owner's decision reaches the phone; re-posts of the same id don't.
    for(const f of fresh)notifier.notify({kind:'needs-you',title:'Claude needs your decision',body:f.title,url:'/?open=backlog',tag:`finding:${f.id}`});
    json(res,201,{ok:true,items:claudeRanked(saved)})}catch(e){storageError(res,e,400)}
}
function claudeUpdateFinding(res,id,mutate){
  const key=CLAUDE_FINDING_PREFIX+claudeSlug(id,'');const f=storage.readSetting(key,null);if(!f)return json(res,404,{error:'Finding not found'});
  mutate(f);f.updatedAt=nowIso();storage.writeSetting(key,f);json(res,200,{item:{...f,score:claudeScore(f)}});
}
async function apiClaudeVote(req,res){
  try{const b=await readBody(req);const delta=Number(b.delta);if(![1,-1].includes(delta))return json(res,400,{error:'delta must be 1 or -1'});
    claudeUpdateFinding(res,b.id,f=>{f.votes={up:f.votes?.up||0,down:f.votes?.down||0};if(delta>0)f.votes.up++;else f.votes.down++})}catch(e){storageError(res,e,400)}
}
async function apiClaudeDecision(req,res){
  try{const b=await readBody(req);if(!Object.hasOwn(CLAUDE_STATUS,b.status))return json(res,400,{error:`status must be one of ${Object.keys(CLAUDE_STATUS).join(', ')}`});
    let found=null;
    claudeUpdateFinding(res,b.id,f=>{found=f;f.status=b.status;f.decidedAt=nowIso();if(b.note!==undefined)f.decisionNote=claudeText(b.note,1000)});
    // The audit log names the finding; a decision on one that doesn't exist (404 above) isn't logged.
    if(found)recordActivity('claude',`Finding ${CLAUDE_STATUS[b.status].label.toLowerCase()}`,String(found.title||b.id||''),{findingId:b.id});
    if(found)retireChangeOfClosedItem({...found,status:b.status})}catch(e){storageError(res,e,400)}
}
// Closing an Improve item (fixed, rejected, set aside) ends its unfinished change too; otherwise the change keeps
// counting as unfinished on Home and in "What needs me". Changes being shipped (approved) are left alone.
const IMPROVE_CLOSED=['fixed','rejected','deferred'];
function retireChangeOfClosedItem(item){
  if(!item?.changeId||!IMPROVE_CLOSED.includes(item.status))return false;
  const c=changeStore().find(x=>x.id===item.changeId);
  if(!c||!improve.LIVE_CHANGE.includes(c.status)||IMPROVE_LOCKED_CHANGE.includes(c.status))return false;
  improveRetireChange(c.id);return true;
}
// Items closed before the rule above left their changes open; end those once at start-up. Reopening an item later
// doesn't revive its retired change (as with Discard): Start plans a new one.
function retireChangesOfClosedItems(){let n=0;for(const f of claudeFindings())if(retireChangeOfClosedItem(f))n++;return n}
// What Claude should work on next: open findings in rank order with the operator's decisions.
async function apiClaudePriorities(req,res,urlObj){
  const open=claudeRanked(claudeFindings()).filter(f=>!['fixed','rejected','deferred'].includes(f.status));
  json(res,200,{generatedAt:nowIso(),items:open.slice(0,Math.max(1,Math.min(200,Number(urlObj.searchParams.get('limit'))||50))).map(({id,rank,score,title,category,severity,status,votes,file,fix,decisionNote})=>({id,rank,score,title,category,severity,status,votes,file,fix,decisionNote}))});
}
// ===== END CLAUDE BOARD ======================================================

// Cross-site request guard for every mutating route. Another website open in a LAN browser can send simple
// (no-preflight) POSTs here, so a browser request must come from this origin: Sec-Fetch-Site must not be
// cross-site, and an Origin header, when present, must name the host:port the request was sent to (Host, or
// X-Forwarded-Host from the HTTPS proxy). Requests without either header (scripts, hooks, curl, host jobs) pass:
// browsers always send Origin on these methods, other clients are not the threat this guards against.
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
function sameHost(protocol, origin, host) {
  if (!host) return false;
  try { return new URL(`${protocol}//${host}`).host === origin; } catch { return false; }
}
// The voice ask also answers GET, and an answer costs model time and may push a notification, so it is guarded too.
const GUARDED_GET = /^\/api\/glance\/ask(?:\?|$)/;
function crossSiteRequest(req) {
  if (!MUTATING_METHODS.has(req.method) && !(req.method === 'GET' && GUARDED_GET.test(req.url || ''))) return false;
  if (String(req.headers['sec-fetch-site'] || '').trim().toLowerCase() === 'cross-site') return true;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  let parsed;
  try { parsed = new URL(String(origin)); } catch { return true; } // "null" (sandboxed frame, file://) or garbage
  if (parsed.origin === 'null') return true;
  const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  return !sameHost(parsed.protocol, parsed.host, req.headers.host) && !sameHost(parsed.protocol, parsed.host, forwarded);
}
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = urlObj.pathname;

  try {
    if (crossSiteRequest(req)) { req.resume(); res.setHeader('Connection', 'close'); return json(res, 403, { error: 'Cross-site request blocked' }); }
    if (req.method === 'GET' && p === '/healthz') return json(res, 200, { status: 'ok', appliance: 'Local AI', version: APP_VERSION, releaseCommit: release?.commit || null, storage: { engine: 'sqlite', schemaVersion: 1 } });
    if (req.method === 'GET' && p === '/api/releases') return await apiReleases(req, res);
    if (req.method === 'GET' && p === '/api/access') return await apiAccess(req, res);
    if (req.method === 'GET' && p === '/api/glance') return await apiGlance(req, res, urlObj);
    if ((req.method === 'GET' || req.method === 'POST') && p === '/api/voice/home') return await apiVoiceHome(req, res);
    if ((req.method === 'GET' || req.method === 'POST') && p === '/api/glance/ask') return await apiGlanceAsk(req, res, urlObj);
    if (p.startsWith('/api/push/')) return await apiPush(req, res, p);
    if (req.method === 'GET' && p === '/api/storage/status') return json(res, 200, storage.status());
    if (req.method === 'GET' && p === '/api/status') return await apiStatus(req, res);
    if (req.method === 'GET' && p === '/api/models') return await apiModels(req, res);
    if (req.method === 'GET' && p === '/api/models/pulls') return await apiModelPulls(req, res);
    if (req.method === 'POST' && p === '/api/models/pull') return await apiModelPull(req, res);
    if (req.method === 'POST' && p === '/api/models/pull/cancel') return await apiModelPullCancel(req, res);
    if (req.method === 'POST' && p === '/api/models/delete') return await apiModelDelete(req, res);
    if (req.method === 'GET' && p === '/api/config') return apiConfig(req, res);
    if (req.method === 'GET' && p === '/api/capabilities') return await apiCapabilities(req, res);
    if (req.method === 'GET' && p === '/api/activity') return await apiActivity(req, res);
    if (req.method === 'POST' && p === '/api/activity/clear') return await apiActivityClear(req, res);
    if (req.method === 'GET' && p === '/api/library') return await apiLibrary(req, res);
    if (req.method === 'POST' && p === '/api/library/update') return await apiLibraryUpdate(req, res);
    if (req.method === 'POST' && p === '/api/library/delete') return await apiLibraryDelete(req, res);
    if (req.method === 'GET' && p === '/api/workspace') return await apiWorkspace(req, res);
    if (req.method === 'POST' && p === '/api/route') return await apiRoute(req, res);
    if (req.method === 'POST' && p === '/api/chat') return await apiChat(req, res);
    if (req.method === 'POST' && p === '/api/chat/stream') return await apiChatStream(req, res);
    if (req.method === 'GET' && p === '/api/images/models') return await apiImageModels(req, res);
    if (req.method === 'GET' && p === '/api/images/checkpoints') return await apiCheckpoints(req, res);
    if (req.method === 'POST' && p === '/api/images/generate') return await apiGenerateImage(req, res);
    if (req.method === 'GET' && p === '/api/images/view') return await apiImageView(req, res, urlObj);
    if (req.method === 'GET' && p === '/api/gridcraft/health') return await apiGridcraftHealth(req, res);
    if (req.method === 'POST' && p === '/api/gridcraft/run') return await apiGridcraftRun(req, res);

    // cumulative release features
    if (req.method === 'GET' && p === '/api/projects') return await apiProjects(req,res,urlObj);
    if (req.method === 'POST' && p === '/api/projects/create') return await apiProjectsCreate(req,res);
    if (req.method === 'POST' && p === '/api/projects/update') return await apiProjectsUpdate(req,res);
    if (req.method === 'GET' && p === '/api/conversations') return await apiConversations(req,res,urlObj);
    if (req.method === 'POST' && p === '/api/conversations/save') return await apiConversationSave(req,res);
    if (req.method === 'POST' && p === '/api/conversations/delete') return await apiConversationDelete(req,res);
    if (req.method === 'GET' && p === '/api/knowledge') return await apiKnowledge(req,res,urlObj);
    if (req.method === 'POST' && p === '/api/knowledge/import') return await apiKnowledgeImport(req,res);
    if (req.method === 'POST' && p === '/api/knowledge/delete') return await apiKnowledgeDelete(req,res);
    if (req.method === 'POST' && p === '/api/knowledge/search') return await apiKnowledgeSearch(req,res);
    if (req.method === 'GET' && p === '/api/agents/catalog') return await apiAgentCatalog(req,res);
    if (req.method === 'GET' && p === '/api/agents/models') return await apiAgentModels(req,res);
    if (req.method === 'POST' && p === '/api/agents/specialist/run') return await apiSpecialistRun(req,res);
    if (req.method === 'POST' && p === '/api/agents/dispatch') return await apiAgentDispatch(req,res);
    if (req.method === 'GET' && p === '/api/agents/missions') return await apiAgentMissions(req,res);
    if (req.method === 'GET' && p === '/api/agents/mission') return await apiAgentMission(req,res,urlObj);
    if (req.method === 'POST' && p === '/api/agents/missions/start') return await apiAgentMissionStart(req,res);
    if (req.method === 'GET' && p === '/api/agents/missions/events') return await apiAgentMissionEvents(req,res,urlObj);
    if (req.method === 'GET' && p === '/api/agents') return await apiAgents(req,res);
    if (req.method === 'POST' && p === '/api/agents/run') return await apiAgentRun(req,res);
    if (req.method === 'GET' && p === '/api/automations') return await apiAutomations(req,res);
    if (req.method === 'POST' && p === '/api/automations/create') return await apiAutomationCreate(req,res);
    if (req.method === 'POST' && p === '/api/automations/update') return await apiAutomationUpdate(req,res);
    if (req.method === 'POST' && p === '/api/automations/run') return await apiAutomationRun(req,res);
    if (req.method === 'GET' && p === '/api/workbench/tree') return await apiWorkbenchTree(req,res,urlObj);
    if (req.method === 'GET' && p === '/api/workbench/read') return await apiWorkbenchRead(req,res,urlObj);
    if (req.method === 'POST' && p === '/api/workbench/diff') return await apiWorkbenchDiff(req,res);
    if (req.method === 'POST' && p === '/api/workbench/write') return await apiWorkbenchWrite(req,res);
    if (req.method === 'POST' && p === '/api/workbench/search') return await apiWorkbenchSearch(req,res);
    if (req.method === 'POST' && p === '/api/browser/fetch') return await apiBrowserFetch(req,res);
    if (req.method === 'POST' && p === '/api/actions/http-check') return await apiHttpCheck(req,res);
    if (req.method === 'POST' && p === '/api/computer/batch') return await apiComputerBatch(req,res);


    // product evolution features
    if (req.method === 'GET' && p === '/api/notifications') return await apiNotifications(req,res);
    if (req.method === 'POST' && p === '/api/notifications/update') return await apiNotificationUpdate(req,res);
    if (req.method === 'POST' && p === '/api/notifications/seed') return await apiNotificationSeed(req,res);
    if (req.method === 'POST' && p === '/api/notifications/system') return await apiNotificationSystem(req,res);
    if (req.method === 'GET' && p === '/api/memory') return await apiMemory(req,res,urlObj);
    if (req.method === 'POST' && p === '/api/memory/add') return await apiMemoryAdd(req,res);
    if (req.method === 'POST' && p === '/api/memory/update') return await apiMemoryUpdate(req,res);
    if (req.method === 'POST' && p === '/api/memory/delete') return await apiMemoryDelete(req,res);
    if (req.method === 'GET' && p === '/api/projects/intelligence') return await apiProjectIntelligence(req,res,urlObj);
    if (req.method === 'GET' && p === '/api/approvals') return await apiApprovals(req,res);
    if (req.method === 'POST' && p === '/api/approvals/create') return await apiApprovalCreate(req,res);
    if (req.method === 'POST' && p === '/api/approvals/decide') return await apiApprovalDecide(req,res);
    if (req.method === 'POST' && p === '/api/agents/plan') return await apiAgentPlan(req,res);
    if (req.method === 'GET' && p === '/api/repo/inspect') return await apiRepoInspect(req,res,urlObj);
    if (req.method === 'POST' && p === '/api/workbench/command') return await apiWorkbenchCommand(req,res);
    if (req.method === 'GET' && p === '/api/monitors') return await apiMonitors(req,res);
    if (req.method === 'POST' && p === '/api/monitors/create') return await apiMonitorCreate(req,res);
    if (req.method === 'POST' && p === '/api/monitors/run') return await apiMonitorRun(req,res);
    if (req.method === 'GET' && p === '/api/brief') return await apiMorningBrief(req,res);
    if (req.method === 'GET' && p === '/api/runs') return await apiRuns(req,res,urlObj);
    if (req.method === 'POST' && p === '/api/runs/cancel') return await apiRunCancel(req,res);
    if (req.method === 'POST' && p === '/api/runs/update') return await apiRunUpdate(req,res);
    if (req.method === 'POST' && p === '/api/runs/retry') return await apiRunRetry(req,res);
    if (req.method === 'GET' && p === '/api/engineering/runs') return await apiEngineeringRuns(req,res);
    if (req.method === 'POST' && p === '/api/engineering/run') return await apiEngineeringRun(req,res);
    if (req.method === 'POST' && p === '/api/engineering/start') return await apiEngineeringStart(req,res);

    if (req.method === 'GET' && p === '/api/issues') return await apiIssues(req,res);
    if (req.method === 'POST' && p === '/api/issues/scan') return await apiIssuesScan(req,res);
    if (req.method === 'POST' && p === '/api/issues/update') return await apiIssueUpdate(req,res);
    if (req.method === 'POST' && p === '/api/issues/prepare-change') return await apiIssuePrepareChange(req,res);

    if (req.method === 'GET' && p === '/api/quality') return await apiQuality(req,res);
    if (req.method === 'POST' && p === '/api/quality/scan') return await apiQualityScan(req,res);
    if (req.method === 'POST' && p === '/api/quality/client-event') return await apiQualityClientEvent(req,res);

    if (req.method === 'GET' && p === '/api/changes') return await apiChanges(req,res,urlObj);
    if (req.method === 'GET' && p === '/api/changes/capabilities') return await apiChangeCapabilities(req,res);
    if (req.method === 'POST' && p === '/api/changes/plan') return await apiChangePlan(req,res);
    if (req.method === 'POST' && p === '/api/changes/stage') return await apiChangeStage(req,res);
    if (req.method === 'POST' && p === '/api/changes/approve') return await apiChangeApprove(req,res);
    if (req.method === 'POST' && p === '/api/changes/request-apply') return await apiChangeRequestApply(req,res);
    if (req.method === 'POST' && p === '/api/changes/deploy-result') return await apiChangeDeployResult(req,res);

    if (req.method === 'GET' && p === '/api/powershell/jobs') return await apiPowerShellJobs(req,res);
    if (req.method === 'POST' && p === '/api/powershell/create') return await apiPowerShellCreate(req,res);
    if (req.method === 'POST' && p === '/api/powershell/approve') return await apiPowerShellApprove(req,res);
    if (req.method === 'POST' && p === '/api/powershell/request-run') return await apiPowerShellRequestRun(req,res);
    if (req.method === 'POST' && p === '/api/powershell/cancel') return await apiPowerShellCancel(req,res);
    if (req.method === 'GET' && p === '/api/powershell/host/next') return await apiPowerShellHostNext(req,res);
    if (req.method === 'POST' && p === '/api/powershell/host/result') return await apiPowerShellHostResult(req,res);
    if (p.startsWith('/api/claude/chat/') && await claudeChat.handle(req, res, urlObj, p)) return;
    if (req.method === 'GET' && p === '/api/improve/items') return await apiImproveItems(req,res);
    if (req.method === 'POST' && p === '/api/improve/idea') return await apiImproveIdea(req,res);
    if (req.method === 'POST' && p === '/api/improve/item') return await apiImproveItem(req,res);
    if (req.method === 'POST' && p === '/api/improve/signal') return await apiImproveSignal(req,res);
    if (req.method === 'GET' && p === '/api/claude/board') return await apiClaudeBoard(req,res,urlObj);
    if (req.method === 'GET' && p === '/api/claude/priorities') return await apiClaudePriorities(req,res,urlObj);
    if (req.method === 'POST' && p === '/api/claude/events') return await apiClaudeEvents(req,res);
    if (req.method === 'POST' && p === '/api/claude/findings') return await apiClaudeFindings(req,res);
    if (req.method === 'POST' && p === '/api/claude/findings/vote') return await apiClaudeVote(req,res);
    if (req.method === 'POST' && p === '/api/claude/findings/decision') return await apiClaudeDecision(req,res);

    if (req.method === 'GET' && p.startsWith('/go/')) {
      if (redirectFor(req, res, p)) return;
    }
    if (req.method === 'GET') return serveStatic(req, res, p);
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    // A streaming handler may already have sent headers; writing them again would throw out of this handler.
    if (res.headersSent) { console.error(`${new Date().toISOString()} ${req.method} ${req.url} failed after response started:`, e); res.end(); }
    else storageError(res,e,500);
  }
});

// Log instead of exiting when background work (schedulers, model calls) rejects unexpectedly.
process.on('unhandledRejection', reason => console.error(`${new Date().toISOString()} Unhandled rejection:`, reason));

// One time: Library titles/summaries and Inbox notices saved before the encoding fixes show text that Windows
// PowerShell decoded as Windows-1252 ("512 ÃƒÆ’… 512"). Repair them; change requests keep what was pasted.
function repairGarbledTextOnce() {
  const KEY = 'repair:garbled-text-v1';
  if (storage.readSetting(KEY, null)) return;
  const { repairText } = require('./text-repair.js');
  const counts = {};
  for (const [collection, fields] of [[LIBRARY_STORE, ['title', 'summary']], [NOTIFICATIONS_STORE, ['title', 'detail']]]) {
    const items = objectStore(collection);
    let changed = 0;
    for (const item of items) {
      if (!item) continue;
      let touched = false;
      for (const f of fields) { const fixed = repairText(item[f]); if (fixed !== item[f]) { item[f] = fixed; touched = true; } }
      if (touched) changed++;
    }
    if (changed) writeState(collection, items);
    counts[collection] = changed;
  }
  storage.writeSetting(KEY, { completedAt: nowIso(), repaired: counts });
  if (counts[LIBRARY_STORE] || counts[NOTIFICATIONS_STORE]) console.log(`${nowIso()} Repaired garbled text: ${JSON.stringify(counts)}`);
}

// One time: runs saved before the encoding fixes have the same garbled text in Work ("ideÃƒÂ¢…"), and some model
// titles carry markdown bold ("**Dev Design**") that Work shows as asterisks. Times and status are left alone.
function repairRunTextOnce() {
  const KEY = 'repair:run-text-v1';
  if (storage.readSetting(KEY, null)) return;
  const { repairText } = require('./text-repair.js');
  const fix = t => repairText(t).replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1');
  const repaired = runLedger.rewriteText(fix);
  storage.writeSetting(KEY, { completedAt: nowIso(), repaired });
  if (repaired) console.log(`${nowIso()} Repaired run text: ${repaired}`);
}

// One time: image runs saved before the summary format changed read "1 704 × 1024 image edited with …", where the
// count looks like a width. Only the summary changes; times, status and output are left alone.
function repairImageSummariesOnce() {
  const KEY = 'repair:image-summaries-v1';
  if (storage.readSetting(KEY, null)) return;
  const { repairImageSummary } = require('./text-repair.js');
  const repaired = runLedger.rewriteText(repairImageSummary);
  storage.writeSetting(KEY, { completedAt: nowIso(), repaired });
  if (repaired) console.log(`${nowIso()} Repaired image-run summaries: ${repaired}`);
}

async function apiPush(req, res, p) {
  try {
    if (req.method === 'GET' && p === '/api/push/key') return json(res, 200, { publicKey: pushLib.loadOrCreateVapid(storage).publicKey });
    if (req.method === 'GET' && p === '/api/push/devices') return json(res, 200, { devices: notifier.devices() });
    if (req.method !== 'POST') return json(res, 404, { error: 'Not found' });
    const b = await readBody(req, 16 * 1024);
    if (p === '/api/push/subscribe') {
      const s = b.subscription || {};
      if (!pushLib.isAllowedEndpoint(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) return json(res, 400, { error: 'That is not a browser push subscription.' });
      return json(res, 200, { device: notifier.subscribe(s, b.name) });
    }
    if (p === '/api/push/unsubscribe') return json(res, 200, { ok: notifier.unsubscribe(String(b.endpoint || '')) });
    if (p === '/api/push/test') return json(res, 200, await notifier.test(b.id ? String(b.id) : undefined));
    if (p === '/api/push/presence') { notifier.presence(); return json(res, 200, { ok: true }); }
    if (p === '/api/push/devices/update') { const d = notifier.updateDevice(String(b.id || ''), { name: b.name, kinds: b.kinds, quiet: b.quiet }); return d ? json(res, 200, { device: d }) : json(res, 404, { error: 'No such device' }); }
    if (p === '/api/push/devices/remove') return json(res, 200, { ok: notifier.removeDevice(String(b.id || '')) });
    return json(res, 404, { error: 'Not found' });
  } catch (e) { storageError(res, e, 400); }
}

// Each deployed release is recorded once (by commit) so the app can show what changed and when.
const REPO_URL = process.env.LOCALAI_REPO_URL || 'https://github.com/azmusgb/LocalAI';
function recordReleaseHistory() {
  if (!release?.commit || storage.readSetting('release:last', null)?.commit === release.commit) return;
  const entry = { commit: release.commit, version: APP_VERSION, deployedAt: release.deployedAt || nowIso(), notes: release.notes || [] };
  storage.writeSetting(`release:history:${entry.deployedAt}`, entry);
  storage.writeSetting('release:last', { commit: release.commit });
  try { resolveDeployFailures(APP_VERSION); } catch (e) { console.error(`${nowIso()} Resolving old update failures failed:`, e); }
  storage.pruneSettings('release:history:', 50);
}
// Addresses a phone can be pointed at (Health › Secure connection). LOCALAI_REMOTE_NAME is the host's Tailscale name;
// the Caddy placeholder (*.invalid) and anything that isn't a plain host name count as not set.
function remoteAccessName(raw = process.env.LOCALAI_REMOTE_NAME) {
  const name = String(raw || '').trim().toLowerCase().replace(/\.$/, '');
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(name) && !name.endsWith('.invalid') ? name : '';
}
async function apiAccess(req, res) {
  json(res, 200, { remoteName: remoteAccessName() });
}
async function apiReleases(req, res) {
  json(res, 200, {
    current: { version: APP_VERSION, commit: release?.commit || null, deployedAt: release?.deployedAt || null },
    repoUrl: REPO_URL,
    history: storage.listSettings('release:history:', { limit: 20 })
  });
}

migrateLegacyActivityToLibrary();
recordReleaseHistory();
// Each start-up pass is on its own: one bad record must not stop the appliance starting.
for (const [name, pass] of [['ship queued self changes', shipQueuedSelfChanges], ['retire changes of closed items', retireChangesOfClosedItems]]) {
  try { pass(); } catch (e) { console.error(`${nowIso()} Start-up pass "${name}" failed:`, e); }
}
// One bad record must not stop the appliance starting; Improve catches up on the next scan or save.
try { runImproveReconcile({ startup: true }); } catch (e) { console.error(`${nowIso()} Improve start-up reconcile failed:`, e); }
// Health is checked on its own every minute, so an outage reaches the phone (Down/Recovered) even with no page open.
const HEALTH_TICK_MS = Math.max(200, Number(process.env.HEALTH_TICK_MS) || 60000);
setInterval(() => { getStatusAndRecordTransition().catch(() => {}); }, HEALTH_TICK_MS).unref();
repairGarbledTextOnce();
try { repairRunTextOnce(); } catch (e) { console.error(`${nowIso()} Run text repair failed:`, e); }
try { repairImageSummariesOnce(); } catch (e) { console.error(`${nowIso()} Image summary repair failed:`, e); }

server.listen(PORT, '0.0.0.0', () => {
  warmText();
  console.log(`${new Date().toISOString()} Local AI Appliance v${APP_VERSION} listening on 0.0.0.0:${PORT}`);
  recordActivity('system', 'Appliance started', `Local AI Appliance v${APP_VERSION} is ready.`);
});
const localUiServer = LOCAL_UI_PORT && LOCAL_UI_PORT !== PORT ? http.createServer((req, res) => server.emit('request', req, res)) : null;
localUiServer?.listen(LOCAL_UI_PORT, '0.0.0.0', () => console.log(`${new Date().toISOString()} Host-only tools listening on 0.0.0.0:${LOCAL_UI_PORT}`));


// Finish in-flight requests before closing the authoritative data store.
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  localUiServer?.close();
  server.close(() => { storage.close(); process.exit(0); });
  server.closeIdleConnections();
  setTimeout(() => { storage.close(); process.exit(0); }, 10000).unref();
});
