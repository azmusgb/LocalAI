'use strict';

const fs = require('node:fs');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'app', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function safeIdentifier(value) {
  return /^[A-Za-z_$][\w$]*$/.test(String(value || '')) ? String(value) : '';
}

function findFunctionRange(text, name) {
  const safe = safeIdentifier(name);
  if (!safe) throw new Error(`Invalid function name: ${name}`);
  const rx = new RegExp(`(?:async\\s+)?function\\s+${safe.replace(/[$]/g, '\\$&')}\\s*\\([^)]*\\)\\s*\\{`, 'm');
  const match = rx.exec(text);
  if (!match) throw new Error(`function ${safe} was not found`);
  const second = rx.exec(text.slice(match.index + match[0].length));
  if (second) throw new Error(`function ${safe} is not unique`);

  const open = text.indexOf('{', match.index);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = open; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return { start: match.index, end: i + 1 };
    }
  }
  throw new Error(`function ${safe} has an unmatched body`);
}

function replacementSource(fn, targetName) {
  return fn.toString().replace(/^((?:async\s+)?function\s+)[A-Za-z_$][\w$]*/, `$1${targetName}`);
}

function replaceFunction(name, fn) {
  const range = findFunctionRange(source, name);
  source = source.slice(0, range.start) + replacementSource(fn, name) + source.slice(range.end);
}

function replacementApiModels(req, res) {
  try {
    const runtime = await loadOllamaModelRuntime({
      baseUrl: OLLAMA_URL,
      fetchWithTimeout,
      defaultModel: MODEL,
      timeoutMs: 5000
    });
    json(res, 200, runtime);
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

function replacementCapabilityPrompt(snapshot) {
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

async function replacementGetCapabilitiesSnapshot(force = false) {
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
    powershell: { configured: !!POWERSHELL_BRIDGE_TOKEN, localOnly: true }
  };
  capabilityCache = { value: snapshot, expiresAt: Date.now() + CAPABILITY_CACHE_MS };
  return snapshot;
}

const storageRequire = "const { Storage } = require('./storage');";
const runtimeRequire = "const { loadOllamaModelRuntime } = require('./model-runtime');";
if (!source.includes(runtimeRequire)) {
  const first = source.indexOf(storageRequire);
  const second = source.indexOf(storageRequire, first + storageRequire.length);
  if (first < 0 || second >= 0) throw new Error('Storage require anchor is missing or ambiguous');
  source = source.slice(0, first + storageRequire.length) + `\n${runtimeRequire}` + source.slice(first + storageRequire.length);
}

replaceFunction('apiModels', replacementApiModels);
replaceFunction('capabilityPrompt', replacementCapabilityPrompt);
replaceFunction('getCapabilitiesSnapshot', replacementGetCapabilitiesSnapshot);

if (!source.includes('`${OLLAMA_URL}/api/ps`') && !source.includes("'/api/ps'")) {
  throw new Error('Patched server does not reference Ollama /api/ps');
}
if (!source.includes('models: modelRuntime')) {
  throw new Error('Patched capability snapshot does not expose model runtime state');
}

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Applied guarded model-runtime patch to app/server.js');
