'use strict';

// Free US cloud models for the coordinator (app/model-router.js): Groq and Cerebras over their OpenAI-compatible chat
// completions APIs. Keys come from the environment (stack.env: LOCALAI_GROQ_API_KEY, LOCALAI_CEREBRAS_API_KEY); their
// names match childEnv's secret filter, so spawned commands never inherit them. A key never appears in an error, a log
// or a status. A rate limit (429) parks the provider until its retry-after (else 1 h); other failures are thrown so the
// coordinator tries the next model, ending on this PC. A caller's signal (Stop, a caller that went away) ends the request
// at once and throws the caller's reason: that is not the provider failing, so nothing is recorded against it.
const { modelFetchWithTimeout } = require('./model-http');

const PROVIDERS = Object.freeze({
  groq: { url: 'https://api.groq.com/openai/v1', key: 'LOCALAI_GROQ_API_KEY', urlEnv: 'LOCALAI_GROQ_URL', name: 'Groq' },
  cerebras: { url: 'https://api.cerebras.ai/v1', key: 'LOCALAI_CEREBRAS_API_KEY', urlEnv: 'LOCALAI_CEREBRAS_URL', name: 'Cerebras' },
});
const HOUR = 3600e3;

function createCloudModels({ env = process.env, timeoutMs = 60000, fetchImpl = modelFetchWithTimeout, now = Date.now } = {}) {
  const parkedUntil = {}, lastError = {}, used = {};
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const keyOf = p => String(env[PROVIDERS[p]?.key] || '').trim();
  // Text that may hold a provider's echo of the key: scrub every key we hold before it goes anywhere.
  const scrub = s => Object.keys(PROVIDERS).reduce((t, p) => (keyOf(p) ? t.split(keyOf(p)).join('[key]') : t), String(s));

  const keys = () => Object.fromEntries(Object.keys(PROVIDERS).map(p => [p, Boolean(keyOf(p))]));
  const parked = () => Object.fromEntries(Object.entries(parkedUntil).filter(([, t]) => t > now()));
  function status() {
    const d = day();
    return Object.fromEntries(Object.entries(PROVIDERS).map(([p, x]) => [p, {
      name: x.name, key: Boolean(keyOf(p)), today: used[p]?.day === d ? used[p].n : 0,
      parkedUntil: parkedUntil[p] > now() ? new Date(parkedUntil[p]).toISOString() : null, lastError: lastError[p] || null,
    }]));
  }

  async function chat({ provider, model, messages, maxTokens = 2048, signal }) {
    const p = PROVIDERS[provider];
    if (!p) throw new Error(`Unknown cloud provider ${provider}`);
    const key = keyOf(provider);
    if (!key) throw new Error(`${p.name}: no key set`);
    // outcome: what the coordinator records for this try (timeout, rate_limited or error).
    const fail = (message, outcome = 'error') => { lastError[provider] = { at: new Date(now()).toISOString(), message: scrub(message).slice(0, 200) }; return Object.assign(new Error(lastError[provider].message), { outcome }); };
    signal?.throwIfAborted();
    const lost = e => {
      if (signal?.aborted) return signal.reason;
      const late = /timeout|timed out/i.test(String(e?.code || e?.message));
      return fail(`${p.name}: ${late ? 'timed out' : 'unreachable'}`, late ? 'timeout' : 'error');
    };
    let r, raw;
    try {
      r = await fetchImpl(`${env[p.urlEnv] || p.url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: false }),
        ...(signal ? { signal } : {}),
      }, timeoutMs);
      raw = await r.text();
    } catch (e) { throw lost(e); }
    if (r.status === 429) {
      const after = Number(r.headers?.get?.('retry-after'));
      parkedUntil[provider] = now() + (Number.isFinite(after) && after > 0 ? after * 1000 : HOUR);
      throw fail(`${p.name}: rate limit reached, resting until ${new Date(parkedUntil[provider]).toLocaleTimeString('en-US')}`, 'rate_limited');
    }
    if (!r.ok) throw fail(`${p.name}: HTTP ${r.status}`);
    let content = '';
    try { content = JSON.parse(raw)?.choices?.[0]?.message?.content || ''; } catch { throw fail(`${p.name}: unreadable answer`); }
    const d = day();
    used[provider] = { day: d, n: (used[provider]?.day === d ? used[provider].n : 0) + 1 };
    delete lastError[provider];
    return { content, provider, model };
  }

  return { chat, keys, parked, status };
}

module.exports = { createCloudModels, PROVIDERS };
