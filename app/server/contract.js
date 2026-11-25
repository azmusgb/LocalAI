'use strict';

// The `pi-hub` consumer's two merged reads (amendment A34, P1a): GET /api/contract/status and GET /api/contract/models.
// Each answers 200 with { as_of, sources: { <name>: { state: 'ok' | 'failed' | 'unknown', checked_at, error? } }, ...data }.
// A source that did not answer is `failed` with the reason and its data is null (never an empty list, never a healthy
// default); `unknown` is a source that was not read (nothing set up to read). The reads reuse what the Services and
// Models pages already call (getStatusAndRecordTransition, the bridge probes, loadOllamaModelRuntime's two Ollama reads);
// they add no new probe. Contract: atlas/contracts.json, consumer `pi-hub`.
const { installedModel, loadedModel, readJson } = require('../model-runtime');

// Per-source deadlines, none longer than the page read's own (Ollama 5 s, GridCraft 4 s, ArtCraft 20 s -> 5 s here,
// Workshop display 3 s plus its camera check). The status read waits on probes that each end within 5 s.
const TIMEOUTS = { services: 6000, gridcraft: 4000, artcraft: 5000, workshop: 5000, watch: 3000, installed: 5000, loaded: 5000, pulls: 3000, routing: 3000 };

// The shape of these two replies. Pi Hub compares it with the one it was built for and shows "Assistant out of date" when
// they differ; raise it only for a change that removes or renames a documented field (atlas/contracts.json, consumer pi-hub).
const CONTRACT_VERSION = 1;

const UNKNOWN = Symbol('unknown');
const unknown = reason => ({ [UNKNOWN]: true, reason });

function errorText(e) {
  const msg = String(e?.message || e || 'failed').slice(0, 200);
  const code = e?.cause?.code;
  return code && !msg.includes(code) ? `${msg} (${code})` : msg;
}

function createContract({ now = () => new Date(), getStatus, gridcraftHealthRead, artcraftStatusRead, workshopStatusRead, watchRead, ollamaUrl, fetchWithTimeout, defaultModel, protectedModels, pullsList, routingRead, timeouts = {} }) {
  const limits = { ...TIMEOUTS, ...timeouts };

  // One source: { state, checked_at, error?, value }. fn may throw (failed) or return unknown(reason); a read that
  // outlives its deadline is failed, and its late answer is dropped.
  async function readSource(name, fn) {
    const ms = limits[name];
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} did not answer within ${ms / 1000} s`)), ms); });
    try {
      const value = await Promise.race([Promise.resolve().then(fn), deadline]);
      if (value && value[UNKNOWN]) return { state: 'unknown', checked_at: now().toISOString(), error: value.reason, value: null };
      return { state: 'ok', checked_at: now().toISOString(), value };
    } catch (e) {
      return { state: 'failed', checked_at: now().toISOString(), error: errorText(e), value: null };
    } finally { clearTimeout(timer); }
  }

  // Runs the named reads together and shapes the merge; as_of is taken when the last one has finished.
  async function merge(reads) {
    const names = Object.keys(reads);
    const done = await Promise.all(names.map(n => readSource(n, reads[n])));
    const results = Object.fromEntries(names.map((n, i) => [n, done[i]]));
    const sources = Object.fromEntries(names.map(n => {
      const { value, ...meta } = results[n];
      return [n, meta];
    }));
    return { as_of: now().toISOString(), sources, value: n => results[n].value };
  }

  async function status() {
    const m = await merge({
      services: getStatus,
      gridcraft: gridcraftHealthRead,
      artcraft: artcraftStatusRead,
      workshop: async () => {
        const w = await workshopStatusRead();
        if (!w.portalUrl) return unknown('No Workshop display address is set');
        if (w.online !== true) throw new Error('The Workshop display did not answer');
        return w;
      },
      watch: async () => watchRead()
    });
    const services = m.value('services');
    return {
      as_of: m.as_of,
      contract_version: CONTRACT_VERSION,
      sources: m.sources,
      overall: services ? services.overall : null,
      services: services ? services.services : null,
      serviceSummary: services ? services.serviceSummary : null,
      gridcraft: m.value('gridcraft'),
      artcraft: m.value('artcraft'),
      workshop: m.value('workshop'),
      watch: m.value('watch')
    };
  }

  async function models() {
    const root = String(ollamaUrl || '').replace(/\/$/, '');
    const m = await merge({
      installed: async () => {
        const tags = await readJson(fetchWithTimeout, `${root}/api/tags`, limits.installed);
        return (Array.isArray(tags?.models) ? tags.models : []).map(installedModel).filter(x => x.name);
      },
      loaded: async () => {
        const ps = await readJson(fetchWithTimeout, `${root}/api/ps`, limits.loaded);
        return (Array.isArray(ps?.models) ? ps.models : []).map(loadedModel).filter(x => x.name);
      },
      pulls: async () => pullsList(),
      routing: async () => routingRead()
    });
    const installed = m.value('installed'), loaded = m.value('loaded');
    return {
      as_of: m.as_of,
      contract_version: CONTRACT_VERSION,
      sources: m.sources,
      default: defaultModel,
      protectedModels: protectedModels(),
      installed,
      loaded,
      defaultInstalled: installed ? installed.some(x => x.name === defaultModel) : null,
      defaultLoaded: loaded ? loaded.some(x => x.name === defaultModel) : null,
      pulls: m.value('pulls'),
      routing: m.value('routing')
    };
  }

  return { status, models };
}

module.exports = { createContract, CONTRACT_VERSION, TIMEOUTS };
