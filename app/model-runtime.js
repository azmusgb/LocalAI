'use strict';

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function modelName(value) {
  return String(value?.name || value?.model || '').trim();
}

function modelDetails(value) {
  const details = value?.details && typeof value.details === 'object' ? value.details : {};
  return {
    format: details.format || null,
    family: details.family || null,
    families: Array.isArray(details.families) ? details.families.filter(Boolean) : [],
    parameterSize: details.parameter_size || null,
    quantizationLevel: details.quantization_level || null
  };
}

function installedModel(value) {
  const name = modelName(value);
  return {
    name,
    digest: value?.digest || null,
    sizeBytes: finiteNumber(value?.size),
    modifiedAt: value?.modified_at || null,
    details: modelDetails(value)
  };
}

function loadedModel(value) {
  const name = modelName(value);
  return {
    name,
    model: String(value?.model || name).trim() || name,
    digest: value?.digest || null,
    sizeBytes: finiteNumber(value?.size),
    sizeVramBytes: finiteNumber(value?.size_vram),
    contextLength: finiteNumber(value?.context_length),
    expiresAt: value?.expires_at || null,
    details: modelDetails(value)
  };
}

function buildRuntimeSnapshot(tagsPayload, psPayload, defaultModel, runtimeError = null) {
  const installed = (Array.isArray(tagsPayload?.models) ? tagsPayload.models : [])
    .map(installedModel)
    .filter(item => item.name);
  const loaded = (Array.isArray(psPayload?.models) ? psPayload.models : [])
    .map(loadedModel)
    .filter(item => item.name);
  const loadedByName = new Map(loaded.map(item => [item.name, item]));
  const models = installed.map(item => ({
    ...item,
    loaded: loadedByName.has(item.name),
    runtime: loadedByName.get(item.name) || null
  }));
  const names = models.map(item => item.name);
  const loadedNames = loaded.map(item => item.name);
  const selected = String(defaultModel || '').trim();

  return {
    available: true,
    default: selected,
    models: names,
    installed: models,
    loaded,
    installedCount: models.length,
    loadedCount: loaded.length,
    runtimeAvailable: !runtimeError,
    runtimeError: runtimeError ? String(runtimeError.message || runtimeError) : null,
    defaultInstalled: !!selected && names.includes(selected),
    defaultLoaded: !!selected && loadedNames.includes(selected)
  };
}

async function readJson(fetchWithTimeout, url, timeoutMs) {
  const response = await fetchWithTimeout(url, {}, timeoutMs);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

async function loadOllamaModelRuntime({ baseUrl, fetchWithTimeout, defaultModel, timeoutMs = 5000 }) {
  if (typeof fetchWithTimeout !== 'function') throw new Error('fetchWithTimeout is required');
  const root = String(baseUrl || '').replace(/\/$/, '');
  if (!root) throw new Error('baseUrl is required');

  const tags = await readJson(fetchWithTimeout, `${root}/api/tags`, timeoutMs);
  let ps = { models: [] };
  let runtimeError = null;
  try {
    ps = await readJson(fetchWithTimeout, `${root}/api/ps`, timeoutMs);
  } catch (error) {
    runtimeError = error;
  }

  return buildRuntimeSnapshot(tags, ps, defaultModel, runtimeError);
}

module.exports = {
  buildRuntimeSnapshot,
  loadOllamaModelRuntime
};
