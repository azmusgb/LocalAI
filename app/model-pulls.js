'use strict';
// Model downloads through Ollama's streaming /api/pull. Progress is kept in memory for the UI to poll; one
// download per model at a time. Removal goes through /api/delete, except for models Local AI depends on.

const MODEL_NAME = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*(?::[a-z0-9][a-z0-9._-]*)?$/i;
const KEEP_FINISHED = 10;
const CONTEXT_VARIANT = /^(.+)-(\d{1,3})k$/i;

function validModelName(value) {
  const name = String(value || '').trim();
  return name.length <= 120 && MODEL_NAME.test(name) ? name : null;
}

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

function createModelPulls({ baseUrl, fetchImpl = globalThis.fetch, protectedModels = () => [], onFinish = () => {} }) {
  const pulls = new Map();
  const view = (p) => ({ name: p.name, state: p.state, status: p.status, completed: p.completed, total: p.total, error: p.error, startedAt: p.startedAt, finishedAt: p.finishedAt || null });

  function prune() {
    const finished = [...pulls.values()].filter(p => p.state !== 'running').sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));
    for (const p of finished.slice(KEEP_FINISHED)) pulls.delete(p.name);
  }

  // Streams one /api/pull into p. Resolves when Ollama reports success; throws with Ollama's message otherwise.
  async function pull(p, name) {
    const response = await fetchImpl(`${baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, name, stream: true }),
      signal: p.controller.signal
    });
    if (!response.ok) throw new Error(`Ollama answered HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
    // NDJSON: {status, digest?, total?, completed?} per line; one layer per digest; {status:'success'} at the end.
    const layers = new Map();
    const decoder = new TextDecoder();
    let buffer = '';
    const handle = (line) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(String(msg.error));
      if (msg.status) p.status = String(msg.status).slice(0, 120);
      if (msg.digest && msg.total) layers.set(msg.digest, { total: Number(msg.total) || 0, completed: Number(msg.completed) || 0 });
      p.total = [...layers.values()].reduce((n, l) => n + l.total, 0);
      p.completed = [...layers.values()].reduce((n, l) => n + l.completed, 0);
      if (msg.status === 'success') p.state = 'done';
    };
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) { handle(buffer.slice(0, i)); buffer = buffer.slice(i + 1); }
    }
    handle(buffer + decoder.decode());
    if (p.state !== 'done') throw new Error('The download stopped before Ollama reported success.');
  }

  async function run(p) {
    try {
      try {
        await pull(p, p.name);
      } catch (error) {
        // "qwen3:4b-instruct-32k" is a local variant, not a library model: fetch the base model, then create the
        // variant with that context window, the way it was made on the host.
        const variant = CONTEXT_VARIANT.exec(p.name);
        if (!variant || p.state === 'cancelled' || !/not exist|not found|manifest/i.test(String(error?.message))) throw error;
        await pull(p, variant[1]);
        p.state = 'running';
        p.status = `Setting up the ${variant[2]}k-context version`;
        const created = await fetchImpl(`${baseUrl}/api/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: p.name, from: variant[1], parameters: { num_ctx: Number(variant[2]) * 1024 }, stream: false }),
          signal: p.controller.signal
        });
        if (!created.ok) throw new Error(`Ollama could not create ${p.name} (HTTP ${created.status}): ${(await created.text().catch(() => '')).slice(0, 200)}`);
        p.state = 'done';
        p.status = 'success';
      }
    } catch (error) {
      if (p.state === 'cancelled') return;
      p.state = 'failed';
      p.error = String(error?.message || error).slice(0, 300);
    } finally {
      p.finishedAt = new Date().toISOString();
      prune();
      onFinish(view(p));
    }
  }

  return {
    list() { return [...pulls.values()].map(view).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))); },
    start(rawName) {
      const name = validModelName(rawName);
      if (!name) throw httpError(400, 'Enter a model name such as qwen3:4b-instruct.');
      const current = pulls.get(name);
      if (current?.state === 'running') return view(current);
      const p = { name, state: 'running', status: 'Starting', completed: 0, total: 0, error: null, startedAt: new Date().toISOString(), controller: new AbortController() };
      pulls.set(name, p);
      run(p);
      return view(p);
    },
    cancel(rawName) {
      const p = pulls.get(validModelName(rawName) || '');
      if (!p || p.state !== 'running') throw httpError(404, 'No download of that model is running.');
      p.state = 'cancelled';
      p.status = 'Cancelled';
      p.controller.abort();
      return view(p);
    },
    async remove(rawName) {
      const name = validModelName(rawName);
      if (!name) throw httpError(400, 'Enter a model name.');
      if (protectedModels().includes(name)) throw httpError(409, `${name} is used by Local AI (the default chat model or GridCraft), so it can't be removed here.`);
      if (pulls.get(name)?.state === 'running') throw httpError(409, `${name} is still downloading. Cancel the download first.`);
      const response = await fetchImpl(`${baseUrl}/api/delete`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name, name }) });
      if (response.status === 404) throw httpError(404, `${name} is not installed.`);
      if (!response.ok) throw httpError(502, `Ollama could not remove ${name} (HTTP ${response.status}).`);
      pulls.delete(name);
      return { name, removed: true };
    }
  };
}

module.exports = { createModelPulls, validModelName };
