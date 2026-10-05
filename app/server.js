const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3080);
const APP_VERSION = process.env.APP_VERSION || '1.18';
const MODEL = process.env.MODEL || 'qwen3:4b-instruct-32k';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
const COMFY_URL = process.env.COMFY_URL || 'http://host.docker.internal:8188';
const N8N_URL = process.env.N8N_URL || 'http://local-ai-n8n:5678';
const PROXY_URL = process.env.PROXY_URL || 'http://local-ai-ollama-responses-proxy:8080';
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://local-ai-searxng:8080';
const MAC_AI_HOME_URL = process.env.MAC_AI_HOME_URL || 'http://10.0.0.16:3083';
const MAC_DSH_URL = process.env.MAC_DSH_URL || 'http://10.0.0.16:3084';
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

const { Storage } = require('./storage');
const release = require('./release').readRelease(__dirname);
const storage = new Storage({ dataDir: DATA_DIR });

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

function writeState(collection, value, previous = value) {
  if (collection === STATUS_STORE) return storage.writeSetting('status', value);
  return storage.save(collection, value, previous);
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
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
  const items = activityStore();
  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    type,
    title,
    detail,
    at: new Date().toISOString(),
    meta
  };
  items.unshift(item);
  writeState(ACTIVITY_STORE, items);
  return item;
}

function libraryStore() {
  const value = readState(LIBRARY_STORE, []);
  return Array.isArray(value) ? value : [];
}

function titleFromText(value, fallback = 'Untitled') {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  return clean.length <= 72 ? clean : `${clean.slice(0, 69).trim()}ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦`;
}

function recordArtifact(kind, title, summary = '', meta = {}, data = {}) {
  const items = libraryStore();
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
  items.unshift(item);
  writeState(LIBRARY_STORE, items);
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
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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
  if (previous.overall && previous.overall !== overall) {
    if (overall === 'HEALTHY') {
      recordActivity('recovery', 'System recovered', `Health returned to normal from ${previous.overall}.`, { previous: previous.overall, current: overall });
    } else {
      const affected = services.filter(x => x.state !== 'HEALTHY').map(x => x.label);
      recordActivity('system', 'System needs attention', affected.join(', ') || `Health changed to ${overall}.`, { previous: previous.overall, current: overall });
    }
  }
  writeState(STATUS_STORE, { overall, checkedAt: new Date().toISOString() });

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
    certification: certificationInfo()
  };
}

async function apiStatus(req, res) {
  json(res, 200, await getStatusAndRecordTransition());
}

async function apiModels(req, res) {
  try {
    const r = await fetchWithTimeout(`${OLLAMA_URL}/api/tags`, {}, 5000);
    if (!r.ok) throw new Error(`Intelligence service returned HTTP ${r.status}`);
    const j = await r.json();
    const models = Array.isArray(j.models) ? j.models.map(x => x.name).filter(Boolean) : [];
    json(res, 200, { default: MODEL, models });
  } catch (e) {
    json(res, 502, { error: String(e.message || e), default: MODEL, models: [MODEL] });
  }
}

async function searxSearch(query) {
  const u = new URL(`${SEARXNG_URL}/search`);
  u.searchParams.set('q', query);
  u.searchParams.set('format', 'json');
  const r = await fetchWithTimeout(u.toString(), {}, 8000);
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
  const serviceText = (snapshot?.services || []).map(x => `${x.name}:${x.state}${x.required === false ? ':optional' : ':core'}`).join(', ');
  return [
    'RUNTIME CAPABILITY SNAPSHOT (authoritative for this response):',
    `Local AI version: ${snapshot?.version || APP_VERSION}`,
    `Local model: ${snapshot?.model || MODEL}`,
    `Appliance state: ${snapshot?.overall || 'UNKNOWN'}`,
    `Services: ${serviceText || 'unavailable'}`,
    `Installed image models: ${images.length ? images.map(x => `${x.checkpoint} [${x.familyLabel || x.family}]`).join(', ') : 'none discovered'}`,
    `Projects: ${snapshot?.projects?.count ?? 0}`,
    `Engineering: ${snapshot?.engineering?.active ?? 0} active; ${snapshot?.engineering?.awaitingApproval ?? 0} awaiting approval`,
    `Changes: ${snapshot?.changes?.pending ?? 0} pending`,
    `Issues: ${snapshot?.issues?.open ?? 0} open`,
    `PowerShell Workbench: ${snapshot?.powershell?.configured ? 'configured' : 'not configured'}`,
    'Use this snapshot instead of guessing. Never claim an image model is installed unless it appears above. Never report a hard-coded appliance version. Image generation is available only when a supported discovered model is present. Local AI can prepare self-changes through Engineering -> Change Intelligence -> approval -> host self-update; never claim a change was applied unless the runtime reports it.'
  ].join('\n');
}

async function getCapabilitiesSnapshot(force = false) {
  if (!force && capabilityCache.value && capabilityCache.expiresAt > Date.now()) return capabilityCache.value;
  const [statusResult, imageResult] = await Promise.allSettled([
    getStatusAndRecordTransition(),
    getCheckpointNames().then(names => buildImageModelCatalog(names))
  ]);
  const status = statusResult.status === 'fulfilled' ? statusResult.value : { overall: 'UNKNOWN', services: [] };
  const imageCatalog = imageResult.status === 'fulfilled' ? imageResult.value : { models: [], families: [], defaultCheckpoint: null, defaultFamily: null };
  const changes = changeStore();
  const issues = issueStore();
  const engineeringRuns = effectiveEngineeringRuns();
  const snapshot = {
    appliance: 'Local AI', version: APP_VERSION, model: MODEL,
    overall: status.overall, services: status.services || [], serviceSummary: status.serviceSummary || {},
    images: { ...imageCatalog, available: imageCatalog.models.some(x => x.supported) },
    projects: { count: projectStore().length },
    agents: { running: agentRunStore().filter(x => x.status === 'running').length },
    changes: { pending: changes.filter(x => ['planned','patch_failed','validation_failed','staged','awaiting_approval','approved','apply_requested'].includes(x.status)).length },
    issues: { open: issues.filter(x => x.status === 'open').length },
    engineering: { active: engineeringRuns.filter(x => x.status === 'running').length, awaitingApproval: engineeringRuns.filter(x => x.status === 'awaiting_approval').length },
    powershell: { configured: !!POWERSHELL_BRIDGE_TOKEN, localOnly: true }
  };
  capabilityCache = { value: snapshot, expiresAt: Date.now() + CAPABILITY_CACHE_MS };
  return snapshot;
}

async function apiCapabilities(req, res) {
  try { json(res, 200, await getCapabilitiesSnapshot(true)); }
  catch (e) { storageError(res,e,500); }
}

function systemPrompt(researchContext = '', capabilityContext = '') {
  return {
    role: 'system',
    content:
      'You are the assistant inside a private local AI appliance. Be concise, technically precise, useful, and action-oriented. ' +
      'Do not expose infrastructure implementation details unless the user asks. Do not claim an action was executed unless it actually was. ' +
      'When discussing this appliance, use the supplied runtime capability snapshot as authoritative and do not invent installed models, versions, services, or completed actions.' +
      (capabilityContext ? `\n\n${capabilityContext}` : '') +
      (researchContext
        ? `\n\nCurrent metasearch results are below. Use them when relevant and cite source numbers like [1].\n\n${researchContext}`
        : '')
  };
}

async function prepareChat(body) {
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : MODEL;
  const messages = sanitizeMessages(body.messages);
  if (!messages.length) throw new Error('messages[] is required');

  let sources = [];
  let researchContext = '';
  if (body.webSearch === true) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (lastUser) {
      sources = await searxSearch(lastUser.content);
      researchContext = sources.map((s, i) =>
        `[${i + 1}] ${s.title}\n${s.content}\n${s.url}`
      ).join('\n\n');
    }
  }

  let capabilityContext = '';
  try { capabilityContext = capabilityPrompt(await getCapabilitiesSnapshot()); } catch {}
  return { model, messages, sources, researchContext, capabilityContext };
}

async function apiChat(req, res) {
  try {
    const body = await readBody(req);
    const prep = await prepareChat(body);
    const started = Date.now();

    const r = await fetchWithTimeout(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: prep.model,
        messages: [systemPrompt(prep.researchContext, prep.capabilityContext), ...prep.messages],
        stream: false,
        options: { num_ctx: 32768 }
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
      { model: prep.model, elapsedMs, sources: prep.sources.length }
    );
    recordArtifact(
      body.webSearch === true ? 'research' : 'conversation',
      lastUser?.content || (body.webSearch === true ? 'Research' : 'Conversation'),
      content.slice(0, 420),
      { model: prep.model, elapsedMs, sources: prep.sources.length },
      { prompt: lastUser?.content || '', response: content.slice(0, 40000), sources: prep.sources }
    );

    json(res, 200, {
      message: { role: 'assistant', content },
      model: prep.model,
      elapsedMs,
      sources: prep.sources
    });
  } catch (e) {
    storageError(res,e,500);
  }
}

async function apiChatStream(req, res) {
  try {
    const body = await readBody(req);
    const prep = await prepareChat(body);
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

    send('meta', { model: prep.model, sources: prep.sources });

    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: prep.model,
        messages: [systemPrompt(prep.researchContext, prep.capabilityContext), ...prep.messages],
        stream: true,
        options: { num_ctx: 32768 }
      })
    });

    if (!upstream.ok || !upstream.body) {
      const raw = await upstream.text();
      send('error', { error: `Intelligence service HTTP ${upstream.status}: ${raw.slice(0, 500)}` });
      return res.end();
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
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
      { model: prep.model, elapsedMs, sources: prep.sources.length }
    );
    recordArtifact(
      body.webSearch === true ? 'research' : 'conversation',
      lastUser?.content || (body.webSearch === true ? 'Research' : 'Conversation'),
      full.slice(0, 420),
      { model: prep.model, elapsedMs, sources: prep.sources.length },
      { prompt: lastUser?.content || '', response: full.slice(0, 40000), sources: prep.sources }
    );

    send('done', { elapsedMs, model: prep.model, sources: prep.sources });
    res.end();
  } catch (e) {
    if (!res.headersSent) {
      storageError(res,e,500);
    } else {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ error: String(e.message || e) })}\n\n`);
        res.end();
      } catch {}
    }
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

async function getCheckpointNames() {
  const r = await fetchWithTimeout(`${COMFY_URL}/object_info/CheckpointLoaderSimple`, {}, 7000);
  if (!r.ok) throw new Error(`Image service returned HTTP ${r.status}`);
  const j = await r.json();
  const names = j?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
  return Array.isArray(names) ? names : [];
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

async function apiImageModels(req, res) {
  try {
    const catalog = buildImageModelCatalog(await getCheckpointNames());
    json(res, 200, catalog);
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

function multipleOf64(v, fallback) {
  const n = clampInt(v, 256, 1024, fallback);
  return Math.max(256, Math.min(1024, Math.round(n / 64) * 64));
}

function comfyWorkflow({ prompt, negativePrompt, width, height, steps, cfg, seed, checkpoint }) {
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: negativePrompt, clip: ["1", 1] } },
    "4": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed, steps, cfg, sampler_name: "euler", scheduler: "normal", denoise: 1,
        model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0]
      }
    },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { filename_prefix: "LocalAI", images: ["6", 0] } }
  };
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

async function apiGenerateImage(req, res) {
  try {
    const body = await readBody(req);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return json(res, 400, { error: 'prompt is required' });

    const catalog = buildImageModelCatalog(await getCheckpointNames());
    if (!catalog.models.length) throw new Error('No image checkpoints were found');

    let selected = catalog.models.find(x => x.checkpoint === body.checkpoint);
    if (!selected && body.family) selected = catalog.models.find(x => x.family === String(body.family) && x.supported);
    if (!selected) selected = catalog.models.find(x => x.supported) || catalog.models[0];
    if (!selected) throw new Error('No image checkpoints were found');
    if (!selected.supported) throw new Error(selected.reason || `The selected ${selected.familyLabel} model requires a different workflow graph.`);

    const checkpoint = selected.checkpoint;
    const negativePrompt = String(body.negativePrompt || 'blurry, low quality, distorted, text, watermark');
    const width = multipleOf64(body.width, 512);
    const height = multipleOf64(body.height, 512);
    const steps = clampInt(body.steps, 1, 60, 24);
    const cfg = Math.max(1, Math.min(20, Number(body.cfg) || 7));
    const seed = Number.isFinite(Number(body.seed)) ? Math.floor(Number(body.seed)) : Math.floor(Math.random() * 2147483647);

    const workflow = comfyWorkflow({ prompt, negativePrompt, width, height, steps, cfg, seed, checkpoint });
    const started = Date.now();

    const queued = await fetchWithTimeout(`${COMFY_URL}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: 'local-ai-appliance' })
    }, 10000);

    const qraw = await queued.text();
    if (!queued.ok) throw new Error(`Image queue HTTP ${queued.status}: ${qraw.slice(0, 500)}`);
    const q = JSON.parse(qraw);
    if (!q.prompt_id) throw new Error('Image service did not return a prompt ID');

    const history = await pollComfyHistory(q.prompt_id);
    const outputs = history.outputs || {};
    const image = outputs?.["7"]?.images?.[0] ||
      Object.values(outputs).flatMap(x => Array.isArray(x?.images) ? x.images : [])[0];

    if (!image) throw new Error('Image generation completed without an output image');

    const params = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder || '',
      type: image.type || 'output'
    });

    const imageUrl = `/api/images/view?${params.toString()}`;
    const elapsedMs = Date.now() - started;

    recordActivity('image', 'Created an image', prompt.slice(0, 180), {
      imageUrl, checkpoint, family: selected.family, seed, width, height, elapsedMs
    });
    recordArtifact(
      'image',
      prompt,
      `${width} ÃƒÆ’Ã¢â‚¬â€ ${height} generated image`,
      { imageUrl, checkpoint, family: selected.family, seed, width, height, elapsedMs },
      { prompt, negativePrompt, imageUrl }
    );

    json(res, 200, {
      promptId: q.prompt_id,
      checkpoint, family: selected.family, familyLabel: selected.familyLabel, seed, width, height, elapsedMs, imageUrl
    });
  } catch (e) {
    storageError(res,e,500);
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
          text(res, 200, d2, 'text/html; charset=utf-8');
        });
        return;
      }
      return text(res, 404, 'Not found');
    }
    const ext = path.extname(file).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon'
    };
    text(res, 200, data, types[ext] || 'application/octet-stream', {
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
    });
  });
}


// ===== CUMULATIVE PRODUCT PLATFORM (v1.3+) ===================================
const FEATURE_LEVEL = Number(String(APP_VERSION || '1.2').split('.')[1] || 2);
const PROJECTS_STORE = 'projects';
const CONVERSATIONS_STORE = 'conversations';
const KNOWLEDGE_STORE = 'knowledge';
const AUTOMATIONS_STORE = 'automations';
const RUNS_STORE = 'agentRuns';
const AUTOMATION_RUNS_STORE = 'automationRuns';
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/workspace';

function featureAtLeast(level) { return FEATURE_LEVEL >= level; }
function objectStore(file) { const v = readState(file, []); return Array.isArray(v) ? v : []; }
function saveStore(collection, items, _legacyMax, previous = items) { return storage.save(collection, items, previous); }
function makeId(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 9)}`; }
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
  const r=await fetchWithTimeout(`${OLLAMA_URL}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:selectedModel,messages:[{role:'system',content:system},{role:'user',content:String(prompt).slice(0,50000)}],stream:false,options:{num_ctx:32768}})},timeoutMs);
  const raw=await r.text(); if(!r.ok)throw new Error(`Intelligence service HTTP ${r.status}: ${raw.slice(0,400)}`); const j=JSON.parse(raw); return j?.message?.content||'';
}
async function runEngineeringPlannerModel(prompt, system, timeoutMs=ENGINEERING_MODEL_TIMEOUT_MS){
  const started=Date.now();
  let watchdogAborted=false;
  const payload=Buffer.from(JSON.stringify({
    model:MODEL,
    messages:[
      {role:'system',content:system},
      {role:'user',content:String(prompt).slice(0,50000)}
    ],
    stream:true,
    options:{num_ctx:32768}
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
      finish(
        reject,
        new Error(
          `Engineering planner transport: ${e?.name||'Error'}: ${e?.message||e}` +
          `${code?`; code=${code}`:''}; elapsedMs=${elapsedMs}; watchdogAborted=${aborted}`
        )
      );
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
  knowledgeStore,knowledgeScore,searxSearch,recordActivity
 });
 return specialistOrchestrator;
}
async function apiAgentCatalog(req,res){if(!requireFeature(res,4))return;json(res,200,{items:getSpecialistOrchestrator().catalog})}
async function apiAgentModels(req,res){if(!requireFeature(res,4))return;try{json(res,200,{items:await getSpecialistOrchestrator().models()})}catch(e){json(res,503,{error:String(e.message||e)})}}
async function apiSpecialistRun(req,res){if(!requireFeature(res,4))return;try{const b=await readBody(req),goal=String(b.goal||'').trim();if(!goal)return json(res,400,{error:'goal is required'});json(res,200,{run:await getSpecialistOrchestrator().specialist(String(b.agentId||''),goal,String(b.projectId||''))})}catch(e){storageError(res,e,400)}}
async function apiAgentDispatch(req,res){if(!requireFeature(res,4))return;try{const b=await readBody(req),goal=String(b.goal||'').trim();if(!goal)return json(res,400,{error:'goal is required'});json(res,200,{routing:await getSpecialistOrchestrator().dispatch(goal,Array.isArray(b.agentIds)?b.agentIds:undefined)})}catch(e){storageError(res,e,400)}}
async function apiAgentMissions(req,res){if(!requireFeature(res,4))return;json(res,200,{items:getSpecialistOrchestrator().missions().slice(0,200)})}
async function apiAgentMission(req,res,urlObj){if(!requireFeature(res,4))return;const id=String(urlObj.searchParams.get('id')||''),m=getSpecialistOrchestrator().missions().find(x=>x.id===id);if(!m)return json(res,404,{error:'Mission not found'});json(res,200,{mission:m})}
async function apiAgentMissionStart(req,res){if(!requireFeature(res,4))return;try{const b=await readBody(req),goal=String(b.goal||'').trim();if(!goal)return json(res,400,{error:'goal is required'});const ids=Array.isArray(b.agentIds)&&b.agentIds.length?b.agentIds:undefined;json(res,200,{mission:await getSpecialistOrchestrator().mission(goal,String(b.projectId||''),ids)})}catch(e){storageError(res,e,400)}}
async function apiAgentMissionEvents(req,res,urlObj){if(!requireFeature(res,4))return;res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});const wanted=String(urlObj.searchParams.get('missionId')||'');const send=m=>{if(!wanted||m.id===wanted)res.write('data: '+JSON.stringify(m)+'\n\n')};const orch=getSpecialistOrchestrator();orch.events.on('mission',send);res.write(': connected\n\n');req.on('close',()=>orch.events.off('mission',send))}
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
async function apiWorkbenchSearch(req,res){if(!requireFeature(res,5))return;try{const b=await readBody(req);const query=String(b.query||'').toLowerCase().trim();if(!query)return json(res,400,{error:'query is required'});const root=safeWorkspacePath(b.path||'');const results=[];function walk(dir,depth){if(depth>5||results.length>=100)return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(['.git','node_modules','.venv','bin','obj'].includes(e.name))continue;const p=path.join(dir,e.name);if(e.isDirectory())walk(p,depth+1);else if(e.isFile()){if(e.name.toLowerCase().includes(query))results.push({path:workspaceRel(p),match:'filename'});else{try{const st=fs.statSync(p);if(st.size<512000){const txt=fs.readFileSync(p,'utf8');const idx=txt.toLowerCase().indexOf(query);if(idx>=0)results.push({path:workspaceRel(p),match:'content',snippet:txt.slice(Math.max(0,idx-100),idx+query.length+160).replace(/\s+/g,' ')})}}catch{}}}if(results.length>=100)return}}walk(root,0);json(res,200,{results})}catch(e){storageError(res,e,400)}}

function validateExternalUrl(raw){const u=new URL(String(raw||''));if(!['http:','https:'].includes(u.protocol))throw new Error('Only http/https URLs are allowed');return u}
function stripHtml(html){return String(html||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim()}
async function apiBrowserFetch(req,res){if(!requireFeature(res,6))return;try{const b=await readBody(req);const u=validateExternalUrl(b.url);const r=await fetchWithTimeout(u.toString(),{headers:{'User-Agent':'LocalAI-Appliance/1.6'}},15000);const raw=await r.text();const ct=r.headers.get('content-type')||'';const title=/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.replace(/\s+/g,' ').trim()||u.hostname;const content=ct.includes('html')?stripHtml(raw):raw;recordActivity('browser','Fetched web page',u.toString(),{status:r.status});json(res,200,{url:u.toString(),status:r.status,title,contentType:ct,text:content.slice(0,40000),truncated:content.length>40000})}catch(e){storageError(res,e,400)}}
async function apiHttpCheck(req,res){if(!requireFeature(res,6))return;try{const b=await readBody(req);const u=validateExternalUrl(b.url);const started=Date.now();const r=await fetchWithTimeout(u.toString(),{method:String(b.method||'GET').toUpperCase()==='HEAD'?'HEAD':'GET'},10000);json(res,200,{url:u.toString(),status:r.status,ok:r.ok,latencyMs:Date.now()-started,contentType:r.headers.get('content-type')||''})}catch(e){storageError(res,e,400)}}
async function apiComputerBatch(req,res){if(!requireFeature(res,6))return;try{const b=await readBody(req,5*1024*1024);if(b.approved!==true)return json(res,409,{error:'Explicit approval is required',approvalRequired:true});const ops=Array.isArray(b.operations)?b.operations.slice(0,30):[];const results=[];for(const op of ops){try{if(op.type==='mkdir'){fs.mkdirSync(safeWorkspacePath(op.path),{recursive:true});results.push({type:op.type,path:op.path,ok:true})}else if(op.type==='write'){const full=safeWorkspacePath(op.path);fs.mkdirSync(path.dirname(full),{recursive:true});let backup=null;if(fs.existsSync(full)){backup=`${full}.localai-${Date.now()}.bak`;fs.copyFileSync(full,backup)}fs.writeFileSync(full,String(op.content||''),'utf8');results.push({type:op.type,path:op.path,ok:true,backup:backup?workspaceRel(backup):null})}else if(op.type==='copy'){const src=safeWorkspacePath(op.from),dst=safeWorkspacePath(op.to);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst);results.push({type:op.type,from:op.from,to:op.to,ok:true})}else{results.push({type:op.type,ok:false,error:'Unsupported operation'})}}catch(e){results.push({type:op.type,path:op.path,ok:false,error:String(e.message||e)})}}recordActivity('computer','Approved computer action batch',`${results.filter(x=>x.ok).length}/${results.length} operations completed`,{});json(res,200,{results})}catch(e){storageError(res,e,400)}}

async function automationSchedulerTick(){if(!featureAtLeast(4))return;const items=automationStore();let changed=false;for(const a of items){if(!a.enabled||!a.nextRunAt||new Date(a.nextRunAt)>new Date())continue;await executeAutomation(a);a.nextRunAt=nextRunFor(a.schedule);a.updatedAt=nowIso();changed=true}if(changed)saveStore(AUTOMATIONS_STORE,items,250)}
setInterval(()=>automationSchedulerTick().catch(()=>{}),30000).unref?.();
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

function addNotification(kind,title,detail='',meta={}){
  const items=notificationStore();
  const item={id:makeId('note'),kind,title:normalizeTitle(title,'Notification'),detail:String(detail||'').slice(0,2000),createdAt:nowIso(),read:false,resolved:false,meta};
  items.unshift(item); saveStore(NOTIFICATIONS_STORE,items,500); return item;
}
async function apiNotifications(req,res){
  if(!requireFeature(res,7))return;
  const items=notificationStore();
  json(res,200,{items,unread:items.filter(x=>!x.read&&!x.resolved).length});
}
async function apiNotificationUpdate(req,res){
  if(!requireFeature(res,7))return;
  try{const b=await readBody(req);const items=notificationStore();const i=items.findIndex(x=>x.id===b.id);if(i<0)return json(res,404,{error:'Notification not found'});
    if(typeof b.read==='boolean')items[i].read=b.read;if(typeof b.resolved==='boolean')items[i].resolved=b.resolved;
    saveStore(NOTIFICATIONS_STORE,items,500);json(res,200,{item:items[i]});
  }catch(e){storageError(res,e,400)}
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
function allowedCommand(cmd){return ['node','npm','npx','git','python3','pytest'].includes(cmd)}
async function apiWorkbenchCommand(req,res){
  if(!requireFeature(res,10))return;
  try{const b=await readBody(req);if(b.approved!==true)return json(res,409,{error:'Explicit approval is required',approvalRequired:true});
    const cmd=String(b.command||'').trim();if(!allowedCommand(cmd))return json(res,400,{error:'Command is not allow-listed'});
    const args=Array.isArray(b.args)?b.args.map(x=>String(x)).slice(0,30):[];const cwd=safeWorkspacePath(b.cwd||'');
    const result=await new Promise((resolve,reject)=>{const child=spawn(cmd,args,{cwd,env:{...process.env,CI:'1'},shell:false});let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Command timed out'))},120000);child.stdout.on('data',d=>stdout+=d.toString());child.stderr.on('data',d=>stderr+=d.toString());child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,stdout:stdout.slice(-60000),stderr:stderr.slice(-60000)})})});
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
function saveChanges(items){ saveStore(CHANGES_STORE, items, 300); }
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
  const st=fs.statSync(src); fs.mkdirSync(dst,{recursive:true});
  for(const e of fs.readdirSync(src,{withFileTypes:true})){
    if(['node_modules','.git','.venv','bin','obj'].includes(e.name)) continue;
    const a=path.join(src,e.name), b=path.join(dst,e.name);
    if(e.isDirectory()) copyTree(a,b); else if(e.isFile()){fs.mkdirSync(path.dirname(b),{recursive:true});fs.copyFileSync(a,b)}
  }
}
function candidateTextFiles(rootDir,request){
  const words=[...new Set(String(request||'').toLowerCase().match(/[a-z0-9_.-]{3,}/g)||[])].slice(0,24);
  const exts=new Set(['.js','.mjs','.cjs','.html','.css','.json','.md','.txt','.ps1','.cs','.csproj','.py','.ts','.tsx','.jsx','.yml','.yaml']);
  const found=[];
  function walk(dir,depth){
    if(depth>5 || found.length>600) return;
    let entries=[]; try{entries=fs.readdirSync(dir,{withFileTypes:true})}catch{return}
    for(const e of entries){
      if(['node_modules','.git','.venv','bin','obj','dist','build','.next'].includes(e.name)) continue;
      const full=path.join(dir,e.name);
      if(e.isDirectory()){walk(full,depth+1);continue}
      if(!e.isFile() || !exts.has(path.extname(e.name).toLowerCase())) continue;
      let st; try{st=fs.statSync(full)}catch{continue}; if(st.size>900000) continue;
      let txt=''; try{txt=fs.readFileSync(full,'utf8')}catch{continue}
      const low=txt.toLowerCase(), name=e.name.toLowerCase(); let score=0;
      for(const w of words){if(name.includes(w))score+=8;const idx=low.indexOf(w);if(idx>=0)score+=2}
      if(/server\.js|app\.js|index\.html|readme|package\.json/i.test(e.name)) score+=2;
      found.push({full,rel:path.relative(rootDir,full).replace(/\\/g,'/'),txt,score,size:st.size});
    }
  }
  walk(rootDir,0); found.sort((a,b)=>b.score-a.score||a.size-b.size); return found.slice(0,10);
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
  return await new Promise((resolve,reject)=>{const child=spawn(cmd,args,{cwd,env:{...process.env,...env,CI:'1'},shell:false});let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Validation command timed out'))},timeoutMs);child.stdout?.on('data',d=>stdout+=d.toString());child.stderr?.on('data',d=>stderr+=d.toString());child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,stdout:stdout.slice(-20000),stderr:stderr.slice(-20000)})})});
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
    const child=spawn('node',[path.join(stageRoot,'server.js')],{cwd:stageRoot,env:{...process.env,PORT:String(smokePort),APP_VERSION:`${APP_VERSION}-stage`,DATA_DIR:stageData},shell:false}); let stderr='';child.stderr?.on('data',d=>stderr+=d.toString());
    let healthy=false,imageModelsOk=false,imageDetail=''; try{for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,250));try{const r=await fetch(`http://127.0.0.1:${smokePort}/healthz`);if(r.ok){const j=await r.json();if(j.status==='ok'){healthy=true;break}}}catch{}}if(healthy){try{const r=await fetchWithTimeout(`http://127.0.0.1:${smokePort}/api/images/models`,{},10000);imageModelsOk=r.ok;if(r.ok){const j=await r.json();imageDetail=`${Array.isArray(j.models)?j.models.length:0} model(s) discovered`}else imageDetail=`HTTP ${r.status}`}catch(e){imageDetail=String(e.message||e)}}}finally{child.kill('SIGTERM')}
    add('staged server smoke test',healthy,healthy?'health endpoint responded':stderr.slice(-1800));
    add('staged image model discovery',imageModelsOk,imageDetail||'image model API unavailable');
  }
  return {checks,passed:checks.every(x=>x.result==='PASS')};
}
function repairContextForChange(change,sourceRoot,errorText){
  const blocks=[];for(const f of change.files||[]){try{const full=ensureInside(sourceRoot,f.path);if(fs.existsSync(full)){const txt=fs.readFileSync(full,…5652 tokens truncated…ity('engineering','Engineering run started',request.slice(0,180),{runId:run.id,target});return run;
}
function refreshEngineeringRun(run){const runs=engineeringRunStore();const i=runs.findIndex(x=>x.id===run.id);if(i>=0)runs[i]=run;else runs.unshift(run);saveEngineeringRuns(runs)}
async function executeEngineeringRun(run){
  let workingRequest=run.request,lastError='';
  for(let attempt=1;attempt<=run.maxAttempts;attempt++){
    run.attempt=attempt;const planStep=engineeringStep(run,`Attempt ${attempt}: plan`,'running');refreshEngineeringRun(run);
    let change;
    try{change=await createEngineeringChange(workingRequest,run.target,run.root==='app'?'repos':run.root,run.id,attempt)}catch(e){lastError=String(e.message||e);planStep.state='error';planStep.detail=lastError;refreshEngineeringRun(run);if(attempt<run.maxAttempts){workingRequest=`${run.request}\n\nPrevious planning attempt failed. Retry with a smaller source-aware patch. Failure:\n${lastError}`;engineeringStep(run,`Attempt ${attempt}: repair feedback`,'complete',lastError);refreshEngineeringRun(run);continue}break}
    run.changeIds.push(change.id);planStep.state=change.files.length?'complete':'error';planStep.detail=change.files.length?`${change.files.length} file(s) planned`:'No patch operations produced';refreshEngineeringRun(run);
    if(!change.files.length){lastError='Patch planner produced no patch operations';if(attempt<run.maxAttempts){workingRequest=`${run.request}\n\nThe previous planner produced no usable operations. Inspect the supplied source and produce a minimal source-aware patch using replace_function/insert_after_function where possible.`;engineeringStep(run,`Attempt ${attempt}: repair feedback`,'complete',lastError);refreshEngineeringRun(run);continue}break}
    const st=engineeringStep(run,`Attempt ${attempt}: stage + validate`,'running');refreshEngineeringRun(run);let staged;
    try{staged=await internalStageChange(change.id)}catch(e){lastError=String(e.message||e);st.state='error';st.detail=lastError;refreshEngineeringRun(run);if(attempt<run.maxAttempts){const targetRoot=run.target==='self'?SELF_APP_ROOT:safeWorkspacePath(run.root);const context=repairContextForChange(change,targetRoot,lastError);workingRequest=`${run.request}\n\nThe previous patch could not be applied. Do not repeat the brittle operation. Use the actual current source below and create a corrected structural patch.\n\n${context}`;engineeringStep(run,`Attempt ${attempt}: repair feedback`,'complete',context.slice(0,6000));refreshEngineeringRun(run);continue}break}
    st.state=staged.validation?.passed?'complete':'error';st.detail=staged.validation?.passed?'All staging checks passed':(staged.validation?.checks||[]).filter(x=>x.result==='FAIL').map(x=>`${x.name}: ${x.detail}`).join('\n').slice(0,6000);refreshEngineeringRun(run);
    if(staged.validation?.passed){run.status='awaiting_approval';run.finalChangeId=change.id;run.error=null;engineeringStep(run,'Human approval required','waiting',`Validated change ${change.id} is ready for review.`);run.updatedAt=nowIso();refreshEngineeringRun(run);recordActivity('engineering','Engineering run validated',run.request.slice(0,180),{runId:run.id,changeId:change.id,attempt});return run}
    lastError=st.detail||'Validation failed';if(attempt<run.maxAttempts){const targetRoot=run.target==='self'?SELF_APP_ROOT:safeWorkspacePath(run.root);const context=repairContextForChange(change,targetRoot,lastError);workingRequest=`${run.request}\n\nPrevious patch staged but failed real validation. Produce a corrected patch, do not add fake validators, and preserve the approval boundary.\n\n${context}`;engineeringStep(run,`Attempt ${attempt}: repair feedback`,'complete',lastError);refreshEngineeringRun(run)}
  }
  run.status='needs_attention';run.updatedAt=nowIso();run.error=lastError||`Unable to produce a validated patch within ${run.maxAttempts} attempt(s).`;engineeringStep(run,'Stopped safely','error',run.error);refreshEngineeringRun(run);addNotification('engineering','Engineering run needs attention',`${run.request.slice(0,180)} ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â ${run.error}`,{runId:run.id});recordActivity('engineering','Engineering run stopped',run.error,{runId:run.id});return run;
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
function localUiRequest(req){const raw=String(req.headers.host||'').toLowerCase();const host=raw.startsWith('[')?raw.slice(1,raw.indexOf(']')):raw.split(':')[0];return host==='127.0.0.1'||host==='localhost'||host==='::1'}
function requireLocalUi(req,res){if(!localUiRequest(req)){json(res,403,{error:'PowerShell Workbench is available only from http://127.0.0.1 or localhost on the Windows host.'});return false}if(!POWERSHELL_UI_TOKEN||String(req.headers['x-localai-powershell-token']||'')!==POWERSHELL_UI_TOKEN){json(res,401,{error:'PowerShell Workbench is locked. Enter the local UI token from C:\\LocalAI\\powershell-bridge\\ui-token.txt.'});return false}return true}
function hostBridgeAuthorized(req){if(!POWERSHELL_BRIDGE_TOKEN)return false;const auth=String(req.headers.authorization||'');return auth===`Bearer ${POWERSHELL_BRIDGE_TOKEN}`}
function normalizeWindowsCwd(value){let v=String(value||'C:\\Projects').trim().replace(/\//g,'\\');if(/\.\.(?:\\|$)/.test(v))throw new Error('Working directory may not contain ..');const low=v.toLowerCase();const roots=['c:\\projects','c:\\repos','c:\\localai'];if(!roots.some(r=>low===r||low.startsWith(r+'\\')))throw new Error('Working directory must be under C:\\Projects, C:\\repos, or C:\\LocalAI');return v}
function powerShellRisk(script){const s=String(script||'').toLowerCase();if(/format-volume|clear-disk|remove-item\s+[^\r\n]*-recurse|stop-computer|restart-computer|docker\s+(?:rm|system\s+prune)|remove-netfirewallrule/.test(s))return 'high';if(/set-content|add-content|copy-item|move-item|remove-item|new-item|docker\s+(?:restart|stop|start)|invoke-webrequest|invoke-restmethod/.test(s))return 'medium';return 'low'}
async function apiPowerShellJobs(req,res){if(!requireFeature(res,17)||!requireLocalUi(req,res))return;const items=powerShellJobStore();json(res,200,{items:items.slice(0,100),bridgeConfigured:!!POWERSHELL_BRIDGE_TOKEN,localOnly:true})}
async function apiPowerShellCreate(req,res){if(!requireFeature(res,17)||!requireLocalUi(req,res))return;try{const b=await readBody(req,512*1024);const script=String(b.script||'');if(!script.trim())return json(res,400,{error:'script is required'});if(script.length>150000)return json(res,413,{error:'script is too large'});const item={id:makeId('ps'),script,cwd:normalizeWindowsCwd(b.cwd),timeoutSec:Math.max(5,Math.min(600,Number(b.timeoutSec)||120)),risk:powerShellRisk(script),status:'pending_approval',createdAt:nowIso(),updatedAt:nowIso(),stdout:'',stderr:'',exitCode:null};const items=powerShellJobStore();items.unshift(item);savePowerShellJobs(items);recordActivity('powershell','PowerShell script prepared',`${item.risk} risk Ãƒâ€šÃ‚Â· ${item.cwd}`,{jobId:item.id});json(res,201,{item})}catch(e){storageError(res,e,400)}}
async function apiPowerShellApprove(req,res){if(!requireFeature(res,17)||!requireLocalUi(req,res))return;try{const b=await readBody(req);const items=powerShellJobStore();const item=items.find(x=>x.id===b.id);if(!item)return json(res,404,{error:'PowerShell job not found'});if(item.status!=='pending_approval')return json(res,409,{error:`Job is not awaiting approval (${item.status})`});const decision=String(b.decision||'');if(!['approved','rejected'].includes(decision))return json(res,400,{error:'decision must be approved or rejected'});item.status=decision;item.updatedAt=nowIso();savePowerShellJobs(items);recordActivity('powershell',`PowerShell job ${decision}`,item.id,{jobId:item.id,risk:item.risk});json(res,200,{item})}catch(e){storageError(res,e,400)}}
async function apiPowerShellRequestRun(req,res){if(!requireFeature(res,17)||!requireLocalUi(req,res))return;try{const b=await readBody(req);if(String(b.confirmation||'')!=='RUN')return json(res,409,{error:'Type RUN to queue an approved PowerShell job'});const items=powerShellJobStore();const item=items.find(x=>x.id===b.id);if(!item)return json(res,404,{error:'PowerShell job not found'});if(item.status!=='approved')return json(res,409,{error:`Job must be approved before queueing (${item.status})`});if(!POWERSHELL_BRIDGE_TOKEN)return json(res,503,{error:'PowerShell host bridge is not configured'});item.status='run_requested';item.runRequestedAt=nowIso();item.updatedAt=nowIso();savePowerShellJobs(items);recordActivity('powershell','PowerShell job queued',item.id,{jobId:item.id});json(res,200,{item})}catch(e){storageError(res,e,400)}}
async function apiPowerShellCancel(req,res){if(!requireFeature(res,17)||!requireLocalUi(req,res))return;try{const b=await readBody(req);const items=powerShellJobStore();const item=items.find(x=>x.id===b.id);if(!item)return json(res,404,{error:'PowerShell job not found'});if(!['pending_approval','approved','run_requested'].includes(item.status))return json(res,409,{error:`Job cannot be cancelled from ${item.status}`});item.status='cancelled';item.updatedAt=nowIso();savePowerShellJobs(items);json(res,200,{item})}catch(e){storageError(res,e,400)}}
async function apiPowerShellHostNext(req,res){if(!requireFeature(res,17))return;if(!hostBridgeAuthorized(req))return json(res,401,{error:'Unauthorized host bridge'});const items=powerShellJobStore();const item=[...items].reverse().find(x=>x.status==='run_requested');if(!item)return json(res,200,{item:null});item.status='running';item.hostStartedAt=nowIso();item.updatedAt=nowIso();savePowerShellJobs(items);json(res,200,{item:{id:item.id,script:item.script,cwd:item.cwd,timeoutSec:item.timeoutSec,risk:item.risk}})}
async function apiPowerShellHostResult(req,res){if(!requireFeature(res,17))return;if(!hostBridgeAuthorized(req))return json(res,401,{error:'Unauthorized host bridge'});try{const b=await readBody(req,512*1024);const items=powerShellJobStore();const item=items.find(x=>x.id===b.id);if(!item)return json(res,404,{error:'PowerShell job not found'});if(item.status!=='running')return json(res,409,{error:`Job is not running (${item.status})`});item.exitCode=Number.isFinite(Number(b.exitCode))?Number(b.exitCode):-1;item.stdout=String(b.stdout||'').slice(-120000);item.stderr=String(b.stderr||'').slice(-120000);item.durationMs=Math.max(0,Number(b.durationMs)||0);item.status=item.exitCode===0?'completed':'failed';item.completedAt=nowIso();item.updatedAt=nowIso();savePowerShellJobs(items);recordActivity('powershell',item.status==='completed'?'PowerShell job completed':'PowerShell job failed',`${item.id} Ãƒâ€šÃ‚Â· exit ${item.exitCode}`,{jobId:item.id});json(res,200,{ok:true,item})}catch(e){storageError(res,e,400)}}
// ===== END POWERSHELL WORKBENCH =============================================

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = urlObj.pathname;

  try {
    if (req.method === 'GET' && p === '/healthz') return json(res, 200, { status: 'ok', appliance: 'Local AI', version: APP_VERSION, releaseCommit: release?.commit || null, storage: { engine: 'sqlite', schemaVersion: 1 } });
    if (req.method === 'GET' && p === '/api/storage/status') return json(res, 200, storage.status());
    if (req.method === 'GET' && p === '/api/status') return await apiStatus(req, res);
    if (req.method === 'GET' && p === '/api/models') return await apiModels(req, res);
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

    if (req.method === 'GET' && p.startsWith('/go/')) {
      if (redirectFor(req, res, p)) return;
    }
    if (req.method === 'GET') return serveStatic(req, res, p);
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    storageError(res,e,500);
  }
});

migrateLegacyActivityToLibrary();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`${new Date().toISOString()} Local AI Appliance v${APP_VERSION} listening on 0.0.0.0:${PORT}`);
  recordActivity('system', 'Appliance started', 'Local AI Appliance v${APP_VERSION} is ready.');
});


// Finish in-flight requests before closing the authoritative data store.
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close(() => { storage.close(); process.exit(0); });
  server.closeIdleConnections();
  setTimeout(() => { storage.close(); process.exit(0); }, 10000).unref();
});
